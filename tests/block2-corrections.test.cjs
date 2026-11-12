const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const O='507f1f77bcf86cd799439011',D='507f1f77bcf86cd799439012';
function fixture(repo,opts={}){
 const tenant={taxConfig:{enabled:true,defaultTaxId:'itbis',taxes:[{id:'itbis',name:'ITBIS',ratePercent:18,active:true,includedInPrice:false}]},features:{tip:{enabled:true},serviceCharges:{enabled:true,charges:[{id:'legal',name:'Propina legal',code:'LEGAL_TIP',ratePercent:10,active:true,calculationBase:'NET',addToTotal:true}]}}};
 const order={_id:O,tenantId:'T',clientId:'default',updatedAt:'2026-11-04T12:00:00Z',paymentMethod:'Efectivo',orderStatus:'En Progreso',paymentStatus:opts.paid?'Pagado':'Pendiente',inventoryDeducted:false,cogsTotal:9,items:[{lineId:'L',dishId:D,name:'QA',unitPrice:100,quantity:1,addons:[],taxId:'itbis'}],bills:{subtotal:100,totalWithTax:128,taxEnabled:true,tipEnabled:false,tipAmount:0},toObject(){return {...this};}};
 const dish={_id:D,name:'QA',price:100,taxId:'itbis',customization:{extras:[{_id:'extra',name:'Extra',price:20,maxQuantity:3}]}};
 const stats={writes:0,audits:[],events:[],ended:0};
 if(opts.inventory)order.inventoryDeducted=true;
 const movements=[{itemId:D,sourceType:'order',type:'sale',qty:1}];
 const inventory={_id:D,stockCurrent:9,avgCost:5,allowNegativeStock:false,async save(){stats.stockWrites=(stats.stockWrites||0)+1;}};
 const q=v=>({select(){return this;},lean(){return this;},session(){return this;},then(resolve,reject){return Promise.resolve(v).then(resolve,reject);}});
 const session={async withTransaction(fn){await fn();},async endSession(){stats.ended++;}};
 const calculator=require(path.resolve(repo,'services/orders/orderCorrectionCalculator'));
 const dependencies={
  "../services/inventory/returnAuthorization":require(path.resolve(repo,"services/inventory/returnAuthorization")),
  "../services/inventory/customizedRecipe":require(path.resolve(repo,"services/inventory/customizedRecipe")),
  mongoose:{isValidObjectId:v=>/^[a-f\d]{24}$/i.test(v),Types:{ObjectId:class{toString(){return D;}}},async startSession(){if(opts.sessionFailure)throw Error('SESSION_UNAVAILABLE');return session;}},
  '../models/orderModel':{findOne(filter){return q(filter.tenantId===order.tenantId&&(!filter.clientId||filter.clientId===order.clientId)?qOrder():null);},findOneAndUpdate(filter,update){assert.equal(filter.updatedAt,order.updatedAt);assert.ok(Number.isFinite(update.$set.cogsTotal ?? order.cogsTotal),'cogsTotal must stay finite');stats.writes++;stats.audits.push(update.$push.correctionHistory);Object.assign(order,update.$set,{updatedAt:'2026-11-04T12:01:00Z'});return q(order);}},
  '../models/tenantModel':{findOne(){return q(tenant);}},
  '../models/dish':{find(){return q([dish]);},findOne(filter){assert.ok(filter.$and,'stock filter must preserve branch clause');assert.equal(filter.$and[0].tenantId,'T');assert.ok(filter.$and[0].$or.some(x=>x.clientId==='default'));return q(inventory);}},
  '../models/inventoryMovementModel':{find(){return q(movements);},async create(rows){movements.push(...rows);}},
  '../models/electronicTaxDocumentModel':{exists(){return q(opts.ecf||false);}},
  '../models/cashSessionModel':{},'../models/orderCorrectionAdjustmentModel':{async create(rows){stats.adjustment=rows;}},
  '../services/orders/orderCorrectionCalculator':calculator,
  '../services/inventory/deductInventoryForOrder':{getExtraStockLines:async()=>[],shouldUseRecipe:()=>false,shouldTrackDirectStock:()=>Boolean(opts.inventory)},
 };
 function qOrder(){return order;}
 const mod={exports:{}};
 const source=process.env.BLOCK2_BASELINE?JSON.parse(fs.readFileSync('BLOQUE_2_2026-11-04/estado-inicial.json')).find(x=>x.file===repo+'/controllers/orderCorrectionController.js').source:fs.readFileSync(repo+'/controllers/orderCorrectionController.js','utf8');
 vm.runInNewContext(source+'\nmodule.exports.testHooks={buildCandidate,reconcileInventory};',{module:mod,require:name=>dependencies[name]||{},console:{error(){}},Date,Map,Set});
 const req={tenantId:'T',clientId:'default',user:{_id:'user'},params:{id:O},body:{reason:'Corrección de prueba',expectedUpdatedAt:order.updatedAt,items:[{...order.items[0],quantity:2,baseUnitPrice:100}]},app:{get(){return{to(room){stats.events.push(room);return{emit(){if(opts.socketFailure)throw Error('SOCKET_DOWN');}};}};}}};
 const invoke=async(preview=false,paymentOnly=false)=>{const res={statusCode:200,status(n){this.statusCode=n;return this;},set(){},json(body){this.body=body;return this;}};await mod.exports[paymentOnly?'correctOrdinaryPaymentMethod':preview?'previewNormalOrderCorrection':'correctNormalOrder'](req,res);return res;};
 return {order,tenant,dish,stats,req,invoke,calculator,inventory,movements,hooks:mod.exports.testHooks};
}
for(const repo of [path.resolve(__dirname,'..')]){
 test(repo+': unpaid item correction preserves finite cost, audit and scope',async()=>{const f=fixture(repo);const r=await f.invoke();assert.equal(r.statusCode,200,JSON.stringify(r.body));assert.equal(f.order.cogsTotal,9);assert.equal(f.stats.audits.length,1);assert.equal(f.order.bills.totalWithTax,256);assert.deepEqual(f.stats.events,['tenant:T:branch:default']);});
 test(repo+': modifiers-only correction is recorded and requires kitchen reprint',async()=>{const f=fixture(repo);f.order.items[0].printedQty=1;f.req.body.items=[{...f.order.items[0],modifiers:[{name:'Sin cebolla'}]}];const r=await f.invoke();assert.equal(r.statusCode,200,JSON.stringify(r.body));assert.ok(f.stats.audits[0].changed.includes('items'));assert.equal(f.order.items[0].printedQty,0);});
 test(repo+': preview distinguishes legal charge and optional manual tip',async()=>{const f=fixture(repo);f.req.body.bills={discount:20,tipEnabled:true,tipAmount:15};const r=await f.invoke(true);assert.equal(r.statusCode,200);assert.equal(r.body.data.bills.tax,32.4);assert.equal(r.body.data.bills.serviceChargeTotal,18);assert.equal(r.body.data.bills.tipAmount,15);assert.equal(r.body.data.newTotal,245.4);assert.equal(f.stats.writes,0);});
 test(repo+': extras and quantities calculated once',async()=>{const f=fixture(repo);f.req.body.items[0].addons=[{extraId:'extra',name:'Extra',quantity:2,price:20}];const r=await f.invoke(true);assert.equal(r.statusCode,200);assert.equal(r.body.data.bills.subtotal,280);assert.equal(r.body.data.newTotal,358.4);});
 test(repo+': explicit zero tip is preserved',async()=>{const f=fixture(repo);f.order.bills.tip=25;f.req.body.bills={tipEnabled:true,tipAmount:0};const r=await f.invoke(true);assert.equal(r.body.data.bills.tipAmount,0);});
 test(repo+': electronic fiscal corrections remain rejected',async()=>{for(const opts of [{ecf:true},{}]){const f=fixture(repo,opts);if(!opts.ecf)f.order.fiscal={ecfDocumentType:'31',ncfNumber:'E310000000001'};const r=await f.invoke();assert.equal(r.statusCode,409);assert.equal(f.stats.writes,0);}});
 test(repo+': another tenant is rejected',async()=>{const f=fixture(repo);f.req.tenantId='other';assert.equal((await f.invoke()).statusCode,404);assert.equal(f.stats.writes,0);});
 test(repo+': paid order needs audited settlement',async()=>{const f=fixture(repo,{paid:true});delete f.req.body.items;f.req.body.bills={tipEnabled:true,tipAmount:15};assert.equal((await f.invoke()).body.code,'SETTLEMENT_CONFIRMATION_REQUIRED');assert.equal(f.stats.writes,0);f.req.body.settlement={direction:'collected',amount:15,confirmed:true};assert.equal((await f.invoke()).statusCode,200);assert.equal(f.stats.adjustment.length,1);});
 test(repo+': stale replay cannot duplicate correction',async()=>{const f=fixture(repo);assert.equal((await f.invoke()).statusCode,200);assert.equal((await f.invoke()).body.code,'ORDER_CHANGED_RELOAD');assert.equal(f.stats.writes,1);});
 test(repo+': socket failure does not deny committed correction',async()=>{const f=fixture(repo,{socketFailure:true});assert.equal((await f.invoke()).statusCode,200);assert.equal(f.stats.writes,1);});
 test(repo+': session initialization failure handled',async()=>{const f=fixture(repo,{sessionFailure:true});const r=await f.invoke();assert.equal(r.statusCode,500);assert.equal(f.stats.writes,0);});
 test(repo+': duplicate lines rejected',async()=>{const f=fixture(repo);f.req.body.items.push({...f.req.body.items[0]});assert.equal((await f.invoke()).body.code,'DUPLICATE_LINE_ID');assert.equal(f.stats.writes,0);});
 test(repo+': inventory delta, restoration and replay do not double deduct',async()=>{const f=fixture(repo,{inventory:true});assert.equal((await f.invoke()).statusCode,200);assert.equal(f.inventory.stockCurrent,8);assert.equal(f.order.cogsTotal,14);assert.equal((await f.invoke()).statusCode,409);assert.equal(f.inventory.stockCurrent,8);f.req.body.expectedUpdatedAt=f.order.updatedAt;f.req.body.items[0].quantity=1;assert.equal((await f.invoke()).statusCode,200);assert.equal(f.inventory.stockCurrent,9);assert.equal(f.order.cogsTotal,9);assert.equal(f.movements.length,3);});
 test(repo+': insufficient stock does not save order or movement',async()=>{const f=fixture(repo,{inventory:true});f.inventory.stockCurrent=0;assert.equal((await f.invoke()).body.code,'INSUFFICIENT_STOCK');assert.equal(f.stats.writes,0);assert.equal(f.stats.stockWrites,undefined);assert.equal(f.movements.length,1);});
 for(const ncfType of ['B01','B02'])test(repo+': audited '+ncfType+' correction preserves fiscal number and payment',async()=>{const f=fixture(repo,{paid:true});f.order.fiscal={requested:true,ncfType,ncfNumber:ncfType+'00000001'};f.order.invoiceNumber='INV-001';f.req.body.settlement={confirmed:true,direction:'collected',amount:128};const r=await f.invoke();assert.equal(r.statusCode,200,JSON.stringify(r.body));assert.equal(f.order.fiscal.ncfNumber,ncfType+'00000001');assert.equal(f.order.invoiceNumber,'INV-001');assert.equal(f.order.paymentStatus,'Pagado');assert.equal(f.stats.audits.length,1);});
 test(repo+': no-stock paid correction is allowed but unverified tracked change is denied in preview and apply',async()=>{const plain=fixture(repo,{paid:true});assert.equal((await plain.invoke(true)).statusCode,200);const tracked=fixture(repo,{paid:true,inventory:true});tracked.order.inventoryDeducted=false;assert.equal((await tracked.invoke(true)).body.code,'INVENTORY_STATE_UNVERIFIED');assert.equal((await tracked.invoke()).body.code,'INVENTORY_STATE_UNVERIFIED');assert.equal(tracked.stats.writes,0);});
 for(const taxEnabled of [true,false])for(const legalTipEnabled of [true,false])test(`${repo}: independent tax=${taxEnabled} legal=${legalTipEnabled} plus manual tip`,async()=>{const f=fixture(repo);f.req.body.bills={taxEnabled,legalTipEnabled,tipEnabled:true,tipAmount:15};const r=await f.invoke();assert.equal(r.statusCode,200,JSON.stringify(r.body));assert.equal(f.order.bills.totalWithTax,200+(taxEnabled?36:0)+(legalTipEnabled?20:0)+15);assert.equal(f.order.bills.legalTipEnabled,legalTipEnabled);});
 test(repo+': add and remove product lines retain audit details',async()=>{const f=fixture(repo);f.req.body.items=[{...f.order.items[0]},{...f.order.items[0],lineId:'L2'}];assert.equal((await f.invoke()).statusCode,200);assert.equal(f.order.items.length,2);f.req.body.expectedUpdatedAt=f.order.updatedAt;f.req.body.items=[{...f.order.items[0]}];assert.equal((await f.invoke()).statusCode,200);assert.equal(f.order.items.length,1);assert.equal(f.stats.audits[1].previousItems.length,2);assert.equal(f.stats.audits[1].nextItems.length,1);});
 test(repo+': branch scope cannot edit another branch',async()=>{const f=fixture(repo);f.req.clientId='other';assert.equal((await f.invoke()).statusCode,404);assert.equal(f.stats.writes,0);});
 test(repo+': effective correction permission respects role, flag and branch',async()=>{
  const source=fs.readFileSync(repo+'/routes/orderRoute.js','utf8');let membership=null;
  const context={Membership:{findOne(filter){assert.equal(filter.status,'active');assert.equal(filter.tenantId,'T');return{select(){return this;},async lean(){return membership;}};}}};
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('async function correctionAccess'),source.indexOf('router.get("/correction/access"')),context);
  const req={user:{_id:'U'},tenantId:'T',clientId:'east'};
  assert.equal(await context.correctionAccess(req),false);
  for(const [role,edit,branches,expected] of [['Camarero',true,['east'],false],['Cajera',false,['east'],false],['Cajera',true,['west'],false],['Cajera',true,['east'],true],['Admin',false,[],true]]){membership={role,permissions:{orders:{edit}},clientIds:branches};assert.equal(await context.correctionAccess(req),expected);}
 });
}

for(const repo of [path.resolve(__dirname,'..')]) {
 test(repo+': narrow payment correction preserves invoice, costs and totals',async()=>{const f=fixture(repo,{paid:true});f.order.invoiceNumber='001';const bills=f.order.bills;f.req.body={paymentMethod:'Tarjeta',expectedUpdatedAt:f.order.updatedAt};const r=await f.invoke(false,true);assert.equal(r.statusCode,200);assert.equal(f.order.invoiceNumber,'001');assert.equal(f.order.bills,bills);assert.equal(f.order.cogsTotal,9);assert.equal(f.order.paymentMethod,'Tarjeta');});
 test(repo+': credit shortcut still rejects issued electronic documents',async()=>{const f=fixture(repo,{ecf:true});f.order.paymentMethod='Credito';f.order.accountReceivableId='AR';f.req.body={paymentMethod:'Efectivo',expectedUpdatedAt:f.order.updatedAt,creditPaymentConfirmed:true};const r=await f.invoke(false,true);assert.equal(r.statusCode,409);assert.equal(r.body.code,'ECF_DOCUMENT_EXISTS');assert.equal(f.stats.writes,0);});
}
