const express=require('express');
const https=require('https');
const crypto=require('crypto');
const prisma=require('../lib/prisma');
const {ok,fail,asyncHandler,decimal}=require('../lib/http');
const {requireAuth,requireRole}=require('../middleware/auth');
const {encryptSellerPii,decryptSellerPii}=require('../lib/seller-pii');
const {sellerWithdrawalBalance,buyerWalletBalance,withdrawalQuote}=require('../lib/withdrawal-balance');
const {claimProviderEvent}=require('../lib/payment-integrity');

const router=express.Router();

function paystackGet(path){
  return new Promise((resolve,reject)=>{
    const request=https.get({hostname:'api.paystack.co',path,headers:{Authorization:`******`}},response=>{
      let body='';
      response.setEncoding('utf8');
      response.on('data',chunk=>body+=chunk);
      response.on('end',()=>{
        try{
          const result=JSON.parse(body);
          if(response.statusCode<200||response.statusCode>=300||result.status!==true)return reject(Object.assign(new Error(result.message||'Paystack account verification failed.'),{code:'PAYOUT_ACCOUNT_UNVERIFIED'}));
          resolve(result.data);
        }catch(error){reject(error);}
      });
    });
    request.on('error',reject);
    request.setTimeout(10000,()=>request.destroy(new Error('Paystack account verification timed out.')));
  });
}

function paystackPost(path,data){
  return new Promise((resolve,reject)=>{
    const body=JSON.stringify(data);
    const request=https.request({hostname:'api.paystack.co',path,method:'POST',headers:{Authorization:`******`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},response=>{
      let raw='';
      response.setEncoding('utf8');
      response.on('data',chunk=>raw+=chunk);
      response.on('end',()=>{
        try{
          const result=JSON.parse(raw);
          if(response.statusCode<200||response.statusCode>=300||result.status!==true)return reject(Object.assign(new Error(result.message||'Paystack transfer request failed.'),{code:'PAYSTACK_TRANSFER_REJECTED'}));
          resolve(result.data);
        }catch(error){reject(error);}
      });
    });
    request.on('error',reject);
    request.setTimeout(15000,()=>request.destroy(Object.assign(new Error('Paystack transfer request timed out; transfer status must be reconciled before retrying.'),{code:'PAYSTACK_TRANSFER_UNCERTAIN'})));
    request.write(body);
    request.end();
  });
}

async function accountSnapshot(req,seller){
  let bankAccount;
  if(req.user.role==='SELLER'){
    const setting=await prisma.sellerSetting.findUnique({where:{sellerId:seller.id}});
    bankAccount=setting?.bankAccount;
    if(!bankAccount)return {error:['PAYOUT_ACCOUNT_REQUIRED','Add a verified bank account before requesting a withdrawal.']};
    try{
      bankAccount={...bankAccount,accountNumber:decryptSellerPii(bankAccount.accountNumber)};
    }catch(error){
      console.warn('Seller payout account could not be decrypted:',error.message);
      return {error:['SELLER_APPLICATION_STORAGE_UNAVAILABLE','Secure payout account storage is unavailable. Contact marketplace support.']};
    }
  }else{
    const {accountNumber,bankCode,bankName}=req.body||{};
    bankAccount={accountNumber,bankCode,bankName};
  }
  if(!/^\d{10}$/.test(String(bankAccount.accountNumber||''))||!/^\d+$/.test(String(bankAccount.bankCode||'')))return {error:['INVALID_BANK_DETAILS','Provide a valid 10-digit bank account number and bank code.']};
  if(!process.env.PAYSTACK_SECRET_KEY)return {error:['PAYSTACK_NOT_CONFIGURED','Paystack is required to verify the payout account.']};
  const verified=await paystackGet(`/bank/resolve?account_number=${encodeURIComponent(bankAccount.accountNumber)}&bank_code=${encodeURIComponent(bankAccount.bankCode)}`);
  if(String(verified.account_number||'')!==String(bankAccount.accountNumber)||!verified.account_name)return {error:['PAYOUT_ACCOUNT_UNVERIFIED','Paystack could not verify the payout account.']};
  try{
    return {snapshot:{bankName:String(bankAccount.bankName||''),bankCode:String(bankAccount.bankCode),accountName:verified.account_name,accountNumber:encryptSellerPii(bankAccount.accountNumber),verified:true}};
  }catch(error){
    if(error.code==='SELLER_PII_KEY_MISSING')return {error:['SELLER_APPLICATION_STORAGE_UNAVAILABLE','Secure payout account storage is not configured. Contact marketplace support.']};
    throw error;
  }
}

async function availableBalance(user,db=prisma){
  if(user.role==='SELLER'){
    const seller=await db.seller.findUnique({where:{userId:user.id}});
    if(!seller)return {error:['SELLER_NOT_FOUND','Seller profile not found.']};
    return {accountType:'SELLER',sellerId:seller.id,balance:(await sellerWithdrawalBalance(seller.id,db)).availableBalance};
  }
  return {accountType:'BUYER',sellerId:null,balance:await buyerWalletBalance(user.id,db)};
}

function withdrawalAccountType(row){
  if(row.accountType==='BUYER'||row.accountType==='SELLER')return row.accountType;
  return row.sellerId?'SELLER':'BUYER';
}

function maskedAccountNumber(value){
  if(!value)return null;
  try{
    const plain=decryptSellerPii(value);
    return `••••${String(plain).slice(-4)}`;
  }catch(error){
    console.warn('Withdrawal bank snapshot could not be decrypted:',error.message);
    return null;
  }
}

function bankSnapshotView(snapshot){
  return snapshot?{bankName:snapshot.bankName,bankCode:snapshot.bankCode,accountName:snapshot.accountName,accountNumber:maskedAccountNumber(snapshot.accountNumber)}:null;
}

function withdrawalSummary(row){
  return {id:row.id,accountType:withdrawalAccountType(row),requestedAmount:decimal(row.requestedAmount),feeAmount:decimal(row.feeAmount),netAmount:decimal(row.netAmount),currency:row.currency,status:row.status,transferReference:row.transferReference,createdAt:row.createdAt,processedAt:row.processedAt};
}

router.get('/quote',requireAuth,requireRole('BUYER','SELLER'),asyncHandler(async(req,res)=>{
  const amount=Number(req.query.amount);
  if(!Number.isFinite(amount)||amount<=0||Math.round(amount*100)!==amount*100)return fail(res,400,'INVALID_WITHDRAWAL_AMOUNT','Enter a positive amount with no more than two decimal places.');
  const account=await availableBalance(req.user);
  if(account.error)return fail(res,404,...account.error);
  let quote;
  try{quote=await withdrawalQuote(account.accountType,amount,prisma);}
  catch(error){if(error instanceof RangeError)return fail(res,400,'INVALID_WITHDRAWAL_AMOUNT',error.message);throw error;}
  return ok(res,{...quote,availableBalance:account.balance,currency:'NGN',sufficientBalance:amount<=account.balance});
}));

router.get('/',requireAuth,requireRole('BUYER','SELLER'),asyncHandler(async(req,res)=>{
  const where={userId:req.user.id};
  const rows=await prisma.withdrawalRequest.findMany({where,orderBy:{createdAt:'desc'}});
  return ok(res,rows.map(row=>({...withdrawalSummary(row),failureReason:row.failureReason,bankSnapshot:bankSnapshotView(row.bankSnapshot)})));
}));

router.post('/',requireAuth,requireRole('BUYER','SELLER'),asyncHandler(async(req,res)=>{
  const {amount,confirmed,idempotencyKey,expectedFeeAmount}=req.body||{};
  if(confirmed!==true)return fail(res,400,'CONFIRMATION_REQUIRED','Review the withdrawal amount, fee, and net amount, then confirm.');
  if(typeof idempotencyKey!=='string'||idempotencyKey.length<12||idempotencyKey.length>128)return fail(res,400,'IDEMPOTENCY_KEY_REQUIRED','A valid idempotency key is required.');
  const existing=await prisma.withdrawalRequest.findUnique({where:{idempotencyKey}});
  if(existing)return existing.userId===req.user.id?ok(res,withdrawalSummary(existing)):fail(res,409,'IDEMPOTENCY_KEY_REUSED','This idempotency key has already been used.');
  const account=await availableBalance(req.user);
  if(account.error)return fail(res,404,...account.error);
  const amountNumber=Number(amount);
  if(!Number.isFinite(amountNumber)||amountNumber<=0||Math.round(amountNumber*100)!==amountNumber*100)return fail(res,400,'INVALID_WITHDRAWAL_AMOUNT','Enter a positive amount with no more than two decimal places.');
  const quote=await withdrawalQuote(account.accountType,amountNumber,prisma);
  if(quote.netAmount<=0)return fail(res,400,'WITHDRAWAL_BELOW_FEE','Withdrawal must exceed the applicable fee.');
  if(!Number.isFinite(Number(expectedFeeAmount))||Number(expectedFeeAmount)!==quote.feeAmount)return fail(res,409,'WITHDRAWAL_QUOTE_STALE','The withdrawal fee changed. Review the refreshed quote and confirm again.');
  if(quote.requestedAmount>account.balance)return fail(res,400,'INSUFFICIENT_BALANCE','Requested withdrawal exceeds your available balance.');
  const bank=await accountSnapshot(req,account.sellerId?{id:account.sellerId}:null);
  if(bank.error)return fail(res,bank.error[0]==='PAYSTACK_NOT_CONFIGURED'?503:400,...bank.error);
  const reference=`ANLWD-${crypto.randomUUID()}`;
  let withdrawal;
  try{
    withdrawal=await prisma.$transaction(async tx=>{
      const existing=await tx.withdrawalRequest.findUnique({where:{idempotencyKey}});
      if(existing){
        if(existing.userId!==req.user.id)return {conflict:'IDEMPOTENCY_KEY_REUSED'};
        return {existing};
      }
      const current=await availableBalance(req.user,tx);
      if(current.error||quote.requestedAmount>current.balance)return {conflict:'INSUFFICIENT_BALANCE'};
      const created=await tx.withdrawalRequest.create({data:{
        userId:req.user.id,sellerId:account.sellerId,accountType:account.accountType,requestedAmount:quote.requestedAmount,
        feeAmount:quote.feeAmount,netAmount:quote.netAmount,currency:'NGN',idempotencyKey,transferReference:reference,
        bankSnapshot:bank.snapshot,status:'PENDING',provider:'PAYSTACK'
      }});
      await tx.financialLedgerEntry.createMany({data:[
        {userId:req.user.id,sellerId:account.sellerId,withdrawalId:created.id,entryType:'WITHDRAWAL_RESERVED',account:account.accountType==='BUYER'?'BUYER_AVAILABLE':'SELLER_AVAILABLE',direction:'DEBIT',amount:quote.requestedAmount,reference,idempotencyKey:`${idempotencyKey}:reserve`,metadata:{requestedAmount:quote.requestedAmount}},
        {userId:req.user.id,sellerId:account.sellerId,withdrawalId:created.id,entryType:'WITHDRAWAL_FEE',account:'PLATFORM_REVENUE',direction:'CREDIT',amount:quote.feeAmount,reference,idempotencyKey:`${idempotencyKey}:fee`,metadata:{accountType:account.accountType}},
        {userId:req.user.id,sellerId:account.sellerId,withdrawalId:created.id,entryType:'WITHDRAWAL_NET',account:'PAYOUT_PAYABLE',direction:'CREDIT',amount:quote.netAmount,reference,idempotencyKey:`${idempotencyKey}:net`,metadata:{netAmount:quote.netAmount}}
      ]});
      await tx.auditLog.create({data:{actorUserId:req.user.id,action:'WITHDRAWAL_REQUESTED',targetType:'WithdrawalRequest',targetId:created.id,metadata:{requestedAmount:quote.requestedAmount,feeAmount:quote.feeAmount,netAmount:quote.netAmount,reference},ipAddress:req.ip}});
      return {created};
    },{isolationLevel:'Serializable'});
  }catch(error){
    if(error.code==='P2002'){
      const existing=await prisma.withdrawalRequest.findUnique({where:{idempotencyKey}});
      if(existing?.userId===req.user.id)return ok(res,withdrawalSummary(existing),200);
    }
    throw error;
  }
  if(withdrawal.conflict==='IDEMPOTENCY_KEY_REUSED')return fail(res,409,'IDEMPOTENCY_KEY_REUSED','This idempotency key has already been used.');
  if(withdrawal.conflict)return fail(res,409,'INSUFFICIENT_BALANCE','Available balance changed. Refresh the quote and try again.');
  return ok(res,withdrawalSummary(withdrawal.created),201);
}));

async function settleWithdrawal(reference,success,event){
  const withdrawal=await prisma.withdrawalRequest.findUnique({where:{transferReference:reference}});
  if(!withdrawal)return {found:false};
  return prisma.$transaction(async tx=>{
    const status=success?'COMPLETED':'FAILED';
    const changed=await tx.withdrawalRequest.updateMany({where:{id:withdrawal.id,status:'PROCESSING'},data:{
      status,processedAt:new Date(),failureReason:success?null:String(event?.data?.reason||event?.message||'Transfer failed').slice(0,1000),
      transferFeeAmount:success?Math.max(0,Number(event?.data?.fees||0)/100):0,providerResponse:event||undefined
    }});
    if(!changed.count){
      const current=await tx.withdrawalRequest.findUnique({where:{id:withdrawal.id},select:{status:true}});
      return {found:true,alreadyProcessed:['COMPLETED','FAILED'].includes(current?.status),status:current?.status};
    }
    const transferFee=success?Math.max(0,Number(event?.data?.fees||0)/100):0;
    if(success){
      await tx.financialLedgerEntry.createMany({data:[
        {userId:withdrawal.userId,sellerId:withdrawal.sellerId,withdrawalId:withdrawal.id,entryType:'WITHDRAWAL_NET_PAID',account:'PAYOUT_PAYABLE',direction:'DEBIT',amount:withdrawal.netAmount,reference,idempotencyKey:`${withdrawal.idempotencyKey}:net-paid`,metadata:{provider:'PAYSTACK'}},
        ...(transferFee>0?[{userId:withdrawal.userId,sellerId:withdrawal.sellerId,withdrawalId:withdrawal.id,entryType:'WITHDRAWAL_TRANSFER_COST',account:'PLATFORM_REVENUE',direction:'DEBIT',amount:transferFee,reference,idempotencyKey:`${withdrawal.idempotencyKey}:transfer-cost`,metadata:{provider:'PAYSTACK'}}]:[])
      ]});
    }else{
      const account=withdrawal.accountType==='BUYER'?'BUYER_AVAILABLE':'SELLER_AVAILABLE';
      await tx.financialLedgerEntry.createMany({data:[
        {userId:withdrawal.userId,sellerId:withdrawal.sellerId,withdrawalId:withdrawal.id,entryType:'WITHDRAWAL_FAILED_RESTORATION',account,direction:'CREDIT',amount:withdrawal.requestedAmount,reference,idempotencyKey:`${withdrawal.idempotencyKey}:restore`,metadata:{reason:event?.data?.reason||event?.message||'Transfer failed'}},
        {userId:withdrawal.userId,sellerId:withdrawal.sellerId,withdrawalId:withdrawal.id,entryType:'WITHDRAWAL_FEE_REVERSAL',account:'PLATFORM_REVENUE',direction:'DEBIT',amount:withdrawal.feeAmount,reference,idempotencyKey:`${withdrawal.idempotencyKey}:fee-reversal`},
        {userId:withdrawal.userId,sellerId:withdrawal.sellerId,withdrawalId:withdrawal.id,entryType:'WITHDRAWAL_NET_REVERSAL',account:'PAYOUT_PAYABLE',direction:'DEBIT',amount:withdrawal.netAmount,reference,idempotencyKey:`${withdrawal.idempotencyKey}:net-reversal`}
      ]});
    }
    await tx.auditLog.create({data:{action:success?'WITHDRAWAL_COMPLETED':'WITHDRAWAL_FAILED',targetType:'WithdrawalRequest',targetId:withdrawal.id,metadata:{reference,status,transferFee},ipAddress:null}});
    return {found:true,status};
  },{isolationLevel:'Serializable'});
}

router.post('/webhook',express.raw({type:'application/json'}),asyncHandler(async(req,res)=>{
  const signature=req.headers['x-paystack-signature'];
  if(!process.env.PAYSTACK_SECRET_KEY||!signature||!Buffer.isBuffer(req.body))return res.status(400).send('invalid');
  const expected=crypto.createHmac('sha512',process.env.PAYSTACK_SECRET_KEY).update(req.body).digest('hex');
  const expectedBytes=Buffer.from(expected);
  const suppliedBytes=Buffer.from(String(signature));
  if(expectedBytes.length!==suppliedBytes.length||!crypto.timingSafeEqual(expectedBytes,suppliedBytes))return res.status(401).send('invalid signature');
  const event=JSON.parse(req.body.toString());
  if(!['transfer.success','transfer.failed','transfer.reversed'].includes(event.event))return res.status(200).send('ignored');
  const reference=event.data?.reference;
  if(!reference)return res.status(400).send('missing reference');
  const providerEventId=crypto.createHash('sha256').update(req.body).digest('hex');
  const claim=await claimProviderEvent(prisma,{provider:'PAYSTACK',providerEventId,eventType:event.event,reference,payload:event});
  if(!claim.owned)return res.status(200).send('ok');
  const existing=claim.paymentEvent;
  try{
    if(event.event==='transfer.reversed'){
      const reversal=await prisma.$transaction(async tx=>{
        const withdrawal=await tx.withdrawalRequest.findUnique({where:{transferReference:reference}});
        if(!withdrawal)return null;
        const changed=await tx.withdrawalRequest.updateMany({where:{id:withdrawal.id,status:'COMPLETED'},data:{status:'REVERSED',failureReason:'Paystack reversed the transfer.'}});
        if(!changed.count)return {withdrawal,changed:false};
        const account=withdrawal.accountType==='BUYER'?'BUYER_AVAILABLE':'SELLER_AVAILABLE';
        await tx.financialLedgerEntry.createMany({data:[
          {userId:withdrawal.userId,sellerId:withdrawal.sellerId,withdrawalId:withdrawal.id,entryType:'WITHDRAWAL_REVERSED_RESTORATION',account,direction:'CREDIT',amount:withdrawal.requestedAmount,reference,idempotencyKey:`${withdrawal.idempotencyKey}:reversed-restore`,metadata:{provider:'PAYSTACK'}},
          {userId:withdrawal.userId,sellerId:withdrawal.sellerId,withdrawalId:withdrawal.id,entryType:'WITHDRAWAL_REVERSED_FEE',account:'PLATFORM_REVENUE',direction:'DEBIT',amount:withdrawal.feeAmount,reference,idempotencyKey:`${withdrawal.idempotencyKey}:reversed-fee`},
          {userId:withdrawal.userId,sellerId:withdrawal.sellerId,withdrawalId:withdrawal.id,entryType:'WITHDRAWAL_REVERSED_NET',account:'PAYOUT_PAYABLE',direction:'CREDIT',amount:withdrawal.netAmount,reference,idempotencyKey:`${withdrawal.idempotencyKey}:reversed-net`}
        ]});
        await tx.auditLog.create({data:{action:'WITHDRAWAL_TRANSFER_REVERSED',targetType:'WithdrawalRequest',targetId:withdrawal.id,metadata:{reference,event:event.data},ipAddress:null}});
        return {withdrawal,changed:true};
      },{isolationLevel:'Serializable'});
      if(!reversal)return res.status(404).send('withdrawal not found');
      if(reversal.changed)await prisma.notification.create({data:{audienceRole:'ADMIN',type:'WITHDRAWAL_TRANSFER_REVERSED',title:'Withdrawal transfer reversed',message:`Paystack reversed withdrawal ${reversal.withdrawal.id}; the requested funds were restored for review.`,data:{reference,withdrawalId:reversal.withdrawal.id}}});
      await prisma.paymentEvent.update({where:{id:existing.id},data:{processedAt:new Date(),processingError:null}});
      return res.status(200).send('ok');
    }
    const settled=await settleWithdrawal(reference,event.event==='transfer.success',event);
    if(!settled.found)return res.status(404).send('withdrawal not found');
    await prisma.paymentEvent.update({where:{id:existing.id},data:{processedAt:new Date(),processingError:null}});
    const target=await prisma.withdrawalRequest.findUnique({where:{transferReference:reference},select:{id:true,userId:true,status:true}});
    if(target)await prisma.notification.create({data:{userId:target.userId,type:'WITHDRAWAL_STATUS',title:'Withdrawal updated',message:`Your withdrawal is ${target.status.toLowerCase()}.`,data:{withdrawalId:target.id,status:target.status}}});
    return res.status(200).send('ok');
  }catch(error){
    await prisma.paymentEvent.update({where:{id:existing.id},data:{processingError:String(error.message||error).slice(0,2000)}});
    throw error;
  }
}));

router.get('/admin',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>{
  const rows=await prisma.withdrawalRequest.findMany({include:{user:{select:{id:true,email:true,firstName:true,lastName:true}},seller:{select:{id:true,businessName:true}}},orderBy:{createdAt:'desc'}});
  const summary=rows.reduce((totals,row)=>{
    totals.totalWithdrawalAmount+=decimal(row.requestedAmount);
    totals.transferCosts+=decimal(row.transferFeeAmount);
    if(row.status==='PENDING'||row.status==='PROCESSING')totals.pending++;
    if(row.status==='COMPLETED'){
      totals.successful++;
      totals.feesCollected[withdrawalAccountType(row)]+=decimal(row.feeAmount);
    }
    if(row.status==='FAILED')totals.failed++;
    return totals;
  },{pending:0,successful:0,failed:0,totalWithdrawalAmount:0,transferCosts:0,feesCollected:{BUYER:0,SELLER:0}});
  summary.netFeeRevenue=summary.feesCollected.BUYER+summary.feesCollected.SELLER-summary.transferCosts;
  const withdrawals=rows.map(row=>({...withdrawalSummary(row),user:row.user,seller:row.seller,transferFeeAmount:decimal(row.transferFeeAmount),failureReason:row.failureReason,bankSnapshot:bankSnapshotView(row.bankSnapshot)}));
  return ok(res,{summary,withdrawals});
}));

router.post('/admin/:id/process',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>{
  if(process.env.PAYSTACK_TRANSFER_ENABLED!=='true')return fail(res,503,'PAYOUTS_DISABLED','Paystack transfers are disabled until payout-provider and business approvals are confirmed.');
  if(!process.env.PAYSTACK_SECRET_KEY)return fail(res,503,'PAYSTACK_NOT_CONFIGURED','Paystack is not configured.');
  const withdrawal=await prisma.withdrawalRequest.findUnique({where:{id:req.params.id}});
  if(!withdrawal)return fail(res,404,'WITHDRAWAL_NOT_FOUND','Withdrawal not found.');
  if(withdrawal.status!=='PENDING')return fail(res,409,'WITHDRAWAL_NOT_PENDING','Only a pending withdrawal can be submitted for transfer.');
  const claim=await prisma.$transaction(async tx=>{
    const current=await tx.withdrawalRequest.findUnique({where:{id:withdrawal.id}});
    if(!current||current.status!=='PENDING')return {conflict:true};
    if(current.sellerId){
      const eligible=await sellerWithdrawalBalance(current.sellerId,tx,new Date(),{excludeWithdrawalId:current.id});
      if(decimal(current.requestedAmount)>eligible.availableBalance)return {blocked:true};
    }
    const changed=await tx.withdrawalRequest.updateMany({where:{id:current.id,status:'PENDING'},data:{status:'PROCESSING'}});
    return changed.count?{claimed:true}:{conflict:true};
  },{isolationLevel:'Serializable'});
  if(claim.blocked)return fail(res,409,'PAYOUT_ON_HOLD','Current delivery, dispute, refund, or administrative holds make this withdrawal ineligible. The request remains pending.');
  if(claim.conflict)return fail(res,409,'WITHDRAWAL_ALREADY_PROCESSING','Withdrawal status changed; refresh before retrying.');
  try{
    const accountNumber=decryptSellerPii(withdrawal.bankSnapshot.accountNumber);
    let recipientCode=withdrawal.providerRecipientCode;
    let recipientData=null;
    if(!recipientCode){
      recipientData=await paystackPost('/transferrecipient',{type:'nuban',name:withdrawal.bankSnapshot.accountName,account_number:accountNumber,bank_code:withdrawal.bankSnapshot.bankCode,currency:withdrawal.currency,description:`ANILyfe withdrawal ${withdrawal.id}`});
      recipientCode=recipientData.recipient_code;
      await prisma.withdrawalRequest.update({where:{id:withdrawal.id},data:{providerRecipientCode:recipientCode,providerResponse:recipientData}});
    }
    const transfer=await paystackPost('/transfer',{source:'balance',amount:Math.round(Number(withdrawal.netAmount)*100),recipient:recipientCode,reason:`ANILyfe withdrawal ${withdrawal.id}`,reference:withdrawal.transferReference});
    const updated=await prisma.withdrawalRequest.update({where:{id:withdrawal.id},data:{providerResponse:transfer}});
    await prisma.auditLog.create({data:{actorUserId:req.user.id,action:'WITHDRAWAL_TRANSFER_INITIATED',targetType:'WithdrawalRequest',targetId:updated.id,metadata:{reference:updated.transferReference,transferCode:transfer.transfer_code||null},ipAddress:req.ip}});
    return ok(res,{id:updated.id,status:updated.status,reference:updated.transferReference,providerStatus:transfer.status||'queued'});
  }catch(error){
    if(error.code==='PAYSTACK_TRANSFER_REJECTED'){
      await settleWithdrawal(withdrawal.transferReference,false,{message:error.message});
      return fail(res,502,error.code,error.message);
    }
    throw error;
  }
}));

router.get('/admin/disputes',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>{
  try{
    const disputes=await prisma.dispute.findMany({include:{order:{select:{id:true,orderNumber:true,total:true,orderStatus:true,paymentStatus:true,seller:{select:{id:true,businessName:true}}}},openedBy:{select:{id:true,email:true,firstName:true,lastName:true}}},orderBy:{createdAt:'asc'}});
    return ok(res,disputes);
  }catch(error){
    const schemaMismatch=error?.code==='P2021'||error?.code==='P2022'||/does not exist|unknown arg|Unknown field/i.test(String(error?.message||''));
    if(!schemaMismatch)throw error;
    console.warn('Admin disputes are unavailable until the dispute schema is migrated:',error.message);
    return ok(res,[]);
  }
}));

router.patch('/admin/disputes/:id',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>{
  const {resolution,status}=req.body||{};
  if(typeof resolution!=='string'||resolution.trim().length<10||resolution.trim().length>2000)return fail(res,400,'INVALID_DISPUTE_RESOLUTION','Provide a resolution between 10 and 2,000 characters.');
  if(!['RESOLVED','DISMISSED'].includes(status))return fail(res,400,'INVALID_DISPUTE_STATUS','Dispute status must be RESOLVED or DISMISSED.');
  const dispute=await prisma.$transaction(async tx=>{
    const current=await tx.dispute.findUnique({where:{id:req.params.id},include:{order:true}});
    if(!current)return null;
    if(['RESOLVED','CLOSED','DISMISSED'].includes(current.status))throw Object.assign(new Error('This dispute has already been resolved.'),{code:'DISPUTE_ALREADY_RESOLVED'});
    const updated=await tx.dispute.update({where:{id:current.id},data:{status,resolution:resolution.trim(),resolvedByUserId:req.user.id,resolvedAt:new Date()}});
    const remaining=await tx.dispute.count({where:{orderId:current.orderId,status:{notIn:['RESOLVED','CLOSED','DISMISSED']}}});
    if(!remaining)await tx.order.update({where:{id:current.orderId},data:{payoutHoldReason:null}});
    await tx.auditLog.create({data:{actorUserId:req.user.id,action:'ORDER_DISPUTE_RESOLVED',targetType:'Dispute',targetId:current.id,metadata:{status,orderId:current.orderId},ipAddress:req.ip}});
    return updated;
  });
  if(!dispute)return fail(res,404,'DISPUTE_NOT_FOUND','Dispute not found.');
  return ok(res,dispute);
}));

module.exports=router;
