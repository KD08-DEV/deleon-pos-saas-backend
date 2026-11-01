"use strict";

// Fase 12.1: snapshot fiscal calculado EXCLUSIVAMENTE a partir de datos
// persistidos en la orden. Fallar antes de reservar e-NCF ante ambigüedad.
// Este validador NO reemplaza la validación XSD de la fase 12.2.
const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const close = (a, b) => Math.abs(round2(a) - round2(b)) <= 0.011;

function fiscalError(code, details = {}) {
    const e = new Error(code);
    e.code = code;
    e.statusCode = 422;
    e.details = details;
    return e;
}
function amount(value, name) {
    const n = Number(value ?? 0);
    if (!Number.isFinite(n) || n < 0) throw fiscalError("ECF_INVALID_AMOUNT", { field: name });
    return round2(n);
}
function positive(value, name) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) throw fiscalError("ECF_INVALID_QUANTITY", { field: name });
    return n;
}

function getFiscalSnapshot(order = {}) {
    const bills = order.bills || {};
    const items = Array.isArray(order.items) ? order.items : [];
    if (!items.length) throw fiscalError("ECF_ITEMS_REQUIRED");

    const subtotal = amount(bills.subtotal, "bills.subtotal");
    const discount = amount(bills.discount, "bills.discount");
    const tax = amount(bills.tax, "bills.tax");
    const tip = amount(bills.tipAmount || bills.tip, "bills.tipAmount");
    const deliveryFee = amount(bills.deliveryFee, "bills.deliveryFee");
    const deliveryTax = amount(bills.deliveryTaxAmount, "bills.deliveryTaxAmount");
    const serviceCharge = amount(bills.serviceChargeTotal, "bills.serviceChargeTotal");
    const storedTotal = amount(bills.totalWithTax, "bills.totalWithTax");

    // Recargos de servicio configurables requieren mapeo DGII específico,
    // no deben desaparecer ni convertirse silenciosamente en propina legal.
    if (serviceCharge > 0) {
        throw fiscalError("ECF_SERVICE_CHARGE_MAPPING_REQUIRED", { serviceCharge });
    }
    if (discount > subtotal) throw fiscalError("ECF_DISCOUNT_EXCEEDS_SUBTOTAL");

    const lines = [];
    let itemAmountSum = 0;
    let discountSum = 0;
    let itemTaxSum = 0;

    for (const [i, item] of items.entries()) {
        const quantity = positive(item?.quantity, `items[${i}].quantity`);
        const unitPrice = amount(item?.unitPrice, `items[${i}].unitPrice`);
        const lineAmount = amount(item?.price, `items[${i}].price`);
        const lineDiscount = amount(item?.discountAmount, `items[${i}].discountAmount`);
        const lineTax = amount(item?.taxAmount ?? item?.taxSnapshot?.amount, `items[${i}].taxAmount`);
        if (lineDiscount > lineAmount) throw fiscalError("ECF_LINE_DISCOUNT_EXCEEDS_AMOUNT", { index: i });
        if (!close(lineAmount, quantity * unitPrice)) {
            throw fiscalError("ECF_LINE_PRICE_MISMATCH", { index: i, lineAmount, quantity, unitPrice });
        }

        const snapshot = item?.taxSnapshot || null;
        let indicator = "4";  // exento explícito
        let rate = 0;
        if (snapshot) {
            if (snapshot.includedInPrice === true) {
                throw fiscalError("ECF_TAX_INCLUDED_NEEDS_FISCAL_MAPPING", { index: i });
            }
            rate = Number(snapshot.ratePercent ?? 0);
            const taxBase = amount(snapshot.taxableBase, `items[${i}].taxSnapshot.taxableBase`);
            if (!close(taxBase, lineAmount - lineDiscount)) {
                throw fiscalError("ECF_TAX_BASE_MISMATCH", { index: i, taxBase });
            }
            if (!close(lineTax, amount(snapshot.amount, `items[${i}].taxSnapshot.amount`))) {
                throw fiscalError("ECF_TAX_SNAPSHOT_MISMATCH", { index: i });
            }
            if (rate === 18 || rate === 16) {
                const code = String(snapshot.code || "").trim().toUpperCase();
                const name = String(snapshot.name || "").trim().toUpperCase();
                if (!/^ITBIS(?:[_\s-]?\d+)?$/.test(code) && !name.includes("ITBIS")) {
                    throw fiscalError("ECF_NON_ITBIS_TAX_MAPPING_REQUIRED", { index: i, code });
                }
                indicator = rate === 18 ? "1" : "2";
                if (!close(lineTax, round2(taxBase * rate / 100))) {
                    throw fiscalError("ECF_TAX_RATE_MISMATCH", { index: i, rate, lineTax });
                }
            } else if (rate === 0 && close(lineTax, 0)) {
                // No confundir tasa 0% (indicador 3) con exención (4).
                // Requiere configuración DGII explícita, por ahora NO emitir.
                const taxCode = String(snapshot.code || "").trim().toUpperCase();
                const taxName = String(snapshot.name || "").trim().toUpperCase();
                if (!taxCode.includes("EXENTO") && !taxName.includes("EXENTO")) {
                    throw fiscalError("ECF_ZERO_RATE_REQUIRES_CLASSIFICATION", { index: i });
                }
                indicator = "4";
            } else {
                throw fiscalError("ECF_UNSUPPORTED_TAX_RATE", { index: i, rate });
            }
        } else if (lineTax > 0) {
            throw fiscalError("ECF_MISSING_ITEM_TAX_SNAPSHOT", { index: i });
        }

        const line = {
            name: String(item?.name || "Producto"), quantity, unitPrice,
            amount: lineAmount, discount: lineDiscount, tax: lineTax,
            base: round2(lineAmount - lineDiscount), indicator,
            goodsOrService: "1", delivery: false,
        };
        lines.push(line);
        itemAmountSum = round2(itemAmountSum + lineAmount);
        discountSum = round2(discountSum + lineDiscount);
        itemTaxSum = round2(itemTaxSum + lineTax);
    }

    if (!close(itemAmountSum, subtotal)) {
        throw fiscalError("ECF_SUBTOTAL_MISMATCH", { itemAmountSum, subtotal });
    }
    if (!close(discountSum, discount)) {
        throw fiscalError("ECF_DISCOUNT_ALLOCATION_MISMATCH", { discountSum, discount });
    }
    if (!close(round2(itemTaxSum + deliveryTax), tax)) {
        throw fiscalError("ECF_TOTAL_TAX_MISMATCH", { itemTaxSum, deliveryTax, tax });
    }

    if (deliveryFee > 0) {
        let indicator = "4";
        if (deliveryTax > 0) {
            const matches18 = close(deliveryTax, round2(deliveryFee * 0.18));
            const matches16 = close(deliveryTax, round2(deliveryFee * 0.16));
            if (!matches18 && !matches16) {
                throw fiscalError("ECF_DELIVERY_TAX_MAPPING_REQUIRED", { deliveryFee, deliveryTax });
            }
            indicator = matches18 ? "1" : "2";
        }
        lines.push({
            name: "Servicio de entrega", quantity: 1, unitPrice: deliveryFee,
            amount: deliveryFee, discount: 0, tax: deliveryTax,
            base: deliveryFee, indicator, goodsOrService: "2", delivery: true,
        });
    } else if (deliveryTax > 0) {
        throw fiscalError("ECF_DELIVERY_TAX_WITHOUT_FEE");
    }

    const expectedTotal = round2(subtotal - discount + tax + tip + deliveryFee + serviceCharge);
    if (!close(expectedTotal, storedTotal)) {
        throw fiscalError("ECF_ORDER_TOTAL_MISMATCH", { expectedTotal, storedTotal });
    }
    const sum = (indicator, field) => round2(lines.filter((l) => l.indicator === indicator)
        .reduce((s, l) => s + l[field], 0));
    const taxable18 = sum("1", "base");
    const taxable16 = sum("2", "base");
    const exempt = sum("4", "base");
    const itbis18 = sum("1", "tax");
    const itbis16 = sum("2", "tax");
    if (!close(round2(taxable18 + taxable16 + exempt + tax + tip), storedTotal)) {
        throw fiscalError("ECF_FISCAL_BREAKDOWN_MISMATCH");
    }
    return {
        lines, subtotal, discount, tax, tip, deliveryFee, deliveryTax,
        total: storedTotal, taxable18, taxable16, exempt, itbis18, itbis16,
    };
}
module.exports = { getFiscalSnapshot, fiscalError };
