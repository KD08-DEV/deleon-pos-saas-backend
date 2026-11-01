"use strict";

// Fase 12.1.3. Nunca inventar un desglose al emitir una nota e-CF.
// Este módulo construye una nueva orden virtual usando el snapshot fiscal
// VERIFICADO del comprobante original; no modifica la venta persistida.
const { getFiscalSnapshot, fiscalError } = require("./ecfFiscalSnapshot");

const cents = (n) => {
  if (n === null || n === undefined || n === '' || !Number.isFinite(Number(n))) {
    throw fiscalError('ECF_ADJUSTMENT_INVALID_MONEY');
  }
  return Math.round(Number(n) * 100);
};
const money = (n) => Math.round(Number(n)) / 100;
const close = (a, b) => Math.abs(cents(a) - cents(b)) <= 1;
const fail = (code, details = {}) => { throw fiscalError(code, details); };

function creditAvailability(originalTotal, acceptedCreditsTotal) {
  const original = cents(originalTotal);
  const credits = cents(acceptedCreditsTotal);
  if (original <= 0 || credits < 0) fail('ECF_ADJUSTMENT_INVALID_BALANCE');
  if (credits > original + 1) {
    fail('E34_PREVIOUS_CREDITS_EXCEED_ORIGINAL', { originalTotal, acceptedCreditsTotal });
  }
  // No sumar E33: la DGII limita E34 acumuladas al monto original referenciado.
  return money(Math.max(0, original - credits));
}

function invoiceClone(originalOrder) {
  return typeof originalOrder?.toObject === 'function'
    ? originalOrder.toObject()
    : { ...originalOrder };
}

function newAdjustmentItem(line, index, noteType, reason) {
  const rate = line.indicator === '1' ? 18 : line.indicator === '2' ? 16 : 0;
  const isExempt = rate === 0;
  return {
    lineId: `fiscal-adj-${index + 1}`,
    dishId: null,
    name: `Nota de ${noteType === '33' ? 'débito' : 'crédito'} - ${line.name || reason || 'Ajuste'}`,
    presentation: 'Regular', category: 'Ajuste e-CF', qtyType: 'unit',
    weightUnit: 'lb', quantity: line.quantity,
    unitPrice: line.unitPrice, price: line.amount,
    discountAmount: line.discount, taxAmount: line.tax,
    taxSnapshot: {
      code: isExempt ? 'EXENTO' : 'ITBIS',
      name: isExempt ? 'EXENTO' : `ITBIS ${rate}%`,
      includedInPrice: false,
      ratePercent: rate,
      taxableBase: line.base,
      amount: line.tax,
    },
    addons: [], modifiers: [], productionArea: 'other', printedQty: 0,
  };
}

function createVirtualOrder({ originalOrder, type, reason, signedAt, lines, bills }) {
  const source = invoiceClone(originalOrder);
  const result = {
    ...source,
    _id: originalOrder._id,
    fiscal: {
      ...(source.fiscal || {}),
      ecfDocumentType: type,
      requested: type === '33',
      ncfType: `E${type}`,
      issuedAt: signedAt,
    },
    items: lines,
    bills: {
      subtotal: bills.subtotal,
      total: bills.subtotal,
      discount: bills.discount,
      taxEnabled: bills.tax > 0,
      tax: bills.tax,
      tipEnabled: bills.tip > 0,
      tip: bills.tip,
      tipAmount: bills.tip,
      deliveryFee: bills.deliveryFee,
      deliveryTaxAmount: bills.deliveryTax,
      serviceChargeTotal: 0,
      totalWithTax: bills.total,
    },
    invoicedAt: signedAt,
    paidAt: signedAt,
    paymentMethod: originalOrder.paymentMethod || 'Efectivo',
    orderNote: reason || originalOrder.orderNote || '',
  };
  // Comprueba de nuevo el objeto EXACTO que se usará para construir el XML.
  getFiscalSnapshot(result);
  return result;
}

function buildFullAmountAdjustment({ originalOrder, documentType, reason, signedAt }) {
  const fiscal = getFiscalSnapshot(originalOrder);
  const goods = fiscal.lines.filter(line => !line.delivery);
  if (goods.length === 0) fail('ECF_ADJUSTMENT_ORIGINAL_ITEMS_REQUIRED');
  const items = goods.map((line, i) => newAdjustmentItem(line, i, documentType, reason));
  return createVirtualOrder({
    originalOrder, type: documentType, reason, signedAt, lines: items,
    bills: {
      subtotal: fiscal.subtotal, discount: fiscal.discount, tax: fiscal.tax,
      tip: fiscal.tip, deliveryFee: fiscal.deliveryFee,
      deliveryTax: fiscal.deliveryTax, total: fiscal.total,
    },
  });
}

function buildRemainingBalanceCancellation({ originalOrder, reason, signedAt, acceptedCreditDocs = [] }) {
  const original = getFiscalSnapshot(originalOrder);
  if (!Array.isArray(acceptedCreditDocs) || acceptedCreditDocs.length === 0) {
    return buildFullAmountAdjustment({ originalOrder, documentType: '34', reason, signedAt });
  }

  // No podemos distribuir notas anteriores en distintas tasas o cargos sin
  // conocer la línea de origen de cada nota. Bloquear en lugar de inventar.
  if (original.discount !== 0 || original.tip !== 0 || original.deliveryFee !== 0 || original.deliveryTax !== 0) {
    fail('E34_REMAINING_CREDIT_REQUIRES_ITEMIZED_ALLOCATION');
  }
  const items = original.lines.filter(l => !l.delivery);
  const kinds = new Set(items.map(l => l.indicator));
  if (kinds.size !== 1 || !['1', '2', '4'].includes([...kinds][0])) {
    fail('E34_REMAINING_CREDIT_REQUIRES_SINGLE_TAX_CLASS');
  }
  const indicator = [...kinds][0];
  const rate = indicator === '1' ? 18 : indicator === '2' ? 16 : 0;
  let creditedBase = 0;
  let creditedTax = 0;
  let creditedTotal = 0;
  for (const doc of acceptedCreditDocs) {
    const t = doc?.totals || {};
    if (t.subtotal === undefined || t.tax === undefined || t.total === undefined) {
      fail('E34_PREVIOUS_NOTE_TAX_DETAIL_REQUIRED', { eNCF: doc?.ecf?.eNCF });
    }
    const base = cents(t.subtotal);
    const tax = cents(t.tax);
    const total = cents(t.total);
    if (base < 0 || tax < 0 || base + tax !== total ||
        !close(money(tax), money(Math.round(base * rate / 100)))) {
      fail('E34_PREVIOUS_NOTE_TAX_DETAIL_INVALID', { eNCF: doc?.ecf?.eNCF });
    }
    if (Number(t.discount || 0) !== 0 || Number(t.tip || 0) !== 0 || Number(t.deliveryFee || 0) !== 0) {
      fail('E34_PREVIOUS_NOTE_ITEMIZATION_REQUIRED', { eNCF: doc?.ecf?.eNCF });
    }
    if (t.fiscalSummaryVersion === 1) {
      const k = indicator === '1' ? 'taxable18' : indicator === '2' ? 'taxable16' : 'exempt';
      if (t[k] !== undefined && cents(t[k]) !== base) {
        fail('E34_PREVIOUS_NOTE_TAX_CLASS_MISMATCH', { eNCF: doc?.ecf?.eNCF });
      }
    }
    creditedBase += base;
    creditedTax += tax;
    creditedTotal += total;
  }
  const originalBase = cents(original.subtotal);
  const originalTax = cents(original.tax);
  const originalTotal = cents(original.total);
  if (originalBase < creditedBase || originalTax < creditedTax || originalTotal < creditedTotal) {
    fail('E34_CREDIT_EXCEEDS_ORIGINAL');
  }
  const remainingBase = money(originalBase - creditedBase);
  const remainingTax = money(originalTax - creditedTax);
  const remainingTotal = money(originalTotal - creditedTotal);
  if (remainingBase <= 0 || remainingTotal <= 0) fail('E34_NO_CREDIT_BALANCE');
  if (cents(remainingBase) + cents(remainingTax) !== cents(remainingTotal) ||
      !close(remainingTax, Math.round(cents(remainingBase) * rate / 100) / 100)) {
    fail('E34_REMAINING_TAX_ALLOCATION_NOT_EXACT', { remainingBase, remainingTax, rate });
  }
  const line = {
    name: 'Saldo no acreditado del comprobante original',
    quantity: 1, unitPrice: remainingBase, amount: remainingBase,
    discount: 0, tax: remainingTax, base: remainingBase, indicator,
  };
  return createVirtualOrder({
    originalOrder, type: '34', reason, signedAt,
    lines: [newAdjustmentItem(line, 0, '34', reason)],
    bills: {
      subtotal: remainingBase, discount: 0, tax: remainingTax,
      tip: 0, deliveryFee: 0, deliveryTax: 0, total: remainingTotal,
    },
  });
}

module.exports = {
  buildFullAmountAdjustment,
  buildRemainingBalanceCancellation,
  creditAvailability,
};
