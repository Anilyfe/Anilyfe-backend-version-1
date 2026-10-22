const test=require('node:test');
const assert=require('node:assert/strict');
const {calculatePayoutBalance,HOLD_MS}=require('../src/lib/payout-balance');
const {foundingBenefitActive,calculateSellerTotals}=require('../src/lib/pricing');
const {minimumPrice,validatePrice}=require('../src/lib/product-rules');

test('48-hour payout hold separates pending clearance from available earnings',()=>{
  const now=new Date('2026-10-21T12:00:00Z');
  const balance=calculatePayoutBalance([
    {paidAt:new Date(now.getTime()-HOLD_MS-1000),sellerEarnings:'10000.00'},
    {paidAt:new Date(now.getTime()-HOLD_MS+1000),sellerEarnings:'2500.00'}
  ],[{amount:'2000.00',status:'PENDING'}],now);
  assert.deepEqual(balance,{totalEarnings:12500,pendingClearance:2500,totalWithdrawn:0,pendingPayouts:2000,availableBalance:8000});
});

test('pending and processing payouts reserve mature earnings but failed payouts do not',()=>{
  const now=new Date('2026-10-21T12:00:00Z');
  const orders=[{paidAt:new Date(now.getTime()-HOLD_MS-1000),sellerEarnings:'10000'}];
  assert.equal(calculatePayoutBalance(orders,[{amount:'1000',status:'PROCESSING'},{amount:'500',status:'FAILED'}],now).availableBalance,9000);
});

test('physical and digital product minimum prices apply after discounts and to variants',()=>{
  assert.equal(minimumPrice('PHYSICAL'),2000);
  assert.equal(minimumPrice('DIGITAL'),1000);
  assert.equal(validatePrice('PHYSICAL',2000,0,[{price:2000}]),true);
  assert.equal(validatePrice('PHYSICAL',2000,1,[{price:2000}]),false);
  assert.equal(validatePrice('DIGITAL',1000,0,[{price:999}]),false);
});

test('founding commission requires ten listed products and remains time-bounded from official launch',async()=>{
  const seller={commissionRate:15,foundingSellerActive:true,settings:{}};
  assert.equal(foundingBenefitActive(seller,9,'2026-01-01','2026-06-01'),false);
  assert.equal(foundingBenefitActive(seller,10,'2026-01-01',new Date('2026-06-01')),true);
  assert.equal(foundingBenefitActive(seller,10,'2026-01-01',new Date('2027-01-02')),false);
  const totals=await calculateSellerTotals(seller,[{quantity:1,unitPrice:10000,product:{shipping:{type:'free'}}}],'Lagos',{foundingProductCount:10,launchDate:'2026-01-01',now:new Date('2026-06-01')});
  assert.equal(totals.commissionRate,10);
  assert.equal(totals.commissionAmount,1000);
});

test('stored founding commission dates expire independently of the permanent payout benefit',()=>{
  const seller={foundingSellerActive:true,foundingPayoutBenefit:true,foundingCommissionStartsAt:new Date('2026-01-01T00:00:00Z'),foundingCommissionExpiresAt:new Date('2027-01-01T00:00:00Z')};
  assert.equal(foundingBenefitActive(seller,10,undefined,new Date('2026-12-31T23:59:59Z')),true);
  assert.equal(foundingBenefitActive(seller,10,undefined,new Date('2027-01-01T00:00:00Z')),false);
  assert.equal(seller.foundingPayoutBenefit,true);
});
