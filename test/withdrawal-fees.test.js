const test=require('node:test');
const assert=require('node:assert/strict');
const {DEFAULT_WITHDRAWAL_FEES,calculateWithdrawalFee,validateWithdrawalFeeSchedule}=require('../src/lib/withdrawal-fees');

test('buyer withdrawal fees follow each specified tier boundary',()=>{
  for(const [amount,fee] of [[10000,100],[10000.01,200],[30000,200],[30000.01,300],[50000,300],[50000.01,500],[100000,500],[100000.01,1000]])assert.equal(calculateWithdrawalFee('BUYER',amount).feeAmount,fee);
});

test('seller withdrawal fees follow each specified tier boundary',()=>{
  for(const [amount,fee] of [[10000,50],[10000.01,100],[30000,100],[30000.01,200],[50000,200],[50000.01,300],[100000,300],[100000.01,500]])assert.equal(calculateWithdrawalFee('SELLER',amount).feeAmount,fee);
});

test('withdrawal fee is deducted from requested amount',()=>{
  assert.deepEqual(calculateWithdrawalFee('SELLER',20000),{accountType:'SELLER',requestedAmount:20000,feeAmount:100,netAmount:19900});
  assert.deepEqual(calculateWithdrawalFee('BUYER',20000),{accountType:'BUYER',requestedAmount:20000,feeAmount:200,netAmount:19800});
});

test('only well-formed separate buyer/seller fee schedules are accepted',()=>{
  assert.equal(validateWithdrawalFeeSchedule(DEFAULT_WITHDRAWAL_FEES),true);
  assert.equal(validateWithdrawalFeeSchedule({BUYER:[],SELLER:[]}),false);
  assert.throws(()=>calculateWithdrawalFee('ADMIN',1000),TypeError);
  assert.throws(()=>calculateWithdrawalFee('BUYER',0),RangeError);
});
