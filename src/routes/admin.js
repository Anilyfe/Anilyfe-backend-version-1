const express=require('express'); const {z}=require('zod'); const prisma=require('../lib/prisma'); const {ok,fail,asyncHandler}=require('../lib/http'); const {requireAuth,requireRole}=require('../middleware/auth'); const {notify}=require('../lib/notifications'); const {audit}=require('../lib/audit'); const {commissionRate}=require('../lib/pricing'); const {decryptSellerPii}=require('../lib/seller-pii'); const {DEFAULT_WITHDRAWAL_FEES,validateWithdrawalFeeSchedule}=require('../lib/withdrawal-fees'); const {DEFAULT_PAYOUT_RELEASE_HOURS,validatePayoutReleaseHours}=require('../lib/withdrawal-balance');const {DEFAULT_RESERVATION_TTL_MINUTES,validateReservationTtlMinutes}=require('../lib/reservations');
const router=express.Router();
const ADMIN_USER_SELECT={id:true,email:true,firstName:true,lastName:true,phone:true,profileImageUrl:true,role:true,status:true,state:true,city:true,lga:true,createdAt:true,adminNotes:true};
const ADMIN_USER_SELECT_BASE={...ADMIN_USER_SELECT}; delete ADMIN_USER_SELECT_BASE.adminNotes;
router.get('/dashboard',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>{const [users,sellers,products,orders,pendingSellers,pendingProducts]=await Promise.all([prisma.user.count(),prisma.seller.count(),prisma.product.count(),prisma.order.count(),prisma.seller.count({where:{status:'PENDING'}}),prisma.product.count({where:{status:'PENDING_APPROVAL'}})]);const paid=await prisma.order.findMany({where:{paymentStatus:'PAID'},select:{total:true,commissionAmount:true,sellerEarnings:true}});return ok(res,{stats:{users,sellers,products,orders,pendingSellers,pendingProducts,grossSales:paid.reduce((n,o)=>n+Number(o.total),0),commission:paid.reduce((n,o)=>n+Number(o.commissionAmount),0),sellerEarnings:paid.reduce((n,o)=>n+Number(o.sellerEarnings),0)}})}));
router.get('/users',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>{
  try{
    return ok(res,await prisma.user.findMany({select:ADMIN_USER_SELECT,orderBy:{createdAt:'desc'}}));
  }catch(error){
    const missingOptionalColumn=error?.code==='P2022'||/adminNotes/i.test(String(error?.message||''));
    if(!missingOptionalColumn)throw error;
    const users=await prisma.user.findMany({select:ADMIN_USER_SELECT_BASE,orderBy:{createdAt:'desc'}});
    return ok(res,users.map(user=>({...user,adminNotes:null})));
  }
}));
router.patch('/users/:id/notes',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>{const notes=z.string().max(4000).parse(String(req.body?.notes||''));const user=await prisma.user.update({where:{id:req.params.id},data:{adminNotes:notes}});await audit(req,'USER_ADMIN_NOTES_UPDATED','User',user.id,{});return ok(res,{id:user.id,adminNotes:user.adminNotes})}));
router.get('/sellers',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>{const sellers=await prisma.seller.findMany({include:{user:{select:{id:true,email:true,firstName:true,lastName:true}},verification:true,settings:true},orderBy:{createdAt:'desc'}});return ok(res,sellers.map(s=>({...s,verification:s.verification?{...s.verification,nationalIdNumber:decryptSellerPii(s.verification.nationalIdNumber)}:null,settings:s.settings?{...s.settings,bankAccount:s.settings.bankAccount?{...s.settings.bankAccount,accountNumber:decryptSellerPii(s.settings.bankAccount.accountNumber)}:null}:null})))}));
router.get('/products',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>ok(res,await prisma.product.findMany({include:{seller:true,images:true,variants:true},orderBy:{createdAt:'desc'}}))));
router.patch('/users/:id/status',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>{const {status}=req.body||{};if(!['ACTIVE','SUSPENDED'].includes(status))return fail(res,400,'INVALID_USER_STATUS','Invalid user status.');const u=await prisma.user.update({where:{id:req.params.id},data:{status}});await audit(req,'USER_STATUS_UPDATED','User',u.id,{status});return ok(res,u)}));
router.patch('/sellers/:id/approval',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>{
  const {status,rejectionReason}=req.body||{};
  if(!['APPROVED','REJECTED','SUSPENDED'].includes(status))return fail(res,400,'INVALID_SELLER_STATUS','Invalid seller approval status.');
  const s=await prisma.$transaction(async tx=>{
    const current=await tx.seller.findUnique({where:{id:req.params.id},include:{verification:true}});
    if(!current)throw Object.assign(new Error('Seller not found.'),{code:'P2025'});
    if(status==='APPROVED'&&(!current.hasAcceptedTerms||!current.verification))throw Object.assign(new Error('This seller application is missing accepted terms or verification details.'),{code:'SELLER_APPLICATION_INCOMPLETE'});
    const updated=await tx.seller.update({where:{id:current.id},data:{
      status,rejectionReason:status==='REJECTED'?String(rejectionReason||''):null,
      storeStatus:status==='APPROVED'?'Published':'Under Review',
      verificationStatus:status==='APPROVED'?'APPROVED':status==='REJECTED'?'REJECTED':'UNDER_REVIEW',
      ...(status==='REJECTED'?{foundingSellerActive:false}:{})
    }});
    if(current.verification&&status!=='SUSPENDED')await tx.sellerVerification.update({where:{sellerId:updated.id},data:{
      status:status==='APPROVED'?'APPROVED':status==='REJECTED'?'REJECTED':'UNDER_REVIEW',
      rejectionReason:status==='REJECTED'?String(rejectionReason||''):null,
      reviewedByAdminId:req.user.id,reviewedAt:new Date()
    }});
    await tx.user.update({where:{id:updated.userId},data:{
      role:status==='APPROVED'?'SELLER':status==='REJECTED'?'BUYER':'SELLER',
      status:status==='SUSPENDED'?'SUSPENDED':'ACTIVE'
    }});
    return tx.seller.findUnique({where:{id:updated.id}});
  });
  await notify({userId:s.userId,type:'SELLER_APPROVAL',title:`Seller application ${status.toLowerCase()}`,message:status==='APPROVED'?'Your seller account has been approved.':status==='REJECTED'?'Your seller application was not approved.':'Your seller account has been suspended.',data:{sellerId:s.id,status,rejectionReason,foundingSellerNumber:s.foundingSellerNumber}});
  await audit(req,'SELLER_APPROVAL','Seller',s.id,{status,rejectionReason,foundingSellerNumber:s.foundingSellerNumber});
  return ok(res,s);
}));

router.patch('/sellers/:id/commission',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>{const rate=Number(req.body?.commissionRate);if(!Number.isFinite(rate)||rate<0||rate>100)return fail(res,400,'INVALID_COMMISSION_RATE','Commission must be between 0 and 100.');const seller=await prisma.seller.update({where:{id:req.params.id},data:{commissionRate:rate}});await audit(req,'SELLER_COMMISSION_UPDATED','Seller',seller.id,{commissionRate:rate});return ok(res,seller)}));
router.patch('/sellers/:id/founding-status',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>{
  const parsed=z.object({active:z.boolean()}).safeParse(req.body||{});
  if(!parsed.success)return fail(res,400,'INVALID_FOUNDING_STATUS','Provide a boolean founding-seller status.');
  const {active}=parsed.data;
  const seller=await prisma.seller.findUnique({where:{id:req.params.id},include:{verification:true}});
  if(!seller)return fail(res,404,'SELLER_NOT_FOUND','Seller not found.');
  if(active&&(seller.status!=='APPROVED'||seller.verification?.status!=='APPROVED'))return fail(res,409,'VERIFICATION_REQUIRED','Only an approved and verified seller can receive Founding Seller status.');
  if(active&&await prisma.product.count({where:{sellerId:seller.id,status:{in:['PUBLISHED','APPROVED','OUT_OF_STOCK']}}})<10)return fail(res,409,'FOUNDING_PRODUCT_REQUIREMENT','A seller must have at least 10 listed products before receiving Founding Seller status.');
  let foundingCommissionStartsAt=seller.foundingCommissionStartsAt;
  let foundingCommissionExpiresAt=seller.foundingCommissionExpiresAt;
  const launchDate=process.env.OFFICIAL_LAUNCH_DATE?new Date(process.env.OFFICIAL_LAUNCH_DATE):null;
  if(active&&launchDate&&Number.isFinite(launchDate.getTime())){
    foundingCommissionStartsAt=launchDate;
    foundingCommissionExpiresAt=new Date(launchDate);
    foundingCommissionExpiresAt.setFullYear(foundingCommissionExpiresAt.getFullYear()+1);
  }
  const updated=await prisma.$transaction(async tx=>{
    let number=seller.foundingSellerNumber;
    if(active&&!number){
      const configuredLimit=Number(process.env.FOUNDING_SELLER_LIMIT||50);
      const limit=Number.isFinite(configuredLimit)?Math.min(50,Math.max(0,Math.floor(configuredLimit))):50;
      const used=await tx.seller.findMany({where:{foundingSellerNumber:{not:null}},select:{foundingSellerNumber:true}});
      const assigned=new Set(used.map(row=>row.foundingSellerNumber));
      for(let candidate=1;candidate<=limit;candidate++)if(!assigned.has(candidate)){number=candidate;break;}
      if(!number)throw Object.assign(new Error('All Founding Seller numbers have been assigned.'),{code:'FOUNDING_SELLER_LIMIT_REACHED'});
    }
    return tx.seller.update({where:{id:seller.id},data:{foundingSellerActive:active,foundingPayoutBenefit:active||seller.foundingPayoutBenefit,foundingSellerNumber:number,foundingCommissionStartsAt,foundingCommissionExpiresAt}});
  });
  await audit(req,'FOUNDING_SELLER_STATUS_UPDATED','Seller',seller.id,{active,foundingSellerNumber:updated.foundingSellerNumber});
  return ok(res,updated);
}));

router.get('/management',requireAuth,requireRole('SUPER_ADMIN'),asyncHandler(async(req,res)=>ok(res,await prisma.user.findMany({where:{role:{in:['ADMIN','SUPER_ADMIN']}},select:{id:true,email:true,firstName:true,lastName:true,role:true,status:true,createdAt:true},orderBy:{createdAt:'asc'}}))));
router.post('/management',requireAuth,requireRole('SUPER_ADMIN'),asyncHandler(async(req,res)=>{const d=z.object({email:z.string().email(),role:z.enum(['ADMIN','SUPER_ADMIN'])}).parse(req.body||{});const user=await prisma.user.findUnique({where:{email:d.email.toLowerCase()}});if(!user)return fail(res,404,'USER_NOT_FOUND','Create a verified user account before assigning administrator access.');if(!user.emailVerifiedAt)return fail(res,409,'EMAIL_NOT_VERIFIED','The account email must be verified before administrator access is granted.');const updated=await prisma.user.update({where:{id:user.id},data:{role:d.role,status:'ACTIVE'}});await audit(req,'ADMIN_ROLE_ASSIGNED','User',user.id,{role:d.role});return ok(res,{id:updated.id,email:updated.email,role:updated.role})}));
router.delete('/management/:id',requireAuth,requireRole('SUPER_ADMIN'),asyncHandler(async(req,res)=>{if(req.params.id===req.user.id)return fail(res,409,'CANNOT_REMOVE_SELF','You cannot remove your own administrator access.');const user=await prisma.user.findUnique({where:{id:req.params.id}});if(!user||!['ADMIN','SUPER_ADMIN'].includes(user.role))return fail(res,404,'ADMIN_NOT_FOUND','Administrator not found.');if(user.role==='SUPER_ADMIN'&&await prisma.user.count({where:{role:'SUPER_ADMIN'}})<=1)return fail(res,409,'LAST_SUPER_ADMIN','The last super administrator cannot be removed.');await prisma.user.update({where:{id:user.id},data:{role:'BUYER',authVersion:{increment:1}}});await audit(req,'ADMIN_ROLE_REMOVED','User',user.id,{});return ok(res,{removed:true})}));
router.patch('/products/:id/approval',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>{const {status,rejectionReason}=req.body||{};if(!['APPROVED','PUBLISHED','REJECTED'].includes(status))return fail(res,400,'INVALID_PRODUCT_STATUS','Invalid product approval status.');const p=await prisma.product.findUnique({where:{id:req.params.id},include:{seller:true}});if(!p)return fail(res,404,'PRODUCT_NOT_FOUND','Product not found.');if(p.seller.status!=='APPROVED')return fail(res,409,'SELLER_NOT_APPROVED','Seller must be approved before a product can be published.');if(status==='REJECTED'&&!String(rejectionReason||'').trim())return fail(res,400,'REJECTION_REASON_REQUIRED','A rejection reason is required.');const u=await prisma.product.update({where:{id:p.id},data:{status:status==='APPROVED'?'APPROVED':status,rejectionReason:status==='REJECTED'?rejectionReason:null,rejectedAt:status==='REJECTED'?new Date():null,publishedAt:status==='PUBLISHED'||status==='APPROVED'?new Date():null}});await notify({userId:p.seller.userId,type:status==='REJECTED'?'PRODUCT_REJECTED':'PRODUCT_APPROVED',title:`Product ${status.toLowerCase()}`,message:status==='REJECTED'?`${p.name} was rejected: ${rejectionReason}`:`${p.name} has been approved.`,data:{productId:p.id,status,rejectionReason}});await audit(req,'PRODUCT_APPROVAL','Product',p.id,{status,rejectionReason});return ok(res,u)}));
router.get('/orders',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>ok(res,await prisma.order.findMany({include:{buyer:{select:{id:true,email:true,firstName:true,lastName:true}},seller:true,items:true,payments:true,timeline:true},orderBy:{createdAt:'desc'}}))));
router.patch('/orders/:id/payout-hold',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>{
  const parsed=z.object({held:z.boolean(),reason:z.string().trim().max(1000).optional()}).safeParse(req.body||{});
  if(!parsed.success||parsed.data.held&&(!parsed.data.reason||parsed.data.reason.length<10))return fail(res,400,'INVALID_PAYOUT_HOLD','Provide held=true with a 10-1,000 character reason, or held=false to remove an existing admin hold.');
  const order=await prisma.order.findUnique({where:{id:req.params.id},include:{seller:{select:{userId:true}}}});
  if(!order)return fail(res,404,'ORDER_NOT_FOUND','Order not found.');
  if(order.paymentStatus!=='PAID'||order.payoutReleasedAt)return fail(res,409,'PAYOUT_HOLD_NOT_ALLOWED','Only paid orders that have not been released can have an administrative payout hold.');
  if(!parsed.data.held&&!order.adminPayoutHoldReason)return fail(res,409,'PAYOUT_HOLD_NOT_ACTIVE','This order has no administrative payout hold.');
  const payoutInProgress=await prisma.withdrawalRequest.findFirst({where:{sellerId:order.sellerId,status:'PROCESSING'},select:{id:true}});
  if(payoutInProgress)return fail(res,409,'PAYOUT_ALREADY_PROCESSING','A seller payout is already being executed and cannot be held retroactively.');
  const reason=parsed.data.held?parsed.data.reason.trim():null;
  const changed=await prisma.order.updateMany({where:{id:order.id,paymentStatus:'PAID',payoutReleasedAt:null},data:{adminPayoutHoldReason:reason}});
  if(!changed.count)return fail(res,409,'ORDER_PAYOUT_STATE_CHANGED','The order payout state changed; refresh and retry.');
  await audit(req,parsed.data.held?'ORDER_PAYOUT_HELD':'ORDER_PAYOUT_HOLD_REMOVED','Order',order.id,{reason});
  await notify({userId:order.seller.userId,type:'PAYOUT_HOLD',title:parsed.data.held?'Payout placed on hold':'Payout hold removed',message:parsed.data.held?"An administrator placed this order's earnings on hold. Contact support if you need details.":"The administrative hold on this order's earnings was removed.",data:{orderId:order.id,held:parsed.data.held}});
  return ok(res,{orderId:order.id,adminPayoutHoldReason:reason});
}));
router.get('/support',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>ok(res,await prisma.supportTicket.findMany({include:{messages:true},orderBy:{createdAt:'desc'}}))));
router.get('/audit-logs',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>ok(res,await prisma.auditLog.findMany({orderBy:{createdAt:'desc'},take:500}))));
router.get('/settings',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>{const rows=await prisma.marketplaceSetting.findMany();const obj={};rows.forEach(x=>obj[x.key]=x.value);if(obj.commissionRate===undefined)obj.commissionRate=await commissionRate();if(obj.withdrawalFees===undefined)obj.withdrawalFees=DEFAULT_WITHDRAWAL_FEES;if(obj.payoutReleaseHours===undefined)obj.payoutReleaseHours=DEFAULT_PAYOUT_RELEASE_HOURS;if(obj.reservationTtlMinutes===undefined)obj.reservationTtlMinutes=DEFAULT_RESERVATION_TTL_MINUTES;return ok(res,obj)}));
router.patch('/settings',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>{const settings=req.body||{};if(Object.prototype.hasOwnProperty.call(settings,'withdrawalFees')&&!validateWithdrawalFeeSchedule(settings.withdrawalFees))return fail(res,400,'INVALID_WITHDRAWAL_FEE_SCHEDULE','Buyer and seller schedules must each contain five valid, ascending tiers with a final open-ended tier.');if(Object.prototype.hasOwnProperty.call(settings,'payoutReleaseHours')&&!validatePayoutReleaseHours(settings.payoutReleaseHours))return fail(res,400,'INVALID_PAYOUT_RELEASE_HOURS','Founding and standard payout holds must be whole hours between 1 and 8,760.');if(Object.prototype.hasOwnProperty.call(settings,'reservationTtlMinutes')&&!validateReservationTtlMinutes(Number(settings.reservationTtlMinutes)))return fail(res,400,'INVALID_RESERVATION_TTL','The stock reservation lifetime must be a whole number of minutes between 5 and 10,080.');for(const [key,value] of Object.entries(settings)){await prisma.marketplaceSetting.upsert({where:{key},create:{key,value},update:{value}})}await audit(req,'MARKETPLACE_SETTINGS_UPDATED','MarketplaceSetting',null,{keys:Object.keys(settings),withdrawalFees:settings.withdrawalFees||undefined,payoutReleaseHours:settings.payoutReleaseHours||undefined,reservationTtlMinutes:settings.reservationTtlMinutes});return ok(res,settings)}));
router.post('/announcements',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>{const {text,imageUrl,linkUrl,activeFrom,activeUntil,active=true}=req.body||{};if(!text)return fail(res,400,'VALIDATION_ERROR','Announcement text is required.');const a=await prisma.announcement.create({data:{text,imageUrl,linkUrl,activeFrom:activeFrom?new Date(activeFrom):null,activeUntil:activeUntil?new Date(activeUntil):null,active,createdByAdminId:req.user.id}});return ok(res,a,201)}));
router.get('/announcements',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>ok(res,await prisma.announcement.findMany({orderBy:{createdAt:'desc'}}))));
router.delete('/announcements/:id',requireAuth,requireRole('ADMIN'),asyncHandler(async(req,res)=>{await prisma.announcement.delete({where:{id:req.params.id}});return ok(res,{deleted:true})}));
router.get('/applications',requireAuth,requireRole('SUPER_ADMIN'),asyncHandler(async(req,res)=>{const applications=await prisma.adminApplication.findMany({include:{user:{select:{id:true,email:true,firstName:true,lastName:true,createdAt:true}}},orderBy:[{status:'asc'},{createdAt:'asc'}]});return ok(res,applications)}));
router.patch('/applications/:id/review',requireAuth,requireRole('SUPER_ADMIN'),asyncHandler(async(req,res)=>{
  const {decision,role,reviewNote}=req.body||{};
  if(!['APPROVE','REJECT'].includes(decision))return fail(res,400,'INVALID_DECISION','decision must be APPROVE or REJECT.');
  if(decision==='APPROVE'&&!['ADMIN','SUPER_ADMIN'].includes(role))return fail(res,400,'INVALID_ROLE','An approved application must be assigned ADMIN or SUPER_ADMIN.');
  if(decision==='REJECT'&&role!==undefined)return fail(res,400,'INVALID_ROLE','A rejected application cannot be assigned an administrator role.');
  if(reviewNote!==undefined&&(typeof reviewNote!=='string'||reviewNote.length>1000))return fail(res,400,'INVALID_REVIEW_NOTE','reviewNote must be text of at most 1000 characters.');
  const application=await prisma.$transaction(async tx=>{
    const current=await tx.adminApplication.findUnique({where:{id:req.params.id},include:{user:true}});
    if(!current)throw Object.assign(new Error('Admin application not found.'),{code:'P2025'});
    if(current.status!=='PENDING')throw Object.assign(new Error('This admin application has already been reviewed.'),{code:'APPLICATION_ALREADY_REVIEWED'});
    const assignedRole=decision==='APPROVE'?role:null;
    const changed=await tx.adminApplication.updateMany({where:{id:current.id,status:'PENDING'},data:{status:decision==='APPROVE'?'APPROVED':'REJECTED',assignedRole,reviewedByUserId:req.user.id,reviewNote:reviewNote?.trim()||null,reviewedAt:new Date()}});
    if(changed.count!==1)throw Object.assign(new Error('This admin application has already been reviewed.'),{code:'APPLICATION_ALREADY_REVIEWED'});
    const updated=await tx.adminApplication.findUnique({where:{id:current.id}});
    await tx.user.update({where:{id:current.userId},data:{role:assignedRole||'BUYER',status:'ACTIVE'}});
    await tx.notification.create({data:{userId:current.userId,type:'ADMIN_APPLICATION_REVIEW',title:decision==='APPROVE'?'Admin application approved':'Admin application declined',message:decision==='APPROVE'?`Your application was approved. Assigned role: ${role}.`:'Your administrator application was not approved.',data:{applicationId:current.id,status:updated.status,assignedRole}}});
    return updated;
  });
  await audit(req,decision==='APPROVE'?'ADMIN_APPLICATION_APPROVED':'ADMIN_APPLICATION_REJECTED','AdminApplication',application.id,{assignedRole:application.assignedRole});
  return ok(res,application);
}));
module.exports=router;
