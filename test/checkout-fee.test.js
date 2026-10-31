const test=require('node:test');
const assert=require('node:assert/strict');
const {DEFAULT_CHECKOUT_FEES,validateCheckoutFeeSchedule,getCheckoutFeeSchedule,calculateCheckoutFee,allocateCheckoutFee}=require('../src/lib/checkout-fee');
const {calculateSellerTotals}=require('../src/lib/pricing');

test('checkout fees follow each agreed band boundary',()=>{
  for(const [subtotal,fee] of [[0,300],[9999.99,300],[10000,500],[49999.99,500],[50000,1000],[1250000,1000]])assert.equal(calculateCheckoutFee(subtotal),fee);
});

test('the agreed default schedule is three ascending bands starting at zero',()=>{
  assert.deepEqual(DEFAULT_CHECKOUT_FEES,[{from:0,fee:300},{from:10000,fee:500},{from:50000,fee:1000}]);
  assert.equal(validateCheckoutFeeSchedule(DEFAULT_CHECKOUT_FEES),true);
});

test('invalid checkout fee schedules are rejected',()=>{
  assert.equal(validateCheckoutFeeSchedule([]),false);
  assert.equal(validateCheckoutFeeSchedule(null),false);
  assert.equal(validateCheckoutFeeSchedule([{from:500,fee:300}]),false);
  assert.equal(validateCheckoutFeeSchedule([{from:0,fee:300},{from:0,fee:500}]),false);
  assert.equal(validateCheckoutFeeSchedule([{from:0,fee:300},{from:50000,fee:500},{from:10000,fee:1000}]),false);
  assert.equal(validateCheckoutFeeSchedule([{from:0,fee:-1}]),false);
  assert.equal(validateCheckoutFeeSchedule([{from:0,fee:'abc'}]),false);
});

test('checkout fees are read from configuration and bad stored schedules fail loudly',async()=>{
  assert.deepEqual(await getCheckoutFeeSchedule({marketplaceSetting:{findUnique:async()=>null}}),DEFAULT_CHECKOUT_FEES);
  const configured=[{from:0,fee:100},{from:2000,fee:250}];
  assert.deepEqual(await getCheckoutFeeSchedule({marketplaceSetting:{findUnique:async()=>({value:configured})}}),configured);
  await assert.rejects(
    ()=>getCheckoutFeeSchedule({marketplaceSetting:{findUnique:async()=>({value:[{from:400,fee:100}]})}}),
    {code:'CHECKOUT_FEE_SCHEDULE_INVALID'}
  );
});

test('an allocated cart fee always sums back to exactly one fee',()=>{
  const cases=[
    [500,[8000,8000,8000]],
    [1000,[1,1,1,1,1,1]],
    [300,[0,0]],
    [300,[70000,1]],
    [100,[10000]],
    [0,[5000,5000]]
  ];
  for(const [fee,weights] of cases){
    const parts=allocateCheckoutFee(fee,weights);
    assert.equal(parts.length,weights.length);
    assert.equal(Math.round(parts.reduce((sum,part)=>sum+part,0)*100),Math.round(fee*100),`allocation for fee ${fee}`);
    for(const part of parts)assert.ok(part>=0);
  }
  assert.deepEqual(allocateCheckoutFee(500,[24000]),[500]);
  assert.deepEqual(allocateCheckoutFee(500,[8000,8000,8000]),[166.67,166.67,166.66]);
  assert.deepEqual(allocateCheckoutFee(300,[0,0]),[150,150]);
});

test('the checkout fee is charged to the buyer but never inflates commission or seller earnings',async()=>{
  const seller={commissionRate:15,foundingSellerActive:false,settings:{}};
  const items=[{quantity:1,unitPrice:20000,product:{shipping:{type:'free'}}}];
  const withoutFee=await calculateSellerTotals(seller,items,'Lagos',{});
  const withFee=await calculateSellerTotals(seller,items,'Lagos',{buyerFees:500});
  assert.equal(withoutFee.buyerFees,0);
  assert.equal(withoutFee.total,20000);
  assert.equal(withFee.buyerFees,500);
  assert.equal(withFee.total,20500);
  assert.equal(withFee.commissionAmount,withoutFee.commissionAmount);
  assert.equal(withFee.commissionAmount,3000);
  assert.equal(withFee.sellerEarnings,17000);
});
