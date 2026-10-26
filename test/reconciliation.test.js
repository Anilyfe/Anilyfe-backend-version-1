const test=require('node:test');
const assert=require('node:assert/strict');
const {ledgerAccountBalances,platformFeeSummary,withdrawalExposure,orderTotals,summarizeReconciliation}=require('../src/lib/reconciliation');

const NOW=new Date('2026-03-01T12:00:00Z');

test('ledger account balances net debits against credits',()=>{
  const balances=ledgerAccountBalances([
    {account:'BUYER_AVAILABLE',direction:'CREDIT',amount:1000},
    {account:'BUYER_AVAILABLE',direction:'DEBIT',amount:250},
    {account:'PLATFORM_REVENUE',direction:'CREDIT',amount:75}
  ]);
  assert.deepEqual(balances,[
    {account:'BUYER_AVAILABLE',debits:250,credits:1000,net:750,entries:2},
    {account:'PLATFORM_REVENUE',debits:0,credits:75,net:75,entries:1}
  ]);
});

test('platform revenue separates collected fees, reversals, and provider transfer costs',()=>{
  const summary=platformFeeSummary([
    {account:'PLATFORM_REVENUE',entryType:'WITHDRAWAL_FEE',direction:'CREDIT',amount:100},
    {account:'PLATFORM_REVENUE',entryType:'WITHDRAWAL_FEE_REVERSAL',direction:'DEBIT',amount:40},
    {account:'PLATFORM_REVENUE',entryType:'WITHDRAWAL_TRANSFER_COST',direction:'DEBIT',amount:10},
    {account:'BUYER_AVAILABLE',entryType:'WITHDRAWAL_RESERVED',direction:'DEBIT',amount:500}
  ]);
  assert.deepEqual(summary,{feeCollected:100,feeReversals:40,transferCosts:10,otherDebits:0,netFeeRevenue:50});
});

test('withdrawal exposure separates pending, processing, completed, and stuck transfers',()=>{
  const exposure=withdrawalExposure([
    {id:'w-1',status:'PENDING',accountType:'SELLER',requestedAmount:5000,netAmount:4500,transferFeeAmount:0,createdAt:new Date('2026-03-01T11:00:00Z'),updatedAt:new Date('2026-03-01T11:00:00Z')},
    {id:'w-2',status:'PROCESSING',accountType:'SELLER',requestedAmount:2000,netAmount:1900,transferFeeAmount:0,createdAt:new Date('2026-03-01T09:00:00Z'),updatedAt:new Date('2026-03-01T09:00:00Z')},
    {id:'w-3',status:'PROCESSING',accountType:'BUYER',requestedAmount:1000,netAmount:900,transferFeeAmount:0,createdAt:new Date('2026-03-01T11:59:00Z'),updatedAt:new Date('2026-03-01T11:59:00Z')},
    {id:'w-4',status:'COMPLETED',accountType:'SELLER',requestedAmount:3000,netAmount:2800,transferFeeAmount:25,createdAt:new Date('2026-02-01T09:00:00Z'),updatedAt:new Date('2026-02-01T09:00:00Z')},
    {id:'w-5',status:'FAILED',accountType:'SELLER',requestedAmount:100,netAmount:95,transferFeeAmount:0,createdAt:new Date('2026-02-01T09:00:00Z'),updatedAt:new Date('2026-02-01T09:00:00Z')},
    {id:'w-6',status:'REVERSED',accountType:'SELLER',requestedAmount:100,netAmount:95,transferFeeAmount:0,createdAt:new Date('2026-02-01T09:00:00Z'),updatedAt:new Date('2026-02-01T09:00:00Z')}
  ],NOW,30);
  assert.equal(exposure.pending,1);
  assert.equal(exposure.processing,2);
  assert.equal(exposure.completed,1);
  assert.equal(exposure.failed,1);
  assert.equal(exposure.reversed,1);
  assert.equal(exposure.stuckCount,1);
  assert.equal(exposure.stuck[0].id,'w-2');
  assert.equal(exposure.reservedAmount,8000);
  assert.equal(exposure.payableAmount,7300);
  assert.equal(exposure.transferCosts,25);
});

test('order totals count only paid orders toward gross, commission, and earnings',()=>{
  const totals=orderTotals([
    {paymentStatus:'PAID',total:10000,commissionAmount:1500,sellerEarnings:8500},
    {paymentStatus:'PAID',total:5000,commissionAmount:750,sellerEarnings:4250},
    {paymentStatus:'PENDING',total:9000,commissionAmount:1350,sellerEarnings:7650},
    {paymentStatus:'REFUNDED',total:2000,commissionAmount:300,sellerEarnings:1700}
  ]);
  assert.deepEqual(totals,{gross:15000,commission:2250,sellerEarnings:12750,paidCount:2,refundedCount:1});
});

test('a healthy reconciliation report passes its critical checks',()=>{
  const report=summarizeReconciliation({
    orders:[{id:'o-1',orderNumber:'ANL-1',paymentStatus:'PAID',total:10000,commissionAmount:1500,sellerEarnings:8500}],
    payments:[{id:'p-1',reference:'ANL-1-A',orderId:'o-1',status:'PAID',amount:10000,createdAt:new Date('2026-02-01T00:00:00Z')}],
    sessions:[],
    withdrawals:[{id:'w-1',status:'COMPLETED',accountType:'SELLER',requestedAmount:1000,netAmount:950,feeAmount:50,transferFeeAmount:5,createdAt:new Date('2026-02-01T00:00:00Z'),updatedAt:new Date('2026-02-01T00:00:00Z')}],
    ledgerEntries:[
      {account:'PLATFORM_REVENUE',entryType:'WITHDRAWAL_FEE',direction:'CREDIT',amount:50},
      {account:'PLATFORM_REVENUE',entryType:'WITHDRAWAL_TRANSFER_COST',direction:'DEBIT',amount:5}
    ],
    reservations:[]
  },{now:NOW});
  assert.equal(report.healthy,true);
  assert.deepEqual(report.payments.anomalies,[]);
  assert.equal(report.ledger.fees.netFeeRevenue,45);
  assert.equal(report.withdrawals.completed,1);
  assert.ok(report.checks.find(check=>check.code==='COMMISSION_POSTED_TO_LEDGER').ok===false);
});

test('a duplicate charge fails the critical reconciliation check',()=>{
  const report=summarizeReconciliation({
    orders:[{id:'o-1',orderNumber:'ANL-1',paymentStatus:'PAID',total:10000,commissionAmount:1500,sellerEarnings:8500}],
    payments:[
      {id:'p-1',reference:'ANL-1-A',orderId:'o-1',status:'PAID',amount:10000,createdAt:new Date('2026-02-01T00:00:00Z')},
      {id:'p-2',reference:'ANL-1-B',orderId:'o-1',status:'PAID',amount:10000,createdAt:new Date('2026-02-01T00:00:00Z')}
    ],
    sessions:[],
    withdrawals:[],
    ledgerEntries:[],
    reservations:[]
  },{now:NOW});
  assert.equal(report.healthy,false);
  assert.equal(report.payments.severity.critical,1);
  assert.equal(report.checks.find(check=>check.code==='DUPLICATE_CHARGE_FREE').ok,false);
});

test('a transfer stuck in processing fails the critical reconciliation check',()=>{
  const report=summarizeReconciliation({
    orders:[],
    payments:[],
    sessions:[],
    withdrawals:[{id:'w-2',status:'PROCESSING',accountType:'SELLER',requestedAmount:2000,netAmount:1900,feeAmount:100,transferFeeAmount:0,createdAt:new Date('2026-02-01T00:00:00Z'),updatedAt:new Date('2026-02-01T00:00:00Z')}],
    ledgerEntries:[],
    reservations:[]
  },{now:NOW,stuckMinutes:30});
  assert.equal(report.healthy,false);
  assert.equal(report.withdrawals.stuckCount,1);
  assert.equal(report.checks.find(check=>check.code==='NO_STUCK_TRANSFERS').ok,false);
});
