const DEFAULT_RESERVATION_TTL_MINUTES=30;
const MIN_RESERVATION_TTL_MINUTES=5;
const MAX_RESERVATION_TTL_MINUTES=10080;
const RESERVATION_STATUS=Object.freeze({HELD:'HELD',CONSUMED:'CONSUMED',RELEASED:'RELEASED'});
const DEFAULT_PAYMENT_GRACE_MINUTES=60;

function validateReservationTtlMinutes(value){
  return Number.isInteger(value)&&value>=MIN_RESERVATION_TTL_MINUTES&&value<=MAX_RESERVATION_TTL_MINUTES;
}

async function getReservationTtlMinutes(db){
  const setting=await db.marketplaceSetting.findUnique({where:{key:'reservationTtlMinutes'}});
  if(!setting)return DEFAULT_RESERVATION_TTL_MINUTES;
  const minutes=Number(setting.value);
  if(!validateReservationTtlMinutes(minutes))throw Object.assign(new Error('Configured reservation lifetime is invalid.'),{code:'RESERVATION_TTL_SETTINGS_INVALID'});
  return minutes;
}

function reservationExpiry(now=new Date(),ttlMinutes=DEFAULT_RESERVATION_TTL_MINUTES){
  const minutes=Number.isInteger(ttlMinutes)?ttlMinutes:DEFAULT_RESERVATION_TTL_MINUTES;
  return new Date(new Date(now).getTime()+minutes*60*1000);
}

function selectExpiredReservations(reservations=[],now=new Date()){
  const cutoff=new Date(now).getTime();
  return reservations.filter(reservation=>reservation.status===RESERVATION_STATUS.HELD&&new Date(reservation.expiresAt).getTime()<=cutoff);
}

function planReservationReleases(reservations=[],now=new Date()){
  return selectExpiredReservations(reservations,now).map(reservation=>({
    reservationId:reservation.id,
    orderId:reservation.orderId,
    variantId:reservation.variantId,
    quantity:reservation.quantity,
    expiresAt:reservation.expiresAt
  }));
}

function summarizeReservations(reservations=[]){
  const summary={total:0,held:0,heldQuantity:0,consumed:0,released:0,expired:0};
  const now=Date.now();
  for(const reservation of reservations){
    summary.total+=1;
    if(reservation.status===RESERVATION_STATUS.HELD){
      summary.held+=1;
      summary.heldQuantity+=Number(reservation.quantity||0);
      if(new Date(reservation.expiresAt).getTime()<=now)summary.expired+=1;
      continue;
    }
    if(reservation.status===RESERVATION_STATUS.CONSUMED){summary.consumed+=1;continue;}
    if(reservation.status===RESERVATION_STATUS.RELEASED)summary.released+=1;
  }
  return summary;
}

function reservationExposure(reservations=[]){
  const held=reservations.filter(reservation=>reservation.status===RESERVATION_STATUS.HELD);
  return {
    heldCount:held.length,
    heldQuantity:held.reduce((sum,reservation)=>sum+Number(reservation.quantity||0),0)
  };
}

function classifyExpiredReservations({reservations=[],orders=[],recentPayments=[],now=new Date()}){
  const expired=selectExpiredReservations(reservations,now);
  const orderById=new Map(orders.map(order=>[order.id,order]));
  const sessionByOrder=new Map(orders.map(order=>[order.id,order.checkoutSessionId||null]));
  const activePaymentOrderIds=new Set();
  for(const payment of recentPayments){
    if(payment.orderId)activePaymentOrderIds.add(payment.orderId);
    if(payment.checkoutSessionId){
      for(const [orderId,sessionId] of sessionByOrder){
        if(sessionId&&sessionId===payment.checkoutSessionId)activePaymentOrderIds.add(orderId);
      }
    }
  }
  const releasable=[];
  const deferred=[];
  const stale=[];
  for(const reservation of expired){
    const order=orderById.get(reservation.orderId);
    if(!order){stale.push(reservation);continue;}
    if(order.paymentStatus!=='PENDING'||order.orderStatus!=='PENDING_PAYMENT'){stale.push(reservation);continue;}
    if(activePaymentOrderIds.has(reservation.orderId)){deferred.push(reservation);continue;}
    releasable.push(reservation);
  }
  return {expired,releasable,deferred,stale};
}

async function applyReservationRelease(tx,plan,now=new Date()){
  const released=[];
  const mismatches=[];
  for(const item of plan){
    const rows=await tx.$queryRawUnsafe('UPDATE "ProductVariant" SET "reserved"="reserved"-$1, "updatedAt"=NOW() WHERE "id"=$2 AND "reserved">=$1 RETURNING "id"',item.quantity,item.variantId);
    if(!rows.length)mismatches.push(item);
    const changed=await tx.stockReservation.updateMany({where:{id:item.reservationId,status:RESERVATION_STATUS.HELD},data:{status:RESERVATION_STATUS.RELEASED,releasedAt:now}});
    if(!changed.count)continue;
    released.push({...item,stockReleased:rows.length>0});
  }
  return {released,mismatches};
}

async function releaseExpiredReservations(db,now=new Date(),{limit=200,graceMinutes=DEFAULT_PAYMENT_GRACE_MINUTES}={}){
  const reservations=await db.stockReservation.findMany({
    where:{status:RESERVATION_STATUS.HELD,expiresAt:{lte:now}},
    orderBy:{expiresAt:'asc'},
    take:limit
  });
  const empty={released:0,cancelledOrders:[],mismatches:[],deferred:[],stale:[],summary:summarizeReservations([])};
  if(!reservations.length)return empty;
  const orderIds=[...new Set(reservations.map(reservation=>reservation.orderId))];
  const graceCutoff=new Date(now.getTime()-Math.max(0,Number(graceMinutes)||0)*60*1000);
  const orders=await db.order.findMany({where:{id:{in:orderIds}},select:{id:true,orderNumber:true,orderStatus:true,paymentStatus:true,checkoutSessionId:true,buyerId:true}});
  const sessionIds=[...new Set(orders.map(order=>order.checkoutSessionId).filter(Boolean))];
  const recentPayments=await db.payment.findMany({
    where:{
      status:'PENDING',
      createdAt:{gt:graceCutoff},
      OR:[
        ...(orderIds.length?[{orderId:{in:orderIds}}]:[]),
        ...(sessionIds.length?[{checkoutSessionId:{in:sessionIds}}]:[])
      ]
    },
    select:{id:true,orderId:true,checkoutSessionId:true,reference:true,createdAt:true}
  });
  const classified=classifyExpiredReservations({reservations,orders,recentPayments,now});
  if(!classified.releasable.length)return {...empty,deferred:classified.deferred,stale:classified.stale,summary:summarizeReservations(reservations)};
  const plan=planReservationReleases(classified.releasable,now);
  const result=await db.$transaction(async tx=>{
    const applied=await applyReservationRelease(tx,plan,now);
    const cancelledOrders=[];
    for(const orderId of [...new Set(applied.released.map(item=>item.orderId))]){
      const order=await tx.order.findUnique({where:{id:orderId},select:{id:true,orderNumber:true,orderStatus:true,paymentStatus:true,checkoutSessionId:true,buyerId:true}});
      if(!order||order.paymentStatus!=='PENDING'||order.orderStatus!=='PENDING_PAYMENT')continue;
      const changed=await tx.order.updateMany({where:{id:order.id,orderStatus:'PENDING_PAYMENT',paymentStatus:'PENDING'},data:{orderStatus:'CANCELLED'}});
      if(!changed.count)continue;
      await tx.orderTimeline.create({data:{orderId:order.id,status:'CANCELLED',note:'Checkout was not completed before the stock reservation expired.'}});
      await tx.auditLog.create({data:{action:'ORDER_RESERVATION_EXPIRED',targetType:'Order',targetId:order.id,metadata:{orderNumber:order.orderNumber,checkoutSessionId:order.checkoutSessionId},ipAddress:null}});
      cancelledOrders.push({id:order.id,orderNumber:order.orderNumber,buyerId:order.buyerId,checkoutSessionId:order.checkoutSessionId});
      if(order.checkoutSessionId){
        const remaining=await tx.order.count({where:{checkoutSessionId:order.checkoutSessionId,orderStatus:'PENDING_PAYMENT'}});
        if(!remaining)await tx.checkoutSession.updateMany({where:{id:order.checkoutSessionId,status:'PENDING_PAYMENT'},data:{status:'EXPIRED'}});
      }
    }
    return {...applied,cancelledOrders};
  },{isolationLevel:'Serializable'});
  return {
    released:result.released.length,
    cancelledOrders:result.cancelledOrders,
    mismatches:result.mismatches,
    deferred:classified.deferred,
    stale:classified.stale,
    summary:summarizeReservations(reservations)
  };
}

async function consumeReservations(db,orderIds=[]){
  if(!orderIds.length)return {consumed:0};
  const changed=await db.stockReservation.updateMany({
    where:{orderId:{in:orderIds},status:RESERVATION_STATUS.HELD},
    data:{status:RESERVATION_STATUS.CONSUMED,consumedAt:new Date()}
  });
  return {consumed:changed.count};
}

module.exports={
  DEFAULT_RESERVATION_TTL_MINUTES,
  MIN_RESERVATION_TTL_MINUTES,
  MAX_RESERVATION_TTL_MINUTES,
  DEFAULT_PAYMENT_GRACE_MINUTES,
  RESERVATION_STATUS,
  validateReservationTtlMinutes,
  getReservationTtlMinutes,
  reservationExpiry,
  selectExpiredReservations,
  planReservationReleases,
  summarizeReservations,
  reservationExposure,
  classifyExpiredReservations,
  applyReservationRelease,
  releaseExpiredReservations,
  consumeReservations
};
