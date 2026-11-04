"use strict";
const { createHash } = require("node:crypto");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
}
function makeKeys({ tenantId, clientId = "default", orderId, kind, documentType, body = {} }) {
  const tenant = String(tenantId);
  const branch = String(clientId);
  const order = String(orderId);
  if (kind === "ORDER") {
    return {
      issueKey: `order:${branch}:${order}`,
      activeSlot: `order:${tenant}:${branch}:${order}`,
    };
  }
  // Compatibilidad con formularios anteriores: una misma solicitud (mismo cuerpo)
  // siempre conserva su identificador. Las nuevas UI pueden proporcionar requestId.
  const callerKey = String(body.requestId || body.idempotencyKey || "").trim();
  const fiscalPayload = {
    documentType: String(documentType),
    adjustmentMode: body.adjustmentMode,
    modificationCode: body.modificationCode,
    reason: body.reason,
    amount: body.amount,
    baseAmount: body.baseAmount,
    items: body.items,
    discount: body.discount,
    totalWithTax: body.totalWithTax,
    confirmFullCancellation: body.confirmFullCancellation,
  };
  const fingerprint = createHash("sha256")
    .update(callerKey || JSON.stringify(canonical(fiscalPayload))).digest("hex");
  return {
    issueKey: `note:${branch}:${order}:${fingerprint}`,
    activeSlot: `note-active:${tenant}:${branch}:${order}`,
  };
}
function makeError(code, details) {
  const err = new Error(code);
  err.statusCode = 409;
  err.details = details;
  return err;
}
let indexCreationPromise;
async function ensureIndexes(Model) {
  // En producción Mongoose puede tener autoIndex=false. Asegurar índices antes
  // de admitir emisiones, sin borrar ni modificar índices de otras colecciones.
  if (typeof Model.createIndexes !== "function") return; // modelos falsos de pruebas
  if (!indexCreationPromise) {
    indexCreationPromise = Model.createIndexes().catch(error => {
      indexCreationPromise = null;
      throw error;
    });
  }
  await indexCreationPromise;
}
async function claimIssue(Model, props) {
  await ensureIndexes(Model);
  const keys = makeKeys(props);
  try {
    return await Model.create({ ...props, ...keys, stage: "claimed", body: undefined });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const previous = await Model.findOne({ tenantId: props.tenantId, issueKey: keys.issueKey }).lean();
    const active = previous || await Model.findOne({ activeSlot: keys.activeSlot }).lean();
    throw makeError("ECF_ISSUANCE_ALREADY_CLAIMED", {
      stage: active?.stage || "unknown",
      eNCF: active?.eNCF || null,
      documentId: active?.documentId || null,
    });
  }
}
async function advance(Model, attempt, patch) {
  await Model.updateOne({ _id: attempt._id }, { $set: patch });
  Object.assign(attempt, patch);
}
async function complete(Model, attempt, stage, patch = {}) {
  const update = { $set: { ...patch, stage, lastCheckedAt: new Date(), errorCode: null } };
  if (attempt.kind === "ECF_ADJUSTMENT" && ["accepted", "accepted_with_observation", "rejected"].includes(stage)) {
    update.$unset = { activeSlot: "" };
  }
  await Model.updateOne({ _id: attempt._id }, update);
}
async function failed(Model, attempt, error) {
  // Si no se reservó una secuencia, es seguro cancelar la reclamación.
  if (!attempt.sequenceNumber && attempt.stage === "claimed") {
    await Model.deleteOne({ _id: attempt._id });
    return;
  }
  // Secuencia reservada => NUNCA reintentar automáticamente.
  await Model.updateOne({ _id: attempt._id }, {
    $set: { stage: "needs_review", errorCode: String(error?.message || "ECF_UNKNOWN_ERROR").slice(0, 140) },
  });
}
module.exports = { canonical, makeKeys, claimIssue, advance, complete, failed };
