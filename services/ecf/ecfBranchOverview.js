"use strict";
// Presentación exclusivamente agregada: nunca expone XML, certificados o datos del comprador.
const OPEN_STAGES = ["claimed", "reserving", "reserved", "xml_generated", "signed", "dispatching", "submitted", "track_received", "pending", "needs_review"];
function classifyBranch(clientId) {
  return typeof clientId === "string" && clientId.length ? clientId : "default";
}
function summarizeBranches({ clients = [], profile, documents = [], attempts = [] }) {
  const table = new Map();
  const add = (id, name, active, enabled) => {
    table.set(id, { clientId: id, name, active: Boolean(active), ecfEnabled: Boolean(enabled),
      documents: 0, accepted: 0, rejected: 0, openDocuments: 0, openAttempts: 0, needsReview: 0,
      environments: { internal_sandbox: 0, dgii_certification: 0, dgii_production: 0, legacy_unknown: 0 } });
  };
  add("default", "Principal", true, Boolean(profile) && profile?.branchActivation?.primaryEnabled !== false);
  for (const client of clients) {
    if (!client.clientId || client.clientId === "default") continue;
    add(String(client.clientId), String(client.name || "Sucursal").slice(0, 120), client.isActive === true, client.ecf?.enabled === true);
  }
  for (const doc of documents) {
    const row = table.get(classifyBranch(doc._id?.clientId));
    if (!row) continue;
    const count = Number(doc.count) || 0;
    row.documents += count;
    const status = String(doc._id?.status || "");
    if (status === "accepted" || status === "accepted_with_observation") row.accepted += count;
    else if (status === "rejected") row.rejected += count;
    else if (!["cancelled"].includes(status)) row.openDocuments += count;
    const env = String(doc._id?.environment || "legacy_unknown");
    row.environments[Object.hasOwn(row.environments, env) ? env : "legacy_unknown"] += count;
  }
  for (const attempt of attempts) {
    const row = table.get(classifyBranch(attempt._id?.clientId));
    if (!row) continue;
    const count = Number(attempt.count) || 0;
    if (OPEN_STAGES.includes(String(attempt._id?.stage))) row.openAttempts += count;
    if (String(attempt._id?.stage) === "needs_review") row.needsReview += count;
  }
  const profileReady = profile?.enabled === true &&
    Boolean(String(profile?.issuer?.rnc || "").trim()) &&
    Boolean(String(profile?.issuer?.legalName || "").trim()) &&
    Boolean(String(profile?.issuer?.taxAddress || "").trim());
  for (const item of table.values()) {
    item.profileReady = profileReady;
    item.canIssueInSandbox = item.active && item.ecfEnabled && profileReady &&
      profile?.environment === "internal_sandbox";
  }
  return Array.from(table.values());
}
module.exports = { OPEN_STAGES, classifyBranch, summarizeBranches };
