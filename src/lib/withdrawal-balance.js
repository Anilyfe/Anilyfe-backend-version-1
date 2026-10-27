const {decimal}=require('./http');
const {calculateWithdrawalFee,DEFAULT_WITHDRAWAL_FEES,validateWithdrawalFeeSchedule}=require('./withdrawal-fees');
const DEFAULT_PAYOUT_RELEASE_HOURS=Object.freeze({founding:48,standard:48});

async function getWithdrawalSchedule(db){
  const setting=await db.marketplaceSetting.findUnique({where:{key:'withdrawalFees'}});
  if(!setting)return DEFAULT_WITHDRAWAL_FEES;
  if(!validateWithdrawalFeeSchedule(setting.value))throw Object.assign(new Error('Configured withdrawal fee schedule is invalid.'),{code:'WITHDRAWAL_FEE_SCHEDULE_INVALID'});
  return setting.value;
}

function validatePayoutReleaseHours(value){
  return value&&typeof value==='object'&&['founding','standard'].every(key=>Number.isInteger(value[key])&&value[key]>=1&&value[key]<=8760);
}

async function getPayoutReleaseHours(db){
  const setting=await db.marketplaceSetting.findUnique({where:{key:'payoutReleaseHours'}});
  if(!setting)return DEFAULT_PAYOUT_RELEASE_HOURS;
  if(!validatePayoutReleaseHours(setting.value))throw Object.assign(new Error('Configured payout release periods are invalid.'),{code:'PAYOUT_RELEASE_SETTINGS_INVALID'});
  return setting.value;
}

async function sellerWithdrawalBalance(sellerId,db,now=new Date(),{excludeWithdrawalId}={}){
  const [seller,releaseHours,orders,payouts,withdrawals]=await Promise.all([
    db.seller.findUnique({where:{id:sellerId},select:{foundingPayoutBenefit:true}}),
    getPayoutReleaseHours(db),
    db.order.findMany({where:{sellerId,paymentStatus:'PAID',orderStatus:{notIn:['CANCELLED','REFUNDED','REFUND_PENDING']}},select:{sellerEarnings:true,deliveryConfirmedAt:true,payoutEligibleAt:true,payoutReleasedAt:true,adminPayoutHoldReason:true,refund:{select:{status:true}},disputes:{select:{status:true}}}}),
    db.payout.findMany({where:{sellerId,status:{in:['PENDING','PROCESSING','PAID']}},select:{amount:true,netAmount:true,status:true}}),
    db.withdrawalRequest.findMany({where:{sellerId,status:{in:['PENDING','PROCESSING','COMPLETED']},...(excludeWithdrawalId?{id:{not:excludeWithdrawalId}}:{})},select:{requestedAmount:true,status:true}})
  ]);
  const releaseDelay=(seller?.foundingPayoutBenefit?releaseHours.founding:releaseHours.standard)*60*60*1000;
  let totalEarnings=0,pendingDelivery=0,awaitingRelease=0,availableBeforeReservations=0,disputed=0,administrativeHold=0;
  for(const order of orders){
    const earnings=decimal(order.sellerEarnings);
    totalEarnings+=earnings;
    if(order.refund)continue;
    if(!order.deliveryConfirmedAt){pendingDelivery+=earnings;continue;}
    const hasOpenDispute=order.disputes.some(dispute=>!['RESOLVED','CLOSED','DISMISSED'].includes(dispute.status));
    if(hasOpenDispute){disputed+=earnings;continue;}
    if(order.adminPayoutHoldReason){administrativeHold+=earnings;continue;}
    if(order.payoutReleasedAt)continue;
    const releaseAt=order.payoutEligibleAt||new Date(new Date(order.deliveryConfirmedAt).getTime()+releaseDelay);
    if(new Date(releaseAt)>now){awaitingRelease+=earnings;continue;}
    availableBeforeReservations+=earnings;
  }
  const paidLegacy=payouts.filter(item=>item.status==='PAID').reduce((sum,item)=>sum+decimal(item.netAmount||item.amount),0);
  const reservedLegacy=payouts.filter(item=>['PENDING','PROCESSING'].includes(item.status)).reduce((sum,item)=>sum+decimal(item.amount),0);
  const paidWithdrawals=withdrawals.filter(item=>item.status==='COMPLETED').reduce((sum,item)=>sum+decimal(item.requestedAmount),0);
  const reservedWithdrawals=withdrawals.filter(item=>['PENDING','PROCESSING'].includes(item.status)).reduce((sum,item)=>sum+decimal(item.requestedAmount),0);
  const paid=paidLegacy+paidWithdrawals;
  const reserved=reservedLegacy+reservedWithdrawals;
  return {
    totalEarnings,
    pendingDelivery,
    awaitingRelease,
    disputed,
    administrativeHold,
    pendingClearance:pendingDelivery+awaitingRelease+disputed+administrativeHold,
    totalWithdrawn:paid,
    pendingPayouts:reserved,
    availableBalance:Math.max(0,availableBeforeReservations-paid-reserved)
  };
}

async function buyerWalletBalance(userId,db){
  const entries=await db.financialLedgerEntry.findMany({where:{userId,account:'BUYER_AVAILABLE'},select:{direction:true,amount:true}});
  return entries.reduce((balance,entry)=>balance+(entry.direction==='CREDIT'?decimal(entry.amount):-decimal(entry.amount)),0);
}

async function withdrawalQuote(accountType,amount,db){
  const schedule=await getWithdrawalSchedule(db);
  return calculateWithdrawalFee(accountType,amount,schedule);
}

module.exports={DEFAULT_PAYOUT_RELEASE_HOURS,validatePayoutReleaseHours,getPayoutReleaseHours,getWithdrawalSchedule,sellerWithdrawalBalance,buyerWalletBalance,withdrawalQuote};
