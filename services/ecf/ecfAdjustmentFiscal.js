"use strict";
const { getFiscalSnapshot, fiscalError } = require("./ecfFiscalSnapshot");
const money = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const close = (a, b) => Math.abs(money(a) - money(b)) <= 0.011;
const fail = (code, details = {}) => { throw fiscalError(code, details); };

// Solo usar el tratamiento fiscal comprobado del documento original.
// Si el original mezcla tasas, una nota por monto global es ambigua.
function singleTaxClass(originalOrder) {
  let fiscal;
  try { fiscal = getFiscalSnapshot(originalOrder); }
  catch (err) { fail("ECF_ADJUSTMENT_ORIGINAL_TAX_SNAPSHOT_REQUIRED", { cause: err.message }); }
  const goods = fiscal.lines.filter((l) => !l.delivery);
  const kinds = new Set(goods.map((l) => l.indicator));
  if (kinds.size !== 1 || goods.length === 0) {
    fail("ECF_ADJUSTMENT_ITEMIZED_TAX_REQUIRED", { indicators: [...kinds] });
  }
  const indicator = [...kinds][0];
  if (!["1", "2", "4"].includes(indicator)) fail("ECF_ADJUSTMENT_UNSUPPORTED_TAX_CLASS");
  const rate = indicator === "1" ? 18 : indicator === "2" ? 16 : 0;
  return { indicator, rate };
}

function buildPartialAdjustmentTax({ originalOrder, baseAmount, userTax }) {
  if (!Number.isFinite(baseAmount) || baseAmount <= 0) fail("ECF_ADJUSTMENT_AMOUNT_INVALID");
  const { rate } = singleTaxClass(originalOrder);
  const calculatedTax = money(baseAmount * rate / 100);
  if (userTax !== undefined && userTax !== null && userTax !== "") {
    const suppliedTax = Number(userTax);
    if (!Number.isFinite(suppliedTax) || suppliedTax < 0 || !close(suppliedTax, calculatedTax)) {
      fail("ECF_ADJUSTMENT_TAX_RATE_MISMATCH", { baseAmount, ratePercent: rate, taxEntered: userTax, expectedTax: calculatedTax });
    }
  }
  return {
    tax: calculatedTax,
    taxAmount: calculatedTax,
    taxSnapshot: {
      code: rate ? "ITBIS" : "EXENTO",
      name: rate ? `ITBIS ${rate}%` : "EXENTO",
      ratePercent: rate,
      includedInPrice: false,
      taxableBase: money(baseAmount),
      amount: calculatedTax,
    },
  };
}

function validateAdjustmentMode({ documentType, adjustmentMode, modificationCode }) {
  const code = String(modificationCode || "").trim();
  if (!["1", "2", "3"].includes(code)) fail("ECF_ADJUSTMENT_INVALID_MODIFICATION_CODE");
  if (code === "2") fail("ECF_TEXT_ONLY_ADJUSTMENT_NOT_IMPLEMENTED");
  if (documentType === "33" && code !== "3") fail("E33_REQUIRES_AMOUNT_CORRECTION_CODE_3");
  if (documentType === "34") {
    if (adjustmentMode === "partial" && code !== "3") fail("E34_PARTIAL_REQUIRES_CODE_3");
    if (adjustmentMode === "total" && code !== "1") fail("E34_TOTAL_REQUIRES_CODE_1");
  }
}

module.exports = { buildPartialAdjustmentTax, validateAdjustmentMode, singleTaxClass };
