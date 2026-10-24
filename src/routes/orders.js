const express=require('express'); const crypto=require('crypto'); const prisma=require('../lib/prisma'); const {ok,fail,asyncHandler,decimal}=require('../lib/http'); const {requireAuth,requireRole}=require('../middleware/auth'); const {calculateSellerTotals}=require('../lib/pricing'); const {notify}=require('../lib/notifications'); const {audit}=require('../lib/audit');
const router=express.Router();
const {getPayoutReleaseHours}=require('../lib/withdrawal-balance');
const {getReservationTtlMinutes,reservationExpiry}=require('../lib/reservations');
function out(o){return {...o,subtotal:decimal(o.subtotal),shipping:decimal(o.shipping),buyerFees:decimal(o.buyerFees),commissionRate:decimal(o.commissionRate),commissionAmount:decimal(o.commissionAmount),sellerEarnings:decimal(o.sellerEarnings),total:decimal(o.total),items:o.items?.map(i=>({...i,unitPrice:decimal(i.unitPrice),discount:decimal(i.discount),lineTotal:decimal(i.lineTotal)}))}}
async function loadCheckoutCart(userId){return prisma.cart.findUnique({where:{userId},include:{items:{include:{product:{include:{images:true,seller:{include:{settings:true}}}},variant:true}}}})}
async function sellerTotals(seller,items,state){const foundingProductCount=await prisma.product.count({where:{sellerId:seller.id,status:{in:['PUBLISHED','APPROVED','OUT_OF_STOCK']}}});return calculateSellerTotals(seller,items,state,{foundingProductCount})}
async function checkoutQuote(req){const {state}=req.body||{};if(!state)return {error:['DELIVERY_REQUIRED','State is required to calculate shipping.']};const c=await loadCheckoutCart(req.user.id);if(!c||!c.items.length)return {error:['CART_EMPTY','Your cart is empty.']};for(const i of c.items){if(!i.variant||i.variant.stock-i.variant.reserved<i.quantity)return {error:['INSUFFICIENT_STOCK',`Insufficient stock for ${i.product.name}.`]};if(!['PUBLISHED','APPROVED'].includes(i.product.status)||i.product.seller.status!=='APPROVED')return {error:['PRODUCT_NOT_AVAILABLE',`${i.product.name} is no longer available.`]}}const groups={};for(const i of c.items)(groups[i.product.sellerId]??=[]).push(i);const quotes=[];for(const [sellerId,items] of Object.entries(groups)){const seller=items[0].product.seller;quotes.push({sellerId,businessName:seller.businessName,itemCount:items.length,...await sellerTotals(seller,items,state)})}return {currency:'NGN',sellerCount:quotes.length,quotes,total:quotes.reduce((n,q)=>n+q.total,0)}}
router.post('/quote',requireAuth,requireRole('BUYER','SELLER'),asyncHandler(async(req,res)=>{const q=await checkoutQuote(req);if(q.error)return fail(res,400,q.error[0],q.error[1]);return ok(res,q)}));

async function createOrder(req){
  const {state,city,lga,addressLine,country='Nigeria',recipientName,recipientPhone}=req.body||{};
  if(!state||!city||!addressLine)return {error:['DELIVERY_REQUIRED','State, city and delivery address are required.']};
  const cart=await loadCheckoutCart(req.user.id);
  if(!cart||!cart.items.length)return {error:['CART_EMPTY','Your cart is empty.']};
  for(const item of cart.items){
    if(!item.variant||item.variant.stock-item.variant.reserved<item.quantity)return {error:['INSUFFICIENT_STOCK',`Insufficient stock for ${item.product.name}.`]};
    if(!['PUBLISHED','APPROVED'].includes(item.product.status)||item.product.seller.status!=='APPROVED')return {error:['PRODUCT_NOT_AVAILABLE',`${item.product.name} is no longer available.`]};
  }
  const groups=new Map();
  for(const item of cart.items){
    const group=groups.get(item.product.sellerId)||{seller:item.product.seller,items:[]};
    group.items.push(item);
    groups.set(item.product.sellerId,group);
  }
  const allocations=[];
  for(const [sellerId,group] of groups)allocations.push({sellerId,...group,totals:await sellerTotals(group.seller,group.items,state)});
  const total=allocations.reduce((sum,allocation)=>sum+Number(allocation.totals.total),0);
  const reservationTtlMinutes=await getReservationTtlMinutes(prisma);
  const reservationExpiresAt=reservationExpiry(new Date(),reservationTtlMinutes);
  const created=await prisma.$transaction(async tx=>{
    const address=await tx.deliveryAddress.create({data:{userId:req.user.id,country,state,city,lga,addressLine,recipientName,recipientPhone}});
    let checkoutSession=null;
    if(allocations.length>1)checkoutSession=await tx.checkoutSession.create({data:{
      buyerId:req.user.id,reference:`ANL-CS-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID()}`,currency:'NGN',total,
      deliverySnapshot:{country,state,city,lga,addressLine,recipientName,recipientPhone}
    }});
    const orders=[];
    for(const allocation of allocations){
      const {seller,items,sellerId,totals}=allocation;
      const orderNumber=`ANL-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
      const order=await tx.order.create({data:{
        orderNumber,buyerId:req.user.id,sellerId,deliveryAddressId:address.id,currency:'NGN',...totals,
        paymentStatus:'PENDING',orderStatus:'PENDING_PAYMENT',checkoutSessionId:checkoutSession?.id||null,
        deliverySnapshot:{country,state,city,lga,addressLine,recipientName,recipientPhone},
        buyerSnapshot:{id:req.user.id,email:req.user.email,firstName:req.user.firstName,lastName:req.user.lastName},
        sellerSnapshot:{id:seller.id,businessName:seller.businessName},
        items:{create:items.map(item=>({productId:item.productId,variantId:item.variantId,productNameSnapshot:item.product.name,sellerNameSnapshot:seller.businessName,skuSnapshot:item.variant.sku,imageSnapshot:item.product.images?.[0]?.url||null,quantity:item.quantity,unitPrice:item.unitPrice,discount:item.product.discount,lineTotal:Number(item.unitPrice)*item.quantity,productSnapshot:{id:item.product.id,name:item.product.name,price:Number(item.product.price),salePrice:Number(item.product.salePrice),images:item.product.images}}))},
        timeline:{create:{status:'PENDING_PAYMENT',note:'Order created; awaiting payment.'}}
      },include:{items:true,timeline:true}});
      orders.push(order);
      for(const item of items){
        const rows=await tx.$queryRawUnsafe('UPDATE "ProductVariant" SET "reserved"="reserved"+$1, "updatedAt"=NOW() WHERE "id"=$2 AND "stock"-"reserved">=$1 RETURNING "id"',item.quantity,item.variantId);
        if(!rows.length)throw Object.assign(new Error('Insufficient stock'),{code:'INSUFFICIENT_STOCK'});
        await tx.stockReservation.create({data:{orderId:order.id,variantId:item.variantId,quantity:item.quantity,status:'HELD',expiresAt:reservationExpiresAt}});
      }
    }
    await tx.cartItem.deleteMany({where:{cartId:cart.id}});
    return {orders,checkoutSession};
  },{isolationLevel:'Serializable'});
  for(let index=0;index<created.orders.length;index++){
    const order=created.orders[index];
    const allocation=allocations[index];
    await Promise.all([
      notify({userId:allocation.seller.userId,type:'NEW_ORDER',title:'New order',message:`Order ${order.orderNumber} was placed and is awaiting payment.`,data:{orderId:order.id,checkoutSessionId:created.checkoutSession?.id}}),
      notify({audienceRole:'ADMIN',type:'NEW_ORDER',title:'New marketplace order',message:`Order ${order.orderNumber} was created.`,data:{orderId:order.id}})
    ]);
  }
  await notify({userId:req.user.id,type:'ORDER_CREATED',title:'Order created',message:created.orders.length>1?`${created.orders.length} seller orders are awaiting payment.`:`Your order ${created.orders[0].orderNumber} is awaiting payment.`,data:{orderIds:created.orders.map(order=>order.id),checkoutSessionId:created.checkoutSession?.id}});
  const orders=await prisma.order.findMany({where:{id:{in:created.orders.map(order=>order.id)}},include:{items:true,timeline:true,payments:true},orderBy:{createdAt:'asc'}});
  return {orders,checkoutSession:created.checkoutSession,total};
}
router.post('/',requireAuth,requireRole('BUYER','SELLER'),asyncHandler(async(req,res)=>{
  const result=await createOrder(req);
  if(result.error)return fail(res,400,result.error[0],result.error[1]);
  if(result.orders.length===1)return ok(res,out(result.orders[0]),201);
  return ok(res,{checkoutSession:result.checkoutSession,orders:result.orders.map(out),total:result.total,currency:'NGN'},201);
}));
router.get('/',requireAuth,asyncHandler(async(req,res)=>{const where=['ADMIN','SUPER_ADMIN'].includes(req.user.role)?{}:req.user.role==='SELLER'?{seller:{userId:req.user.id}}:{buyerId:req.user.id};const rows=await prisma.order.findMany({where,include:{items:true,timeline:{orderBy:{createdAt:'asc'}},payments:true},orderBy:{createdAt:'desc'}});return ok(res,rows.map(out))}));
router.get('/:id',requireAuth,asyncHandler(async(req,res)=>{const o=await prisma.order.findUnique({where:{id:req.params.id},include:{items:true,timeline:{orderBy:{createdAt:'asc'}},payments:true,refund:true,seller:true}});if(!o)return fail(res,404,'ORDER_NOT_FOUND','Order not found.');const allowed=['ADMIN','SUPER_ADMIN'].includes(req.user.role)||o.buyerId===req.user.id||(req.user.role==='SELLER'&&o.seller?.userId===req.user.id);if(!allowed)return fail(res,403,'FORBIDDEN','You do not have access to this order.');return ok(res,out(o))}));
router.patch('/:id/status',requireAuth,requireRole('SELLER'),asyncHandler(async(req,res)=>{const {status,note}=req.body||{};const transitions={CONFIRMED:['PROCESSING'],PROCESSING:['READY_TO_SHIP'],READY_TO_SHIP:['SHIPPED'],SHIPPED:['DELIVERED']};if(!['CONFIRMED','PROCESSING','READY_TO_SHIP','SHIPPED','DELIVERED'].includes(status))return fail(res,400,'INVALID_ORDER_STATUS','Seller cannot set this order status.');const o=await prisma.order.findUnique({where:{id:req.params.id},include:{seller:true}});if(!o||o.seller.userId!==req.user.id)return fail(res,404,'ORDER_NOT_FOUND','Order not found.');if(o.paymentStatus!=='PAID')return fail(res,409,'PAYMENT_REQUIRED','Order must be paid before fulfillment.');if(o.orderStatus==='PENDING_PAYMENT')return fail(res,409,'INVALID_ORDER_STATUS','Paid orders are confirmed automatically.');if(o.orderStatus!==status&&!(transitions[o.orderStatus]||[]).includes(status))return fail(res,409,'INVALID_ORDER_TRANSITION',`Cannot change order from ${o.orderStatus} to ${status}.`);const updated=await prisma.$transaction(async tx=>{const x=await tx.order.update({where:{id:o.id},data:{orderStatus:status}});await tx.orderTimeline.create({data:{orderId:o.id,status,note:note||null,actorUserId:req.user.id}});return x});await notify({userId:o.buyerId,type:'ORDER_STATUS',title:`Order ${status.toLowerCase().replaceAll('_',' ')}`,message:`Order ${o.orderNumber} is now ${status}.`,data:{orderId:o.id,status}});await audit(req,'ORDER_STATUS_UPDATED','Order',o.id,{status});return ok(res,out(updated))}));
router.post('/:id/confirm-delivery',requireAuth,requireRole('BUYER'),asyncHandler(async(req,res)=>{
  const order=await prisma.order.findUnique({where:{id:req.params.id},include:{seller:true,disputes:{where:{status:{notIn:['RESOLVED','CLOSED','DISMISSED']}},select:{id:true}}}});
  if(!order||order.buyerId!==req.user.id)return fail(res,404,'ORDER_NOT_FOUND','Order not found.');
  if(order.paymentStatus!=='PAID'||order.orderStatus!=='DELIVERED')return fail(res,409,'DELIVERY_NOT_READY','Delivery can only be confirmed for a paid order marked delivered by its seller.');
  if(order.disputes.length)return fail(res,409,'ORDER_HAS_OPEN_DISPUTE','Resolve the open dispute before confirming delivery.');
  if(order.deliveryConfirmedAt)return ok(res,{orderId:order.id,deliveryConfirmedAt:order.deliveryConfirmedAt,payoutEligibleAt:order.payoutEligibleAt});
  const confirmedAt=new Date();
  const releaseSettings=await getPayoutReleaseHours(prisma);
  const releaseHours=order.seller.foundingPayoutBenefit?releaseSettings.founding:releaseSettings.standard;
  const payoutEligibleAt=new Date(confirmedAt.getTime()+releaseHours*60*60*1000);
  const result=await prisma.$transaction(async tx=>{
    const changed=await tx.order.updateMany({where:{id:order.id,buyerId:req.user.id,orderStatus:'DELIVERED',deliveryConfirmedAt:null},data:{deliveryConfirmedAt:confirmedAt,payoutEligibleAt,payoutHoldReason:null}});
    if(!changed.count)throw Object.assign(new Error('Delivery confirmation was already recorded or the order changed.'),{code:'DELIVERY_CONFIRMATION_CONFLICT'});
    await tx.orderTimeline.create({data:{orderId:order.id,status:'DELIVERED',note:'Buyer confirmed delivery.',actorUserId:req.user.id}});
    await tx.auditLog.create({data:{actorUserId:req.user.id,action:'DELIVERY_CONFIRMED',targetType:'Order',targetId:order.id,metadata:{deliveryConfirmedAt:confirmedAt.toISOString(),payoutEligibleAt:payoutEligibleAt.toISOString(),releaseHours},ipAddress:req.ip}});
    return {orderId:order.id,deliveryConfirmedAt:confirmedAt,payoutEligibleAt};
  });
  await notify({userId:order.seller.userId,type:'DELIVERY_CONFIRMED',title:'Delivery confirmed',message:`The buyer confirmed delivery for order ${order.orderNumber}. Earnings are eligible for payout after the applicable release period.`,data:{orderId:order.id,payoutEligibleAt:payoutEligibleAt.toISOString()}});
  return ok(res,result);
}));
router.post('/:id/disputes',requireAuth,requireRole('BUYER'),asyncHandler(async(req,res)=>{
  const reason=String(req.body?.reason||'').trim();
  if(reason.length<10||reason.length>2000)return fail(res,400,'INVALID_DISPUTE_REASON','Provide a dispute reason between 10 and 2,000 characters.');
  const order=await prisma.order.findUnique({where:{id:req.params.id},include:{seller:true}});
  if(!order||order.buyerId!==req.user.id)return fail(res,404,'ORDER_NOT_FOUND','Order not found.');
  if(order.paymentStatus!=='PAID'||!['SHIPPED','DELIVERED'].includes(order.orderStatus)||order.payoutReleasedAt)return fail(res,409,'DISPUTE_NOT_ALLOWED','A dispute can be opened only for a paid, shipped or delivered order before payout release.');
  const dispute=await prisma.$transaction(async tx=>{
    const existing=await tx.dispute.findFirst({where:{orderId:order.id,status:{notIn:['RESOLVED','CLOSED','DISMISSED']}}});
    if(existing)throw Object.assign(new Error('An unresolved dispute already exists for this order.'),{code:'DISPUTE_ALREADY_OPEN'});
    const payoutInProgress=await tx.withdrawalRequest.findFirst({where:{sellerId:order.sellerId,status:'PROCESSING'},select:{id:true}});
    if(payoutInProgress)throw Object.assign(new Error('A seller payout is already being executed; contact support to raise a dispute.'),{code:'PAYOUT_ALREADY_PROCESSING'});
    const created=await tx.dispute.create({data:{orderId:order.id,openedByUserId:req.user.id,reason}});
    await tx.order.update({where:{id:order.id},data:{payoutHoldReason:'OPEN_DISPUTE'}});
    await tx.auditLog.create({data:{actorUserId:req.user.id,action:'ORDER_DISPUTE_OPENED',targetType:'Dispute',targetId:created.id,metadata:{orderId:order.id},ipAddress:req.ip}});
    return created;
  },{isolationLevel:'Serializable'});
  await Promise.all([
    notify({userId:order.seller.userId,type:'ORDER_DISPUTE',title:'Order dispute opened',message:`A dispute was opened for order ${order.orderNumber}.`,data:{orderId:order.id,disputeId:dispute.id}}),
    notify({audienceRole:'ADMIN',type:'ORDER_DISPUTE',title:'Order dispute needs review',message:`A dispute was opened for order ${order.orderNumber}.`,data:{orderId:order.id,disputeId:dispute.id}})
  ]);
  return ok(res,dispute,201);
}));
module.exports=router;
