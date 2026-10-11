const prisma=require('./prisma');
async function notify({userId,audienceRole,type,title,message,data}){return prisma.notification.create({data:{userId,audienceRole,type,title,message,data}})}
module.exports={notify}
