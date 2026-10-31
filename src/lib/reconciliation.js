const {decimal}=require('./http');
const {detectPaymentAnomalies,countBySeverity,DEFAULT_ABANDONED_PAYMENT_MINUTES}=require('./payment-integrity');
const {summarizeReservations,DEFAULT_RESERVATION_TTL_MINUTES}=require('./reservations');

const DEFAULT_STUCK_TRANSFER_MINUTES=30;

function ledgerAccountBalances(entries=[]){
  const balances=new Map();
  for(const entry of entries){
    const current=balances.get(entry.account)||{account:entry.account,debits:0,credits:0,net:0,entries:0};
    const amount=decimal(entry.amount);
    if(entry.direction==='CREDIT'){current.credits+=amount;current.net+=amount;}
    else{current.debits+=amount;current.net-=amount;}
    current.entries+=1;
    balances.set(entry.account,current);
  }
  return [...balances.values()].sort((a,b)=>String(a.account).localeCompare(String(b.account)));
}

const PLATFORM_FEE_REVERSAL_TYPES=Object.freeze(['WITHDRAWAL_FEE_REVERSAL','WITHDRAWAL_REVERSED_FEE']);
const PLATFORM_TRANSFER_COST_TYPES=Object.freeze(['WITHDRAWAL_TRANSFER_COST']);

function platformFeeSummary(entries=[]){
  let feeCollected=0,feeReversals=0,transferCosts=0,otherDebits=0;
  for(const entry of entries){
    if(entry.account!=='PLATFORM_REVENUE')continue;
    const amount=decimal(entry.amount);
    if(entry.direction==='CREDIT'){feeCollected+=amount;continue;}
    if(PLATFORM_FEE_REVERSAL_TYPES.includes(entry.entryType)){feeReversals+=amount;continue;}
    if(PLATFORM_TRANSFER_COST_TYPES.includes(entry.entryType)){transferCosts+=amount;continue;}
    otherDebits+=amount;
  }
  return {feeCollected,feeReversals,transferCosts,otherDebits,netFeeRevenue:feeCollected-feeReversals-transferCosts-otherDebits};
}

function withdrawalExposure(withdrawals=[],now=new Date(),stuckMinutes=DEFAULT_STUCK_TRANSFER_MINUTES){
  const cutoff=new Date(now.getTime()-Math.max(1,Number(stuckMinutes)||DEFAULT_STUCK_TRANSFER_MINUTES)*60*1000);
  const exposure={pending:0,processing:0,completed:0,failed:0,reversed:0,cancelled:0,reservedAmount:0,payableAmount:0,transferCosts:0,stuckCount:0,stuck:[]};
  for(const withdrawal of withdrawals){
    const reserved=decimal(withdrawal.requestedAmount);
    const payable=decimal(withdrawal.netAmount);
    const transferCost=decimal(withdrawal.transferFeeAmount);
    if(withdrawal.status==='PENDING'){exposure.pending+=1;exposure.reservedAmount+=reserved;exposure.payableAmount+=payable;continue;}
    if(withdrawal.status==='PROCESSING'){
      exposure.processing+=1;
      exposure.reservedAmount+=reserved;
      exposure.payableAmount+=payable;
      const stamp=withdrawal.updatedAt||withdrawal.createdAt;
      if(stamp&&new Date(stamp).getTime()<=cutoff.getTime()){
        exposure.stuckCount+=1;
        exposure.stuck.push({id:withdrawal.id,transferReference:withdrawal.transferReference,accountType:withdrawal.accountType,requestedAmount:reserved,netAmount:payable,status:withdrawal.status,lastUpdatedAt:stamp});
      }
      continue;
    }
    if(withdrawal.status==='COMPLETED'){exposure.completed+=1;exposure.transferCosts+=transferCost;continue;}
    if(withdrawal.status==='FAILED'){exposure.failed+=1;continue;}
    if(withdrawal.status==='REVERSED'){exposure.reversed+=1;continue;}
    if(withdrawal.status==='CANCELLED')exposure.cancelled+=1;
  }
  return exposure;
}

function orderTotals(orders=[]){
  let gross=0,commission=0,sellerEarnings=0,paidCount=0,refundedCount=0;
  for(const order of orders){
    if(order.paymentStatus==='PAID'){
      paidCount+=1;
      gross+=decimal(order.total);
      commission+=decimal(order.commissionAmount);
      sellerEarnings+=decimal(order.sellerEarnings);
    }
    if(order.paymentStatus==='REFUNDED')refundedCount+=1;
  }
  return {gross,commission,sellerEarnings,paidCount,refundedCount};
}

function summarizeReconciliation({orders=[],payments=[],sessions=[],withdrawals=[],ledgerEntries=[],reservations=[]},{now=new Date(),abandonedMinutes=DEFAULT_ABANDONED_PAYMENT_MINUTES,stuckMinutes=DEFAULT_STUCK_TRANSFER_MINUTES}={}){
  const anomalies=detectPaymentAnomalies({orders,payments,sessions,now,abandonedMinutes});
  const exposure=withdrawalExposure(withdrawals,now,stuckMinutes);
  const accounts=ledgerAccountBalances(ledgerEntries);
  const fees=platformFeeSummary(ledgerEntries);
  const totals=orderTotals(orders);
  const reservationSummary=summarizeReservations(reservations);
  const checks=[];
  checks.push({
    code:'DUPLICATE_CHARGE_FREE',
    severity:'critical',
    ok:!anomalies.some(anomaly=>anomaly.code==='DUPLICATE_CHARGE'),
    message:'No order or checkout session has settled more than one payment.'
  });
  checks.push({
    code:'NO_STUCK_TRANSFERS',
    severity:'critical',
    ok:exposure.stuckCount===0,
    message:`${exposure.stuckCount} withdrawal transfer(s) are still in PROCESSING past the reconciliation window.`
  });
  checks.push({
    code:'LEDGER_COVERS_WITHDRAWAL_FEES',
    severity:'warning',
    ok:fees.feeCollected>0||exposure.completed===0,
    message:`Recorded withdrawal fees: ${fees.feeCollected}; reversals: ${fees.feeReversals}; provider transfer costs: ${fees.transferCosts}.`
  });
  checks.push({
    code:'COMMISSION_POSTED_TO_LEDGER',
    severity:'warning',
    ok:false,
    message:`Order commission recorded on paid orders totals ${totals.commission}, but commission is not yet posted to the financial ledger.`
  });
  checks.push({
    code:'RESERVATIONS_RELEASED',
    severity:'warning',
    ok:reservationSummary.expired===0,
    message:`${reservationSummary.expired} stock reservation(s) are past their expiry and still held.`
  });
  return {
    generatedAt:now.toISOString(),
    totals,
    ledger:{accounts,fees,entryCount:ledgerEntries.length},
    payments:{anomalies,severity:countBySeverity(anomalies),count:payments.length},
    withdrawals:exposure,
    reservations:reservationSummary,
    checks,
    healthy:checks.filter(check=>check.severity==='critical').every(check=>check.ok)
  };
}

async function buildReconciliationReport(db,{now=new Date(),abandonedMinutes=DEFAULT_ABANDONED_PAYMENT_MINUTES,stuckMinutes=DEFAULT_STUCK_TRANSFER_MINUTES,reservationTtlMinutes=DEFAULT_RESERVATION_TTL_MINUTES}={}){
  const [orders,payments,sessions,withdrawals,ledgerEntries,reservations]=await Promise.all([
    db.order.findMany({select:{id:true,orderNumber:true,buyerId:true,sellerId:true,paymentStatus:true,orderStatus:true,total:true,commissionAmount:true,sellerEarnings:true,checkoutSessionId:true,createdAt:true}}),
    db.payment.findMany({select:{id:true,reference:true,orderId:true,checkoutSessionId:true,amount:true,currency:true,status:true,createdAt:true,paidAt:true,pendingKey:true}}),
    db.checkoutSession.findMany({select:{id:true,reference:true,status:true,total:true,createdAt:true}}),
    db.withdrawalRequest.findMany({select:{id:true,userId:true,sellerId:true,accountType:true,status:true,requestedAmount:true,netAmount:true,feeAmount:true,transferFeeAmount:true,transferReference:true,createdAt:true,updatedAt:true,processedAt:true}}),
    db.financialLedgerEntry.findMany({select:{id:true,entryType:true,account:true,direction:true,amount:true,currency:true,reference:true,createdAt:true}}),
    db.stockReservation.findMany({select:{id:true,orderId:true,variantId:true,quantity:true,status:true,expiresAt:true,createdAt:true}})
  ]);
  const report=summarizeReconciliation({orders,payments,sessions,withdrawals,ledgerEntries,reservations},{now,abandonedMinutes,stuckMinutes});
  return {...report,reservationTtlMinutes};
}

module.exports={
  DEFAULT_STUCK_TRANSFER_MINUTES,
  ledgerAccountBalances,
  platformFeeSummary,
  withdrawalExposure,
  orderTotals,
  summarizeReconciliation,
  buildReconciliationReport
};
