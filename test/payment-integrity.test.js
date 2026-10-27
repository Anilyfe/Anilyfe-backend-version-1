const test=require('node:test');
const assert=require('node:assert/strict');
const {orderPendingKey,sessionPendingKey,pendingKeyFor,buildPaymentReference,detectPaymentAnomalies,countBySeverity,claimProviderEvent,PAYMENT_ANOMALY_CODES}=require('../src/lib/payment-integrity');

test('a pending payment key identifies exactly one order or checkout session',()=>{
  assert.equal(orderPendingKey('order-1'),'ORDER:order-1');
  assert.equal(sessionPendingKey('session-1'),'SESSION:session-1');
  assert.equal(pendingKeyFor({orderId:'order-1'}),'ORDER:order-1');
  assert.equal(pendingKeyFor({checkoutSessionId:'session-1'}),'SESSION:session-1');
  assert.equal(pendingKeyFor({orderId:'order-1',checkoutSessionId:'session-1'}),'SESSION:session-1');
  assert.equal(pendingKeyFor({}),null);
});

test('payment references stay prefixed, traceable, and free of unsafe characters',()=>{
  const first=buildPaymentReference('ANL-CS-ABC/123','a1b2c3d4');
  const second=buildPaymentReference('ANL-CS-ABC/123','e5f6a7b8');
  assert.match(first,/^ANL-CS-ABC123-A1B2C3D4$/);
  assert.notEqual(first,second);
  assert.equal(buildPaymentReference('ANL-ORDER-1',''),'ANL-ORDER-1-');
});

test('two settled payments against one order are reported as a duplicate charge',()=>{
  const anomalies=detectPaymentAnomalies({
    orders:[{id:'order-1',orderNumber:'ANL-1',paymentStatus:'PAID'}],
    payments:[
      {id:'pay-1',reference:'ANL-1-A',orderId:'order-1',status:'PAID',amount:5000},
      {id:'pay-2',reference:'ANL-1-B',orderId:'order-1',status:'PAID',amount:5000}
    ]
  });
  const duplicate=anomalies.find(anomaly=>anomaly.code===PAYMENT_ANOMALY_CODES.DUPLICATE_CHARGE);
  assert.ok(duplicate);
  assert.equal(duplicate.severity,'critical');
  assert.deepEqual(duplicate.references,['ANL-1-A','ANL-1-B']);
  assert.equal(duplicate.amount,10000);
  assert.equal(countBySeverity(anomalies).critical,1);
});

test('a settled payment whose order is not paid is reported',()=>{
  const anomalies=detectPaymentAnomalies({
    orders:[{id:'order-1',orderNumber:'ANL-1',paymentStatus:'PENDING'}],
    payments:[{id:'pay-1',reference:'ANL-1-A',orderId:'order-1',status:'PAID',amount:2500}]
  });
  const anomaly=anomalies.find(item=>item.code===PAYMENT_ANOMALY_CODES.ORDER_NOT_PAID);
  assert.ok(anomaly);
  assert.equal(anomaly.orderNumber,'ANL-1');
});

test('more than one payment awaiting settlement for one order is reported',()=>{
  const anomalies=detectPaymentAnomalies({
    orders:[{id:'order-1',orderNumber:'ANL-1',paymentStatus:'PENDING'}],
    payments:[
      {id:'pay-1',reference:'ANL-1-A',orderId:'order-1',status:'PENDING',amount:1000,createdAt:new Date('2026-01-01T00:00:00Z')},
      {id:'pay-2',reference:'ANL-1-B',orderId:'order-1',status:'PENDING',amount:1000,createdAt:new Date('2026-01-01T00:00:00Z')}
    ],
    now:new Date('2026-01-01T00:05:00Z')
  });
  assert.ok(anomalies.some(anomaly=>anomaly.code===PAYMENT_ANOMALY_CODES.DUPLICATE_ACTIVE_PAYMENT));
});

test('a payment left pending beyond the abandoned window is reported',()=>{
  const anomalies=detectPaymentAnomalies({
    orders:[],
    payments:[{id:'pay-1',reference:'ANL-1-A',orderId:'order-1',status:'PENDING',amount:1000,createdAt:new Date('2026-01-01T00:00:00Z')}],
    now:new Date('2026-01-01T02:00:00Z'),
    abandonedMinutes:60
  });
  const abandoned=anomalies.find(anomaly=>anomaly.code===PAYMENT_ANOMALY_CODES.ABANDONED_PAYMENT);
  assert.ok(abandoned);
  assert.equal(abandoned.reference,'ANL-1-A');
});

test('a checkout session with settled payments but a non-paid status is reported',()=>{
  const anomalies=detectPaymentAnomalies({
    orders:[],
    sessions:[{id:'session-1',status:'PENDING_PAYMENT'}],
    payments:[{id:'pay-1',reference:'ANL-CS-1',checkoutSessionId:'session-1',status:'PAID',amount:9000}]
  });
  assert.ok(anomalies.some(anomaly=>anomaly.code===PAYMENT_ANOMALY_CODES.SESSION_NOT_PAID));
});

test('a healthy payment set produces no anomalies',()=>{
  const anomalies=detectPaymentAnomalies({
    orders:[{id:'order-1',orderNumber:'ANL-1',paymentStatus:'PAID'}],
    sessions:[{id:'session-1',status:'PAID'}],
    payments:[{id:'pay-1',reference:'ANL-1-A',orderId:'order-1',status:'PAID',amount:5000}]
  });
  assert.deepEqual(anomalies,[]);
});

test('a duplicate provider event is only processed by one caller',async()=>{
  const stored={id:'event-1',providerEventId:'hash-1',processedAt:null,processingStartedAt:null};
  const db={
    paymentEvent:{
      create:async()=>{const error=Object.assign(new Error('unique violation'));error.code='P2002';throw error;},
      findUnique:async()=>({...stored}),
      updateMany:async(args)=>{
        if(args.where.processedAt!==null)return {count:0};
        stored.processingStartedAt=args.data.processingStartedAt;
        return {count:1};
      }
    }
  };
  const first=await claimProviderEvent(db,{providerEventId:'hash-1',eventType:'charge.success'});
  assert.equal(first.owned,true);
  assert.ok(stored.processingStartedAt);
});

test('an already processed provider event is never processed again',async()=>{
  const db={
    paymentEvent:{
      create:async()=>{const error=Object.assign(new Error('unique violation'));error.code='P2002';throw error;},
      findUnique:async()=>({id:'event-1',processedAt:new Date(),processingStartedAt:new Date()}),
      updateMany:async()=>({count:0})
    }
  };
  const result=await claimProviderEvent(db,{providerEventId:'hash-1',eventType:'charge.success'});
  assert.equal(result.owned,false);
  assert.equal(result.reason,'already_processed');
});

test('an in-flight provider event blocks a second concurrent processor',async()=>{
  const db={
    paymentEvent:{
      create:async()=>{const error=Object.assign(new Error('unique violation'));error.code='P2002';throw error;},
      findUnique:async()=>({id:'event-1',processedAt:null,processingStartedAt:new Date('2026-01-01T00:00:00Z')}),
      updateMany:async()=>({count:0})
    }
  };
  const result=await claimProviderEvent(db,{providerEventId:'hash-1',eventType:'charge.success',now:new Date('2026-01-01T00:01:00Z')});
  assert.equal(result.owned,false);
  assert.equal(result.reason,'in_flight');
});
