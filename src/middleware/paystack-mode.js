const {fail}=require('../lib/http');

function getPaystackConfig(env=process.env){
  const secretKey=env.PAYSTACK_SECRET_KEY||'';
  const mode=String(env.PAYSTACK_MODE||'').trim().toLowerCase();
  if(!secretKey)return {error:{status:503,code:'PAYSTACK_NOT_CONFIGURED',message:'Paystack is not configured.'}};
  if(mode!=='test'&&mode!=='live')return {error:{status:503,code:'PAYSTACK_MODE_REQUIRED',message:'Set PAYSTACK_MODE to test or live before enabling Paystack.'}};
  const expectedPrefix=mode==='test'?'sk_test_':'sk_live_';
  if(!secretKey.startsWith(expectedPrefix))return {error:{status:503,code:'PAYSTACK_KEY_MODE_MISMATCH',message:'The Paystack key does not match the configured payment mode.'}};
  if(mode==='live'&&env.NODE_ENV!=='production')return {error:{status:503,code:'PAYSTACK_LIVE_DISABLED',message:'Live Paystack payments are disabled outside production.'}};
  return {secretKey};
}

function paystackModeGuard(req,res,next){
  const providerRequest=req.method==='POST'&&(req.path==='/initialize'||req.path==='/webhook'||/^\/verify\/[^/]+$/.test(req.path));
  if(!providerRequest)return next();
  const config=getPaystackConfig();
  if(config.error)return fail(res,config.error.status,config.error.code,config.error.message);
  return next();
}

module.exports={getPaystackConfig,paystackModeGuard};
