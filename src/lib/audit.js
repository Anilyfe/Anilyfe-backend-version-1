const prisma=require('./prisma');
async function audit(req,action,targetType,targetId,metadata={}){try{return await prisma.auditLog.create({data:{actorUserId:req.user?.id||null,action,targetType,targetId,metadata,ipAddress:req.ip}})}catch(e){console.error('audit error',e)}}
module.exports={audit}
