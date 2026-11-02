require('dotenv').config();
const bcrypt=require('bcryptjs');
const prisma=require('../src/lib/prisma');
function arg(name){const a=process.argv.find(x=>x.startsWith(`--${name}=`));return a?xval(a):null}
function xval(a){return a.slice(a.indexOf('=')+1)}
(async()=>{
 const email=arg('email')?.trim().toLowerCase(); const password=arg('password'); const firstName=arg('firstName')||'ANILyfe'; const lastName=arg('lastName')||'Administrator';
 if(!email||!password){console.error('Usage: npm run admin:create -- --email=admin@example.com --password="strong-password" --firstName=Admin --lastName=User');process.exit(1)}
 if(password.length<8) throw new Error('Admin password must be at least 8 characters.');
 const existing=await prisma.user.findUnique({where:{email}});
 if(existing){if(existing.role==='ADMIN'){console.log('Account is already an administrator.');return;}throw new Error('A user with this email already exists. Use admin:promote with an existing authorized setup process.')}
 const passwordHash=await bcrypt.hash(password,12);
 const u=await prisma.user.create({data:{email,passwordHash,firstName,lastName,role:'ADMIN',status:'ACTIVE',emailVerifiedAt:new Date()}});
 console.log(`Administrator created: ${u.email}`);
})().catch(e=>{console.error(e.message||e);process.exitCode=1}).finally(()=>prisma.$disconnect());
