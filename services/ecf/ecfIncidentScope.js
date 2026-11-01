"use strict";

const ATTEMPT_OPEN = Object.freeze([
  "claimed", "reserving", "reserved", "xml_generated", "signed",
  "dispatching", "submitted", "track_received", "pending", "needs_review",
]);
const DOCUMENT_OPEN = Object.freeze([
  "draft", "xml_generated", "signed", "submitted", "track_received",
]);
const FINISHED = Object.freeze(["accepted", "accepted_with_observation", "rejected", "cancelled"]);

function parseIncidentQuery(query = {}) {
  const rawPage = String(query.page ?? "1");
  const rawMode = String(query.mode ?? "attempts");
  const rawFilter = String(query.filter ?? "open");
  if (!/^\d{1,5}$/.test(rawPage) || Number(rawPage) < 1 || Number(rawPage) > 10000)
    throw Object.assign(new Error("INVALID_INCIDENT_PAGE"), { statusCode: 400 });
  if (!["attempts", "documents"].includes(rawMode))
    throw Object.assign(new Error("INVALID_INCIDENT_MODE"), { statusCode: 400 });
  if (!["open", "finished", "all"].includes(rawFilter))
    throw Object.assign(new Error("INVALID_INCIDENT_FILTER"), { statusCode: 400 });
  return { page: Number(rawPage), limit: 20, mode: rawMode, filter: rawFilter };
}

function scopeForAttempts(tenantId, clientId) {
  return { tenantId: String(tenantId), clientId: String(clientId || "default") };
}
function scopeForDocuments(tenantId, clientId) {
  const base = { tenantId: String(tenantId) };
  return clientId === "default"
    ? { ...base, $or: [ { clientId: "default" }, { clientId: { $exists: false } } ] }
    : { ...base, clientId: String(clientId) };
}
function buildIncidentFilter({ mode, filter, tenantId, clientId }) {
  const scope = mode === "attempts"
    ? scopeForAttempts(tenantId, clientId)
    : scopeForDocuments(tenantId, clientId);
  if (filter === "all") return scope;
  const stages = filter === "open"
    ? (mode === "attempts" ? ATTEMPT_OPEN : DOCUMENT_OPEN)
    : FINISHED;
  return { ...scope, [mode === "attempts" ? "stage" : "ecf.status"]: { $in: stages } };
}
function safeAttempt(a) {
  return {
    id: String(a._id), orderId: a.orderId ? String(a.orderId) : null,
    documentId: a.documentId ? String(a.documentId) : null,
    source: "attempt", documentType: a.documentType || "",
    environment: a.environment || null,
    eNCF: a.eNCF || "", status: a.stage || "",
    trackId: a.trackId || "", errorCode: a.errorCode || "",
    createdAt: a.createdAt || null, updatedAt: a.updatedAt || null,
    lastCheckedAt: a.lastCheckedAt || null,
    needsManualReview: !a.documentId || !a.trackId,
  };
}
function safeDocument(d) {
  return {
    id: String(d._id), orderId: d.orderId ? String(d.orderId) : null,
    documentId: String(d._id), source: "document",
    documentType: d.ecf?.documentType || "",
    environment: d.ecf?.environment || null,
    eNCF: d.ecf?.eNCF || "", status: d.ecf?.status || "",
    trackId: d.ecf?.trackId || "", errorCode: "",
    createdAt: d.createdAt || null, updatedAt: d.updatedAt || null,
    lastCheckedAt: d.dgiiResponse?.receivedAt || null,
    needsManualReview: !d.orderId || (!d.ecf?.trackId && !d.ecf?.securityCode),
  };
}
module.exports = {
  ATTEMPT_OPEN, DOCUMENT_OPEN, FINISHED, parseIncidentQuery,
  scopeForAttempts, scopeForDocuments, buildIncidentFilter, safeAttempt, safeDocument,
};
