const test=require('node:test');
const assert=require('node:assert/strict');
const {getPaystackConfig,paystackModeGuard}=require('../src/middleware/paystack-mode');

test('Paystack configuration requires an explicit matching mode and key prefix',()=>{
  assert.equal(getPaystackConfig({}).error.code,'PAYSTACK_NOT_CONFIGURED');
  assert.equal(getPaystackConfig({PAYSTACK_SECRET_KEY:'sk_test_dummy'}).error.code,'PAYSTACK_MODE_REQUIRED');
  assert.equal(getPaystackConfig({PAYSTACK_SECRET_KEY:'sk_live_dummy',PAYSTACK_MODE:'test',NODE_ENV:'production'}).error.code,'PAYSTACK_KEY_MODE_MISMATCH');
  assert.equal(getPaystackConfig({PAYSTACK_SECRET_KEY:'sk_live_dummy',PAYSTACK_MODE:'live',NODE_ENV:'development'}).error.code,'PAYSTACK_LIVE_DISABLED');
  assert.equal(getPaystackConfig({PAYSTACK_SECRET_KEY:'sk_test_dummy',PAYSTACK_MODE:'test',NODE_ENV:'development'}).secretKey,'sk_test_dummy');
  assert.equal(getPaystackConfig({PAYSTACK_SECRET_KEY:'sk_live_dummy',PAYSTACK_MODE:'live',NODE_ENV:'production'}).secretKey,'sk_live_dummy');
});

test('payment read routes bypass the provider-mode guard',()=>{
  let nextCalled=false;
  const res={status(){throw new Error('read route should not be blocked')},json(){throw new Error('read route should not be blocked')}};
  paystackModeGuard({method:'GET',path:'/ANL-reference'},res,()=>{nextCalled=true});
  assert.equal(nextCalled,true);
});

test('provider requests are blocked until a matching mode is configured',()=>{
  const previous={NODE_ENV:process.env.NODE_ENV,PAYSTACK_MODE:process.env.PAYSTACK_MODE,PAYSTACK_SECRET_KEY:process.env.PAYSTACK_SECRET_KEY};
  try{
    process.env.NODE_ENV='development';
    delete process.env.PAYSTACK_MODE;
    delete process.env.PAYSTACK_SECRET_KEY;
    let status=0, response=null, nextCalled=false;
    const res={status(code){status=code;return this},json(body){response=body;return this}};
    paystackModeGuard({method:'POST',path:'/initialize'},res,()=>{nextCalled=true});
    assert.equal(status,503);
    assert.equal(response.error.code,'PAYSTACK_NOT_CONFIGURED');
    assert.equal(nextCalled,false);

    process.env.PAYSTACK_MODE='test';
    process.env.PAYSTACK_SECRET_KEY='sk_test_dummy';
    paystackModeGuard({method:'POST',path:'/initialize'},res,()=>{nextCalled=true});
    assert.equal(nextCalled,true);
  }finally{
    for(const key of Object.keys(previous)){
      if(previous[key]===undefined)delete process.env[key];
      else process.env[key]=previous[key];
    }
  }
});
