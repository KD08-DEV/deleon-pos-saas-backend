const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),path=require('path');
for(const repo of [path.resolve(__dirname,'..')]){
 function fixture({allowed=true,customer=true,existing=null,open=true,paid=true}={}){
  const session={},created=[],movements=[];
  const deps={
   '../../models/accountReceivableModel':{findOne(q){assert.equal(q.tenantId,'T');assert.equal(q.clientId,'B');return{session:async()=>existing};},async create(rows,opts){assert.equal(opts.session,session);created.push(...rows);return[{...rows[0],_id:'AR'}];}},
   '../../models/customerModel':{findOne(q){assert.equal(q.tenantId,'T');assert.equal(q.clientId,'B');assert.equal(q.isActive.$ne,false);return{session:async()=>customer?{_id:'CUSTOMER',name:'Cliente'}:null};}},
   '../../models/cashSessionModel':{findOne(){return {session:async()=>({_id:'CASH',status:'CLOSED'})};},async findOneAndUpdate(q,u,opts){assert.equal(q._id,'CASH');assert.equal(q.status,'OPEN');assert.equal(opts.session,session);movements.push(u);return open?{_id:'CASH',status:'OPEN'}:null;}},
   './creditSaleAccess':{canCreateCreditSale:async()=>allowed},
   './orderCorrectionCalculator':require(path.resolve(repo,'services/orders/orderCorrectionCalculator')),
  };
  const m={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(repo,'services/orders/convertPaymentToCredit.js'),'utf8'),{module:m,require:n=>deps[n],Date});
  const order={_id:'ORDER',customerId:'CUSTOMER',bills:{totalWithTax:128},paymentMethod:'Tarjeta',paymentStatus:paid?'Pagado':'Pendiente',cashSessionId:'CASH',invoiceNumber:'BILL-1'};
  const args={req:{tenantId:'T',clientId:'B',user:{_id:'USER'},body:{creditConversionConfirmed:true}},order,tenant:{},session,correctionCode:'COR-1'};
  return{created,movements,args,run:()=>m.exports(args)};
 }
 test(repo+': cash to credit creates debt, removes paid state and keeps invoice total',async()=>{
  const f=fixture(),r=await f.run();assert.equal(f.created.length,1);assert.equal(f.created[0].balance,128);assert.equal(f.created[0].paidAmount,0);assert.equal(f.created[0].invoiceNumber,'BILL-1');assert.equal(r.patch.paymentStatus,'Pendiente');assert.equal(r.patch.paidAt,null);assert.equal(r.patch.accountReceivableId,'AR');assert.equal(r.settlement.amount,128);assert.equal(f.movements[0].$push.movements.amount,0);assert.equal(f.args.order.bills.totalWithTax,128);
 });
 for(const [opts,code] of [[{allowed:false},'CREDIT_SETTLEMENT_PERMISSION_DENIED'],[{customer:false},'CUSTOMER_REQUIRED_FOR_CREDIT_SALE'],[{existing:{paidAmount:30}},'CREDIT_HISTORY_REQUIRES_REVIEW']])test(repo+': '+code+' does not create debt',async()=>{const f=fixture(opts);await assert.rejects(f.run(),new RegExp(code));assert.equal(f.created.length,0);});
 test(repo+': closed cash allows conversion without changing its closing',async()=>{const f=fixture({open:false});const r=await f.run();assert.equal(r.cashSession.status,'CLOSED');assert.equal(f.created.length,1);assert.equal(r.patch.paymentStatus,'Pendiente');});
 test(repo+': conversion needs explicit confirmation',async()=>{const f=fixture();f.args.req.body.creditConversionConfirmed=false;await assert.rejects(f.run(),/CREDIT_CONVERSION_CONFIRMATION_REQUIRED/);assert.equal(f.created.length,0);assert.equal(f.movements.length,0);});
}
