const ELIGIBLE_PRODUCT_STATUSES=['PUBLISHED','APPROVED','OUT_OF_STOCK'];
const RANKS=[
  {key:'GENIN',label:'Genin',min:0,max:5,next:'CHUNIN',nextMin:6},
  {key:'CHUNIN',label:'Chunin',min:6,max:20,next:'JONIN',nextMin:21},
  {key:'JONIN',label:'Jonin',min:21,max:40,next:'ANBU',nextMin:41},
  {key:'ANBU',label:'Anbu',min:41,max:80,next:'HOKAGE',nextMin:81},
  {key:'HOKAGE',label:'Hokage',min:81,max:null,next:null,nextMin:null}
];
const FOUNDING_PRODUCT_REQUIREMENT=20;

function rankFromCount(count){
  const n=Math.max(0,Number(count)||0);
  return RANKS.find(rank=>n>=rank.min&&(rank.max===null||n<=rank.max))||RANKS[0];
}

function progressFor(count){
  const n=Math.max(0,Number(count)||0);
  const rank=rankFromCount(n);
  if(!rank.next){
    return {current:n,target:n,needed:0,percent:100,nextRank:null,nextMin:null};
  }
  const span=rank.nextMin-rank.min;
  const progressed=Math.min(span,Math.max(0,n-rank.min));
  return {
    current:n,
    target:rank.nextMin,
    needed:Math.max(0,rank.nextMin-n),
    percent:Math.round((progressed/span)*100),
    nextRank:rank.next,
    nextMin:rank.nextMin
  };
}

function rankMessage(count){
  const n=Math.max(0,Number(count)||0);
  const rank=rankFromCount(n);
  const needed=rank.next?Math.max(0,rank.nextMin-n):0;
  if(rank.key==='GENIN'){
    if(n===0)return 'Your ANILyfe journey starts here! Add your first product and begin building your shop.';
    if(n>=1&&n<=4)return "You're currently a Genin! Keep adding products to grow your shop and reach Chunin.";
    return "You're almost there! Add 1 more product to become a Chunin.";
  }
  if(rank.key==='CHUNIN'){
    if(n===6)return "Congratulations! You've become a Chunin. Keep growing your shop and work toward becoming a Jonin.";
    if(n===20)return "You're one step away from Jonin! Add 1 more product to reach the next rank.";
    return 'Your shop is growing! Keep listing products to get closer to Jonin.';
  }
  if(rank.key==='JONIN'){
    if(n===21)return "Congratulations! You've reached Jonin rank. Keep building your shop and work toward Anbu.";
    if(n===40)return "You're almost an Anbu! Add 1 more product to reach the next rank.";
    return `You're making great progress! Add ${needed} more product${needed===1?'':'s'} to become an Anbu.`;
  }
  if(rank.key==='ANBU'){
    if(n===41)return 'Welcome to Anbu! Your shop is growing stronger. Keep listing products and work toward Hokage.';
    if(n===80)return "You're one product away from becoming a Hokage! Add 1 more product to reach the highest seller rank.";
    return `You're making excellent progress! Add ${needed} more product${needed===1?'':'s'} to become a Hokage.`;
  }
  return "Congratulations! You've reached Hokage rank, the highest seller rank on ANILyfe. Your dedication to growing your shop deserves recognition!";
}

async function eligibleProductCount(prisma,sellerId){
  return prisma.product.count({where:{sellerId,status:{in:ELIGIBLE_PRODUCT_STATUSES}}});
}

function rankPayload(count){
  const n=Math.max(0,Number(count)||0);
  const rank=rankFromCount(n);
  const progress=progressFor(n);
  return {
    rank:rank.key,
    rankLabel:rank.label,
    eligibleProducts:n,
    foundingUnlocked:n>=FOUNDING_PRODUCT_REQUIREMENT,
    foundingRequired:FOUNDING_PRODUCT_REQUIREMENT,
    foundingRemaining:Math.max(0,FOUNDING_PRODUCT_REQUIREMENT-n),
    progress,
    message:rankMessage(n)
  };
}

async function maybeNotifyRankChange(prisma,{seller,count,notify}){
  const payload=rankPayload(count);
  if(seller.lastNotifiedRank===payload.rank)return payload;
  if(typeof notify==='function'){
    await notify({userId:seller.userId,type:'SELLER_RANK',title:`${payload.rankLabel} rank`,message:payload.message,data:{rank:payload.rank,eligibleProducts:count}});
  }
  await prisma.seller.update({where:{id:seller.id},data:{lastNotifiedRank:payload.rank}});
  return payload;
}

module.exports={
  ELIGIBLE_PRODUCT_STATUSES,
  FOUNDING_PRODUCT_REQUIREMENT,
  RANKS,
  rankFromCount,
  progressFor,
  rankMessage,
  eligibleProductCount,
  rankPayload,
  maybeNotifyRankChange
};
