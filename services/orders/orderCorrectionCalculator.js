"use strict";
const { calculateOrderTaxes } = require("../tax/taxEngine");
const { calculateServiceCharges } = require("../charges/serviceChargeEngine");

const round = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
function bad(code, status=400) { const err = new Error(code); err.code=code; err.statusCode=status; return err; }
function money(value, name, cap=1e9) { const v = Number(value); if (!Number.isFinite(v) || v < 0 || v > cap) throw bad(`INVALID_${name}`); return round(v); }
function summarize({tenant, items, bills, source="DINE_IN", commissionRate=0}) {
  if (!Array.isArray(items) || !items.length || items.length>80) throw bad("INVALID_ITEMS");
  const priced=items.map(i=> {
    const quantity=Number(i.quantity);
    if (!Number.isFinite(quantity) || quantity<=0 || quantity>9999) throw bad("INVALID_ITEM_QUANTITY");
    const unitPrice=money(i.unitPrice,"UNIT_PRICE");
    return {...i,quantity,unitPrice,price:round(quantity*unitPrice)};
  });
  const subtotal=round(priced.reduce((s,i)=>s+i.price,0));
  const features=tenant?.features||{};
  const discount=features.discount?.enabled===false?0:money(bills.discount??0,"DISCOUNT");
  if(discount>subtotal) throw bad("DISCOUNT_EXCEEDS_SUBTOTAL");
  const deliveryFee=money(bills.deliveryFee??0,"DELIVERY_FEE");
  const tipEnabled=features.tip?.enabled!==false && bills.tipEnabled===true;
  const tip=tipEnabled?money(bills.tipAmount??0,"TIP"):0;
  const taxEnabled=(tenant?.taxConfig?.enabled!==false && features.tax?.enabled!==false) && bills.taxEnabled===true;
  const taxResult=calculateOrderTaxes({tenant,items:priced,discountAmount:discount,deliveryFee,taxesEnabled:taxEnabled});
  const charges=calculateServiceCharges({tenant,taxResult,orderSource:source,legalTipEnabled:bills.legalTipEnabled!==false});
  const total=round(taxResult.totalBeforeTip+charges.addedTotal+tip);
  const rate=Number(commissionRate)||0;
  const commissionAmount=round(taxResult.itemsTotalWithTax*rate);
  return {items: taxResult.items,bills:{subtotal:taxResult.subtotal,total:taxResult.subtotal,discount,deliveryFee,legalTipEnabled:bills.legalTipEnabled!==false,tipEnabled,tip,tipAmount:tip,taxEnabled,tax:taxResult.taxTotal,taxEngineVersion:taxResult.engineVersion,subtotalAfterDiscount:taxResult.subtotalAfterDiscount,netAmount:taxResult.netAmount,deliveryTaxAmount:taxResult.deliveryTaxAmount,taxBreakdown:taxResult.taxBreakdown,serviceChargeTotal:charges.addedTotal,serviceChargeBreakdown:charges.breakdown,totalWithTax:total},commissionAmount,netTotal:round(total-commissionAmount)};
}
module.exports={summarize,bad,money,round};
