const test=require('node:test');
const assert=require('node:assert/strict');
const {hashEmailOtp,isEmailOtpValid,isPendingEmailTargetMatch}=require('../src/lib/email-otp');

test('email OTP accepts the correct code only before expiry',()=>{
  const secret='test-secret';
  const storedHash=hashEmailOtp('123456',secret);
  const expiresAt=new Date('2030-01-01T00:10:00Z');
  const now=new Date('2030-01-01T00:00:00Z').getTime();
  assert.equal(isEmailOtpValid({storedHash,code:'123456',secret,expiresAt,now}),true);
  assert.equal(isEmailOtpValid({storedHash,code:'654321',secret,expiresAt,now}),false);
  assert.equal(isEmailOtpValid({storedHash,code:'123456',secret,expiresAt,now:expiresAt.getTime()}),false);
  assert.equal(isEmailOtpValid({storedHash:null,code:'123456',secret,expiresAt,now}),false);
});

test('email change OTP is bound to the requested address',()=>{
  assert.equal(isPendingEmailTargetMatch('new@example.com','new@example.com'),true);
  assert.equal(isPendingEmailTargetMatch('New@Example.com','new@example.com'),true);
  assert.equal(isPendingEmailTargetMatch('new@example.com','other@example.com'),false);
  assert.equal(isPendingEmailTargetMatch(null,'new@example.com'),false);
});
