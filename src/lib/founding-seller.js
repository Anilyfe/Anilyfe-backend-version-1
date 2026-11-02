const {eligibleProductCount,FOUNDING_PRODUCT_REQUIREMENT,rankPayload}=require('./seller-rank');
const {foundingBenefitActive}=require('./pricing');

function programmeLimit(){
  const configured=Number(process.env.FOUNDING_SELLER_LIMIT||50);
  return Number.isFinite(configured)?Math.min(50,Math.max(0,Math.floor(configured))):50;
}

async function approvedFoundingCount(prisma){
  return prisma.seller.count({where:{foundingSellerActive:true,foundingSellerNumber:{not:null}}});
}

function shopProfileComplete(seller){
  return Boolean(
    String(seller.businessName||'').trim().length>=2 &&
    String(seller.category||'').trim() &&
    String(seller.state||'').trim() &&
    String(seller.city||'').trim() &&
    String(seller.phone||'').trim() &&
    String(seller.businessEmail||seller.user?.email||'').trim()
  );
}

function basicVerificationComplete(seller){
  const verification=seller.verification;
  if(!verification)return false;
  const kind=String(verification.registrationType||'INDIVIDUAL').toUpperCase();
  const ninOk=['VERIFIED','APPROVED'].includes(String(verification.ninVerificationStatus||'').toUpperCase())||verification.status==='APPROVED';
  if(kind==='BUSINESS'||kind==='LIMITED COMPANY'||kind==='LIMITED_COMPANY'){
    return verification.status==='APPROVED'&&Boolean(verification.cacRegistrationNumber)&&ninOk;
  }
  return verification.status==='APPROVED'&&ninOk;
}

async function qualification(prisma,seller){
  const eligibleProducts=await eligibleProductCount(prisma,seller.id);
  const productsMet=eligibleProducts>=FOUNDING_PRODUCT_REQUIREMENT;
  const verificationMet=basicVerificationComplete(seller);
  const profileMet=shopProfileComplete(seller);
  const policiesMet=Boolean(seller.hasAcceptedTerms&&seller.foundingPoliciesAcceptedAt);
  const application=seller.foundingApplications?.[0]||seller.foundingApplication||null;
  const places=programmeLimit();
  const approvedCount=await approvedFoundingCount(prisma);
  const placesRemaining=Math.max(0,places-approvedCount);
  const ready=productsMet&&verificationMet&&profileMet&&policiesMet&&!seller.foundingSellerActive&&placesRemaining>0;
  return {
    eligibleProducts,
    rank:rankPayload(eligibleProducts),
    limit:places,
    approvedCount,
    placesRemaining,
    programmeOpen:placesRemaining>0,
    requirements:{
      products:{met:productsMet,current:eligibleProducts,required:FOUNDING_PRODUCT_REQUIREMENT},
      verification:{met:verificationMet,status:seller.verification?.status||'NOT_STARTED',kind:seller.verification?.registrationType||'INDIVIDUAL'},
      shopProfile:{met:profileMet},
      policies:{met:policiesMet,sellerPolicy:Boolean(seller.hasAcceptedTerms),foundingPolicy:Boolean(seller.foundingPoliciesAcceptedAt)},
      application:{status:application?.status||(seller.foundingSellerActive?'APPROVED':'NOT_SUBMITTED'),rejectionReason:application?.rejectionReason||null}
    },
    readyToApply:ready&&(!application||application.status==='REJECTED'),
    foundingSellerActive:Boolean(seller.foundingSellerActive),
    foundingSellerNumber:seller.foundingSellerNumber||null,
    commissionRate:foundingBenefitActive(seller,eligibleProducts)?10:Number(seller.commissionRate||15),
    foundingCommissionExpiresAt:seller.foundingCommissionExpiresAt||null
  };
}

module.exports={programmeLimit,approvedFoundingCount,shopProfileComplete,basicVerificationComplete,qualification};
