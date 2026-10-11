const jwt=require('jsonwebtoken');
const prisma=require('../lib/prisma');
const {fail}=require('../lib/http');
function cookieToken(req){ const raw=req.headers.cookie||''; const m=raw.match(/(?:^|;\s*)anilyfe_access=([^;]+)/); return m?decodeURIComponent(m[1]):null; }
function sign(user){return jwt.sign({sub:user.id,role:user.role},process.env.JWT_SECRET,{expiresIn:'7d'})}
async function requireAuth(req,res,next){
  const h=req.headers.authorization||''; const token=h.startsWith('Bearer ')?h.slice(7):cookieToken(req); if(!token) return fail(res,401,'AUTH_REQUIRED','Authentication required.');
  try{const p=jwt.verify(token,process.env.JWT_SECRET); const u=await prisma.user.findUnique({where:{id:p.sub}}); if(!u||u.status!=='ACTIVE') return fail(res,401,'AUTH_INVALID','Invalid or inactive account.'); req.user=u; next();}
  catch(e){return fail(res,401,'AUTH_INVALID','Invalid or expired access token.');}
}
function requireRole(...roles){return (req,res,next)=>{const role=req.user?.role;const allowed=roles.includes(role)||(role==='SUPER_ADMIN'&&roles.includes('ADMIN'));return allowed?next():fail(res,403,'FORBIDDEN','You do not have permission to perform this action.')}}
module.exports={sign,requireAuth,requireRole}
