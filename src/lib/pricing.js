const prisma=require('./prisma');
async function settingNumber(key,fallback){const s=await prisma.marketplaceSetting.findUnique({where:{key}});return s?Number(s.value):fallback}
async function commissionRate(){return settingNumber('commissionRate',Number(process.env.DEFAULT_COMMISSION_RATE||15))}
function foundingBenefitActive(seller,_productCount,launchDate=process.env.OFFICIAL_LAUNCH_DATE,now=new Date()){
  if(!seller?.foundingSellerActive)return false;
  const configuredLaunch=launchDate?new Date(launchDate):null;
  const officialLaunch=configuredLaunch&&Number.isFinite(configuredLaunch.getTime())?configuredLaunch:null;
  const start=officialLaunch||(seller.foundingCommissionStartsAt?new Date(seller.foundingCommissionStartsAt):null);
  if(!start||!Number.isFinite(start.getTime()))return false;
  let end;
  if(officialLaunch){
    end=new Date(officialLaunch);end.setFullYear(end.getFullYear()+1);
  }else{
    end=seller.foundingCommissionExpiresAt?new Date(seller.foundingCommissionExpiresAt):null;
    if(!end||!Number.isFinite(end.getTime())){end=new Date(start);end.setFullYear(end.getFullYear()+1);}
  }
  if(!Number.isFinite(end.getTime()))return false;
  return now>=start&&now<end;
}
function legacyShipping(seller,buyerState){const rules=seller.settings?.deliveryRules||{};const dispatchState=seller.state||seller.settings?.dispatchState||'';const same=dispatchState&&buyerState&&dispatchState.toLowerCase()===buyerState.toLowerCase();if(same&&rules.freeShippingInState)return 0;return same?Number(rules.sameStateFee||0):Number(rules.outsideStateFee||0)}
function productShipping(items,buyerState){let anyConfigured=false,total=0;const state=String(buyerState||'').toLowerCase();for(const item of items){const policy=item.product?.shipping;if(!policy||!['flat','per_item','free'].includes(policy.type))continue;anyConfigured=true;if(policy.type==='free')continue;const regions=Array.isArray(policy.regions)?policy.regions:[];if(regions.length&&!regions.some(x=>String(x).toLowerCase()===state))return {configured:true,unavailable:true,total:0};const rate=Math.max(0,Number(policy.rate)||0);total+=policy.type==='per_item'?rate*item.quantity:rate;}return {configured:anyConfigured,unavailable:false,total}}
async function shippingForSeller(seller,buyerState,items=[]){const policy=productShipping(items,buyerState);return policy.configured?(policy.unavailable?null:policy.total):legacyShipping(seller,buyerState)}
async function calculateSellerTotals(seller,items,buyerState,{foundingProductCount=0,launchDate,now=new Date(),buyerFees=0}={}){const subtotal=items.reduce((n,i)=>n+Number(i.unitPrice)*i.quantity,0);const shipping=await shippingForSeller(seller,buyerState,items);if(shipping===null)throw Object.assign(new Error('This seller does not ship to the selected state.'),{code:'SHIPPING_UNAVAILABLE'});const configuredRate=seller.commissionRate===null||seller.commissionRate===undefined?await commissionRate():Number(seller.commissionRate);const fallbackRate=Number.isFinite(configuredRate)&&configuredRate>=0&&configuredRate<=100?configuredRate:await commissionRate();const rate=foundingBenefitActive(seller,foundingProductCount,launchDate,now)?10:fallbackRate;const commission=Math.round((subtotal+shipping)*rate)/100;const estimatedDays=items.map(i=>i.product?.shipping?.estimatedDays).filter(Boolean).sort()[0]||null;return {subtotal,shipping,buyerFees,commissionRate:rate,commissionAmount:commission,sellerEarnings:Math.max(0,subtotal+shipping-commission),total:subtotal+shipping+buyerFees,estimatedDays}}
module.exports={settingNumber,commissionRate,shippingForSeller,calculateSellerTotals,legacyShipping,productShipping,foundingBenefitActive};
