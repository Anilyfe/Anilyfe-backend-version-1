const test=require('node:test');
const assert=require('node:assert/strict');
const {encryptSellerPii,decryptSellerPii,maskSellerPii}=require('../src/lib/seller-pii');

test('seller PII is encrypted at rest and can be decrypted for authorized review',()=>{
  const previous=process.env.SELLER_PII_ENCRYPTION_KEY;
  process.env.SELLER_PII_ENCRYPTION_KEY='test-key-used-only-by-this-unit-test';
  try{
    const encrypted=encryptSellerPii('12345678901');
    assert.notEqual(encrypted,'12345678901');
    assert.equal(encrypted.includes('12345678901'),false);
    assert.equal(decryptSellerPii(encrypted),'12345678901');
    assert.equal(maskSellerPii(encrypted),'•••••••8901');
  }finally{
    if(previous===undefined)delete process.env.SELLER_PII_ENCRYPTION_KEY;
    else process.env.SELLER_PII_ENCRYPTION_KEY=previous;
  }
});

test('seller PII encryption fails explicitly when its dedicated key is missing',()=>{
  const previous=process.env.SELLER_PII_ENCRYPTION_KEY;
  delete process.env.SELLER_PII_ENCRYPTION_KEY;
  try{assert.throws(()=>encryptSellerPii('12345678901'),{code:'SELLER_PII_KEY_MISSING'});}
  finally{if(previous!==undefined)process.env.SELLER_PII_ENCRYPTION_KEY=previous;}
});
