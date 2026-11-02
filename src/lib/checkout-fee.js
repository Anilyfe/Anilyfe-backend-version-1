const DEFAULT_CHECKOUT_FEES=Object.freeze([
  {from:0,fee:300},
  {from:10000,fee:500},
  {from:50000,fee:1000}
]);

function validateCheckoutFeeSchedule(schedule){
  if(!Array.isArray(schedule)||schedule.length===0)return false;
  if(Number(schedule[0].from)!==0)return false;
  let previous=null;
  for(const tier of schedule){
    if(!tier||!Number.isFinite(Number(tier.from))||Number(tier.from)<0)return false;
    if(!Number.isFinite(Number(tier.fee))||Number(tier.fee)<0)return false;
    if(previous!==null&&Number(tier.from)<=previous)return false;
    previous=Number(tier.from);
  }
  return true;
}

async function getCheckoutFeeSchedule(db){
  const setting=await db.marketplaceSetting.findUnique({where:{key:'checkoutFees'}});
  if(!setting)return DEFAULT_CHECKOUT_FEES;
  if(!validateCheckoutFeeSchedule(setting.value))throw Object.assign(new Error('Configured checkout fee schedule is invalid.'),{code:'CHECKOUT_FEE_SCHEDULE_INVALID'});
  return setting.value;
}

function calculateCheckoutFee(subtotal,schedule=DEFAULT_CHECKOUT_FEES){
  const value=Number(subtotal);
  if(!Number.isFinite(value)||value<0)throw new RangeError('Checkout fee requires a finite, non-negative order subtotal.');
  if(!Array.isArray(schedule)||schedule.length===0)throw new TypeError('Checkout fee schedule is missing.');
  const tier=[...schedule].sort((a,b)=>Number(a.from)-Number(b.from)).reverse().find(item=>value>=Number(item.from));
  if(!tier)throw new TypeError('Checkout fee schedule does not cover this order subtotal.');
  return Math.round(Number(tier.fee)*100)/100;
}

// Checkout is split into one Order row per seller, so the single cart-level fee is
// allocated pro-rata by subtotal in kobo and must sum back to exactly one fee.
function allocateCheckoutFee(fee,weights){
  const count=weights.length;
  if(count===0)return [];
  const totalKobo=Math.max(0,Math.round(Number(fee)*100));
  if(!Number.isFinite(totalKobo)||totalKobo===0)return new Array(count).fill(0);
  const positive=weights.map(weight=>Number.isFinite(weight)&&weight>0?weight:0);
  const weightSum=positive.reduce((sum,weight)=>sum+weight,0);
  const exact=positive.map(weight=>weightSum>0?(totalKobo*weight)/weightSum:totalKobo/count);
  const parts=exact.map(value=>Math.floor(value));
  let remainder=totalKobo-parts.reduce((sum,value)=>sum+value,0);
  const byFraction=exact
    .map((value,index)=>({index,fraction:value-Math.floor(value)}))
    .sort((a,b)=>b.fraction-a.fraction||a.index-b.index);
  for(let cursor=0;remainder>0&&cursor<byFraction.length;cursor++,remainder--)parts[byFraction[cursor].index]++;
  return parts.map(kobo=>kobo/100);
}

module.exports={DEFAULT_CHECKOUT_FEES,validateCheckoutFeeSchedule,getCheckoutFeeSchedule,calculateCheckoutFee,allocateCheckoutFee};
