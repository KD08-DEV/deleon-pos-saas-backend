"use strict";
const mongoose = require("mongoose");
// Una reclamación de emisión persiste incluso si la operación queda incierta.
// La colección es nueva: no modifica comprobantes fiscales anteriores.
const schema = new mongoose.Schema({
  tenantId: { type: String, required: true },
  clientId: { type: String, required: true, default: "default" },
  orderId: { type: mongoose.Schema.Types.ObjectId, required: true },
  kind: { type: String, enum: ["ORDER", "ECF_ADJUSTMENT"], required: true },
  documentType: { type: String, required: true },
  environment: { type: String, enum: ["internal_sandbox", "dgii_certification", "dgii_production"], default: undefined },
  issueKey: { type: String, required: true },
  // Solo se establece mientras una nota está pendiente. Para ORDER queda permanente.
  activeSlot: { type: String, default: undefined },
  stage: { type: String, default: "claimed" },
  documentId: { type: mongoose.Schema.Types.ObjectId, default: null },
  sequenceNumber: { type: Number, default: null },
  eNCF: { type: String, default: null },
  trackId: { type: String, default: null },
  errorCode: { type: String, default: null },
  lastCheckedAt: { type: Date, default: null },
}, { timestamps: true });
schema.index({ tenantId: 1, issueKey: 1 }, { unique: true, name: "ecf_issue_attempt_unique_key" });
schema.index({ activeSlot: 1 }, {
  unique: true, name: "ecf_issue_attempt_active_slot",
  partialFilterExpression: { activeSlot: { $type: "string" } },
});
schema.index({ tenantId: 1, clientId: 1, orderId: 1, createdAt: -1 });
schema.index({ tenantId: 1, clientId: 1, stage: 1, createdAt: -1 }, { name: "ecf_incident_scope_stage_date" });
module.exports = mongoose.models.EcfEmissionAttempt || mongoose.model("EcfEmissionAttempt", schema);
