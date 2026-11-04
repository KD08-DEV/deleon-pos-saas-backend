"use strict";
// Legacy empty clientIds belong only to the principal branch.
const ADMIN_ROLES = ["Owner", "Admin"];
const selected = id => String(id || "default").trim() || "default";
function visibleInBranch(membership, clientId) {
  if (!membership || membership.status && membership.status !== "active") return false;
  if (ADMIN_ROLES.includes(membership.role)) return true;
  const ids = Array.isArray(membership.clientIds) ? membership.clientIds.map(String) : [];
  return ids.includes(selected(clientId)) || (selected(clientId) === "default" && ids.length === 0);
}
function membershipFilter(tenantId, clientId) {
  const branchId = selected(clientId);
  const clauses = [{ role: { $in: ADMIN_ROLES } }, { clientIds: branchId }];
  if (branchId === "default") clauses.push({ clientIds: { $size: 0 } }, { clientIds: { $exists: false } });
  return { tenantId, status: "active", $or: clauses };
}
function validateBranchIds(value) {
  if (!Array.isArray(value) || !value.length || value.length > 3 || value.some(x => typeof x !== "string" || !x.trim() || x.length > 100)) return null;
  const ids = [...new Set(value.map(x=>x.trim()))];
  return ids;
}
module.exports = { selected, visibleInBranch, membershipFilter, validateBranchIds, ADMIN_ROLES };
