const test=require('node:test');
const assert=require('node:assert/strict');
const jwt=require('jsonwebtoken');

process.env.JWT_SECRET='anilyfe-session-test-secret-with-enough-entropy';
const {sign,setSession}=require('../src/middleware/auth');

test('admin access tokens last seven days while seller tokens retain one day',()=>{
  const admin=jwt.decode(sign({id:'admin-1',role:'ADMIN',authVersion:0}));
  const seller=jwt.decode(sign({id:'seller-1',role:'SELLER',authVersion:0}));
  assert.equal(admin.exp-admin.iat,7*24*60*60);
  assert.equal(seller.exp-seller.iat,24*60*60);
});

test('admin session cookie persists for seven days and remains HttpOnly',()=>{
  const previous=process.env.NODE_ENV;
  process.env.NODE_ENV='production';
  const headers={};
  setSession({setHeader:(name,value)=>{headers[name]=value;}},'test-token',{role:'SUPER_ADMIN'});
  assert.match(headers['Set-Cookie'],/HttpOnly/);
  assert.match(headers['Set-Cookie'],/SameSite=None/);
  assert.match(headers['Set-Cookie'],/Max-Age=604800/);
  assert.match(headers['Set-Cookie'],/Secure/);
  if(previous===undefined)delete process.env.NODE_ENV; else process.env.NODE_ENV=previous;
});
