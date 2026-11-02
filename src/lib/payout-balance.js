const HOLD_MS=48*60*60*1000;
const cents=value=>Math.round(Number(value||0)*100);
const naira=value=>Math.max(0,value)/100;

function calculatePayoutBalance(orders,payouts,now=new Date()){
  const cutoff=now.getTime()-HOLD_MS;
  const mature=orders.filter(order=>order.paidAt&&new Date(order.paidAt).getTime()<=cutoff).reduce((sum,order)=>sum+cents(order.sellerEarnings),0);
  const held=orders.filter(order=>!order.paidAt||new Date(order.paidAt).getTime()>cutoff).reduce((sum,order)=>sum+cents(order.sellerEarnings),0);
  const paid=payouts.filter(payout=>payout.status==='PAID').reduce((sum,payout)=>sum+cents(payout.amount),0);
  const reserved=payouts.filter(payout=>['PENDING','PROCESSING'].includes(payout.status)).reduce((sum,payout)=>sum+cents(payout.amount),0);
  return {totalEarnings:naira(mature+held),pendingClearance:naira(held),totalWithdrawn:naira(paid),pendingPayouts:naira(reserved),availableBalance:naira(mature-paid-reserved)};
}

module.exports={HOLD_MS,calculatePayoutBalance};
