const test=require('node:test');
const assert=require('node:assert/strict');
const {productShipping,calculateSellerTotals}=require('../src/lib/pricing');
const {verifyNIN}=require('../src/lib/nin-verification');

test('free product shipping does not charge',()=>{
  assert.deepEqual(productShipping([{quantity:3,product:{shipping:{type:'free'}}}],'Lagos'),{configured:true,unavailable:false,total:0});
});
test('flat shipping charges once per product line, per-item multiplies quantity',()=>{
  const rows=productShipping([{quantity:4,product:{shipping:{type:'flat',rate:900}}},{quantity:2,product:{shipping:{type:'per_item',rate:200}}}],'Lagos');
  assert.deepEqual(rows,{configured:true,unavailable:false,total:1300});
});
test('shipping regions reject an unsupported state',()=>{
  assert.equal(productShipping([{quantity:1,product:{shipping:{type:'flat',rate:900,regions:['Lagos']}}}],'Oyo').unavailable,true);
});
test('seller commission overrides are applied to order settlement calculations',async()=>{
  const totals=await calculateSellerTotals({commissionRate:'10.00',settings:{}},[{quantity:1,unitPrice:10000,product:{shipping:{type:'free'}}}],'Lagos');
  assert.equal(totals.commissionRate,10);
  assert.equal(totals.commissionAmount,1000);
  assert.equal(totals.sellerEarnings,9000);
});
test('NIN format is validated before any provider request',async()=>{
  assert.deepEqual(await verifyNIN({nin:'123',firstName:'A',lastName:'B'}),{success:false,code:'INVALID_FORMAT'});
});
