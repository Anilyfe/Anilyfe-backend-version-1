const {decimal}=require('./http');

const DEFAULT_ABANDONED_PAYMENT_MINUTES=60;
const PAYMENT_ANOMALY_CODES=Object.freeze({
  DUPLICATE_CHARGE:'DUPLICATE_CHARGE',
  ORDER_NOT_PAID:'ORDER_NOT_PAID',
  PAYMENT_WITHOUT_ORDER:'PAYMENT_WITHOUT_ORDER',
  SESSION_NOT_PAID:'SESSION_NOT_PAID',
  ABANDONED_PAYMENT:'ABANDONED_PAYMENT',
  DUPLICATE_ACTIVE_PAYMENT:'DUPLICATE_ACTIVE_PAYMENT'
});

function orderPendingKey(orderId){return `ORDER:${orderId}`}
function sessionPendingKey(checkoutSessionId){return `SESSION:${checkoutSessionId}`}
function pendingKeyFor({orderId,checkoutSessionId}={}){
  if(checkoutSessionId)return sessionPendingKey(checkoutSessionId);
  if(orderId)return orderPendingKey(orderId);
  return null;
}
function buildPaymentReference(scope,token){
  const clean=String(scope||'').replace(/[^A-Za-z0-9-]/g,'').replace(/^ANL-/,'').slice(0,48);
  const suffix=String(token||'').replace(/[^A-Za-z0-9]/g,'').slice(0,24).toUpperCase();
  return `ANL-${clean}-${suffix}`;
}
function isActivePaymentStatus(status){return status==='PENDING'}

function detectPaymentAnomalies({orders=[],payments=[],sessions=[],now=new Date(),abandonedMinutes=DEFAULT_ABANDONED_PAYMENT_MINUTES}={}){
  const anomalies=[];
  const abandonedCutoff=new Date(now.getTime()-Math.max(1,Number(abandonedMinutes)||DEFAULT_ABANDONED_PAYMENT_MINUTES)*60*1000);
  const paidByOrder=new Map();
  const paidBySession=new Map();
  const activeByOrder=new Map();
  const activeBySession=new Map();
  for(const payment of payments){
    if(payment.status==='PAID'){
      if(payment.orderId)paidByOrder.set(payment.orderId,[...(paidByOrder.get(payment.orderId)||[]),payment]);
      if(payment.checkoutSessionId)paidBySession.set(payment.checkoutSessionId,[...(paidBySession.get(payment.checkoutSessionId)||[]),payment]);
      continue;
    }
    if(isActivePaymentStatus(payment.status)){
      if(payment.orderId)activeByOrder.set(payment.orderId,[...(activeByOrder.get(payment.orderId)||[]),payment]);
      if(payment.checkoutSessionId)activeBySession.set(payment.checkoutSessionId,[...(activeBySession.get(payment.checkoutSessionId)||[]),payment]);
      const createdAt=payment.createdAt?new Date(payment.createdAt):null;
      if(createdAt&&createdAt<=abandonedCutoff)anomalies.push({
        code:PAYMENT_ANOMALY_CODES.ABANDONED_PAYMENT,
        severity:'warning',
        reference:payment.reference,
        orderId:payment.orderId||null,
        checkoutSessionId:payment.checkoutSessionId||null,
        amount:decimal(payment.amount),
        createdAt:payment.createdAt,
        detail:`Payment ${payment.reference} has been pending since ${createdAt.toISOString()}.`
      });
    }
  }
  for(const [orderId,list] of paidByOrder){
    if(list.length>1)anomalies.push({
      code:PAYMENT_ANOMALY_CODES.DUPLICATE_CHARGE,
      severity:'critical',
      orderId,
      references:list.map(payment=>payment.reference),
      amount:list.reduce((sum,payment)=>sum+decimal(payment.amount),0),
      detail:`Order ${orderId} settled ${list.length} separate payments.`
    });
  }
  for(const [sessionId,list] of paidBySession){
    if(list.length>1)anomalies.push({
      code:PAYMENT_ANOMALY_CODES.DUPLICATE_CHARGE,
      severity:'critical',
      checkoutSessionId:sessionId,
      references:list.map(payment=>payment.reference),
      amount:list.reduce((sum,payment)=>sum+decimal(payment.amount),0),
      detail:`Checkout session ${sessionId} settled ${list.length} separate payments.`
    });
  }
  for(const [orderId,list] of activeByOrder){
    if(list.length>1)anomalies.push({
      code:PAYMENT_ANOMALY_CODES.DUPLICATE_ACTIVE_PAYMENT,
      severity:'critical',
      orderId,
      references:list.map(payment=>payment.reference),
      detail:`Order ${orderId} has ${list.length} payments awaiting settlement.`
    });
  }
  for(const [sessionId,list] of activeBySession){
    if(list.length>1)anomalies.push({
      code:PAYMENT_ANOMALY_CODES.DUPLICATE_ACTIVE_PAYMENT,
      severity:'critical',
      checkoutSessionId:sessionId,
      references:list.map(payment=>payment.reference),
      detail:`Checkout session ${sessionId} has ${list.length} payments awaiting settlement.`
    });
  }
  const orderById=new Map(orders.map(order=>[order.id,order]));
  for(const payment of payments){
    if(payment.status!=='PAID')continue;
    if(!payment.orderId)continue;
    const order=orderById.get(payment.orderId);
    if(!order){anomalies.push({
      code:PAYMENT_ANOMALY_CODES.PAYMENT_WITHOUT_ORDER,
      severity:'critical',
      reference:payment.reference,
      orderId:payment.orderId,
      amount:decimal(payment.amount),
      detail:`Payment ${payment.reference} is settled but its order is missing.`
    });continue;}
    if(order.paymentStatus!=='PAID')anomalies.push({
      code:PAYMENT_ANOMALY_CODES.ORDER_NOT_PAID,
      severity:'critical',
      reference:payment.reference,
      orderId:order.id,
      orderNumber:order.orderNumber||null,
      amount:decimal(payment.amount),
      detail:`Payment ${payment.reference} is settled but order ${order.orderNumber||order.id} is ${order.paymentStatus}.`
    });
  }
  const sessionById=new Map(sessions.map(session=>[session.id,session]));
  for(const [sessionId,list] of paidBySession){
    const session=sessionById.get(sessionId);
    if(session&&session.status!=='PAID')anomalies.push({
      code:PAYMENT_ANOMALY_CODES.SESSION_NOT_PAID,
      severity:'critical',
      checkoutSessionId:sessionId,
      references:list.map(payment=>payment.reference),
      detail:`Checkout session ${sessionId} has settled payments but its status is ${session.status}.`
    });
  }
  return anomalies;
}

function countBySeverity(anomalies=[]){
  return anomalies.reduce((totals,anomaly)=>{
    const key=anomaly.severity||'warning';
    totals[key]=(totals[key]||0)+1;
    totals.total=(totals.total||0)+1;
    return totals;
  },{total:0});
}

const STALE_PROVIDER_EVENT_MINUTES=10;

async function claimProviderEvent(db,{provider='PAYSTACK',providerEventId,eventType='unknown',reference=null,payload=null,now=new Date()}){
  const startedAt=new Date(now);
  try{
    const created=await db.paymentEvent.create({data:{provider,providerEventId,eventType,reference,payload,processingStartedAt:startedAt}});
    return {owned:true,paymentEvent:created};
  }catch(error){
    if(error.code!=='P2002')throw error;
    const existing=await db.paymentEvent.findUnique({where:{providerEventId}});
    if(!existing)throw error;
    if(existing.processedAt)return {owned:false,paymentEvent:existing,reason:'already_processed'};
    const staleBefore=new Date(now.getTime()-STALE_PROVIDER_EVENT_MINUTES*60*1000);
    const claim=await db.paymentEvent.updateMany({
      where:{id:existing.id,processedAt:null,OR:[{processingStartedAt:null},{processingStartedAt:{lt:staleBefore}}]},
      data:{processingStartedAt:startedAt,processingError:null}
    });
    if(!claim.count)return {owned:false,paymentEvent:existing,reason:'in_flight'};
    return {owned:true,paymentEvent:existing};
  }
}

module.exports={
  DEFAULT_ABANDONED_PAYMENT_MINUTES,
  PAYMENT_ANOMALY_CODES,
  STALE_PROVIDER_EVENT_MINUTES,
  orderPendingKey,
  sessionPendingKey,
  pendingKeyFor,
  buildPaymentReference,
  isActivePaymentStatus,
  detectPaymentAnomalies,
  countBySeverity,
  claimProviderEvent
};
