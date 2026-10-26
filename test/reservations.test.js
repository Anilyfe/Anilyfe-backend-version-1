const test=require('node:test');
const assert=require('node:assert/strict');
const {DEFAULT_RESERVATION_TTL_MINUTES,MIN_RESERVATION_TTL_MINUTES,MAX_RESERVATION_TTL_MINUTES,validateReservationTtlMinutes,getReservationTtlMinutes,reservationExpiry,selectExpiredReservations,planReservationReleases,summarizeReservations,reservationExposure,classifyExpiredReservations}=require('../src/lib/reservations');

const NOW=new Date('2026-02-01T12:00:00Z');

test('the reservation lifetime defaults to thirty minutes and rejects invalid settings',async()=>{
  assert.equal(DEFAULT_RESERVATION_TTL_MINUTES,30);
  assert.equal(await getReservationTtlMinutes({marketplaceSetting:{findUnique:async()=>null}}),30);
  assert.equal(await getReservationTtlMinutes({marketplaceSetting:{findUnique:async()=>({value:45})}}),45);
  await assert.rejects(()=>getReservationTtlMinutes({marketplaceSetting:{findUnique:async()=>({value:1})}}),{code:'RESERVATION_TTL_SETTINGS_INVALID'});
  assert.equal(validateReservationTtlMinutes(MIN_RESERVATION_TTL_MINUTES),true);
  assert.equal(validateReservationTtlMinutes(MAX_RESERVATION_TTL_MINUTES),true);
  assert.equal(validateReservationTtlMinutes(MAX_RESERVATION_TTL_MINUTES+1),false);
  assert.equal(validateReservationTtlMinutes(12.5),false);
});

test('a reservation expiry is derived from the configured lifetime',()=>{
  assert.equal(reservationExpiry(NOW,30).toISOString(),'2026-02-01T12:30:00.000Z');
  assert.equal(reservationExpiry(NOW,undefined).toISOString(),'2026-02-01T12:30:00.000Z');
});

test('only held reservations past their expiry are selected for release',()=>{
  const reservations=[
    {id:'r-1',orderId:'o-1',variantId:'v-1',quantity:2,status:'HELD',expiresAt:new Date('2026-02-01T11:00:00Z')},
    {id:'r-2',orderId:'o-2',variantId:'v-1',quantity:1,status:'HELD',expiresAt:new Date('2026-02-01T13:00:00Z')},
    {id:'r-3',orderId:'o-3',variantId:'v-2',quantity:4,status:'CONSUMED',expiresAt:new Date('2026-02-01T11:00:00Z')},
    {id:'r-4',orderId:'o-4',variantId:'v-2',quantity:4,status:'RELEASED',expiresAt:new Date('2026-02-01T11:00:00Z')}
  ];
  const expired=selectExpiredReservations(reservations,NOW);
  assert.deepEqual(expired.map(reservation=>reservation.id),['r-1']);
  assert.deepEqual(planReservationReleases(reservations,NOW),[{reservationId:'r-1',orderId:'o-1',variantId:'v-1',quantity:2,expiresAt:new Date('2026-02-01T11:00:00Z')}]);
});

test('reservation summaries separate held, expired, consumed, and released rows',()=>{
  const summary=summarizeReservations([
    {id:'r-1',quantity:2,status:'HELD',expiresAt:new Date('2026-01-01T00:00:00Z')},
    {id:'r-2',quantity:3,status:'HELD',expiresAt:new Date('2027-01-01T00:00:00Z')},
    {id:'r-3',quantity:1,status:'CONSUMED',expiresAt:new Date('2026-01-01T00:00:00Z')},
    {id:'r-4',quantity:1,status:'RELEASED',expiresAt:new Date('2026-01-01T00:00:00Z')}
  ]);
  assert.deepEqual(summary,{total:4,held:2,heldQuantity:5,consumed:1,released:1,expired:1});
  assert.deepEqual(reservationExposure([{quantity:2,status:'HELD'},{quantity:1,status:'CONSUMED'}]),{heldCount:1,heldQuantity:2});
});

test('an order with a live payment attempt defers its reservation release',()=>{
  const reservations=[{id:'r-1',orderId:'o-1',variantId:'v-1',quantity:2,status:'HELD',expiresAt:new Date('2026-02-01T11:00:00Z')}];
  const orders=[{id:'o-1',orderStatus:'PENDING_PAYMENT',paymentStatus:'PENDING',checkoutSessionId:null}];
  const classified=classifyExpiredReservations({reservations,orders,recentPayments:[{id:'p-1',orderId:'o-1',reference:'ANL-1',createdAt:new Date('2026-02-01T11:59:00Z')}],now:NOW});
  assert.equal(classified.releasable.length,0);
  assert.equal(classified.deferred.length,1);
  assert.equal(classified.stale.length,0);
});

test('a session payment attempt also defers the release of every order in that session',()=>{
  const reservations=[
    {id:'r-1',orderId:'o-1',variantId:'v-1',quantity:2,status:'HELD',expiresAt:new Date('2026-02-01T11:00:00Z')},
    {id:'r-2',orderId:'o-2',variantId:'v-2',quantity:1,status:'HELD',expiresAt:new Date('2026-02-01T11:00:00Z')}
  ];
  const orders=[
    {id:'o-1',orderStatus:'PENDING_PAYMENT',paymentStatus:'PENDING',checkoutSessionId:'s-1'},
    {id:'o-2',orderStatus:'PENDING_PAYMENT',paymentStatus:'PENDING',checkoutSessionId:'s-1'}
  ];
  const classified=classifyExpiredReservations({reservations,orders,recentPayments:[{id:'p-1',orderId:null,checkoutSessionId:'s-1',reference:'ANL-CS-1',createdAt:new Date('2026-02-01T11:59:00Z')}],now:NOW});
  assert.equal(classified.releasable.length,0);
  assert.equal(classified.deferred.length,2);
});

test('a reservation on an order that is already paid is flagged as stale, not released',()=>{
  const reservations=[{id:'r-1',orderId:'o-1',variantId:'v-1',quantity:2,status:'HELD',expiresAt:new Date('2026-02-01T11:00:00Z')}];
  const orders=[{id:'o-1',orderStatus:'CONFIRMED',paymentStatus:'PAID',checkoutSessionId:null}];
  const classified=classifyExpiredReservations({reservations,orders,recentPayments:[],now:NOW});
  assert.equal(classified.releasable.length,0);
  assert.equal(classified.stale.length,1);
});

test('a reservation on an unpaid order with no live payment is releasable',()=>{
  const reservations=[{id:'r-1',orderId:'o-1',variantId:'v-1',quantity:2,status:'HELD',expiresAt:new Date('2026-02-01T11:00:00Z')}];
  const orders=[{id:'o-1',orderStatus:'PENDING_PAYMENT',paymentStatus:'PENDING',checkoutSessionId:null}];
  const classified=classifyExpiredReservations({reservations,orders,recentPayments:[],now:NOW});
  assert.equal(classified.releasable.length,1);
  assert.equal(classified.stale.length,0);
  assert.equal(classified.deferred.length,0);
});
