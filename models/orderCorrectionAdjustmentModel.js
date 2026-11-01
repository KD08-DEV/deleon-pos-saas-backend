"use strict";
const mongoose = require("mongoose");
// Libro append-only para correcciones de ventas cobradas (no modifica cierres históricos).
const schema = new mongoose.Schema({
    tenantId: { type: String, required: true, index: true },
    clientId: { type: String, required: true, index: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    correctionCode: { type: String, default: null, index: true },
    originalCashSessionId: { type: mongoose.Schema.Types.ObjectId, ref: "CashSession", default: null },
    originalSessionStatus: { type: String, enum: ["OPEN", "CLOSED", "NOT_FOUND"], required: true },
    previousTotal: { type: Number, required: true },
    newTotal: { type: Number, required: true },
    delta: { type: Number, required: true },
    previousPaymentMethod: { type: String, required: true },
    nextPaymentMethod: { type: String, required: true },
    settlement: { type: mongoose.Schema.Types.Mixed, default: null },
    reason: { type: String, required: true },
    changed: { type: [String], default: [] },
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    reconciliationStatus: { type: String, enum: ["OPEN_REGISTER_RECORDED", "REQUIRES_RECONCILIATION"], required: true },
}, { timestamps: true, versionKey: false });
schema.index({ tenantId: 1, clientId: 1, createdAt: -1 });
module.exports = mongoose.model("OrderCorrectionAdjustment", schema);
