const { wasPrepared, authorizeInventoryReturn } = require("../services/inventory/returnAuthorization");
const { customizedRecipe } = require("../services/inventory/customizedRecipe");
"use strict";
const mongoose=require("mongoose");
const Order=require("../models/orderModel");
const Tenant=require("../models/tenantModel");
const Dish=require("../models/dish");
const User=require("../models/userModel");
const CashSession=require("../models/cashSessionModel");
const OrderCorrectionAdjustment=require("../models/orderCorrectionAdjustmentModel");
const InventoryMovement=require("../models/inventoryMovementModel");
const ElectronicTaxDocument=require("../models/electronicTaxDocumentModel");
const {getTenantTimezone,getYMDInTimeZone}=require("../utils/timezone");
const {summarize,bad,money,round}=require("../services/orders/orderCorrectionCalculator");
const {getExtraStockLines,shouldUseRecipe,shouldTrackDirectStock}=require("../services/inventory/deductInventoryForOrder");

const NON_CREDIT_METHODS = new Set(["Efectivo","Tarjeta","Transferencia","Pedido Ya","Uber Eats","Otros"]);
function fiscalLocked(o){
  const number=String(o?.fiscal?.ncfNumber||o?.ncfNumber||"");
  const traditional=["B01","B02"].includes(o?.fiscal?.ncfType)||/^B0[12]\d+$/.test(number);
  return Boolean(o?.fiscal?.ecfDocumentType||o?.eNCF||o?.ecf?.eNCF||o?.ecf?.exists||o?.accountReceivableId||
    (number&&!/^B0[12]\d+$/.test(number))||(o?.fiscal?.requested&&!traditional));
}
const owns= (req,id)=>({_id:id,tenantId:req.tenantId,...(req.clientId==="default"?{$or:[{clientId:"default"},{clientId:{$exists:false}},{clientId:null},{clientId:""}]}:{clientId:req.clientId})});
const dishScope=req=>({tenantId:req.tenantId,...(req.clientId==="default"?{$or:[{clientId:"default"},{clientId:{$exists:false}},{clientId:null}]}:{clientId:req.clientId}),isArchived:{$ne:true}});
async function getOrderAndTenant(req,session){
  if(!mongoose.isValidObjectId(req.params.id))throw bad("ORDER_NOT_FOUND",404);
  if(!req.tenantId||!req.clientId||!req.user?._id)throw bad("UNAUTHORIZED_SCOPE",403);
  const oq=Order.findOne(owns(req,req.params.id)).select("+correctionHistory");
  const tq=Tenant.findOne({tenantId:req.tenantId}).lean();
  const [order,tenant]=await Promise.all([session?oq.session(session):oq,session?tq.session(session):tq]);
  if(!order)throw bad("ORDER_NOT_FOUND",404);
  if(!tenant)throw bad("TENANT_NOT_FOUND",404);
  if(order.orderStatus==="Cancelado"||order.paymentStatus==="Anulado")throw bad("ORDER_CANCELLED",409);
  if(fiscalLocked(order)||order.paymentMethod==="Credito"||order.creditStatus&&order.creditStatus!=="none")throw bad("FISCAL_OR_CREDIT_ORDER_LOCKED",409);
  const eq=ElectronicTaxDocument.exists({tenantId:req.tenantId,orderId:order._id});
  if(await(session?eq.session(session):eq))throw bad("ECF_DOCUMENT_EXISTS",409);
  return {order,tenant};
}
function normalizeAddon(add, dish, originalLine){
  const extraId=String(add?.extraId||"").trim();
  const extraDishId=String(add?.extraDishId||"").trim();
  const defs=dish?.customization?.extras||[];
  const definition=defs.find(x=>x.active!==false&&(
    (extraId&&String(x._id)===extraId) ||
    (extraDishId&&x.extraDishId&&String(x.extraDishId)===extraDishId)
  ));
  // Preservar extras comerciales de líneas históricas existentes; no inventar referencias de inventario.
  const legacy=(originalLine?.addons||[]).find(x=>String(x?.extraId||"")===extraId&&String(x?.extraDishId||"")===extraDishId&&String(x?.name||"")===String(add?.name||""));
  if(!definition&&!legacy)throw bad("EXTRA_NOT_ALLOWED_FOR_DISH",409);
  const qty=Number(add.quantity??1);
  if(!Number.isInteger(qty)||qty<1||qty>(definition?.maxQuantity||legacy?.quantity||5))throw bad("INVALID_EXTRA_QUANTITY");
  const price=money(add.price??definition?.price??legacy?.price??0,"EXTRA_PRICE");
  return {extraId:definition?String(definition._id):extraId,extraDishId:definition?.extraDishId||legacy?.extraDishId||null,name:definition?.name||legacy?.name||"Extra",quantity:qty,price};
}
async function buildCandidate(req,order,tenant,session){
  const p=req.body||{};
  const legalKeys=["items","bills","paymentMethod","orderNote","reason","expectedUpdatedAt","settlement","inventoryReturnConfirmed"];
  if(Object.keys(p).some(k=>!legalKeys.includes(k)))throw bad("UNSUPPORTED_CORRECTION_FIELD");
  const method=p.paymentMethod??order.paymentMethod;
  if(!NON_CREDIT_METHODS.has(method))throw bad("PAYMENT_METHOD_NOT_SUPPORTED");
  const note=p.orderNote??order.orderNote??"";
  if(typeof note!=="string"||note.length>1500)throw bad("INVALID_ORDER_NOTE");
  const input=Array.isArray(p.items)?p.items:order.items.map(x=>x.toObject?x.toObject():x);
  if(!input.length||input.length>80)throw bad("INVALID_ITEMS");
  const rawIds=input.map(x=>String(x.dishId||""));
  if(rawIds.some(id=>!mongoose.isValidObjectId(id)))throw bad("DISH_ID_REQUIRED");
  const dishesQuery=Dish.find({...dishScope(req),_id:{$in:rawIds}}).select("_id name category price productionArea customization recipe taxId taxIncludedOverride inventoryType isInventoryItem inventoryCategoryId allowNegativeStock stockCurrent avgCost lastCost").lean();
  const dishes=await(session?dishesQuery.session(session):dishesQuery);
  const dishMap=new Map(dishes.map(d=>[String(d._id),d]));
  const oldLines=new Map((order.items||[]).map(x=>[String(x.lineId),x.toObject?x.toObject():x]));
  const normalized=[]; const lineIds=new Set();
  for(const [index,line] of input.entries()){
    const dish=dishMap.get(String(line.dishId));
    if(!dish)throw bad("DISH_NOT_FOUND_IN_BRANCH",409);
    const old=oldLines.get(String(line.lineId||""));
    const lineId=String(line.lineId||`edit-${index}-${String(new mongoose.Types.ObjectId())}`);
    if(lineIds.has(lineId))throw bad("DUPLICATE_LINE_ID");lineIds.add(lineId);
    const qty=Number(line.quantity);if(!Number.isFinite(qty)||qty<=0||qty>9999)throw bad("INVALID_ITEM_QUANTITY");
    const extras=(line.addons||[]);if(!Array.isArray(extras)||extras.length>25)throw bad("INVALID_EXTRAS");
    const addons=extras.map(x=>normalizeAddon(x,dish,old));
    const base=money(line.baseUnitPrice??(Number(line.unitPrice||0)-addons.reduce((s,a)=>s+a.price*a.quantity,0)),"BASE_PRICE");
    const unitPrice=round(base+addons.reduce((s,a)=>s+a.price*a.quantity,0));
    const requestedTaxId=line.taxId===undefined?dish.taxId:String(line.taxId||"").trim()||dish.taxId;
    const availableTaxes=tenant?.taxConfig?.taxes||[];
    if(requestedTaxId && availableTaxes.length && !availableTaxes.some(t=>String(t.id)===String(requestedTaxId)&&t.active!==false))throw bad("ITEM_TAX_NOT_ACTIVE",400);
    const taxIncluded=typeof line.taxIncludedOverride==="boolean"?line.taxIncludedOverride:(typeof dish.taxIncludedOverride==="boolean"?dish.taxIncludedOverride:null);
    normalized.push({lineId,dishId:dish._id,name:dish.name,category:dish.category||"",presentation:String(line.presentation||"Regular").slice(0,100),productionArea:dish.productionArea||"kitchen",qtyType:line.qtyType==="weight"?"weight":"unit",weightUnit:line.weightUnit==="kg"?"kg":"lb",quantity:qty,unitPrice,price:round(unitPrice*qty),addons,modifiers:Array.isArray(line.modifiers)?line.modifiers.slice(0,25):[],note:String(line.note||"").slice(0,500),taxId:requestedTaxId||null,taxIncludedOverride:taxIncluded,printedQty:old&&JSON.stringify(old.addons||[])===JSON.stringify(addons)&&old.quantity===qty&&JSON.stringify(old.modifiers||[])===JSON.stringify(line.modifiers||[])&&String(old.note||"")===String(line.note||"").slice(0,500)&&String(old.presentation||"Regular")===String(line.presentation||"Regular").slice(0,100)?old.printedQty||0:0});
  }
  const existing=order.bills?.toObject?order.bills.toObject():order.bills||{};
  const incoming=p.bills||{};
  if(!incoming||typeof incoming!=="object"||Array.isArray(incoming))throw bad("INVALID_BILLS");
  const keys=["discount","taxEnabled","legalTipEnabled","tipEnabled","tipAmount","deliveryFee"];
  if(Object.keys(incoming).some(k=>!keys.includes(k)))throw bad("UNSUPPORTED_BILL_FIELD");
  if(["taxEnabled","legalTipEnabled","tipEnabled"].some(k=>incoming[k]!==undefined&&typeof incoming[k]!=="boolean"))throw bad("INVALID_BILL_FLAGS");
  const bills={legalTipEnabled:incoming.legalTipEnabled??existing.legalTipEnabled??true,discount:incoming.discount??existing.discount??0,taxEnabled:incoming.taxEnabled??existing.taxEnabled??true,tipEnabled:incoming.tipEnabled??existing.tipEnabled??true,tipAmount:incoming.tipAmount??existing.tipAmount??existing.tip??0,deliveryFee:incoming.deliveryFee??existing.deliveryFee??0};
  const calculated=summarize({tenant,items:normalized,bills,source:order.orderSource,commissionRate:order.commissionRate});
  const previousTotal=round(Number(existing.totalWithTax??existing.total??0));
  const newTotal=calculated.bills.totalWithTax;
  const delta=round(newTotal-previousTotal);
  const oldItemList=(order.items||[]).map(i=>i.toObject?i.toObject():i);
  const normalizedExtras=(line)=> (line.addons||[]).map(e=>({
    extraId:String(e?.extraId||""),extraDishId:String(e?.extraDishId||""),
    name:String(e?.name||""),quantity:Number(e?.quantity??e?.extraQuantity??1),price:round(Number(e?.price||0))
  })).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const itemView=rows=>rows.map(i=>({
    lineId:String(i.lineId||""),dishId:String(i.dishId||""),quantity:Number(i.quantity||0),unitPrice:round(Number(i.unitPrice||0)),
    addons:normalizedExtras(i),modifiers:Array.isArray(i.modifiers)?i.modifiers:[],note:String(i.note||""),presentation:String(i.presentation||"Regular"),
    taxId:String(i.taxId||""),taxIncludedOverride:i.taxIncludedOverride??null,
  }));
  const stockView=rows=>rows.map(i=>({modifiers:(i.modifiers||[]).filter(m=>m.type==="remove"),dishId:String(i.dishId||""),quantity:Number(i.quantity||0),
    addons:normalizedExtras(i).filter(e=>e.extraDishId).map(e=>({extraDishId:e.extraDishId,quantity:e.quantity}))}));
  const previousLines=itemView(oldItemList);
  const newLines=itemView(normalized);
  const itemsChanged=JSON.stringify(previousLines)!==JSON.stringify(newLines);
  const inventoryChanged=JSON.stringify(stockView(oldItemList))!==JSON.stringify(stockView(normalized));
  const previousBills={legalTipEnabled:existing.legalTipEnabled!==false,discount:round(existing.discount||0),taxEnabled:!!existing.taxEnabled,tipEnabled:!!existing.tipEnabled,tipAmount:round(existing.tipAmount||existing.tip||0),deliveryFee:round(existing.deliveryFee||0)};
  const nextBills={legalTipEnabled:bills.legalTipEnabled!==false,discount:round(bills.discount),taxEnabled:bills.taxEnabled,tipEnabled:bills.tipEnabled,tipAmount:round(bills.tipEnabled?bills.tipAmount:0),deliveryFee:round(bills.deliveryFee)};
  const changed=[itemsChanged?"items":null,JSON.stringify(previousBills)!==JSON.stringify(nextBills)?"bills":null,method!==order.paymentMethod?"paymentMethod":null,note.trim()!==String(order.orderNote||"")?"orderNote":null].filter(Boolean);
  if(!changed.length)throw bad("NO_CHANGES",409);
  return {normalized,calculated,method,note:note.trim(),delta,previousTotal,newTotal,itemsChanged,inventoryChanged,changed,previousLines,newLines,previousBills,nextBills};
}
// Una caja cerrada jamás se reabre ni se edita para corregir una orden histórica.
// La corrección se registra en un libro independiente cuando no hay caja abierta.
async function lookupOriginalCashSession(order, req, session) {
  if (order.paymentStatus !== "Pagado" || !order.cashSessionId) return null;
  const q = CashSession.findOne({
    _id: order.cashSessionId,
    tenantId: req.tenantId,
    clientId: req.clientId,
  }).select("_id status closedAt movements");
  return await (session ? q.session(session) : q);
}
function sessionIsOpen(cashSession) {
  return cashSession?.status === "OPEN" && !cashSession.closedAt;
}
function sumMap(rows){const out=new Map();for(const m of rows){const id=String(m.itemId);out.set(id,round6((out.get(id)||0)+(m.qtySigned==null?(m.type==="sale"?-Number(m.qty||0):Number(m.qty||0)):Number(m.qtySigned))));}return out;}
function round6(v){return Math.round((v+Number.EPSILON)*1e6)/1e6;}
async function stockDemandForLines(req,lines,session){
  const desired=new Map();
  const ds=await Dish.find({...dishScope(req),_id:{$in:lines.map(x=>x.dishId)}}).lean().session(session);
  const dishMap=new Map(ds.map(d=>[String(d._id),d]));
  const add=(id,qty)=>desired.set(String(id),round6((desired.get(String(id))||0)+qty));
  for(const line of lines){const dish=dishMap.get(String(line.dishId));if(!dish)throw bad("DISH_NOT_FOUND_IN_BRANCH",409);const qty=Number(line.quantity);
    if(shouldUseRecipe(dish)){for(const ing of customizedRecipe(dish,line)){if(ing.ingredientDishId&&Number(ing.qty)>0)add(ing.ingredientDishId,qty*Number(ing.qty));}}
    else if(shouldTrackDirectStock(dish))add(dish._id,qty);
    for(const ex of await getExtraStockLines({soldDish:dish,line,soldAmount:qty,tenantId:req.tenantId,clientId:req.clientId,session})){add(ex.itemId,ex.qty);}
  }
  return desired;
}
async function assertCorrectionInventoryState(req,order,c,session){
  if(order.paymentStatus!=="Pagado"||!c.inventoryChanged||order.inventoryDeducted)return;
  const before=await stockDemandForLines(req,order.items||[],session);
  const after=await stockDemandForLines(req,c.normalized,session);
  for(const id of new Set([...before.keys(),...after.keys()])){
    if(Math.abs((before.get(id)||0)-(after.get(id)||0))>0.0000001)throw bad("INVENTORY_STATE_UNVERIFIED",409);
  }
}
async function reconcileInventory(req,order,lines,session){
  if(!order.inventoryDeducted)return {movements:0,costDelta:0};
  const prevMov=await InventoryMovement.find({tenantId:req.tenantId,clientId:req.clientId,sourceId:String(order._id),sourceType:{$in:["order","order_correction"]}}).session(session).lean();
  const prior=sumMap(prevMov.filter(m=>(m.sourceType==="order"&&m.type==="sale")||m.sourceType==="order_correction"));
  const desired=await stockDemandForLines(req,lines,session);
  let movements=0, costDelta=0;
  for(const id of new Set([...desired.keys(),...prior.keys()])){
    const actualConsumed=round6(-(prior.get(id)||0));const nextConsumed=round6(desired.get(id)||0);
    const change=round6(nextConsumed-actualConsumed);if(Math.abs(change)<0.0000001)continue;
    if(change<0)await authorizeInventoryReturn(order,{userId:req.user._id,confirmed:req.body.inventoryReturnConfirmed},session);
    const inv=await Dish.findOne({$and:[dishScope(req),{_id:id,$or:[{inventoryType:{$in:["direct","ingredient"]}},{inventoryType:{$exists:false},isInventoryItem:true},{inventoryType:{$exists:false},inventoryCategoryId:{$exists:true,$ne:null}}]}]}).session(session);
    if(!inv)throw bad("INVENTORY_ITEM_NOT_FOUND",409);
    const before=Number(inv.stockCurrent||0);const after=round6(before-change);
    if(inv.allowNegativeStock===false&&after<0)throw bad("INSUFFICIENT_STOCK",409);
    inv.stockCurrent=after;await inv.save({session});
    const unitCost=Number(inv.avgCost||inv.lastCost||0);
    costDelta=round(costDelta+change*unitCost);
    await InventoryMovement.create([{tenantId:req.tenantId,clientId:req.clientId,itemId:inv._id,type:"adjust",qty:Math.abs(change),qtySigned:-change,unitCost,costAmount:round(Math.abs(change)*unitCost),beforeStock:before,afterStock:after,note:`Correction order ${order._id}${change<0&&wasPrepared(order)?"; devolución física confirmada por administrador":""}`,createdBy:req.user._id,sourceType:"order_correction",sourceId:String(order._id)}],{session});
    movements++;
  }
  return {movements,costDelta};
}
async function previewNormalOrderCorrection(req,res,next){try{
  const {order,tenant}=await getOrderAndTenant(req,null);const c=await buildCandidate(req,order,tenant,null);
  const paid=order.paymentStatus==="Pagado";
  await assertCorrectionInventoryState(req,order,c,null);
  const cashSession=paid?await lookupOriginalCashSession(order,req,null):null;
  const postClose=paid&&!sessionIsOpen(cashSession);
  return res.json({success:true,data:{previousTotal:c.previousTotal,newTotal:c.newTotal,delta:c.delta,items:c.calculated.items,bills:c.calculated.bills,changed:c.changed,paid,canApply:true,postCloseAdjustment:postClose,requiresInventoryReturnApproval:Boolean(order.inventoryDeducted&&wasPrepared(order)&&c.inventoryChanged),requiresSettlement:paid&&(Math.abs(c.delta)>=0.01||c.changed.includes("paymentMethod")),reason:null}});
}catch(e){return res.status(e.statusCode||500).json({success:false,code:e.code||e.message});}}
async function correctNormalOrder(req,res,next){
  const reason=String(req.body?.reason||"").trim();if(reason.length<8||reason.length>500)return res.status(400).json({success:false,code:"CORRECTION_REASON_REQUIRED"});
  if(!req.body?.expectedUpdatedAt)return res.status(400).json({success:false,code:"EXPECTED_VERSION_REQUIRED"});
  let session;
  try{
    session=await mongoose.startSession();
    let saved;let lastCorrectionCode="";
    await session.withTransaction(async()=>{
      const {order,tenant}=await getOrderAndTenant(req,session);
      if(new Date(req.body.expectedUpdatedAt).getTime()!==new Date(order.updatedAt).getTime())throw bad("ORDER_CHANGED_RELOAD",409);
      const c=await buildCandidate(req,order,tenant,session);
      const paid=order.paymentStatus==="Pagado";
      await assertCorrectionInventoryState(req,order,c,session);
      const cashSession=await lookupOriginalCashSession(order,req,session);
      let settlement=null;
      if(paid&&(Math.abs(c.delta)>=0.01||c.changed.includes("paymentMethod"))){
        const s=req.body?.settlement||{};
        const direction=c.delta>0?"collected":c.delta<0?"refunded":"reclassified";
        if(s.direction!==direction||Math.abs(money(s.amount??-1,"SETTLEMENT")-Math.abs(c.delta))>0.009)throw bad("SETTLEMENT_CONFIRMATION_REQUIRED",409);
        if(s.confirmed!==true)throw bad("SETTLEMENT_CONFIRMATION_REQUIRED",409);
        // Código de auditoría interno, no equivale a comprobante bancario.
        settlement={direction,amount:Math.abs(c.delta),confirmed:true,manual:true,
          externalReference:String(s.externalReference||"").trim().slice(0,150)};
      }
      const correctionCode=`COR-${new mongoose.Types.ObjectId().toString().slice(-12).toUpperCase()}`;
      if(settlement)settlement.reference=correctionCode;
      lastCorrectionCode=correctionCode;
      const previous=order.toObject();
      const inventoryChange=c.inventoryChanged?await reconcileInventory(req,order,c.normalized,session):{costDelta:0};
      const audit={correctionCode,at:new Date(),by:req.user._id,reason,changed:c.changed,previousPaymentMethod:order.paymentMethod,nextPaymentMethod:c.method,previousNote:order.orderNote||"",nextNote:c.note,previousTotal:c.previousTotal,nextTotal:c.newTotal,previousItems:c.itemsChanged?previous.items:[],nextItems:c.itemsChanged?c.calculated.items:[],previousBills:previous.bills,nextBills:c.calculated.bills,settlement};
      const now=new Date();
      const changed=await Order.findOneAndUpdate({...owns(req,order._id),updatedAt:order.updatedAt},{$set:{...(wasPrepared(order)?{inventoryPreparedAt:order.inventoryPreparedAt||new Date()}:{}),items:c.calculated.items,bills:c.calculated.bills,paymentMethod:c.method,orderNote:c.note,commissionAmount:c.calculated.commissionAmount,netTotal:c.calculated.netTotal,cogsTotal:round(Number(order.cogsTotal||0)+inventoryChange.costDelta),invoiceUrl:"",invoicePath:""},$push:{correctionHistory:audit}},{new:true,runValidators:true,session}).select("-correctionHistory");
      if(!changed)throw bad("ORDER_CHANGED_RELOAD",409);
      if(sessionIsOpen(cashSession)&&settlement){
        cashSession.movements.push({type:"PAYMENT_CORRECTION",amount:c.delta,by:req.user._id,at:now,note:`Order ${order._id}: ${settlement.direction} ${settlement.amount} (${settlement.reference})`});
        await cashSession.save({session});
      }
      // Una venta histórica corregida no toca el cierre de la caja original.
      // Queda en el libro de ajustes para revisión y conciliación posterior.
      if (paid && (Math.abs(c.delta)>=0.01 || c.changed.includes("paymentMethod"))) {
        await OrderCorrectionAdjustment.create([{
          tenantId:req.tenantId, clientId:req.clientId, orderId:order._id,
          correctionCode,originalCashSessionId:cashSession?._id||null,
          originalSessionStatus:sessionIsOpen(cashSession)?"OPEN":cashSession?"CLOSED":"NOT_FOUND",
          previousTotal:c.previousTotal, newTotal:c.newTotal, delta:c.delta,
          previousPaymentMethod:order.paymentMethod, nextPaymentMethod:c.method,
          settlement, reason, changed:c.changed, performedBy:req.user._id,
          reconciliationStatus:sessionIsOpen(cashSession)?"OPEN_REGISTER_RECORDED":"REQUIRES_RECONCILIATION",
        }], {session});
      }
      saved=changed;
    });
    // Notification failures do not negate an already committed correction.
    try { req.app?.get?.("io")?.to(`tenant:${req.tenantId}:branch:${req.clientId}`)?.emit("tenant:orderUpdated",{tenantId:req.tenantId,clientId:req.clientId,orderId:String(saved._id)}); }
    catch (error) { console.error("CORRECTION_SOCKET_NOTIFICATION_FAILED", error.message); }
    res.set("Cache-Control","no-store");return res.json({success:true,data:saved,invoiceNeedsRegeneration:true,correctionCode:lastCorrectionCode});
  }catch(e){
    const msg=String(e?.message||"");
    if(/Transaction numbers are only allowed|replica set|does not support transactions|not supported for this deployment/i.test(msg))
      return res.status(503).json({success:false,code:"MONGODB_TRANSACTIONS_REQUIRED"});
    return res.status(e.statusCode||500).json({success:false,code:e.code||e.message});
  }
  finally{if(session)await session.endSession();}
}

async function getCorrectionCatalog(req,res){
 try{
  if(!req.tenantId||!req.clientId)return res.status(403).json({success:false,code:"UNAUTHORIZED_SCOPE"});
  const q=String(req.query.q||"").trim().slice(0,100);
  const ids=String(req.query.ids||"").split(",").slice(0,80).filter(x=>mongoose.isValidObjectId(x));
  const scoped=dishScope(req);
  const filters=[];
  if(ids.length&&q)filters.push({_id:{$in:ids}});
  if(q)filters.push({name:{$regex:q.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),$options:"i"}});
  const query={$and:[scoped,{category:{$ne:"Inventario"},inventoryType:{$ne:"ingredient"}},...(filters.length?[{$or:filters}]:[])]};
  const items=await Dish.find(query).select("_id name category price inventoryType sellMode weightUnit customization.extras customization.removableIngredients productionArea").sort({name:1}).limit(200).lean();
  const tenant=await Tenant.findOne({tenantId:req.tenantId}).select("taxConfig").lean();
  res.set("Cache-Control","no-store");return res.json({success:true,data:items,taxes:(tenant?.taxConfig?.taxes||[]).filter(x=>x.active!==false).map(x=>({id:x.id,name:x.name,ratePercent:x.ratePercent}))});
 }catch(e){return res.status(500).json({success:false,code:"CATALOG_LOAD_FAILED"});}
}
async function listFinancialCorrections(req,res,next){
  try{
    const rows=await OrderCorrectionAdjustment.find({tenantId:req.tenantId,clientId:req.clientId})
      .sort({createdAt:-1}).limit(100).lean();
    res.set("Cache-Control","no-store");
    return res.json({success:true,data:rows});
  }catch(error){next(error);}
}
// Historial detallado: solo al usuario con permiso de corrección y en su sucursal.
async function getOrderCorrectionHistory(req,res,next){
  try{
    if(!mongoose.isValidObjectId(req.params.id))return res.status(404).json({success:false,code:"ORDER_NOT_FOUND"});
    const order=await Order.findOne(owns(req,req.params.id))
      .select("_id tenantId clientId correctionHistory").select("+correctionHistory").lean();
    if(!order)return res.status(404).json({success:false,code:"ORDER_NOT_FOUND"});
    const history=[...(order.correctionHistory||[])].reverse().slice(0,100);
    const userIds=[...new Set(history.map(x=>String(x.by||"")).filter(x=>mongoose.isValidObjectId(x)))];
    const users=await User.find({_id:{$in:userIds}}).select("_id name email").lean();
    const userById=new Map(users.map(u=>[String(u._id),u]));
    const data=history.map(entry=>({
      id:String(entry._id||""),code:entry.correctionCode||null,
      at:entry.at,reason:entry.reason,changed:entry.changed||[],
      actor:{id:String(entry.by||""),name:userById.get(String(entry.by))?.name||
        userById.get(String(entry.by))?.email||"Usuario no disponible"},
      previousTotal:entry.previousTotal,nextTotal:entry.nextTotal,
      previousPaymentMethod:entry.previousPaymentMethod,nextPaymentMethod:entry.nextPaymentMethod,
      previousItems:entry.previousItems||[],nextItems:entry.nextItems||[],
      previousBills:entry.previousBills,nextBills:entry.nextBills,
      settlement:entry.settlement?{
        direction:entry.settlement.direction,amount:entry.settlement.amount,
        reference:entry.settlement.reference||null,
        externalReference:entry.settlement.externalReference||null,
        manual:entry.settlement.manual===true,
      }:null,
    }));
    res.set("Cache-Control","no-store");return res.json({success:true,data});
  }catch(error){next(error);}
}

// Historial global de correcciones: SOLO órdenes del tenant y sucursal activos.
// No se obtiene desde los últimos pedidos de la pantalla; consulta todo el historial,
// ordenado por fecha y paginado para evitar transferir subdocumentos completos.
async function listOrderCorrectionHistory(req, res, next) {
  try {
    if (!req.tenantId || !req.clientId) {
      return res.status(403).json({ success: false, code: "UNAUTHORIZED_SCOPE" });
    }
    const page = Math.min(Math.max(Number.parseInt(req.query.page, 10) || 1, 1), 100000);
    const pageSize = Math.min(Math.max(Number.parseInt(req.query.pageSize, 10) || 15, 1), 50);
    const search = String(req.query.search || "").trim().slice(0, 80);
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      !Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime());
    if ((from && !validDate(from)) || (to && !validDate(to)) || (from && to && from > to)) {
      return res.status(400).json({ success: false, code: "INVALID_HISTORY_DATE_RANGE" });
    }
    const scoped = {
      tenantId: req.tenantId,
      ...(req.clientId === "default" ? {
        $or: [
          { clientId: "default" }, { clientId: null },
          { clientId: "" }, { clientId: { $exists: false } },
        ],
      } : { clientId: req.clientId }),
      "correctionHistory.0": { $exists: true },
    };
    const entryMatch = {};
    if (from || to) {
      entryMatch["correctionHistory.at"] = {};
      if (from) entryMatch["correctionHistory.at"].$gte = new Date(`${from}T00:00:00.000Z`);
      if (to) {
        const exclusiveEnd = new Date(`${to}T00:00:00.000Z`);
        exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
        entryMatch["correctionHistory.at"].$lt = exclusiveEnd;
      }
    }
    const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Resolver usuarios por separado permite buscar por nombre sin hacer $lookup de
    // todos los documentos del historial; los datos siguen limitados por tenant/sede.
    const matchingActors = search ? await User.find({ $or: [
      { name: { $regex: escapedSearch, $options: "i" } },
      { email: { $regex: escapedSearch, $options: "i" } },
    ] }).select("_id").limit(500).lean() : [];
    const searchMatch = search ? { $or: [
      { "correctionHistory.reason": { $regex: escapedSearch, $options: "i" } },
      { "correctionHistory.correctionCode": { $regex: escapedSearch, $options: "i" } },
      { operationNumber: { $regex: escapedSearch, $options: "i" } },
      ...(matchingActors.length ? [{ "correctionHistory.by": { $in: matchingActors.map(u => u._id) } }] : []),
    ] } : null;
    const pipeline = [
      { $match: scoped },
      { $unwind: "$correctionHistory" },
      ...(Object.keys(entryMatch).length ? [{ $match: entryMatch }] : []),
      ...(searchMatch ? [{ $match: searchMatch }] : []),
      { $facet: {
        entries: [
          { $sort: { "correctionHistory.at": -1, _id: -1 } },
          { $skip: (page - 1) * pageSize },
          { $limit: pageSize },
          { $lookup: {
            from: User.collection.name,
            localField: "correctionHistory.by", foreignField: "_id", as: "correctionActor",
            pipeline: [{ $project: { name: 1, email: 1 } }],
          } },
          { $addFields: {
            actorName: { $ifNull: [
              { $arrayElemAt: ["$correctionActor.name", 0] },
              { $ifNull: [{ $arrayElemAt: ["$correctionActor.email", 0] }, "Usuario no disponible"] },
            ] },
          } },
          { $project: {
            _id: 0, orderId: { $toString: "$_id" },
            orderNumber: { $ifNull: ["$operationNumber", "$invoiceNumber"] },
            code: "$correctionHistory.correctionCode", at: "$correctionHistory.at",
            actorName: 1, reason: "$correctionHistory.reason",
            changed: { $ifNull: ["$correctionHistory.changed", []] },
            previousTotal: "$correctionHistory.previousTotal", nextTotal: "$correctionHistory.nextTotal",
            previousPaymentMethod: "$correctionHistory.previousPaymentMethod",
            nextPaymentMethod: "$correctionHistory.nextPaymentMethod",
          } },
        ],
        totals: [{ $count: "count" }],
      } },
    ];
    const [result] = await Order.aggregate(pipeline).allowDiskUse(true);
    const total = result?.totals?.[0]?.count || 0;
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data: result?.entries || [], pagination: {
      page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)),
    } });
  } catch (error) { next(error); }
}
module.exports={listOrderCorrectionHistory,getOrderCorrectionHistory,correctNormalOrder,previewNormalOrderCorrection,getCorrectionCatalog,listFinancialCorrections,fiscalLocked,NON_CREDIT_METHODS};
