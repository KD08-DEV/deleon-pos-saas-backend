const fs=require('fs'),vm=require('vm'),path=require('path'),assert=require('node:assert/strict'),{test}=require('node:test');
function matches(doc,q){return Object.entries(q).every(([k,v])=>{if(k==='$and')return v.every(x=>matches(doc,x));if(k==='$or')return v.some(x=>matches(doc,x));const a=k.split('.').reduce((o,p)=>o?.[p],doc);if(v&&typeof v==='object'&&!(v instanceof Date))return Object.entries(v).every(([op,b])=>({$not:()=>!b.test(String(a||"")),$regex:()=>new RegExp(b,v.$options||"").test(String(a||"")),$options:()=>true,$exists:()=>b?a!==undefined:a===undefined,$ne:()=>a!==b,$nin:()=>!b.includes(a),$gte:()=>a>=b,$lte:()=>a<=b}[op]?.()??false));return v===null?a==null:a===v;});}
function expression(e,doc){
 if(typeof e==='string'&&e.startsWith('$'))return e.slice(1).split('.').reduce((o,k)=>o?.[k],doc);
 if(e==null||typeof e!=='object')return e;
 if(e.$ifNull){const v=expression(e.$ifNull[0],doc);return v??expression(e.$ifNull[1],doc)}
 if(e.$or)return e.$or.some(x=>expression(x,doc));
 if(e.$cond)return expression(e.$cond[expression(e.$cond[0],doc)?1:2],doc);
 if(e.$eq)return expression(e.$eq[0],doc)===expression(e.$eq[1],doc);
 if(e.$regexMatch)return new RegExp(e.$regexMatch.regex,e.$regexMatch.options).test(expression(e.$regexMatch.input,doc));
 throw Error('Unsupported expression '+JSON.stringify(e));
}
for(const repo of [path.resolve(__dirname,'..')]){
const base=path.resolve(repo),filter=require(path.join(base,'utils/salesReportFilter')),tz=require(path.join(base,'utils/timezone'));
const scope={tenantId:'tenant-a',clientId:'default'},paid={...scope,items:[{}],paymentStatus:'Pagado',orderStatus:'En Progreso',createdAt:new Date('2026-11-01T12:00:00Z'),paidAt:new Date('2026-11-09T15:00:00Z'),bills:{totalWithTax:128},cogsTotal:20};
test(repo+': sales recognition includes paid open tables, correction and legacy; excludes draft, void, other scope',()=>{
 const range=tz.getUtcRangeForYMDRange('2026-11-09','2026-11-09','America/Santo_Domingo'),q=filter.buildLegacyReportFilter({...scope,startDate:range.start,endDate:range.end});
 for(const doc of [paid,{...paid,updatedAt:new Date('2026-11-10'),bills:{totalWithTax:256}},{...paid,clientId:undefined},{...paid,paymentStatus:undefined,paidAt:undefined,orderStatus:'Completado',createdAt:new Date('2026-11-09T12:00:00Z')}])assert(matches(doc,q));
 for(const doc of [{...paid,isDraft:true},{...paid,paymentStatus:'Anulado'},{...paid,orderStatus:'Cancelado'},{...paid,clientId:'branch-b'},{...paid,tenantId:'tenant-b'},{...paid,paidAt:new Date('2026-11-09T03:59:59Z')},{...paid,paidAt:new Date('2026-11-10T04:00:00Z')}])assert(!matches(doc,q));
 assert(matches({...paid,paidAt:new Date('2026-11-10T03:59:59Z')},q));
});
test(repo+': credit follows invoice date and remains isolated from other branches',()=>{
 const range=tz.getUtcRangeForYMDRange('2026-11-09','2026-11-09','America/Santo_Domingo');
 const q=filter.buildCreditReportFilter({...scope,startDate:range.start,endDate:range.end});
 const credit={...paid,paymentMethod:'Crédito',paymentStatus:'Pendiente',invoicedAt:new Date('2026-11-09T15:00:00Z')};
 assert(matches(credit,q));
 const settled={...credit,paymentMethod:"Efectivo",paymentStatus:"Pagado",settledFromCredit:true};
 assert(matches(settled,q));assert(!matches(settled,filter.buildLegacyReportFilter({...scope,startDate:range.start,endDate:range.end})));assert(!matches({...credit,clientId:'branch-b'},q));assert(!matches({...credit,invoicedAt:new Date('2026-11-01T15:00:00Z')},q));assert(!matches({...credit,paymentStatus:'Anulado'},q));
});
test(repo+': summary response reconciles costs without counting purchases or payroll twice',async()=>{
 let payload,error,orderQuery,screenshot=false;const stubs={
 '../models/tenantModel':{findOne:()=>({select:()=>({lean:async()=>({localization:{timezone:'America/Santo_Domingo'}})})})},
 '../models/orderModel':{aggregate:async pipeline=>{orderQuery=pipeline[0].$match;assert(matches(paid,orderQuery));const docs=screenshot?[768,640,256].map(total=>({...paid,cogsTotal:0,bills:{totalWithTax:total}})):[paid,{...paid,cogsTotal:undefined}];
 docs.push({...paid,paymentMethod:'Crédito',paymentStatus:'Pendiente',invoicedAt:paid.paidAt,cogsTotal:700,bills:{totalWithTax:640}});
 const included=docs.filter(d=>matches(d,orderQuery));const group=pipeline[1].$group;
 return [Object.fromEntries(Object.entries(group).filter(([k])=>k!=='_id').map(([k,e])=>[k,included.reduce((sum,d)=>sum+expression(e.$sum,d),0)]))]}},
 '../models/inventoryMovementModel':{aggregate:async p=>{assert.equal(p[0].$match.tenantId,'tenant-a');assert(p[0].$match.$or);return [{cost:p[0].$match.type==='purchase'?500:(screenshot?0:6)}]}},
 '../models/expenseModel':{aggregate:async p=>{assert.equal(p[0].$match['source.type'].$ne,'payroll');assert(p[0].$match.$or);return [{total:screenshot?200:10}]}},
 '../models/payrollRunModel':{aggregate:async()=>[{totalNet:screenshot?0:20}]},
 '../utils/timezone':tz,'../utils/salesReportFilter':filter,
 'http-errors':(status,message)=>Object.assign(new Error(message),{status})};
 const box={exports:{},require:n=>{assert(n in stubs,n);return stubs[n]},Date};vm.runInNewContext(fs.readFileSync(path.join(base,'controllers/summaryController.js'),'utf8'),box);
 const req={scope,user:scope,headers:{},query:{from:'2026-11-09',to:'2026-11-09'}};
 await box.exports.getFinanceSummary(req,{json:x=>payload=x},e=>error=e);assert(!error);assert.equal(payload.data.sales.total,256);assert.equal(payload.data.cogsTotal,20);assert.equal(payload.data.grossProfit,236);assert.equal(payload.data.netTotal,200);assert.equal(payload.data.totals.net,200);assert.equal(payload.data.purchases.total,500);assert.equal(payload.data.range.clientId,'default');assert.equal(payload.data.missingCostCount,1);
 assert.equal(payload.data.sales.creditTotal,640);assert.equal(payload.data.sales.count,2);assert.equal(payload.data.sales.creditCount,1);
 screenshot=true;await box.exports.getFinanceSummary(req,{json:x=>payload=x},e=>error=e);
 assert.equal(payload.data.sales.total,1664);assert.equal(payload.data.sales.collectedTotal,1664);assert.equal(payload.data.sales.count,3);assert.equal(payload.data.sales.creditTotal,640);assert.equal(payload.data.netTotal,1464);assert.equal(payload.data.cogsTotal,0);assert.equal(Number((payload.data.sales.total/payload.data.sales.count).toFixed(2)),554.67);
 for(const query of [{from:'2026-11-10',to:'2026-11-09'},{from:'bad',to:'2026-11-09'},{from:'2026-11-09',to:'2026-11-09',clientId:'all'}]){error=null;await box.exports.getFinanceSummary({...req,query},{json:()=>assert.fail('invalid request accepted')},e=>error=e);assert(error?.status===400||error?.status===403);}
});
}
