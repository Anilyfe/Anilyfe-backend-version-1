const express=require('express'); const {z}=require('zod'); const prisma=require('../lib/prisma'); const {ok,fail,asyncHandler,decimal}=require('../lib/http'); const {sign,setSession,requireAuth,requireRole}=require('../middleware/auth'); const {notify}=require('../lib/notifications'); const {audit}=require('../lib/audit'); const {verifyNIN}=require('../lib/nin-verification');
const {encryptSellerPii,decryptSellerPii,maskSellerPii}=require('../lib/seller-pii');
const {foundingBenefitActive}=require('../lib/pricing');
const router=express.Router();
router.post('/me/verification/nin',requireAuth,requireRole('SELLER'),asyncHandler(async(req,res)=>{
  const nin=String(req.body?.nin||'');if(!/^\d{11}$/.test(nin))return fail(res,400,'INVALID_NIN','NIN must contain exactly 11 digits.');
  const names=z.object({firstName:z.string().trim().min(1).max(80),lastName:z.string().trim().min(1).max(80)}).parse(req.body||{});const d={...names,nin};
  const seller=await prisma.seller.findUnique({where:{userId:req.user.id}});
  if(!seller)return fail(res,404,'SELLER_NOT_FOUND','Seller profile not found.');
  const result=await verifyNIN(d),verified=result.success;
  const status=verified?'VERIFIED':result.code==='NO_MATCH'?'NOT_MATCHED':'PENDING';
  const safeAudit=result.audit?{...result.audit,checkedAt:new Date().toISOString()}:null;
  let encryptedNin;
  try{encryptedNin=encryptSellerPii(d.nin);}catch(error){if(error.code==='SELLER_PII_KEY_MISSING')return fail(res,503,'SELLER_APPLICATION_STORAGE_UNAVAILABLE','Seller application storage is not configured. Contact marketplace support.');throw error;}
  await prisma.sellerVerification.upsert({where:{sellerId:seller.id},create:{sellerId:seller.id,nationalIdType:'NIN',nationalIdNumber:encryptedNin,ninVerificationStatus:status,ninVerifiedAt:verified?new Date():null,ninProvider:'IdentifyOrg',ninProviderResponse:safeAudit},update:{nationalIdType:'NIN',nationalIdNumber:encryptedNin,ninVerificationStatus:status,ninVerifiedAt:verified?new Date():null,ninProvider:'IdentifyOrg',ninProviderResponse:safeAudit}});
  return ok(res,{verified,status});
}));
function profile(s){return {...s,commissionRate:decimal(s.commissionRate),verificationStatus:s.verificationStatus}}
router.get('/',asyncHandler(async(req,res)=>{const rows=await prisma.seller.findMany({where:{status:'APPROVED'},include:{products:{where:{status:{in:['PUBLISHED','APPROVED','OUT_OF_STOCK']}},select:{id:true}}},orderBy:{createdAt:'desc'}}); return ok(res,rows.map(s=>{const {products,...seller}=s;return {...profile(seller),foundingSellerActive:Boolean(s.foundingSellerActive)}}))}));
router.post('/apply',requireAuth,asyncHandler(async(req,res)=>{
  if(['ADMIN','SUPER_ADMIN'].includes(req.user.role))return fail(res,400,'INVALID_ROLE','Admin accounts cannot apply as sellers through this endpoint.');
  const d=z.object({
    businessName:z.string().trim().min(2).max(180),
    slug:z.string().min(2).regex(/^[a-z0-9-]+$/),
    bio:z.string().trim().min(1).max(4000),
    category:z.string().trim().min(1).max(100),
    state:z.string().trim().min(1).max(100),
    city:z.string().trim().min(1).max(100),
    lga:z.string().trim().min(1).max(100),
    phone:z.string().trim().min(5).max(40),
    businessEmail:z.string().email().optional(),
    startingPrice:z.number().positive(),
    hasAcceptedTerms:z.literal(true),
    legalBusinessName:z.string().trim().min(1).max(180),
    registrationType:z.string().trim().min(1).max(80),
    cacRegistrationNumber:z.string().trim().min(1).max(100),
    taxIdentificationNumber:z.string().trim().min(1).max(80),
    nationalIdNumber:z.string().regex(/^\d{11}$/),
    registeredAddress:z.string().trim().min(1).max(500),
    bankAccount:z.object({
      bankName:z.string().trim().min(1).max(120),
      accountName:z.string().trim().min(1).max(180),
      accountNumber:z.string().regex(/^\d{10}$/),
      bankCode:z.string().max(20).optional()
    })
  }).parse(req.body);
  if(await prisma.seller.findUnique({where:{userId:req.user.id}}))return fail(res,409,'SELLER_EXISTS','A seller application already exists for this account.');
  let nationalIdNumber,bankAccount;
  try{
    nationalIdNumber=encryptSellerPii(d.nationalIdNumber);
    bankAccount={...d.bankAccount,accountNumber:encryptSellerPii(d.bankAccount.accountNumber)};
  }catch(error){
    if(error.code==='SELLER_PII_KEY_MISSING')return fail(res,503,'SELLER_APPLICATION_STORAGE_UNAVAILABLE','Seller application storage is not configured. Contact marketplace support.');
    throw error;
  }
  const result=await prisma.$transaction(async tx=>{
    const seller=await tx.seller.create({data:{
      userId:req.user.id,businessName:d.businessName,slug:d.slug,bio:d.bio,category:d.category,
      state:d.state,city:d.city,lga:d.lga,phone:d.phone,businessEmail:d.businessEmail,
      startingPrice:d.startingPrice,hasAcceptedTerms:true,termsAcceptedAt:new Date(),
      status:'PENDING',storeStatus:'Under Review',verificationStatus:'UNDER_REVIEW',foundingSellerActive:false,
      verification:{create:{
        legalBusinessName:d.legalBusinessName,registrationType:d.registrationType,
        cacRegistrationNumber:d.cacRegistrationNumber,taxIdentificationNumber:d.taxIdentificationNumber,
        nationalIdType:'NIN',nationalIdNumber,ninVerificationStatus:'PENDING',
        registeredAddress:d.registeredAddress,status:'UNDER_REVIEW'
      }},
      settings:{create:{bankAccount}}
    }});
    await tx.notification.create({data:{audienceRole:'ADMIN',type:'SELLER_APPLICATION',title:'New seller application',message:`${seller.businessName} submitted a seller application.`,data:{sellerId:seller.id}}});
    return {seller};
  });
  await notify({audienceRole:'ADMIN',type:'SELLER_VERIFICATION',title:'Seller verification submitted',message:`${result.seller.businessName} submitted verification documents.`,data:{sellerId:result.seller.id}});
  return ok(res,{...profile(result.seller),status:'PENDING',applicationUnderReview:true},201);
}));
router.get('/me/profile',requireAuth,requireRole('SELLER'),asyncHandler(async(req,res)=>{const s=await prisma.seller.findUnique({where:{userId:req.user.id},include:{settings:true,verification:true}}); if(!s)return fail(res,404,'SELLER_NOT_FOUND','Seller profile not found.'); const listedProducts=await prisma.product.count({where:{sellerId:s.id,status:{in:['PUBLISHED','APPROVED','OUT_OF_STOCK']}}});const effectiveCommissionRate=foundingBenefitActive(s,listedProducts)?10:decimal(s.commissionRate);return ok(res,{...profile(s),effectiveCommissionRate,verification:s.verification?{...s.verification,nationalIdNumber:maskSellerPii(s.verification.nationalIdNumber)}:null})}));
router.patch('/me/profile',requireAuth,requireRole('SELLER'),asyncHandler(async(req,res)=>{const s=await prisma.seller.findUnique({where:{userId:req.user.id}}); if(!s)return fail(res,404,'SELLER_NOT_FOUND','Seller profile not found.'); const allowed=['businessName','bio','category','state','city','lga','phone','businessEmail','returnPolicy','refundPolicy','logoUrl','bannerUrl','profileImageUrl','featuredProductIds']; const data={}; for(const k of allowed)if(req.body[k]!==undefined)data[k]=req.body[k]; if(data.businessName)data.slug=(data.businessName.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,''))+'-'+s.id.slice(-6).toLowerCase(); const u=await prisma.seller.update({where:{id:s.id},data}); await audit(req,'SELLER_PROFILE_UPDATED','Seller',s.id,{}); return ok(res,profile(u))}));
router.get('/me/settings',requireAuth,requireRole('SELLER'),asyncHandler(async(req,res)=>{const s=await prisma.seller.findUnique({where:{userId:req.user.id},include:{settings:true}});const settings=s?.settings;if(!settings)return ok(res,null);let bankAccount=settings.bankAccount;if(bankAccount?.accountNumber)bankAccount={...bankAccount,accountNumber:decryptSellerPii(bankAccount.accountNumber)};return ok(res,{...settings,bankAccount})}));
router.patch('/me/settings',requireAuth,requireRole('SELLER'),asyncHandler(async(req,res)=>{const s=await prisma.seller.findUnique({where:{userId:req.user.id}}); if(!s)return fail(res,404,'SELLER_NOT_FOUND','Seller not found.'); const d=req.body||{};let bankAccount=d.bankAccount;if(bankAccount?.accountNumber){try{bankAccount={...bankAccount,accountNumber:encryptSellerPii(bankAccount.accountNumber)}}catch(error){if(error.code==='SELLER_PII_KEY_MISSING')return fail(res,503,'SELLER_APPLICATION_STORAGE_UNAVAILABLE','Seller application storage is not configured. Contact marketplace support.');throw error;}}const set=await prisma.sellerSetting.upsert({where:{sellerId:s.id},create:{sellerId:s.id,notifications:d.notifications,security:d.security,storeStatus:d.storeStatus,dispatchState:d.dispatchState,dispatchLocation:d.dispatchLocation,deliveryRules:d.deliveryRules,payoutSchedule:d.payoutSchedule,bankAccount},update:{notifications:d.notifications,security:d.security,storeStatus:d.storeStatus,dispatchState:d.dispatchState,dispatchLocation:d.dispatchLocation,deliveryRules:d.deliveryRules,payoutSchedule:d.payoutSchedule,bankAccount}}); return ok(res,{...set,bankAccount:set.bankAccount?{...set.bankAccount,accountNumber:decryptSellerPii(set.bankAccount.accountNumber)}:null})}));
router.get('/me/verification',requireAuth,requireRole('SELLER'),asyncHandler(async(req,res)=>{const s=await prisma.seller.findUnique({where:{userId:req.user.id},include:{verification:true}});const verification=s?.verification||{status:'NOT_STARTED'};return ok(res,{...verification,nationalIdNumber:maskSellerPii(verification.nationalIdNumber)})}));
router.post('/me/verification',requireAuth,requireRole('SELLER'),asyncHandler(async(req,res)=>{
  const s=await prisma.seller.findUnique({where:{userId:req.user.id}});
  if(!s)return fail(res,404,'SELLER_NOT_FOUND','Seller not found.');
  const d=z.object({
    legalBusinessName:z.string().max(180).optional(),registrationType:z.string().max(80).optional(),
    cacRegistrationNumber:z.string().max(100).optional(),taxIdentificationNumber:z.string().max(80).optional(),
    directorName:z.string().max(180).optional(),nationalIdType:z.string().max(40).optional(),
    nationalIdNumber:z.string().regex(/^\d{11}$/).optional(),registeredAddress:z.string().max(500).optional(),
    submittedDocuments:z.record(z.string(),z.unknown()).optional()
  }).parse(req.body||{});
  const previous=await prisma.sellerVerification.findUnique({where:{sellerId:s.id}});
  let encryptedNin;
  if(d.nationalIdNumber){
    try{encryptedNin=encryptSellerPii(d.nationalIdNumber);}catch(error){if(error.code==='SELLER_PII_KEY_MISSING')return fail(res,503,'SELLER_APPLICATION_STORAGE_UNAVAILABLE','Seller application storage is not configured. Contact marketplace support.');throw error;}
  }
  const {nationalIdNumber,...details}=d;
  const history=[...(Array.isArray(previous?.submissionHistory)?previous.submissionHistory:[]),{status:'UNDER_REVIEW',timestamp:new Date().toISOString()}];
  const data={...details,...(encryptedNin?{nationalIdNumber:encryptedNin}:{}),status:'UNDER_REVIEW',rejectionReason:null,submissionHistory:history,ninVerificationStatus:previous?.ninVerificationStatus||'PENDING'};
  const v=await prisma.sellerVerification.upsert({where:{sellerId:s.id},create:{sellerId:s.id,...data},update:data});
  await prisma.seller.update({where:{id:s.id},data:{verificationStatus:'UNDER_REVIEW'}});
  await notify({audienceRole:'ADMIN',type:'SELLER_VERIFICATION',title:'Seller verification submitted',message:`${s.businessName} submitted verification.`,data:{sellerId:s.id}});
  return ok(res,{...v,nationalIdNumber:maskSellerPii(v.nationalIdNumber)});
}));
router.get('/me/products',requireAuth,requireRole('SELLER'),asyncHandler(async(req,res)=>{const s=await prisma.seller.findUnique({where:{userId:req.user.id}});if(!s)return fail(res,404,'SELLER_NOT_FOUND','Seller not found.');const rows=await prisma.product.findMany({where:{sellerId:s.id},include:{images:{orderBy:{sortOrder:'asc'}},variants:true},orderBy:{createdAt:'desc'}});return ok(res,rows)}));
router.get('/:idOrSlug',asyncHandler(async(req,res)=>{const key=req.params.idOrSlug; const s=await prisma.seller.findFirst({where:{OR:[{id:key},{slug:key}]},include:{products:{where:{status:{in:['PUBLISHED','APPROVED','OUT_OF_STOCK']}},include:{images:true,variants:true}},settings:true}}); if(!s||s.status!=='APPROVED')return fail(res,404,'SELLER_NOT_FOUND','Seller store not found.'); const {settings,...publicSeller}=s;return ok(res,{profile:{...profile(publicSeller),foundingSellerActive:Boolean(s.foundingSellerActive)},products:s.products,featuredProducts:s.products.filter(p=>s.featuredProductIds.includes(p.id)).slice(0,3)})}));
module.exports=router;
