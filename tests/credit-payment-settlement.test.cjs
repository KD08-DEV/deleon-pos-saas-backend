const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
for(const repo of [path.resolve(__dirname,'..')]) {
 function fixture({paid=0,permission=true,open=true,balance=128-paid}={}) {
  const session={}, payments=paid?[{amount:paid,method:'Tarjeta'}]:[];
  const doc={_id:'AR',status:paid?'partial':'pending',originalAmount:128,paidAmount:paid,balance,payments,async save(opts){assert.equal(opts.session,session);this.saved=true;}};
  const writes=[];
  const deps={
   '../../models/accountReceivableModel':{findOne(q){assert.deepEqual(JSON.parse(JSON.stringify(q)),{tenantId:'T',clientId:'B',orderId:'O'});return {session(s){assert.equal(s,session);return doc;}};}},
   '../../models/cashSessionModel':{async findOneAndUpdate(q,u,o){assert.equal(q.status,'OPEN');assert.equal(q.tenantId,'T');assert.equal(q.clientId,'B');assert.equal(o.session,session);writes.push(u);return open?{_id:'C'}:null;}},
   './creditSaleAccess':{canCreateCreditSale:async()=>permission},
   './orderCorrectionCalculator':require(path.resolve(repo,'services/orders/orderCorrectionCalculator')),
  };
  const mod={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(repo,'services/orders/settleCreditPayment.js'),'utf8'),{module:mod,require:n=>deps[n],Date,Number,String,Math});
  const args={req:{tenantId:'T',clientId:'B',user:{_id:'U'},body:{creditPaymentConfirmed:true,registerId:'MAIN'}},order:{_id:'O',bills:{totalWithTax:128}},tenant:{},session,method:'Efectivo',correctionCode:'COR-TEST'};
  return {doc,writes,args,run:()=>mod.exports(args)};
 }
 for(const paid of [0,40])test(`${repo}: credit settlement collects only remaining ${128-paid}, keeps prior payments and closes receivable`,async()=>{
  const f=fixture({paid}),result=await f.run();
  assert.equal(f.doc.status,'paid');assert.equal(f.doc.balance,0);assert.equal(f.doc.paidAmount,128);
  assert.equal(f.doc.payments.at(-1).amount,128-paid);assert.equal(f.doc.payments.at(-1).cashSessionId,'C');
  if(paid)assert.equal(f.doc.payments[0].method,'Tarjeta');
  assert.equal(result.patch.settledFromCredit,true);assert.equal(result.patch.paymentStatus,'Pagado');assert.equal(result.patch.accountReceivableId,'AR');
  assert.equal(result.settlement.amount,128-paid);assert.equal(f.writes[0].$push.movements.amount,0);
  await assert.rejects(f.run(),/CREDIT_BALANCE_NOT_OPEN/);
 });
 for(const [options,code] of [[{permission:false},'CREDIT_SETTLEMENT_PERMISSION_DENIED'],[{balance:100},'CREDIT_BALANCE_REQUIRES_REVIEW']])test(`${repo}: ${code} leaves credit unpaid`,async()=>{
  const f=fixture(options);await assert.rejects(f.run(),new RegExp(code));assert.equal(f.doc.saved,undefined);assert.equal(f.doc.payments.length,0);
 });
 test(`${repo}: no open cash still records collection with no session`,async()=>{const f=fixture({open:false}),r=await f.run();assert.equal(f.doc.status,'paid');assert.equal(f.doc.payments[0].cashSessionId,null);assert.equal(r.cashSession,null);assert.equal(r.settlement.amount,128);});
 test(`${repo}: requires confirmation before recording money`,async()=>{const f=fixture();f.args.req.body.creditPaymentConfirmed=false;await assert.rejects(f.run(),/CREDIT_PAYMENT_CONFIRMATION_REQUIRED/);assert.equal(f.doc.saved,undefined);});
}
