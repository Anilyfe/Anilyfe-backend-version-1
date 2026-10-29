const express=require('express'); const prisma=require('../lib/prisma'); const {ok,fail,asyncHandler}=require('../lib/http'); const {requireAuth,requireRole}=require('../middleware/auth'); const {notify}=require('../lib/notifications');
const router=express.Router();
router.post('/',asyncHandler(async(req,res)=>{
  const {subject,message,email,sellerId}=req.body||{};
  if(!subject||!message||!email)return fail(res,400,'VALIDATION_ERROR','Email, subject and message are required.');
  let seller=null;
  if(sellerId){
    if(!req.user)return fail(res,401,'AUTH_REQUIRED','Sign in before messaging a seller.');
    seller=await prisma.seller.findFirst({where:{OR:[{id:String(sellerId)},{slug:String(sellerId)}]},select:{id:true,userId:true,businessName:true,status:true}});
    if(!seller||seller.status!=='APPROVED')return fail(res,404,'SELLER_NOT_FOUND','That store is not open for messages.');
  }
  const body=String(message).trim().slice(0,4000);
  const title=String(subject).trim().slice(0,200);
  const t=await prisma.supportTicket.create({data:{userId:req.user?.id||null,email,subject:title,message:body,sellerId:seller?.id||null,messages:{create:{senderType:'CUSTOMER',senderUserId:req.user?.id||null,message:body}}}});
  await notify({audienceRole:'ADMIN',type:'SUPPORT_TICKET',title:seller?'New store message':'New support ticket',message:seller?`${seller.businessName} received a message from a buyer.`:title,data:{ticketId:t.id,sellerId:seller?.id||null}});
  if(seller)await notify({userId:seller.userId,type:'STORE_MESSAGE',title:'A buyer messaged your store',message:`New message for ${seller.businessName}: ${title}`,data:{ticketId:t.id,sellerId:seller.id}});
  return ok(res,t,201);
}));
router.get('/',requireAuth,asyncHandler(async(req,res)=>{const where=['ADMIN','SUPER_ADMIN'].includes(req.user.role)?{}:{userId:req.user.id};return ok(res,await prisma.supportTicket.findMany({where,include:{messages:true},orderBy:{createdAt:'desc'}}))}));
router.get('/store',requireAuth,requireRole('SELLER'),asyncHandler(async(req,res)=>{
  const seller=await prisma.seller.findUnique({where:{userId:req.user.id},select:{id:true}});
  if(!seller)return fail(res,404,'SELLER_NOT_FOUND','Seller profile not found.');
  return ok(res,await prisma.supportTicket.findMany({where:{sellerId:seller.id},include:{messages:{orderBy:{createdAt:'asc'}},user:{select:{firstName:true,lastName:true,email:true,phone:true}}},orderBy:{createdAt:'desc'},take:100}));
}));
router.post('/:id/reply',requireAuth,asyncHandler(async(req,res)=>{
  const t=await prisma.supportTicket.findUnique({where:{id:req.params.id},select:{id:true,userId:true,sellerId:true,seller:{select:{userId:true}}}});
  if(!t)return fail(res,404,'TICKET_NOT_FOUND','Conversation not found.');
  const message=String(req.body?.message||'').trim().slice(0,4000);
  if(!message)return fail(res,400,'MESSAGE_REQUIRED','Write a reply before sending.');
  const isStaff=['ADMIN','SUPER_ADMIN'].includes(req.user.role);
  const ownSeller=req.user.role==='SELLER'?await prisma.seller.findUnique({where:{userId:req.user.id},select:{id:true}}):null;
  const isStoreOwner=Boolean(ownSeller&&t.sellerId===ownSeller.id);
  const isBuyer=t.userId===req.user.id;
  if(!isStaff&&!isStoreOwner&&!isBuyer)return fail(res,403,'FORBIDDEN','You cannot reply to this conversation.');
  const created=await prisma.supportMessage.create({data:{ticketId:t.id,senderType:isStoreOwner?'SELLER':isStaff?'ADMIN':'CUSTOMER',senderUserId:req.user.id,message}});
  if(isStoreOwner&&t.userId)await notify({userId:t.userId,type:'STORE_MESSAGE_REPLY',title:'The seller replied',message:`Your store message received a reply.`,data:{ticketId:t.id}});
  if(isBuyer&&t.sellerId)await notify({audienceRole:'SELLER',type:'STORE_MESSAGE_REPLY',title:'A buyer replied to your store message',message:message.slice(0,140),data:{ticketId:t.id,sellerId:t.sellerId}});
  return ok(res,created,201);
}));
router.patch('/:id',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>{const t=await prisma.supportTicket.findUnique({where:{id:req.params.id}});if(!t)return fail(res,404,'TICKET_NOT_FOUND','Support ticket not found.');const {status,reply}=req.body||{};const u=await prisma.$transaction(async tx=>{const x=await tx.supportTicket.update({where:{id:t.id},data:{status:status||t.status,adminResponse:reply??t.adminResponse}});if(reply)await tx.supportMessage.create({data:{ticketId:t.id,senderType:'ADMIN',senderUserId:req.user.id,message:reply}});return x});if(t.userId&&reply)await notify({userId:t.userId,type:'SUPPORT_REPLY',title:'Support replied',message:'ANILyfe support replied to your ticket.',data:{ticketId:t.id}});return ok(res,u)}));
module.exports=router;
