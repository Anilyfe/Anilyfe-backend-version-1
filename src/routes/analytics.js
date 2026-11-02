const express=require('express');const prisma=require('../lib/prisma');const {ok,asyncHandler}=require('../lib/http');const {requireAuth,requireRole}=require('../middleware/auth');const router=express.Router();
const DAY=86400000;
function shortDate(date){return date.toLocaleDateString('en-NG',{day:'2-digit',month:'short'});}
/* Buckets are fixed windows ending now; every order is placed by its createdAt timestamp. */
function bucketPlan(range,now){
  const start=new Date(now);start.setHours(0,0,0,0);
  if(range==='today'){
    const bounds=[];for(let hour=0;hour<24;hour+=4)bounds.push(new Date(start.getTime()+hour*3600000));
    return {bounds,label:date=>`${String(date.getHours()).padStart(2,'0')}:00`};
  }
  if(range==='7d'){
    const bounds=[];for(let i=6;i>=0;i--)bounds.push(new Date(start.getTime()-i*DAY));
    return {bounds,label:shortDate};
  }
  if(range==='3m'){
    const bounds=[];for(let i=11;i>=0;i--)bounds.push(new Date(start.getTime()-i*7*DAY));
    return {bounds,label:shortDate};
  }
  if(range==='6m'){
    const bounds=[];for(let i=5;i>=0;i--){const d=new Date(start.getTime()-i*30*DAY);bounds.push(d);}
    return {bounds,label:shortDate};
  }
  const bounds=[];for(let i=9;i>=0;i--)bounds.push(new Date(start.getTime()-i*3*DAY));
  return {bounds,label:shortDate};
}
function bucketIndex(plan,time){
  const stamp=new Date(time).getTime();
  if(!Number.isFinite(stamp))return -1;
  for(let i=plan.bounds.length-1;i>=0;i--)if(stamp>=plan.bounds[i].getTime())return i;
  return -1;
}
function deliveryState(order){
  const snapshot=order.deliverySnapshot;
  if(snapshot&&typeof snapshot==='object'&&snapshot.state)return String(snapshot.state);
  return 'Unspecified';
}
router.get('/overview',requireAuth,requireRole('SELLER','ADMIN'),asyncHandler(async(req,res)=>{
  const seller=req.user.role==='SELLER'?await prisma.seller.findUnique({where:{userId:req.user.id}}):null;
  const where=seller?{sellerId:seller.id}:{};
  const [orders,products]=await Promise.all([prisma.order.findMany({where,include:{items:true}}),prisma.product.count({where:seller?{sellerId:seller.id}:{}})]);
  const paid=orders.filter(o=>o.paymentStatus==='PAID');
  const completed=orders.filter(o=>o.orderStatus==='DELIVERED');
  const revenue=paid.reduce((n,o)=>n+Number(seller?o.sellerEarnings:o.total),0);
  const productsSold=completed.reduce((n,o)=>n+(o.items||[]).reduce((sum,item)=>sum+Number(item.quantity||0),0),0);
  const cancelled=orders.filter(o=>o.orderStatus==='CANCELLED').length;
  const returned=orders.filter(o=>['RETURN_REQUESTED','RETURNED','REFUND_PENDING','REFUNDED'].includes(o.orderStatus)).length;

  const plan=bucketPlan(String(req.query.dateRange||'30d'),new Date());
  const series={labels:plan.bounds.map(plan.label),revenue:plan.bounds.map(()=>0),orders:plan.bounds.map(()=>0),productsSold:plan.bounds.map(()=>0)};
  for(const order of orders){
    const index=bucketIndex(plan,order.createdAt);
    if(index<0)continue;
    series.orders[index]+=1;
    if(order.paymentStatus==='PAID')series.revenue[index]+=Number(seller?order.sellerEarnings:order.total);
    if(order.orderStatus==='DELIVERED')series.productsSold[index]+=(order.items||[]).reduce((sum,item)=>sum+Number(item.quantity||0),0);
  }

  const performance=new Map();
  for(const order of completed)for(const item of order.items||[]){
    const row=performance.get(item.productId)||{name:item.productNameSnapshot||'Product',unitsSold:0,revenue:0};
    row.unitsSold+=Number(item.quantity||0);
    row.revenue+=Number(item.lineTotal||0);
    performance.set(item.productId,row);
  }
  const bestSellers=[...performance.values()].sort((a,b)=>b.unitsSold-a.unitsSold).slice(0,5);

  const states=new Map();
  for(const order of completed){const state=deliveryState(order);states.set(state,(states.get(state)||0)+1);}
  const completedCount=completed.length||1;
  const topStates=[...states.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5).map(([state,count])=>({state,orders:count,share:`${Math.round((count/completedCount)*100)}%`}));

  return ok(res,{
    dateRange:req.query.dateRange||'30d',
    series,
    kpis:{totalRevenue:revenue,totalOrders:orders.length,productsSold,pendingOrders:orders.filter(o=>!['DELIVERED','CANCELLED','REFUNDED'].includes(o.orderStatus)).length,products,returned},
    ordersBreakdown:{total:orders.length,completed:completed.length,cancelled,returned,completionRate:orders.length?`${((completed.length/orders.length)*100).toFixed(1)}%`:'0%'},
    productPerformance:{bestSellers,lowPerforming:[]},
    locationTrends:{topStates,topCities:[]}
  });
}));
module.exports=router;
