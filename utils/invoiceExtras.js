"use strict";
// Extras and their prices are read exclusively from the order snapshot.
const round = v => Math.round((Number(v) || 0) * 100) / 100;
function invoiceExtras(item = {}) {
  const out = [];
  // Do not double count aliases: pick the first actual extras collection.
  const candidates = [item.addons, item.addOns, item.extras, item.extraIngredients, item.selectedExtras];
  const selected = candidates.find(x => Array.isArray(x) && x.length > 0) || [];
  const modifiers = Array.isArray(item.modifiers) ? item.modifiers :
    (Array.isArray(item.selectedOptions) ? item.selectedOptions : []);
  for (const raw of [...selected, ...modifiers]) {
    const name = typeof raw === 'string' ? raw : raw?.name ?? raw?.label ?? raw?.title ?? '';
    if (!String(name).trim()) continue;
    const qtyRaw = typeof raw === 'object' && raw !== null ? Number(raw.quantity ?? raw.qty ?? 1) : 1;
    const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
    const rawPrice = (typeof raw === 'object' && raw !== null) ?
      raw.unitPrice ?? raw.price ?? raw.amount ??
      (raw.total !== undefined && Number.isFinite(Number(raw.total)) ? Number(raw.total) / qty : undefined) : undefined;
    const numericPrice = rawPrice === undefined || rawPrice === null || rawPrice === '' ? null : Number(rawPrice);
    const unitPrice = Number.isFinite(numericPrice) && numericPrice >= 0 ? round(numericPrice) : null;
    out.push({ label: String(name).trim(), qty, unitPrice,
      perDishTotal: unitPrice === null ? null : round(qty * unitPrice), note: false });
  }
  const note = item.note || item.comment || item.specialInstructions;
  if (String(note || '').trim()) out.push({label: String(note).trim(), qty: 1, unitPrice: null, perDishTotal: null, note: true});
  return out;
}
function invoiceLineBreakdown(item = {}) {
  const qty = Number(item.quantity ?? item.qty ?? 1) || 1;
  const priceFromSnapshot = Number(item.unitPrice ?? item.pricePerQuantity ?? (Number(item.price || 0) / qty));
  const unitPrice = Number.isFinite(priceFromSnapshot) ? round(priceFromSnapshot) : 0;
  const extras = invoiceExtras(item);
  const paidUnit = round(extras.reduce((sum, x) => sum + (x.perDishTotal || 0), 0));
  const explicitBase = item.baseUnitPrice === undefined || item.baseUnitPrice === null ? null : Number(item.baseUnitPrice);
  const canSplit = paidUnit <= unitPrice + .009 && (explicitBase === null || Math.abs(explicitBase + paidUnit - unitPrice) <= .011);
  const mainUnitPrice = canSplit ? round(unitPrice - paidUnit) : unitPrice;
  // If legacy data does not balance, prices are still shown but marked included,
  // without double counting the separate entries in displayed totals.
  return { qty, unitPrice, mainUnitPrice, canSplit, extras: extras.map(x => ({
    ...x, totalQty: round(x.qty * qty), lineTotal: x.perDishTotal === null ? null : round(x.perDishTotal * qty),
    included: !canSplit && !x.note,
  })), mainLineTotal: round(mainUnitPrice * qty), originalLineTotal: round(unitPrice * qty) };
}
module.exports = { invoiceExtras, invoiceLineBreakdown };
