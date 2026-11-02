const prisma=require('./prisma');
const {releaseExpiredReservations}=require('./reservations');
const {notify}=require('./notifications');

async function runReservationExpiry(now=new Date()){
  const result=await releaseExpiredReservations(prisma,now);
  for(const order of result.cancelledOrders){
    await notify({userId:order.buyerId,type:'ORDER_CANCELLED',title:'Checkout expired',message:`Order ${order.orderNumber} was cancelled because payment was not completed before the stock reservation expired.`,data:{orderId:order.id}});
  }
  if(result.mismatches.length)await notify({audienceRole:'ADMIN',type:'RESERVATION_RELEASE_MISMATCH',title:'Reservation release mismatch',message:`${result.mismatches.length} expired reservation(s) could not release the reserved stock counter. Reconcile the variant stock levels.`,data:{count:result.mismatches.length}});
  return result;
}

function startMaintenanceJobs({intervalMinutes=10,logger=console}={}){
  const timer=setInterval(()=>{
    runReservationExpiry().catch(error=>logger.error('maintenance job failed',error));
  },Math.max(1,Number(intervalMinutes)||10)*60*1000);
  if(typeof timer.unref==='function')timer.unref();
  return timer;
}

module.exports={runReservationExpiry,startMaintenanceJobs};
