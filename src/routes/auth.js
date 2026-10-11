const express=require('express'); const bcrypt=require('bcryptjs'); const {z}=require('zod'); const prisma=require('../lib/prisma'); const {ok,fail,asyncHandler}=require('../lib/http'); const {sign,requireAuth}=require('../middleware/auth'); const {notify}=require('../lib/notifications');
const router=express.Router();
function setSession(res,token){ const secure=process.env.NODE_ENV==='production'; res.cookieHeader=`anilyfe_access=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=${secure?'None':'Lax'}; Max-Age=604800${secure?'; Secure':''}`; res.setHeader('Set-Cookie',res.cookieHeader); }

const register=z.object({email:z.string().email(),password:z.string().min(8),firstName:z.string().min(1),lastName:z.string().min(1),phone:z.string().optional(),country:z.string().default('Nigeria'),state:z.string().optional(),city:z.string().optional(),lga:z.string().optional()});
router.post('/register',asyncHandler(async(req,res)=>{const d=register.parse(req.body); const exists=await prisma.user.findUnique({where:{email:d.email.toLowerCase()}}); if(exists)return fail(res,409,'EMAIL_EXISTS','An account with this email already exists.'); const hash=await bcrypt.hash(d.password,12); const u=await prisma.user.create({data:{email:d.email.toLowerCase(),passwordHash:hash,firstName:d.firstName,lastName:d.lastName,phone:d.phone,country:d.country,state:d.state,city:d.city,lga:d.lga}}); const token=sign(u); setSession(res,token); return ok(res,{user:{id:u.id,email:u.email,firstName:u.firstName,lastName:u.lastName,role:u.role}},201)}));
const adminApplication=z.object({email:z.string().email(),password:z.string().min(12),firstName:z.string().trim().min(1),lastName:z.string().trim().min(1)});
router.post('/admin-application',asyncHandler(async(req,res)=>{
  const d=adminApplication.parse(req.body);
  const email=d.email.toLowerCase();
  if(await prisma.user.findUnique({where:{email}}))return fail(res,409,'EMAIL_EXISTS','An account with this email already exists.');
  const passwordHash=await bcrypt.hash(d.password,12);
  const application=await prisma.$transaction(async tx=>{
    const user=await tx.user.create({data:{email,passwordHash,firstName:d.firstName,lastName:d.lastName,role:'BUYER',status:'PENDING'}});
    const record=await tx.adminApplication.create({data:{userId:user.id}});
    await tx.notification.create({data:{audienceRole:'SUPER_ADMIN',type:'ADMIN_APPLICATION',title:'Admin application received',message:`${user.firstName} ${user.lastName} submitted an admin application.`,data:{applicationId:record.id}}});
    return record;
  });
  return ok(res,{application:{id:application.id,status:application.status}},201);
}));
router.post('/login',asyncHandler(async(req,res)=>{const {email,password}=req.body||{}; const u=await prisma.user.findUnique({where:{email:String(email||'').toLowerCase()}}); if(!u||!(await bcrypt.compare(String(password||''),u.passwordHash)))return fail(res,401,'INVALID_CREDENTIALS','Email or password is incorrect.'); if(u.status==='PENDING')return fail(res,403,'ADMIN_APPLICATION_PENDING','Your administrator application is awaiting super-admin approval.'); if(u.status!=='ACTIVE')return fail(res,403,'ACCOUNT_INACTIVE','This account is not active.'); const token=sign(u); setSession(res,token); return ok(res,{user:{id:u.id,email:u.email,firstName:u.firstName,lastName:u.lastName,role:u.role}})}));
router.post('/logout',requireAuth,asyncHandler(async(req,res)=>{res.setHeader('Set-Cookie',`anilyfe_access=; Path=/; HttpOnly; SameSite=${process.env.NODE_ENV==='production'?'None':'Lax'}; Max-Age=0${process.env.NODE_ENV==='production'?'; Secure':''}`);return ok(res,{loggedOut:true})}));
router.get('/me',requireAuth,asyncHandler(async(req,res)=>ok(res,{id:req.user.id,email:req.user.email,firstName:req.user.firstName,lastName:req.user.lastName,phone:req.user.phone,role:req.user.role,state:req.user.state,city:req.user.city,lga:req.user.lga,seller:await prisma.seller.findUnique({where:{userId:req.user.id}})})));

router.patch('/me',requireAuth,asyncHandler(async(req,res)=>{const {firstName,lastName,phone,state,city,lga}=req.body||{};const data={};if(firstName!==undefined)data.firstName=String(firstName).trim();if(lastName!==undefined)data.lastName=String(lastName).trim();if(phone!==undefined)data.phone=String(phone).trim();if(state!==undefined)data.state=String(state).trim();if(city!==undefined)data.city=String(city).trim();if(lga!==undefined)data.lga=String(lga).trim();const u=await prisma.user.update({where:{id:req.user.id},data});return ok(res,{id:u.id,email:u.email,firstName:u.firstName,lastName:u.lastName,phone:u.phone,state:u.state,city:u.city,lga:u.lga,role:u.role})}));
router.post('/change-password',requireAuth,asyncHandler(async(req,res)=>{const {currentPassword,newPassword}=req.body||{}; if(!newPassword||String(newPassword).length<8)return fail(res,400,'VALIDATION_ERROR','New password must be at least 8 characters.'); if(!(await bcrypt.compare(String(currentPassword||''),req.user.passwordHash)))return fail(res,401,'INVALID_PASSWORD','Current password is incorrect.'); const hash=await bcrypt.hash(newPassword,12); await prisma.user.update({where:{id:req.user.id},data:{passwordHash:hash}}); await notify({userId:req.user.id,type:'SECURITY',title:'Password changed',message:'Your ANILyfe password was changed.'}); return ok(res,{changed:true})}));
module.exports=router;
