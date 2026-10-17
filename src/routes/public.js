const express=require('express'); const prisma=require('../lib/prisma'); const {ok,asyncHandler}=require('../lib/http');
const router=express.Router();
router.get('/announcements',asyncHandler(async(req,res)=>{const now=new Date();return ok(res,await prisma.announcement.findMany({where:{active:true,AND:[{OR:[{activeFrom:null},{activeFrom:{lte:now}}]},{OR:[{activeUntil:null},{activeUntil:{gte:now}}]}]},orderBy:{createdAt:'desc'}}))}));
router.get('/settings',asyncHandler(async(req,res)=>{const rows=await prisma.marketplaceSetting.findMany();const obj={};rows.forEach(x=>obj[x.key]=x.value);return ok(res,obj)}));
module.exports=router;
