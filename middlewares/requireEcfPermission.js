"use strict";
/**
 * Fase 12.3. Scope and membership MUST have been verified by tenantMiddleware.
 * NEVER derive permission from x-tenant-id, request body, or req.user.role alone.
 */
const VALID_TYPES = new Set(["33", "34"]);
const VALID_PERMISSIONS = Object.freeze({
  issue: "fiscal.ecfIssue",
  credit: "fiscal.creditNote",
  debit: "fiscal.debitNote",
  manage: "fiscal.manage",
});
function getCapabilities(req) {
  const member = req.scope?.membership;
  const tenantId = String(req.scope?.tenantId || "");
  const clientId = String(req.scope?.clientId || "");
  if (!member || !tenantId || !clientId || !req.user?._id ||
      String(member.tenantId) !== tenantId ||
      String(member.user?._id || member.user) !== String(req.user._id) ||
      member.status !== "active") {
    return { issue: false, credit: false, debit: false, manage: false };
  }
  const isAdmin = member.role === "Owner" || member.role === "Admin";
  if (isAdmin) return { issue: true, credit: true, debit: true, manage: true };
  // Employee permissions are only grantable to the cashier role.
  if (member.role !== "Cajera") return { issue: false, credit: false, debit: false, manage: false };
  const allowedBranches = Array.isArray(member.clientIds) ? member.clientIds.map(String) : [];
  if (clientId !== "default" && !allowedBranches.includes(clientId))
    return { issue: false, credit: false, debit: false, manage: false };
  if (clientId === "default" && allowedBranches.length && !allowedBranches.includes("default"))
    return { issue: false, credit: false, debit: false, manage: false };
  const p = member.permissions?.fiscal || {};
  return {
    issue: p.ecfIssue === true,
    credit: p.creditNote === true,
    debit: p.debitNote === true,
    manage: false,
  };
}
function deny(res, permission) {
  return res.status(403).json({success:false,code:"ECF_PERMISSION_DENIED",permission:VALID_PERMISSIONS[permission]});
}
function requireEcfPermission(kind) {
  if (!VALID_PERMISSIONS[kind]) throw new Error("Invalid ECF permission");
  return (req,res,next) => {
    if (!getCapabilities(req)[kind]) return deny(res,kind);
    return next();
  };
}
function requireEcfAdjustmentPermission(req,res,next) {
  const raw = req.body?.documentType ?? req.body?.type;
  const docType = String(raw ?? "").trim().replace(/^e/i, "");
  if (!VALID_TYPES.has(docType)) return res.status(400).json({success:false,code:"INVALID_ECF_ADJUSTMENT_TYPE"});
  return requireEcfPermission(docType === "34" ? "credit" : "debit")(req,res,next);
}
// Used only with verified tenant+branch scope, and only when the tenant would auto-issue.
async function requireAutomaticEcfPermission(req,res,next) {
  try {
    if (String(req.body?.submitAction || "").trim().toLowerCase() !== "invoice") return next();
    const rawType = String(req.body?.fiscal?.ecfDocumentType || "").trim();
    const selectedType = rawType.replace(/^e/i, "");
    if (rawType && !["31","32"].includes(selectedType))
        return res.status(400).json({success:false,code:"INVALID_ECF_DOCUMENT_TYPE"});
    // requested=true WITHOUT ecfDocumentType is an ordinary B01/B02 NCF request.
    // ECF permissions must not swallow the legacy NCF path from an e-CF OFF branch.
    if (!["31","32"].includes(selectedType)) return next();
    const Tenant = require("../models/tenantModel");
    const TenantEcfProfile = require("../models/tenantEcfProfileModel");
    const {getPlanFeatures} = require("./requirePlan");
    const {assertSecondarySandboxIssue} = require("../services/ecf/ecfBranchAccess");
    const tenant = await Tenant.findOne({tenantId:req.scope.tenantId,status:"active"})
      .select("plan fiscal.enabled features.fiscal.enabled localization.countryCode").lean();
    if (!tenant) return res.status(403).json({success:false,code:"TENANT_UNAVAILABLE"});
    if (String(tenant.localization?.countryCode || "DO").toUpperCase() !== "DO" ||
        !getPlanFeatures(tenant.plan).fiscal || tenant.fiscal?.enabled !== true ||
        tenant.features?.fiscal?.enabled === false)
        return res.status(403).json({success:false,code:"FISCAL_NOT_ENABLED"});
    const profile = await TenantEcfProfile.findOne({tenantId:req.scope.tenantId}).select("enabled").lean();
    if (!profile?.enabled) return res.status(403).json({success:false,code:"ECF_PROFILE_NOT_ENABLED"});
    try { await assertSecondarySandboxIssue(req.scope); }
    catch(e) {return res.status(e.statusCode || 403).json({success:false,code:e.message});}
    return requireEcfPermission("issue")(req,res,next);
  } catch(error) {return next(error);}
}
module.exports = {getCapabilities,requireEcfPermission,requireEcfAdjustmentPermission,requireAutomaticEcfPermission};
