const express=require('express');
const prisma=require('../lib/prisma');
const {ok,asyncHandler}=require('../lib/http');
const {requireAuth,requireRole}=require('../middleware/auth');
const {buildReconciliationReport,summarizeReconciliation,DEFAULT_STUCK_TRANSFER_MINUTES}=require('../lib/reconciliation');
const {releaseExpiredReservations,getReservationTtlMinutes}=require('../lib/reservations');
const {DEFAULT_ABANDONED_PAYMENT_MINUTES}=require('../lib/payment-integrity');
const {notify}=require('../lib/notifications');
const {audit}=require('../lib/audit');

const router=express.Router();

function options(req){
  const abandonedMinutes=Number(req.query.abandonedMinutes||DEFAULT_ABANDONED_PAYMENT_MINUTES);
  const stuckMinutes=Number(req.query.stuckMinutes||DEFAULT_STUCK_TRANSFER_MINUTES);
  return {
    now:new Date(),
    abandonedMinutes:Number.isFinite(abandonedMinutes)&&abandonedMinutes>0?abandonedMinutes:DEFAULT_ABANDONED_PAYMENT_MINUTES,
    stuckMinutes:Number.isFinite(stuckMinutes)&&stuckMinutes>0?stuckMinutes:DEFAULT_STUCK_TRANSFER_MINUTES
  };
}

router.get('/',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>{
  const report=await buildReconciliationReport(prisma,{...options(req),reservationTtlMinutes:await getReservationTtlMinutes(prisma)});
  return ok(res,report);
}));

router.get('/anomalies',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>{
  const [orders,payments,sessions]=await Promise.all([
    prisma.order.findMany({select:{id:true,orderNumber:true,paymentStatus:true,orderStatus:true,total:true}}),
    prisma.payment.findMany({select:{id:true,reference:true,orderId:true,checkoutSessionId:true,amount:true,status:true,createdAt:true}}),
    prisma.checkoutSession.findMany({select:{id:true,reference:true,status:true}})
  ]);
  const report=summarizeReconciliation({orders,payments,sessions},{...options(req)});
  return ok(res,{anomalies:report.payments.anomalies,severity:report.payments.severity,checks:report.checks});
}));

router.get('/withdrawals',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>{
  const settings=options(req);
  const [withdrawals,ledgerEntries]=await Promise.all([
    prisma.withdrawalRequest.findMany({select:{id:true,userId:true,sellerId:true,accountType:true,status:true,requestedAmount:true,netAmount:true,feeAmount:true,transferFeeAmount:true,transferReference:true,createdAt:true,updatedAt:true,processedAt:true},orderBy:{createdAt:'desc'}}),
    prisma.financialLedgerEntry.findMany({select:{entryType:true,account:true,direction:true,amount:true,reference:true,createdAt:true}})
  ]);
  const report=summarizeReconciliation({withdrawals,ledgerEntries},{...settings});
  return ok(res,{exposure:report.withdrawals,ledger:report.ledger});
}));

router.post('/expire-reservations',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>{
  const result=await releaseExpiredReservations(prisma,new Date());
  for(const order of result.cancelledOrders){
    await notify({userId:order.buyerId,type:'ORDER_CANCELLED',title:'Checkout expired',message:`Order ${order.orderNumber} was cancelled because payment was not completed before the stock reservation expired.`,data:{orderId:order.id}});
  }
  if(result.mismatches.length)await notify({audienceRole:'ADMIN',type:'RESERVATION_RELEASE_MISMATCH',title:'Reservation release mismatch',message:`${result.mismatches.length} expired reservation(s) could not release the reserved stock counter. Reconcile the variant stock levels.`,data:{count:result.mismatches.length}});
  await audit(req,'RESERVATIONS_EXPIRED','StockReservation',null,{released:result.released,cancelledOrders:result.cancelledOrders.length,mismatches:result.mismatches.length,deferred:result.deferred.length,stale:result.stale.length});
  return ok(res,{released:result.released,cancelledOrders:result.cancelledOrders,mismatches:result.mismatches.length,deferred:result.deferred.length,stale:result.stale.length});
}));

module.exports=router;
