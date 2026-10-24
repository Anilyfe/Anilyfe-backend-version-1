const express=require('express');const crypto=require('crypto');const https=require('https');const rateLimit=require('express-rate-limit');const prisma=require('../lib/prisma');const {ok,fail,asyncHandler}=require('../lib/http');const {requireAuth,requireRole}=require('../middleware/auth');const {notify}=require('../lib/notifications');
const {pendingKeyFor,buildPaymentReference,claimProviderEvent,DEFAULT_ABANDONED_PAYMENT_MINUTES}=require('../lib/payment-integrity');
const {consumeReservations}=require('../lib/reservations');
const router=express.Router();
const bankLookupLimiter=rateLimit({windowMs:15*60*1000,limit:30,standardHeaders:'draft-8',legacyHeaders:false});
function paystack(path,method,data,token){return new Promise((resolve,reject)=>{const body=data?JSON.stringify(data):'';const r=https.request({hostname:'api.paystack.co',path,method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{let raw='';res.on('data',d=>raw+=d);res.on('end',()=>{try{const j=JSON.parse(raw);res.statusCode>=200&&res.statusCode<300?resolve(j):reject(new Error(j.message||'Paystack error'))}catch(e){reject(e)}})});r.on('error',reject);if(body)r.write(body);r.end()})}
function referenceToken(){return crypto.randomBytes(6).toString('hex').toUpperCase()}

async function consumeOrderInventory(tx,orderIds){
  const items=await tx.orderItem.findMany({where:{orderId:{in:orderIds}}});
  for(const item of items)if(item.variantId){const rows=await tx.$queryRawUnsafe('UPDATE "ProductVariant" SET "stock"="stock"-$1, "reserved"="reserved"-$1, "available"=("stock"-$1)>0, "updatedAt"=NOW() WHERE "id"=$2 AND "reserved">=$1 AND "stock">=$1 RETURNING "id"',item.quantity,item.variantId);if(!rows.length)throw Object.assign(new Error('Inventory reservation mismatch'),{code:'INVENTORY_MISMATCH'});}
  await consumeReservations(tx,orderIds);
}

async function flagDuplicateCharge(tx,{payment,orderIds=[],checkoutSessionId=null,reason}){
  const metadata={reference:payment.reference,amount:Number(payment.amount),currency:payment.currency,orderIds,checkoutSessionId,reason};
  await tx.auditLog.create({data:{action:'PAYMENT_DUPLICATE_CHARGE_DETECTED',targetType:'Payment',targetId:payment.id,metadata,ipAddress:null}});
  return metadata;
}

async function markPaid(reference,event){
  const payment=await prisma.payment.findUnique({where:{reference},include:{order:true,checkoutSession:true}});
  if(!payment)return {found:false};
  if(payment.checkoutSessionId)return markSessionPaid(payment,event);
  if(!payment.orderId||!payment.order)throw Object.assign(new Error('Payment must be associated with an order or checkout session.'),{code:'PAYMENT_ORDER_ASSOCIATION_INVALID'});
  const gatewayAmount=Number(event?.data?.amount||0);
  const gatewayCurrency=String(event?.data?.currency||'').toUpperCase();
  if(gatewayAmount!==Math.round(Number(payment.amount)*100)||gatewayCurrency!==payment.currency.toUpperCase())throw Object.assign(new Error('payment amount or currency mismatch'),{code:'AMOUNT_MISMATCH'});
  const result=await prisma.$transaction(async tx=>{
    const claimed=await tx.payment.updateMany({where:{id:payment.id,status:{in:['PENDING','FAILED']}},data:{status:'PAID',pendingKey:null,channel:event?.data?.channel||null,gatewayResponse:event?.data?.gateway_response||null,providerPayload:event||payment.providerPayload,paidAt:new Date()}});
    if(!claimed.count){const current=await tx.payment.findUnique({where:{id:payment.id},select:{status:true}});if(current?.status==='PAID')return {alreadyPaid:true};throw Object.assign(new Error('Payment is no longer pending.'),{code:'PAYMENT_NOT_PENDING'});}
    const orderClaim=await tx.order.updateMany({where:{id:payment.orderId,paymentStatus:'PENDING'},data:{paymentStatus:'PAID',orderStatus:'CONFIRMED',paidAt:new Date()}});
    if(!orderClaim.count){
      const metadata=await flagDuplicateCharge(tx,{payment,orderIds:[payment.orderId],reason:'The order was already settled by a different payment.'});
      return {alreadyPaid:false,duplicateCharge:true,metadata};
    }
    await tx.orderTimeline.create({data:{orderId:payment.orderId,status:'CONFIRMED',note:'Payment verified by Paystack.'}});
    await consumeOrderInventory(tx,[payment.orderId]);
    await tx.auditLog.create({data:{action:'PAYMENT_SETTLED',targetType:'Payment',targetId:payment.id,metadata:{orderId:payment.orderId,reference:payment.reference,amount:Number(payment.amount),currency:payment.currency}}});
    return {alreadyPaid:false};
  });
  if(result.duplicateCharge){
    await notify({audienceRole:'ADMIN',type:'PAYMENT_DUPLICATE_CHARGE',title:'Possible duplicate charge',message:`Payment ${payment.reference} settled for an order that was already paid. Manual reconciliation is required.`,data:{reference:payment.reference,orderId:payment.orderId,amount:Number(payment.amount)}});
    if(payment.order?.buyerId)await notify({userId:payment.order.buyerId,type:'PAYMENT_REVIEW',title:'Payment needs review',message:`We received an extra payment of ${payment.currency} ${Number(payment.amount).toFixed(2)} for order ${payment.order.orderNumber}. Support will review it and resolve the difference.`,data:{reference:payment.reference,orderId:payment.orderId}});
    return {found:true,...result};
  }
  if(!result.alreadyPaid)await notify({userId:payment.order.buyerId,type:'PAYMENT_SUCCESS',title:'Payment confirmed',message:`Payment for ${payment.order.orderNumber} was verified.`,data:{orderId:payment.orderId}});
  return {found:true,...result};
}

async function markSessionPaid(payment,event){
  const session=await prisma.checkoutSession.findUnique({where:{id:payment.checkoutSessionId},include:{buyer:true,orders:{include:{seller:true}}}});
  if(!session||!session.orders.length)throw Object.assign(new Error('Checkout session has no associated orders.'),{code:'CHECKOUT_ORDERS_MISSING'});
  const gatewayAmount=Number(event?.data?.amount||0);
  const gatewayCurrency=String(event?.data?.currency||'').toUpperCase();
  if(gatewayAmount!==Math.round(Number(payment.amount)*100)||gatewayCurrency!==payment.currency.toUpperCase())throw Object.assign(new Error('payment amount or currency mismatch'),{code:'AMOUNT_MISMATCH'});
  const result=await prisma.$transaction(async tx=>{
    const paidAt=new Date();
    const claimed=await tx.payment.updateMany({where:{id:payment.id,status:{in:['PENDING','FAILED']}},data:{status:'PAID',pendingKey:null,channel:event?.data?.channel||null,gatewayResponse:event?.data?.gateway_response||null,providerPayload:event||payment.providerPayload,paidAt}});
    if(!claimed.count){const current=await tx.payment.findUnique({where:{id:payment.id},select:{status:true}});if(current?.status==='PAID')return {alreadyPaid:true};throw Object.assign(new Error('Payment is no longer pending.'),{code:'PAYMENT_NOT_PENDING'});}
    const sessionClaim=await tx.checkoutSession.updateMany({where:{id:session.id,status:'PENDING_PAYMENT'},data:{status:'PAID',paidAt}});
    if(!sessionClaim.count){
      const orderIds=session.orders.map(order=>order.id);
      const metadata=await flagDuplicateCharge(tx,{payment,orderIds,checkoutSessionId:session.id,reason:'The checkout session was already settled by a different payment.'});
      return {alreadyPaid:false,duplicateCharge:true,metadata};
    }
    const orderIds=session.orders.map(order=>order.id);
    const orderClaim=await tx.order.updateMany({where:{id:{in:orderIds},paymentStatus:'PENDING'},data:{paymentStatus:'PAID',orderStatus:'CONFIRMED',paidAt}});
    if(orderClaim.count!==orderIds.length)throw Object.assign(new Error('One or more orders are no longer awaiting payment.'),{code:'ORDER_PAYMENT_STATE_CONFLICT'});
    await tx.orderTimeline.createMany({data:orderIds.map(orderId=>({orderId,status:'CONFIRMED',note:'Payment verified by Paystack.'}))});
    await consumeOrderInventory(tx,orderIds);
    await tx.auditLog.create({data:{action:'PAYMENT_SETTLED',targetType:'Payment',targetId:payment.id,metadata:{checkoutSessionId:session.id,orderIds,reference:payment.reference,amount:Number(payment.amount),currency:payment.currency}}});
    return {alreadyPaid:false};
  });
  if(result.duplicateCharge){
    await notify({audienceRole:'ADMIN',type:'PAYMENT_DUPLICATE_CHARGE',title:'Possible duplicate charge',message:`Payment ${payment.reference} settled for a checkout session that was already paid. Manual reconciliation is required.`,data:{reference:payment.reference,checkoutSessionId:session.id,amount:Number(payment.amount)}});
    if(session.buyerId)await notify({userId:session.buyerId,type:'PAYMENT_REVIEW',title:'Payment needs review',message:`We received an extra payment of ${payment.currency} ${Number(payment.amount).toFixed(2)}. Support will review it and resolve the difference.`,data:{reference:payment.reference,checkoutSessionId:session.id}});
    return {found:true,...result};
  }
  if(!result.alreadyPaid){
    await notify({userId:session.buyerId,type:'PAYMENT_SUCCESS',title:'Payment confirmed',message:`Payment for ${session.orders.length} seller orders was verified.`,data:{checkoutSessionId:session.id,orderIds:session.orders.map(order=>order.id)}});
    for(const order of session.orders)await notify({userId:order.seller.userId,type:'PAYMENT_SUCCESS',title:'Order payment confirmed',message:`Payment for order ${order.orderNumber} was verified.`,data:{orderId:order.id}});
  }
  return {found:true,...result};
}

async function markFailed(reference,event){
  const payment=await prisma.payment.findUnique({where:{reference},include:{order:true,checkoutSession:{include:{orders:true}}}});
  if(!payment)return {found:false};
  const result=await prisma.$transaction(async tx=>{
    const changed=await tx.payment.updateMany({where:{id:payment.id,status:'PENDING'},data:{status:'FAILED',pendingKey:null,gatewayResponse:event?.data?.gateway_response||event?.data?.message||'Payment failed',providerPayload:event||payment.providerPayload}});
    if(changed.count)await tx.auditLog.create({data:{action:'PAYMENT_FAILED',targetType:'Payment',targetId:payment.id,metadata:{orderId:payment.orderId,reference:payment.reference},ipAddress:null}});
    return {found:true,updated:changed.count===1};
  });
  if(result.updated)await notify({userId:payment.checkoutSession?.buyerId||payment.order?.buyerId,type:'PAYMENT_FAILED',title:'Payment was not completed',message:payment.checkoutSession?`Payment for ${payment.checkoutSession.orders.length} seller orders was not successful. You can retry checkout.`:`Payment for ${payment.order.orderNumber} was not successful. You can retry checkout.`,data:{orderId:payment.orderId,checkoutSessionId:payment.checkoutSessionId}});
  return result;
}

async function acquirePayment({orderId=null,checkoutSessionId=null,amount,currency,scope}){
  const pendingKey=pendingKeyFor({orderId,checkoutSessionId});
  if(!pendingKey)throw Object.assign(new Error('A payment must belong to an order or a checkout session.'),{code:'PAYMENT_ORDER_ASSOCIATION_INVALID'});
  const existing=await prisma.payment.findFirst({where:{pendingKey,status:'PENDING'},orderBy:{createdAt:'desc'}});
  if(existing)return {payment:existing,created:false};
  try{
    const payment=await prisma.payment.create({data:{orderId,checkoutSessionId,provider:'PAYSTACK',reference:buildPaymentReference(scope,referenceToken()),pendingKey,amount,currency,status:'PENDING'}});
    return {payment,created:true};
  }catch(error){
    if(error.code!=='P2002')throw error;
    const winner=await prisma.payment.findFirst({where:{pendingKey,status:'PENDING'},orderBy:{createdAt:'desc'}});
    if(winner)return {payment:winner,created:false};
    throw error;
  }
}

async function retireAbandonedPayment(payment,now=new Date()){
  const cutoff=new Date(now.getTime()-DEFAULT_ABANDONED_PAYMENT_MINUTES*60*1000);
  if(!payment.createdAt||new Date(payment.createdAt).getTime()>cutoff.getTime())return false;
  const changed=await prisma.payment.updateMany({where:{id:payment.id,status:'PENDING'},data:{status:'FAILED',pendingKey:null,gatewayResponse:'Payment was abandoned before it completed.'}});
  if(changed.count)await prisma.auditLog.create({data:{action:'PAYMENT_ABANDONED',targetType:'Payment',targetId:payment.id,metadata:{reference:payment.reference,orderId:payment.orderId,checkoutSessionId:payment.checkoutSessionId},ipAddress:null}});
  return changed.count>0;
}

async function initializePayment({orderId=null,checkoutSessionId=null,amount,currency,scope,email,metadata,callbackUrl}){
  let acquired=await acquirePayment({orderId,checkoutSessionId,amount,currency,scope});
  if(await retireAbandonedPayment(acquired.payment)){
    acquired=await acquirePayment({orderId,checkoutSessionId,amount,currency,scope});
  }
  const payment=acquired.payment;
  const stored=payment.providerPayload||null;
  if(stored&&stored.authorization_url)return {payment,reused:true,authorizationUrl:stored.authorization_url};
  if(!process.env.PAYSTACK_SECRET_KEY)return {payment,configurationRequired:true};
  const response=await paystack('/transaction/initialize','POST',{email,amount:Math.round(Number(amount)*100),currency,reference:payment.reference,metadata,callback_url:callbackUrl||undefined},process.env.PAYSTACK_SECRET_KEY);
  await prisma.payment.update({where:{id:payment.id},data:{providerPayload:response.data}});
  return {payment,authorizationUrl:response.data.authorization_url};
}

router.post('/initialize-session',requireAuth,requireRole('BUYER','SELLER'),asyncHandler(async(req,res)=>{
  const session=await prisma.checkoutSession.findUnique({where:{id:req.body?.checkoutSessionId},include:{buyer:true,orders:true}});
  if(!session||session.buyerId!==req.user.id)return fail(res,404,'CHECKOUT_SESSION_NOT_FOUND','Checkout session not found.');
  if(session.status==='PAID')return fail(res,409,'ALREADY_PAID','Checkout session is already paid.');
  if(session.status!=='PENDING_PAYMENT')return fail(res,409,'CHECKOUT_NOT_PAYABLE','Checkout session is not awaiting payment.');
  const result=await initializePayment({
    checkoutSessionId:session.id,amount:session.total,currency:session.currency,scope:session.reference,email:req.user.email,
    metadata:{checkoutSessionId:session.id,orderIds:session.orders.map(order=>order.id)},callbackUrl:process.env.PAYSTACK_CALLBACK_URL
  });
  if(result.configurationRequired)return ok(res,{provider:'PAYSTACK',reference:result.payment.reference,amount:Number(session.total),currency:session.currency,status:'configuration_required',message:'PAYSTACK_SECRET_KEY is not configured.'});
  return ok(res,{provider:'PAYSTACK',reference:result.payment.reference,checkoutSessionId:session.id,amount:Number(session.total),currency:session.currency,checkoutUrl:result.authorizationUrl,status:'initialized',reused:result.reused===true});
}));

router.post('/initialize',requireAuth,requireRole('BUYER','SELLER'),asyncHandler(async(req,res)=>{
  const {orderId}=req.body||{};
  const order=await prisma.order.findUnique({where:{id:orderId},include:{buyer:true}});
  if(!order||order.buyerId!==req.user.id)return fail(res,404,'ORDER_NOT_FOUND','Order not found.');
  if(order.paymentStatus==='PAID')return fail(res,409,'ALREADY_PAID','Order is already paid.');
  if(order.orderStatus!=='PENDING_PAYMENT')return fail(res,409,'ORDER_NOT_PAYABLE','Order is not awaiting payment.');
  const result=await initializePayment({
    orderId:order.id,amount:order.total,currency:order.currency,scope:order.orderNumber,email:req.user.email,
    metadata:{orderId:order.id,orderNumber:order.orderNumber},callbackUrl:process.env.PAYSTACK_CALLBACK_URL
  });
  if(result.configurationRequired)return ok(res,{provider:'PAYSTACK',reference:result.payment.reference,amount:Number(order.total),currency:order.currency,status:'configuration_required',message:'PAYSTACK_SECRET_KEY is not configured.'});
  return ok(res,{provider:'PAYSTACK',reference:result.payment.reference,amount:Number(order.total),currency:order.currency,checkoutUrl:result.authorizationUrl,status:'initialized',reused:result.reused===true});
}));

async function verifyPayment(req,res){
  const payment=await prisma.payment.findUnique({where:{reference:req.params.reference},include:{order:true,checkoutSession:true}});
  if(!payment)return fail(res,404,'PAYMENT_NOT_FOUND','Payment not found.');
  const ownerId=payment.checkoutSession?.buyerId||payment.order?.buyerId;
  if(!ownerId)return fail(res,409,'PAYMENT_ORDER_ASSOCIATION_INVALID','Payment is not linked to an order or checkout session.');
  if(ownerId!==req.user.id&&!['ADMIN','SUPER_ADMIN'].includes(req.user.role))return fail(res,403,'FORBIDDEN','You do not have access to this payment.');
  if(!process.env.PAYSTACK_SECRET_KEY)return fail(res,503,'PAYSTACK_NOT_CONFIGURED','Paystack is not configured.');
  const response=await paystack(`/transaction/verify/${encodeURIComponent(payment.reference)}`,'GET',null,process.env.PAYSTACK_SECRET_KEY);
  if(!response.data||response.data.status!=='success'){
    if(['failed','abandoned'].includes(String(response.data?.status||'').toLowerCase()))await markFailed(payment.reference,response);
    return fail(res,409,'PAYMENT_NOT_CONFIRMED','Paystack has not confirmed this payment.');
  }
  const result=await markPaid(payment.reference,response);
  return ok(res,{verified:true,...result,orderId:payment.orderId,checkoutSessionId:payment.checkoutSessionId});
}

router.post('/verify/:reference',requireAuth,asyncHandler(verifyPayment));
router.post('/verify-session/:reference',requireAuth,asyncHandler(verifyPayment));

router.get('/banks',requireAuth,requireRole('BUYER','SELLER'),bankLookupLimiter,asyncHandler(async(req,res)=>{if(!process.env.PAYSTACK_SECRET_KEY)return fail(res,503,'PAYSTACK_NOT_CONFIGURED','Paystack is not configured.');const response=await paystack('/bank?country=nigeria&perPage=100','GET',null,process.env.PAYSTACK_SECRET_KEY);return ok(res,(response.data||[]).map(({name,code})=>({name,code})))}));
router.get('/resolve-account',requireAuth,requireRole('BUYER','SELLER'),bankLookupLimiter,asyncHandler(async(req,res)=>{const number=String(req.query.account_number||''),bank=String(req.query.bank_code||'');if(!/^\d{10}$/.test(number)||!/^\d+$/.test(bank))return fail(res,400,'INVALID_BANK_DETAILS','A valid 10-digit account number and bank are required.');if(!process.env.PAYSTACK_SECRET_KEY)return fail(res,503,'PAYSTACK_NOT_CONFIGURED','Paystack is not configured.');const response=await paystack(`/bank/resolve?account_number=${encodeURIComponent(number)}&bank_code=${encodeURIComponent(bank)}`,'GET',null,process.env.PAYSTACK_SECRET_KEY);return ok(res,{accountName:response.data?.account_name,accountNumber:response.data?.account_number,bankCode:bank})}));

router.post('/webhook',express.raw({type:'application/json'}),asyncHandler(async(req,res)=>{
  const signature=req.headers['x-paystack-signature'];
  if(!process.env.PAYSTACK_SECRET_KEY||!signature||!Buffer.isBuffer(req.body))return res.status(400).send('invalid');
  const expected=crypto.createHmac('sha512',process.env.PAYSTACK_SECRET_KEY).update(req.body).digest('hex');
  const expectedBytes=Buffer.from(expected),suppliedBytes=Buffer.from(String(signature));
  if(expectedBytes.length!==suppliedBytes.length||!crypto.timingSafeEqual(expectedBytes,suppliedBytes))return res.status(401).send('invalid signature');
  let event;
  try{event=JSON.parse(req.body.toString());}
  catch{return res.status(400).send('invalid event payload');}
  const providerEventId=crypto.createHash('sha256').update(req.body).digest('hex');
  const claim=await claimProviderEvent(prisma,{provider:'PAYSTACK',providerEventId,eventType:String(event.event||'unknown'),reference:event.data?.reference||null,payload:event});
  if(!claim.owned)return res.status(200).send('ok');
  const paymentEvent=claim.paymentEvent;
  try{
    if(event.event==='charge.success'){
      const result=await markPaid(event.data?.reference,event);
      if(!result.found)throw Object.assign(new Error('Payment reference was not found.'),{code:'PAYMENT_NOT_FOUND'});
    }else if(['charge.failed','charge.abandoned'].includes(event.event)){
      const result=await markFailed(event.data?.reference,event);
      if(!result.found)throw Object.assign(new Error('Payment reference was not found.'),{code:'PAYMENT_NOT_FOUND'});
    }
    await prisma.paymentEvent.update({where:{id:paymentEvent.id},data:{processedAt:new Date(),processingError:null}});
    return res.status(200).send('ok');
  }catch(error){
    await prisma.paymentEvent.update({where:{id:paymentEvent.id},data:{processingError:String(error.message||error).slice(0,2000)}});
    if(error.code==='AMOUNT_MISMATCH')return res.status(400).send('amount or currency mismatch');
    if(error.code==='PAYMENT_NOT_FOUND')return res.status(404).send('payment not found');
    throw error;
  }
}));

router.get('/:reference',requireAuth,asyncHandler(async(req,res)=>{
  const payment=await prisma.payment.findUnique({where:{reference:req.params.reference},include:{order:true,checkoutSession:true}});
  if(!payment)return fail(res,404,'PAYMENT_NOT_FOUND','Payment not found.');
  const buyerId=payment.checkoutSession?.buyerId||payment.order?.buyerId;
  if(!['ADMIN','SUPER_ADMIN'].includes(req.user.role)&&buyerId!==req.user.id)return fail(res,403,'FORBIDDEN','You do not have access to this payment.');
  return ok(res,payment);
}));

module.exports=router;
