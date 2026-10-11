const express=require('express');
const multer=require('multer');
const path=require('path');
const fs=require('fs');
const {ok,fail,asyncHandler}=require('../lib/http');
const {requireAuth,requireRole}=require('../middleware/auth');
const router=express.Router();
const dir=path.resolve(process.env.UPLOAD_DIR||'uploads');
fs.mkdirSync(dir,{recursive:true});
const storage=multer.diskStorage({destination:(req,file,cb)=>cb(null,dir),filename:(req,file,cb)=>{const ext=path.extname(file.originalname).toLowerCase();cb(null,`${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`)}});
const imageUpload=multer({storage,limits:{fileSize:8*1024*1024},fileFilter:(req,file,cb)=>cb(null,/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype))});
const documentUpload=multer({storage,limits:{fileSize:10*1024*1024},fileFilter:(req,file,cb)=>cb(null,/^(application\/pdf|image\/(jpeg|png|webp))$/.test(file.mimetype))});
function urlFor(req,file){return `${req.protocol}://${req.get('host')}/uploads/${file.filename}`;}
router.post('/image',requireAuth,imageUpload.single('file'),asyncHandler(async(req,res)=>{if(!req.file)return fail(res,400,'FILE_REQUIRED','An image file is required.');return ok(res,{url:urlFor(req,req.file),filename:req.file.filename,mimeType:req.file.mimetype,size:req.file.size},201)}));
router.post('/document',requireAuth,requireRole('SELLER'),documentUpload.single('file'),asyncHandler(async(req,res)=>{if(!req.file)return fail(res,400,'FILE_REQUIRED','A PDF or image document is required.');return ok(res,{url:urlFor(req,req.file),filename:req.file.filename,mimeType:req.file.mimetype,size:req.file.size},201)}));
module.exports=router;
