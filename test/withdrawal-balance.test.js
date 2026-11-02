const test=require('node:test');
const assert=require('node:assert/strict');
const {DEFAULT_PAYOUT_RELEASE_HOURS,getPayoutReleaseHours,sellerWithdrawalBalance,buyerWalletBalance}=require('../src/lib/withdrawal-balance');

function createSellerDb({orders=[],payouts=[],withdrawals=[],foundingPayoutBenefit=false,payoutReleaseHours=null}={}){
  return {
    marketplaceSetting:{findUnique:async()=>payoutReleaseHours?{value:payoutReleaseHours}:null},
    seller:{findUnique:async()=>({foundingPayoutBenefit})},
    order:{findMany:async()=>orders},
    payout:{findMany:async()=>payouts},
    withdrawalRequest:{findMany:async()=>withdrawals}
  };
}

test('seller balance separates delivery, release, and dispute holds and reserves requested amounts',async()=>{
  const now=new Date('2026-01-03T00:00:00Z');
  const db=createSellerDb({
    foundingPayoutBenefit:true,
    orders:[
      {sellerEarnings:1000,deliveryConfirmedAt:new Date('2026-01-01T00:00:00Z'),payoutEligibleAt:new Date('2026-01-02T00:00:00Z'),payoutReleasedAt:null,refund:null,disputes:[]},
      {sellerEarnings:2000,deliveryConfirmedAt:null,payoutEligibleAt:null,payoutReleasedAt:null,refund:null,disputes:[]},
      {sellerEarnings:3000,deliveryConfirmedAt:new Date('2025-12-31T00:00:00Z'),payoutEligibleAt:new Date('2026-01-01T00:00:00Z'),payoutReleasedAt:null,refund:null,disputes:[{status:'OPEN'}]}
    ],
    payouts:[
      {amount:100,netAmount:80,status:'PAID'},
      {amount:50,netAmount:40,status:'PROCESSING'}
    ],
    withdrawals:[
      {requestedAmount:200,netAmount:180,status:'COMPLETED'},
      {requestedAmount:40,netAmount:36,status:'PROCESSING'}
    ]
  });

  assert.deepEqual(await sellerWithdrawalBalance('seller-1',db,now),{
    totalEarnings:6000,
    pendingDelivery:2000,
    awaitingRelease:0,
    disputed:3000,
    administrativeHold:0,
    pendingClearance:5000,
    totalWithdrawn:280,
    pendingPayouts:90,
    availableBalance:630
  });
});

test('founding sellers wait the same flat 48-hour payout release period as standard sellers',async()=>{
  const db=createSellerDb({
    foundingPayoutBenefit:true,
    orders:[{
      sellerEarnings:500,
      deliveryConfirmedAt:new Date('2026-01-02T12:00:00Z'),
      payoutEligibleAt:null,
      payoutReleasedAt:null,
      refund:null,
      disputes:[]
    }]
  });

  const justBeforeRelease=await sellerWithdrawalBalance('seller-1',db,new Date('2026-01-04T11:59:59Z'));
  assert.equal(justBeforeRelease.awaitingRelease,500);
  assert.equal(justBeforeRelease.availableBalance,0);

  const justAfterRelease=await sellerWithdrawalBalance('seller-1',db,new Date('2026-01-04T12:00:01Z'));
  assert.equal(justAfterRelease.awaitingRelease,0);
  assert.equal(justAfterRelease.availableBalance,500);
});

test('admin-configured payout release periods are applied to order eligibility',async()=>{
  const db=createSellerDb({
    foundingPayoutBenefit:true,
    payoutReleaseHours:{founding:36,standard:72},
    orders:[{
      sellerEarnings:500,
      deliveryConfirmedAt:new Date('2026-01-02T12:00:00Z'),
      payoutEligibleAt:null,
      payoutReleasedAt:null,
      refund:null,
      disputes:[]
    }]
  });

  const result=await sellerWithdrawalBalance('seller-1',db,new Date('2026-01-03T11:59:59Z'));
  assert.equal(result.awaitingRelease,500);
  assert.equal(result.availableBalance,0);
});

test('administrative holds keep otherwise eligible seller earnings unavailable',async()=>{
  const db=createSellerDb({
    orders:[{
      sellerEarnings:900,
      deliveryConfirmedAt:new Date('2026-01-01T00:00:00Z'),
      payoutEligibleAt:new Date('2026-01-02T00:00:00Z'),
      payoutReleasedAt:null,
      adminPayoutHoldReason:'Manual compliance review',
      refund:null,
      disputes:[]
    }]
  });

  const result=await sellerWithdrawalBalance('seller-1',db,new Date('2026-01-03T00:00:00Z'));
  assert.equal(result.administrativeHold,900);
  assert.equal(result.availableBalance,0);
});

test('payout release periods default to a flat 48 hours and reject invalid settings',async()=>{
  assert.deepEqual(DEFAULT_PAYOUT_RELEASE_HOURS,{founding:48,standard:48});
  assert.deepEqual(await getPayoutReleaseHours({marketplaceSetting:{findUnique:async()=>null}}),DEFAULT_PAYOUT_RELEASE_HOURS);
  await assert.rejects(()=>getPayoutReleaseHours({marketplaceSetting:{findUnique:async()=>({value:{founding:0,standard:48}})}}),{code:'PAYOUT_RELEASE_SETTINGS_INVALID'});
});

test('buyer balance uses only available-wallet ledger entries',async()=>{
  let query;
  const db={financialLedgerEntry:{findMany:async(args)=>{
    query=args;
    return [{direction:'CREDIT',amount:1000},{direction:'DEBIT',amount:250}];
  }}};

  assert.equal(await buyerWalletBalance('buyer-1',db),750);
  assert.deepEqual(query.where,{userId:'buyer-1',account:'BUYER_AVAILABLE'});
});
