const crypto=require('crypto');

function hashEmailOtp(code,secret){
  return crypto.createHash('sha256').update(`${secret}:${code}`).digest('hex');
}

function isEmailOtpValid({storedHash,code,secret,expiresAt,now=Date.now()}){
  if(!storedHash||!expiresAt||new Date(expiresAt).getTime()<=now)return false;
  const expected=Buffer.from(storedHash),actual=Buffer.from(hashEmailOtp(code,secret));
  return expected.length===actual.length&&crypto.timingSafeEqual(expected,actual);
}

function isPendingEmailTargetMatch(pendingEmail,email){
  return typeof pendingEmail==='string'&&typeof email==='string'&&pendingEmail.toLowerCase()===email.trim().toLowerCase();
}

module.exports={hashEmailOtp,isEmailOtpValid,isPendingEmailTargetMatch};
