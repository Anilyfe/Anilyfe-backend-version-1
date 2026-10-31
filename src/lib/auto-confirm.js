const prismaDefault=require('./prisma');
const {getPayoutReleaseHours}=require('./withdrawal-balance');
const {notify}=require('./notifications');

const DEFAULT_AUTO_CONFIRM_DAYS=7;

async function getAutoConfirmDays(db=prismaDefault){
  const row=await db.marketplaceSetting.findUnique({where:{key:'autoConfirmDeliveryDays'}});
  const days=Number(row?.value);
  return Number.isInteger(days)&&days>=1&&days<=60?days:DEFAULT_AUTO_CONFIRM_DAYS;
}

async function autoConfirmDeliveries(db=prismaDefault,now=new Date()){
  const days=await getAutoConfirmDays(db);
  const cutoff=new Date(now.getTime()-days*24*60*60*1000);
  const candidates=await db.order.findMany({
    where:{
      paymentStatus:'PAID',
      orderStatus:'DELIVERED',
      deliveryConfirmedAt:null,
      updatedAt:{lte:cutoff},
      disputes:{none:{status:{notIn:['RESOLVED','CLOSED','DISMISSED']}}}
    },
    include:{seller:true,timeline:{orderBy:{createdAt:'desc'},take:8}}
  });
  const deliveredAt=order=>{
    const mark=order.timeline.find(item=>item.status==='DELIVERED');
    return mark?.createdAt||order.updatedAt;
  };
  const due=candidates.filter(order=>deliveredAt(order)<=cutoff);
  const releaseHours=await getPayoutReleaseHours(db);
  const confirmed=[];
  for(const order of due){
    const hours=order.seller.foundingPayoutBenefit?releaseHours.founding:releaseHours.standard;
    const confirmedAt=now;
    const payoutEligibleAt=new Date(confirmedAt.getTime()+hours*60*60*1000);
    const changed=await db.order.updateMany({
      where:{id:order.id,deliveryConfirmedAt:null,orderStatus:'DELIVERED'},
      data:{deliveryConfirmedAt:confirmedAt,payoutEligibleAt,payoutHoldReason:null}
    });
    if(!changed.count)continue;
    await db.orderTimeline.create({data:{orderId:order.id,status:'DELIVERED',note:`Auto-confirmed after ${days} days without buyer confirmation or dispute.`}});
    await db.auditLog.create({data:{action:'DELIVERY_AUTO_CONFIRMED',targetType:'Order',targetId:order.id,metadata:{days,payoutEligibleAt:payoutEligibleAt.toISOString()}}});
    await notify({userId:order.seller.userId,type:'DELIVERY_CONFIRMED',title:'Delivery auto-confirmed',message:`Order ${order.orderNumber} was auto-confirmed after ${days} days. The payout timer has started.`,data:{orderId:order.id,payoutEligibleAt:payoutEligibleAt.toISOString()}});
    confirmed.push(order.id);
  }
  return {days,confirmed:confirmed.length,orderIds:confirmed};
}

module.exports={DEFAULT_AUTO_CONFIRM_DAYS,getAutoConfirmDays,autoConfirmDeliveries};
