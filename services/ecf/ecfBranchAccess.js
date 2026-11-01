"use strict";
/**
 * Phase 12.6.2. One taxpayer/one TenantEcfProfile; branch flags are not DGII approvals.
 * Client identity always comes from verified tenantMiddleware scope (not client payload).
 * Secondary issuance is deliberately restricted to internal_sandbox pending end-to-end
 * DGII/provider certification; disallow production AND dgii_certification here.
 */
const Client = require("../../models/clientModel");
const TenantEcfProfile = require("../../models/tenantEcfProfileModel");
const Tenant = require("../../models/tenantModel");
const { getPlanFeatures } = require("../../middlewares/requirePlan");

function fiscalError(code, statusCode = 403) {
  const error = new Error(code);
  error.statusCode = statusCode;
  return error;
}
function secondary(clientId) { return String(clientId || "default") !== "default"; }

async function getBranchEcfStatus({tenantId, clientId}) {
  if (!tenantId) throw fiscalError("TENANT_REQUIRED");
  if (!secondary(clientId)) {
    const profile = await TenantEcfProfile.findOne({tenantId})
      .select("branchActivation.primaryEnabled").lean();
    const enabled = profile?.branchActivation?.primaryEnabled !== false;
    return {clientId:"default", secondary:false, prepared:enabled, active:true, name:"Sucursal principal"};
  }
  const branch = await Client.findOne({tenantId,clientId}).select("isActive ecf.enabled name").lean();
  return {clientId, secondary:true, prepared:branch?.isActive === true && branch?.ecf?.enabled === true,
    active:branch?.isActive === true, name:branch?.name || null};
}
async function assertSecondarySandboxIssue({tenantId, clientId, tenant = null}) {
  if (!tenantId || !clientId) throw fiscalError("TENANT_BRANCH_SCOPE_REQUIRED");
  const profile = await TenantEcfProfile.findOne({tenantId}).select("enabled environment branchActivation.primaryEnabled").lean();
  if (!profile?.enabled) throw fiscalError("ECF_PROFILE_NOT_ENABLED");
  if (!secondary(clientId)) {
    if (profile.branchActivation?.primaryEnabled === false) throw fiscalError("BRANCH_ECF_DISABLED");
    return {enabled:true,clientId:"default",mode:"global"};
  }
  const liveTenant = tenant || await Tenant.findOne({tenantId}).select("status plan localization.countryCode fiscal.enabled features.fiscal.enabled").lean();
  if (!liveTenant || liveTenant.status !== "active" ||
      String(liveTenant.localization?.countryCode || "DO").toUpperCase() !== "DO" ||
      getPlanFeatures(liveTenant.plan).fiscal !== true ||
      liveTenant.fiscal?.enabled !== true || liveTenant.features?.fiscal?.enabled === false)
    throw fiscalError("BRANCH_ECF_TENANT_FISCAL_DISABLED");
  const branch = await Client.findOne({tenantId, clientId}).select("isActive ecf.enabled").lean();
  if (!branch || branch.isActive !== true) throw fiscalError("BRANCH_INACTIVE");
  if (branch.ecf?.enabled !== true) throw fiscalError("BRANCH_ECF_NOT_PREPARED");
  if (profile.environment !== "internal_sandbox")
    throw fiscalError("BRANCH_ECF_ONLY_INTERNAL_SANDBOX");
  return {enabled:true,clientId,mode:"shared_sandbox"};
}
const getSecondaryBranchStatus = getBranchEcfStatus; // compatibility
module.exports = {assertSecondarySandboxIssue,getBranchEcfStatus,getSecondaryBranchStatus,fiscalError,secondary};
