require('dotenv').config();
const prisma=require('../src/lib/prisma');

(async()=>{
  const email=String(process.argv[2]||'').trim().toLowerCase();
  if(!email)throw new Error('Usage: npm run admin:promote -- admin@example.com');
  const user=await prisma.user.findUnique({where:{email}});
  if(!user)throw new Error('User not found. Create the account normally first.');
  if(user.status!=='ACTIVE')throw new Error('Only active accounts can be promoted to administrator.');
  if(user.role==='SUPER_ADMIN'){
    console.log('Account is already a super administrator.');
    return;
  }
  if(user.role==='ADMIN'){
    console.log('Account is already an administrator.');
    return;
  }
  await prisma.user.update({where:{id:user.id},data:{role:'ADMIN'}});
  console.log(`Admin role assigned to ${user.email}.`);
})().catch(e=>{console.error(e.message||e);process.exitCode=1}).finally(()=>prisma.$disconnect());
