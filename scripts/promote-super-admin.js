require('dotenv').config();
const prisma=require('../src/lib/prisma');

(async()=>{
  const email=String(process.argv[2]||'').trim().toLowerCase();
  if(!email){
    console.error('Usage: npm run admin:super-promote -- admin@example.com');
    process.exitCode=1;
    return;
  }
  const user=await prisma.user.findUnique({where:{email}});
  if(!user)throw new Error('User not found. Create or approve the administrator account first.');
  if(user.status!=='ACTIVE')throw new Error('Only an active account can be promoted to super administrator.');
  if(user.role==='SUPER_ADMIN'){
    console.log('Account is already a super administrator.');
    return;
  }
  if(user.role!=='ADMIN')throw new Error('Only an existing administrator can be promoted to super administrator.');
  await prisma.user.update({where:{id:user.id},data:{role:'SUPER_ADMIN'}});
  console.log(`Super administrator role assigned to ${user.email}.`);
})().catch(e=>{console.error(e.message||e);process.exitCode=1}).finally(()=>prisma.$disconnect());
