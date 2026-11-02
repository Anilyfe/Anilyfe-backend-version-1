const express=require('express'); const {z}=require('zod'); const prisma=require('../lib/prisma'); const {ok,fail,asyncHandler}=require('../lib/http'); const {requireAuth}=require('../middleware/auth'); const {notify}=require('../lib/notifications');
const router=express.Router();
const ATTACHMENT_MIMES=['image/jpeg','image/png','image/webp','image/gif'];

/* Only URLs our own upload endpoints minted may appear in a chat: without this a buyer could
   post any remote image and the storefront would fetch it from their browser. */
function isTrustedAttachmentUrl(value,req){
  let url; try{url=new URL(String(value));}catch{return false;}
  if(!['http:','https:'].includes(url.protocol))return false;
  if(url.hostname===req.hostname&&url.pathname.startsWith('/uploads/'))return true;
  const publicBase=process.env.R2_PUBLIC_URL;
  if(!publicBase)return false;
  let base; try{base=new URL(publicBase);}catch{return false;}
  return url.hostname===base.hostname;
}
function attachmentInput(){
  return z.object({attachmentUrl:z.string().url().optional(),attachmentMime:z.enum(ATTACHMENT_MIMES).optional()});
}
/* A photo on its own is a legitimate message ("is this the one you have?"), so text is
   optional as long as one of the two is present. */
const hasContent=d=>d.body.length>0||!!d.attachmentUrl;
function messageSchema(fields){
  return z.object(fields).merge(attachmentInput()).refine(hasContent,{message:'Write a message or attach an image.',path:'body'});
}
const bodyField={body:z.string().trim().max(4000).default('')};
function readAttachment(req,body){
  const url=typeof body?.attachmentUrl==='string'&&body.attachmentUrl.trim()?body.attachmentUrl.trim():null;
  const mime=typeof body?.attachmentMime==='string'?body.attachmentMime:null;
  if(!url)return {attachmentUrl:null,attachmentMime:null};
  if(!isTrustedAttachmentUrl(url,req))return {error:'Chat images must be uploaded through ANILyfe first.'};
  if(!ATTACHMENT_MIMES.includes(mime))return {error:'Unsupported chat image type.'};
  return {attachmentUrl:url,attachmentMime:mime};
}
async function participants(conversationId,userId){
  const c=await prisma.conversation.findUnique({where:{id:conversationId},select:{id:true,buyerId:true,sellerUserId:true,buyerUnread:true,sellerUnread:true}});
  if(!c)return null;
  return {conversation:c,isBuyer:c.buyerId===userId,isSeller:c.sellerUserId===userId};
}

router.post('/',requireAuth,asyncHandler(async(req,res)=>{
  /* A thread always starts from the buyer side: the target is a store, and the caller becomes
     Conversation.buyerId. There is deliberately no way to open a thread against a buyer. */
  const d=messageSchema({sellerId:z.string().min(1).max(120),...bodyField}).parse(req.body||{});
  const attachment=readAttachment(req,d);
  if(attachment.error)return fail(res,400,'INVALID_ATTACHMENT',attachment.error);
  const seller=await prisma.seller.findFirst({where:{OR:[{id:d.sellerId},{slug:d.sellerId}],status:'APPROVED'},select:{id:true,userId:true,businessName:true}});
  if(!seller)return fail(res,404,'SELLER_NOT_FOUND','That store is not open for messages.');
  if(seller.userId===req.user.id)return fail(res,400,'SELF_MESSAGE','You cannot message your own store.');
  const conversation=await prisma.conversation.upsert({
    where:{buyerId_sellerId:{buyerId:req.user.id,sellerId:seller.id}},
    create:{buyerId:req.user.id,sellerId:seller.id,sellerUserId:seller.userId},
    update:{}
  });
  const message=await prisma.$transaction(async tx=>{
    const created=await tx.chatMessage.create({data:{conversationId:conversation.id,senderUserId:req.user.id,senderType:'BUYER',body:d.body,attachmentUrl:attachment.attachmentUrl,attachmentMime:attachment.attachmentMime}});
    await tx.conversation.update({where:{id:conversation.id},data:{lastMessageAt:new Date(),sellerUnread:{increment:1}}});
    return created;
  });
  await notify({userId:seller.userId,type:'CHAT_MESSAGE',title:`A buyer messaged ${seller.businessName}`,message:d.body.slice(0,140)||'sent an image',data:{conversationId:conversation.id}});
  return ok(res,{conversationId:conversation.id,message},201);
}));

router.get('/threads',requireAuth,asyncHandler(async(req,res)=>{
  const isStaff=['ADMIN','SUPER_ADMIN'].includes(req.user.role);
  const seller=await prisma.seller.findUnique({where:{userId:req.user.id},select:{id:true}});
  const where=isStaff?{}:{OR:[{buyerId:req.user.id},...(seller?[{sellerId:seller.id}]:[])]};
  const threads=await prisma.conversation.findMany({
    where,
    include:{
      messages:{orderBy:{createdAt:'desc'},take:1},
      buyer:{select:{id:true,firstName:true,lastName:true}},
      seller:{select:{id:true,businessName:true,slug:true,logoUrl:true}}
    },
    orderBy:{lastMessageAt:'desc'},
    take:100
  });
  return ok(res,threads.map(thread=>({
    id:thread.id,
    buyerId:thread.buyerId,
    sellerId:thread.sellerId,
    buyerName:thread.buyer?`${thread.buyer.firstName} ${thread.buyer.lastName}`.trim():'ANILyfe member',
    storeName:thread.seller?.businessName||'Store',
    storeSlug:thread.seller?.slug||null,
    storeLogo:thread.seller?.logoUrl||'',
    lastMessage:thread.messages[0]?.body||(thread.messages[0]?.attachmentUrl?'Photo':''),
    lastMessageAt:thread.lastMessageAt,
    unread:['ADMIN','SUPER_ADMIN'].includes(req.user.role)?0:(thread.sellerUserId===req.user.id?thread.sellerUnread:thread.buyerUnread),
    role:thread.sellerUserId===req.user.id?'SELLER':'BUYER'
  })));
}));

router.get('/threads/:id',requireAuth,asyncHandler(async(req,res)=>{
  const found=await participants(req.params.id,req.user.id);
  if(!found)return fail(res,404,'CONVERSATION_NOT_FOUND','Conversation not found.');
  const isStaff=['ADMIN','SUPER_ADMIN'].includes(req.user.role);
  if(!isStaff&&!found.isBuyer&&!found.isSeller)return fail(res,403,'FORBIDDEN','You cannot open this conversation.');
  const thread=await prisma.conversation.findUnique({
    where:{id:found.conversation.id},
    include:{
      messages:{orderBy:{createdAt:'asc'},include:{sender:{select:{id:true,firstName:true,lastName:true}}}},
      buyer:{select:{id:true,firstName:true,lastName:true}},
      seller:{select:{id:true,userId:true,businessName:true,slug:true,logoUrl:true}}
    }
  });
  /* Only a real party clears the counter; an admin reading must not silently mark it read. */
  if(found.isBuyer||found.isSeller)await prisma.conversation.update({where:{id:thread.id},data:found.isBuyer?{buyerUnread:0}:{sellerUnread:0}});
  return ok(res,{
    id:thread.id,
    buyerName:thread.buyer?`${thread.buyer.firstName} ${thread.buyer.lastName}`.trim():'ANILyfe member',
    storeName:thread.seller?.businessName||'Store',
    storeSlug:thread.seller?.slug||null,
    viewerRole:found.isSeller?'SELLER':'BUYER',
    messages:thread.messages.map(message=>({id:message.id,body:message.body,senderType:message.senderType,senderUserId:message.senderUserId,isMine:message.senderUserId===req.user.id,attachmentUrl:message.attachmentUrl,attachmentMime:message.attachmentMime,createdAt:message.createdAt}))
  });
}));

router.post('/threads/:id/messages',requireAuth,asyncHandler(async(req,res)=>{
  const d=messageSchema(bodyField).parse(req.body||{});
  const attachment=readAttachment(req,d);
  if(attachment.error)return fail(res,400,'INVALID_ATTACHMENT',attachment.error);
  const found=await participants(req.params.id,req.user.id);
  if(!found)return fail(res,404,'CONVERSATION_NOT_FOUND','Conversation not found.');
  if(!found.isBuyer&&!found.isSeller)return fail(res,403,'FORBIDDEN','You cannot reply in this conversation.');
  const message=await prisma.$transaction(async tx=>{
    const created=await tx.chatMessage.create({data:{conversationId:found.conversation.id,senderUserId:req.user.id,senderType:found.isSeller?'SELLER':'BUYER',body:d.body,attachmentUrl:attachment.attachmentUrl,attachmentMime:attachment.attachmentMime}});
    await tx.conversation.update({where:{id:found.conversation.id},data:{lastMessageAt:new Date(),...(found.isSeller?{buyerUnread:{increment:1}}:{sellerUnread:{increment:1}})}});
    return created;
  });
  const recipientId=found.isSeller?found.conversation.buyerId:found.conversation.sellerUserId;
  await notify({userId:recipientId,type:'CHAT_REPLY',title:found.isSeller?'A seller replied to your message':'A buyer replied',message:d.body.slice(0,140)||'sent an image',data:{conversationId:found.conversation.id}});
  return ok(res,{conversationId:found.conversation.id,message},201);
}));

module.exports=router;
