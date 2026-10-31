const express=require('express');
const crypto=require('crypto');
const {z}=require('zod');
const prisma=require('../lib/prisma');
const multer=require('multer');
const path=require('path');
const fs=require('fs');
const {ok,fail,asyncHandler}=require('../lib/http');
const {requireAuth,requireRole}=require('../middleware/auth');
const {S3Client,PutObjectCommand}=require('@aws-sdk/client-s3');
const {getSignedUrl}=require('@aws-sdk/s3-request-presigner');
const router=express.Router();
const dir=path.resolve(process.env.UPLOAD_DIR||'uploads');
fs.mkdirSync(dir,{recursive:true});
const storage=multer.diskStorage({destination:(req,file,cb)=>cb(null,dir),filename:(req,file,cb)=>{const ext=path.extname(file.originalname).toLowerCase();cb(null,`${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`)}});
const imageUpload=multer({storage,limits:{fileSize:8*1024*1024},fileFilter:(req,file,cb)=>cb(null,/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype))});
const documentUpload=multer({storage,limits:{fileSize:10*1024*1024},fileFilter:(req,file,cb)=>cb(null,/^(application\/pdf|image\/(jpeg|png|webp))$/.test(file.mimetype))});
function urlFor(req,file){return `${req.protocol}://${req.get('host')}/uploads/${file.filename}`;}
function r2Config(){
  const {R2_ACCOUNT_ID,R2_ACCESS_KEY_ID,R2_SECRET_ACCESS_KEY,R2_BUCKET,R2_PUBLIC_URL}=process.env;
  if(!R2_ACCOUNT_ID||!R2_ACCESS_KEY_ID||!R2_SECRET_ACCESS_KEY||!R2_BUCKET||!R2_PUBLIC_URL)return null;
  return {R2_ACCOUNT_ID,R2_ACCESS_KEY_ID,R2_SECRET_ACCESS_KEY,R2_BUCKET,R2_PUBLIC_URL:R2_PUBLIC_URL.replace(/\/$/,'')};
}
function r2Client(config){return new S3Client({region:'auto',endpoint:`https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,credentials:{accessKeyId:config.R2_ACCESS_KEY_ID,secretAccessKey:config.R2_SECRET_ACCESS_KEY}});}
router.post('/presign',requireAuth,requireRole('SELLER'),asyncHandler(async(req,res)=>{
  const s=await prisma.seller.findUnique({where:{userId:req.user.id}});
  if(!s)return fail(res,404,'SELLER_NOT_FOUND','Seller profile not found.');
  const d=z.object({filename:z.string().min(1).max(180),contentType:z.enum(['image/jpeg','image/png','image/webp']),size:z.number().int().positive().max(8*1024*1024)}).parse(req.body||{});
  const config=r2Config();
  if(!config)return fail(res,503,'UPLOAD_STORAGE_UNAVAILABLE','Cloudflare R2 image storage is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET and R2_PUBLIC_URL in the backend environment.');
  const ext={ 'image/jpeg':'jpg','image/png':'png','image/webp':'webp' }[d.contentType];
  const key=`products/${s.id}/${crypto.randomUUID()}.${ext}`;
  const command=new PutObjectCommand({Bucket:config.R2_BUCKET,Key:key,ContentType:d.contentType,ContentLength:d.size});
  const uploadUrl=await getSignedUrl(r2Client(config),command,{expiresIn:300});
  return ok(res,{key,uploadUrl,publicUrl:`${config.R2_PUBLIC_URL}/${key}`,method:'PUT',headers:{'Content-Type':d.contentType},expiresIn:300});
}));
router.post('/image',requireAuth,imageUpload.single('file'),asyncHandler(async(req,res)=>{
  if(!req.file)return fail(res,400,'FILE_REQUIRED','An image file is required.');
  const config=r2Config();
  if(!config&&process.env.NODE_ENV==='production'){
    await fs.promises.unlink(req.file.path).catch(()=>{});
    return fail(res,503,'UPLOAD_STORAGE_UNAVAILABLE','Permanent image storage is not configured. Configure Cloudflare R2 in the backend environment before uploading images.');
  }
  if(!config)return ok(res,{url:urlFor(req,req.file),filename:req.file.filename,mimeType:req.file.mimetype,size:req.file.size,persistent:false},201);
  const extensions={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'};
  const ext=extensions[req.file.mimetype];
  if(!ext){await fs.promises.unlink(req.file.path).catch(()=>{});return fail(res,415,'UNSUPPORTED_IMAGE_TYPE','Upload a JPG, PNG, WEBP or GIF image.');}
  const key=`uploads/${String(req.user.role||'user').toLowerCase()}/${req.user.id}/${crypto.randomUUID()}.${ext}`;
  try{
    const body=await fs.promises.readFile(req.file.path);
    await r2Client(config).send(new PutObjectCommand({Bucket:config.R2_BUCKET,Key:key,Body:body,ContentType:req.file.mimetype,ContentLength:req.file.size}));
    await fs.promises.unlink(req.file.path).catch(()=>{});
    return ok(res,{url:`${config.R2_PUBLIC_URL}/${key}`,filename:key,mimeType:req.file.mimetype,size:req.file.size,persistent:true},201);
  }catch(error){
    await fs.promises.unlink(req.file.path).catch(()=>{});
    console.error('R2 image upload failed:',error?.name||'StorageError');
    return fail(res,503,'IMAGE_UPLOAD_FAILED','The image could not be saved to Cloudflare R2. Check the R2 credentials, bucket permissions and public URL, then try again.');
  }
}));
router.post('/document',requireAuth,requireRole('SELLER'),documentUpload.single('file'),asyncHandler(async(req,res)=>{if(!req.file)return fail(res,400,'FILE_REQUIRED','A PDF or image document is required.');return ok(res,{url:urlFor(req,req.file),filename:req.file.filename,mimeType:req.file.mimetype,size:req.file.size},201)}));
module.exports=router;
