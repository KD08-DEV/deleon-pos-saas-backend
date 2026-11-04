"use strict";
const Client = require("../models/clientModel");
const TenantEcfProfile = require("../models/tenantEcfProfileModel");
const ElectronicTaxDocument = require("../models/electronicTaxDocumentModel");
const EcfEmissionAttempt = require("../models/ecfEmissionAttemptModel");
const { summarizeBranches } = require("../services/ecf/ecfBranchOverview");

function createOverview({ Clients = Client, Profiles = TenantEcfProfile, Documents = ElectronicTaxDocument, Attempts = EcfEmissionAttempt } = {}) {
  return async (req, res, next) => {
    try {
      const tenantId = String(req.scope?.tenantId || "");
      const membership = req.scope?.membership;
      // Acceso transversal SOLO Owner de una membresía activa verificada. No aceptar overrides del navegador.
      if (!tenantId || membership?.status !== "active" || membership?.role !== "Owner" ||
          String(membership.tenantId) !== tenantId || req.user?.role === "SuperAdmin") {
        return res.status(403).json({ success: false, code: "ECF_BRANCH_OVERVIEW_OWNER_ONLY" });
      }
      if (req.query?.tenantId || req.query?.clientId || req.query?.scope || req.body?.tenantId) {
        return res.status(400).json({ success: false, code: "ECF_OVERVIEW_SCOPE_OVERRIDE_FORBIDDEN" });
      }
      const match = { tenantId };
      const [clients, profile, documents, attempts] = await Promise.all([
        Clients.find(match).select("clientId name isActive ecf.enabled").lean(),
        Profiles.findOne(match).select("enabled environment certificationStatus branchActivation.primaryEnabled issuer.rnc issuer.legalName issuer.taxAddress").lean(),
        Documents.aggregate([
          { $match: match },
          { $group: { _id: { clientId: { $ifNull: ["$clientId", "default"] }, status: "$ecf.status", environment: "$ecf.environment" }, count: { $sum: 1 } } },
        ]),
        Attempts.aggregate([
          { $match: match },
          { $group: { _id: { clientId: { $ifNull: ["$clientId", "default"] }, stage: "$stage" }, count: { $sum: 1 } } },
        ]),
      ]);
      res.set("Cache-Control", "private, no-store");
      return res.json({ success: true, data: {
        environment: profile?.environment || "not_configured",
        // This is profile state, not evidence of DGII authorization.
        ecfProfileEnabled: profile?.enabled === true,
        certificationStatus: profile?.certificationStatus || "not_started",
        productionReady: false,
        signing: { externalProviderIntegrated: false, status: "PENDING_PROVIDER_SELECTION_AND_VALIDATION" },
        branches: summarizeBranches({ clients, profile, documents, attempts }),
      } });
    } catch (err) { return next(err); }
  };
}
module.exports = { createOverview, getEcfBranchOverview: createOverview() };
