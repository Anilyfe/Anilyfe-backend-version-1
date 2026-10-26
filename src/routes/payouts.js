const express=require('express');
const https=require('https');
const prisma=require('../lib/prisma');
const {ok,fail,asyncHandler,decimal}=require('../lib/http');
const {requireAuth,requireRole}=require('../middleware/auth');
const {notify}=require('../lib/notifications');
const {decryptSellerPii,encryptSellerPii}=require('../lib/seller-pii');
const {sellerWithdrawalBalance}=require('../lib/withdrawal-balance');

const router=express.Router();

function resolvePaystackAccount(accountNumber,bankCode){
  return new Promise((resolve,reject)=>{
    const request=https.get({hostname:'api.paystack.co',path:`/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,headers:{Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}`}},response=>{
      let body='';
      response.setEncoding('utf8');
      response.on('data',chunk=>body+=chunk);
      response.on('end',()=>{
        try{
          const parsed=JSON.parse(body);
          if(response.statusCode<200||response.statusCode>=300||parsed.status!==true)return reject(Object.assign(new Error('Paystack could not verify this payout account.'),{code:'PAYOUT_ACCOUNT_UNVERIFIED'}));
          resolve(parsed.data);
        }catch(error){reject(error);}
      });
    });
    request.on('error',reject);
    request.setTimeout(10000,()=>request.destroy(new Error('Paystack account verification timed out.')));
  });
}

async function balance(sellerId,db=prisma,now=new Date()){
  return sellerWithdrawalBalance(sellerId,db,now);
}

router.get('/',requireAuth,requireRole('SELLER'),asyncHandler(async(req,res)=>{
  const seller=await prisma.seller.findUnique({where:{userId:req.user.id}});
  if(!seller)return fail(res,404,'SELLER_NOT_FOUND','Seller profile not found.');
  const [sellerBalance,history,withdrawals,settings,paidOrders]=await Promise.all([
    balance(seller.id),
    prisma.payout.findMany({where:{sellerId:seller.id},orderBy:{createdAt:'desc'}}),
    prisma.withdrawalRequest.findMany({where:{sellerId:seller.id},orderBy:{createdAt:'desc'}}),
    prisma.sellerSetting.findUnique({where:{sellerId:seller.id}}),
    prisma.order.findMany({where:{sellerId:seller.id,paymentStatus:'PAID',orderStatus:{notIn:['CANCELLED','REFUNDED']}},select:{id:true,orderNumber:true,subtotal:true,shipping:true,commissionAmount:true,sellerEarnings:true,paidAt:true,orderStatus:true}})
  ]);
  const rawBankAccount=settings?.bankAccount?{...settings.bankAccount,accountNumber:decryptSellerPii(settings.bankAccount.accountNumber)}:null;
  const bankAccount=rawBankAccount?{...rawBankAccount,accountNumber:`••••${String(rawBankAccount.accountNumber||'').slice(-4)}`}:null;
  const legacyHistory=history.map(payout=>{
    const account=payout.bankSnapshot||{};
    const number=account.accountNumber?decryptSellerPii(account.accountNumber):'';
    return {...payout,bank:`${account.bankName||'Bank'}${number?` (••••${number.slice(-4)})`:''}`,reference:payout.id,requestedAt:payout.createdAt};
  });
  const withdrawalHistory=withdrawals.map(withdrawal=>({id:withdrawal.id,amount:decimal(withdrawal.requestedAmount),feeAmount:decimal(withdrawal.feeAmount),netAmount:decimal(withdrawal.netAmount),status:withdrawal.status,bank:`${withdrawal.bankSnapshot?.bankName||'Bank'}${withdrawal.bankSnapshot?.accountNumber?` (••••${decryptSellerPii(withdrawal.bankSnapshot.accountNumber).slice(-4)})`:''}`,reference:withdrawal.transferReference,requestedAt:withdrawal.createdAt,processedAt:withdrawal.processedAt}));
  const payoutHistory=[...legacyHistory,...withdrawalHistory].sort((a,b)=>new Date(b.requestedAt)-new Date(a.requestedAt));
  const transactions=paidOrders.map(order=>({id:order.orderNumber,gross:decimal(order.subtotal),discount:null,shipping:decimal(order.shipping),commission:decimal(order.commissionAmount),adjustment:null,earnings:decimal(order.sellerEarnings),date:order.paidAt?new Date(order.paidAt).toLocaleDateString('en-NG'):'—',status:order.orderStatus}));
  return ok(res,{balance:sellerBalance,history:payoutHistory,bankAccount,transactions,schedule:settings?.payoutSchedule||null,totalMarketplaceFees:paidOrders.reduce((sum,order)=>sum+decimal(order.commissionAmount),0)});
}));

router.post('/request',requireAuth,requireRole('SELLER'),asyncHandler(async(req,res)=>fail(res,410,'WITHDRAWAL_ENDPOINT_MOVED','Use POST /api/withdrawals to preview and submit a withdrawal with the applicable fee.')));

router.post('/legacy-request-disabled',requireAuth,requireRole('SELLER'),asyncHandler(async(req,res)=>{
  return fail(res,410,'WITHDRAWAL_ENDPOINT_MOVED','Use POST /api/withdrawals to preview and submit a withdrawal with the applicable fee.');
  const seller=await prisma.seller.findUnique({where:{userId:req.user.id}});
  if(!seller)return fail(res,404,'SELLER_NOT_FOUND','Seller profile not found.');
  const settings=await prisma.sellerSetting.findUnique({where:{sellerId:seller.id}});
  if(!settings?.bankAccount)return fail(res,400,'PAYOUT_ACCOUNT_REQUIRED','A payout account is required before requesting a payout.');
  if(!settings.bankAccount.bankCode||!settings.bankAccount.accountNumber)return fail(res,400,'PAYOUT_ACCOUNT_UNVERIFIED','A bank code and account number are required for payout verification.');
  if(!process.env.PAYSTACK_SECRET_KEY)return fail(res,503,'PAYSTACK_NOT_CONFIGURED','Paystack is required to verify the payout account.');
  const accountNumber=decryptSellerPii(settings.bankAccount.accountNumber);
  let verifiedAccount;
  try{verifiedAccount=await resolvePaystackAccount(accountNumber,String(settings.bankAccount.bankCode));}
  catch(error){if(error.code==='PAYOUT_ACCOUNT_UNVERIFIED')return fail(res,400,error.code,error.message);throw error;}
  if(String(verifiedAccount.account_number||'')!==String(accountNumber)||!verifiedAccount.account_name)return fail(res,400,'PAYOUT_ACCOUNT_UNVERIFIED','Paystack returned account details that do not match the saved account.');
  let encryptedAccountNumber;
  try{encryptedAccountNumber=encryptSellerPii(accountNumber);}
  catch(error){if(error.code==='SELLER_PII_KEY_MISSING')return fail(res,503,'SELLER_APPLICATION_STORAGE_UNAVAILABLE','Seller application storage is not configured. Contact marketplace support.');throw error;}
  const rawAmount=Number(req.body?.amount);
  const amountCents=Math.round(rawAmount*100);
  if(!Number.isFinite(rawAmount)||rawAmount<=0||Math.abs(rawAmount*100-amountCents)>1e-6)return fail(res,400,'INVALID_PAYOUT_AMOUNT','Enter a positive payout amount with no more than two decimal places.');
  const amount=amountCents/100;
  if(amount<10000)return fail(res,400,'PAYOUT_MINIMUM_NOT_MET','The minimum payout request is ₦10,000.');
  const payout=await prisma.$transaction(async tx=>{
    const active=await tx.payout.findFirst({where:{sellerId:seller.id,status:{in:['PENDING','PROCESSING']}}});
    if(active)return {conflict:true};
    const current=await balance(seller.id,tx);
    if(amount>current.availableBalance)return null;
    const created=await tx.payout.create({data:{sellerId:seller.id,requestedByUserId:req.user.id,amount,bankSnapshot:{...settings.bankAccount,accountName:verifiedAccount.account_name,accountNumber:encryptedAccountNumber,verified:true},status:'PENDING'}});
    await tx.auditLog.create({data:{actorUserId:req.user.id,action:'PAYOUT_REQUESTED',targetType:'Payout',targetId:created.id,metadata:{amount},ipAddress:req.ip}});
    return created;
  },{isolationLevel:'Serializable'});
  if(payout?.conflict)return fail(res,409,'PAYOUT_ALREADY_PENDING','A payout request is already being processed for this seller.');
  if(!payout)return fail(res,400,'INSUFFICIENT_BALANCE','Requested payout exceeds earnings that have cleared the 48-hour withdrawal hold.');
  await notify({audienceRole:'ADMIN',type:'PAYOUT_REQUEST',title:'Seller payout requested',message:`${seller.businessName} requested a payout.`,data:{payoutId:payout.id,sellerId:seller.id}});
  return ok(res,payout,201);
}));

router.get('/admin',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>{const payouts=await prisma.payout.findMany({include:{seller:true},orderBy:{createdAt:'desc'}});return ok(res,payouts.map(payout=>({...payout,bankSnapshot:payout.bankSnapshot?{...payout.bankSnapshot,accountNumber:decryptSellerPii(payout.bankSnapshot.accountNumber)}:null})))}));

router.patch('/admin/:id',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>{
  const {status,adminNote}=req.body||{};
  const allowed={PENDING:['PROCESSING','FAILED','CANCELLED'],PROCESSING:['PAID','FAILED','CANCELLED']};
  if(!Object.hasOwn(allowed,status))return fail(res,400,'INVALID_PAYOUT_STATUS','Invalid payout status.');
  const changed=await prisma.$transaction(async tx=>{
    const existing=await tx.payout.findUnique({where:{id:req.params.id}});
    if(!existing)return null;
    if(!allowed[existing.status]?.includes(status))return {conflict:true,current:existing.status};
    const result=await tx.payout.updateMany({where:{id:existing.id,status:existing.status},data:{status,adminNote:adminNote===undefined?existing.adminNote:String(adminNote).slice(0,2000),processedAt:['PAID','FAILED','CANCELLED'].includes(status)?new Date():null}});
    if(!result.count)return {conflict:true,current:existing.status};
    const updated=await tx.payout.findUnique({where:{id:existing.id}});
    await tx.auditLog.create({data:{actorUserId:req.user.id,action:'PAYOUT_STATUS_UPDATED',targetType:'Payout',targetId:updated.id,metadata:{status,amount:decimal(updated.amount)},ipAddress:req.ip}});
    return {payout:updated};
  },{isolationLevel:'Serializable'});
  if(!changed)return fail(res,404,'PAYOUT_NOT_FOUND','Payout not found.');
  if(changed.conflict)return fail(res,409,'INVALID_PAYOUT_TRANSITION',`A payout cannot move from ${changed.current} to ${status}.`);
  const payout=changed.payout;
  const seller=await prisma.seller.findUnique({where:{id:payout.sellerId}});
  await notify({userId:seller.userId,type:'PAYOUT_STATUS',title:'Payout updated',message:`Your payout is ${status.toLowerCase()}.`,data:{payoutId:payout.id,status}});
  return ok(res,{...payout,bankSnapshot:payout.bankSnapshot?{...payout.bankSnapshot,accountNumber:decryptSellerPii(payout.bankSnapshot.accountNumber)}:null});
}));

module.exports=router;
