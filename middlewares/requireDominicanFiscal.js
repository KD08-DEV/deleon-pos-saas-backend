const Tenant = require("../models/tenantModel");
const { getPlanFeatures } = require("./requirePlan");
const { assertSecondarySandboxIssue } = require("../services/ecf/ecfBranchAccess");
module.exports = function requireDominicanFiscal({ issuance = false, branchRead = false, branchReconcile = false } = {}) {
    return async (req, res, next) => {
        try {
            if (!req.tenantId && !req.user?.tenantId) {
                return res.status(403).json({ code: "TENANT_REQUIRED" });
            }
            const tenant = await Tenant.findOne({ tenantId: req.tenantId || req.user.tenantId })
                .select("plan status localization.countryCode fiscal.enabled features.fiscal.enabled").lean();
            if (!tenant || tenant.status !== "active") return res.status(403).json({ code: "TENANT_UNAVAILABLE" });
            if (String(tenant.localization?.countryCode || "DO").toUpperCase() !== "DO") {
                return res.status(403).json({ code: "DGII_ONLY_DOMINICAN_REPUBLIC" });
            }
            // Shared profile: only safe GET routes opt in via branchRead.
            // Mutations remain exclusive to default; secondary issuance requires a
            // prepared, active branch and is restricted to internal sandbox.
            const branchId = String(req.scope?.clientId || req.clientId || "default");
            if (branchId !== "default") {
                if (issuance) {
                    try {
                        await assertSecondarySandboxIssue({tenantId:req.scope.tenantId,clientId:branchId,tenant});
                    } catch (error) { return res.status(error.statusCode || 403).json({code:error.message}); }
                } else if (!((branchRead && req.method === "GET") ||
                             (branchReconcile && req.method === "POST"))) {
                    return res.status(403).json({ code: "BRANCH_ECF_GLOBAL_PROFILE_READ_ONLY" });
                }
            }
            if (!getPlanFeatures(tenant.plan).fiscal) {
                return res.status(403).json({ code: "PLAN_FISCAL_DENIED" });
            }
            if (issuance && (tenant.fiscal?.enabled !== true || tenant.features?.fiscal?.enabled === false)) {
                return res.status(403).json({ code: "FISCAL_NOT_ENABLED" });
            }
            next();
        } catch (e) { next(e); }
    };
};
