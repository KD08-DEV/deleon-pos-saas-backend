const express = require("express");
const router = express.Router();
const verifyToken = require("../middlewares/tokenVerification");
const Tenant = require("../models/tenantModel");
const Order = require("../models/orderModel");
const { resolveTenantLocalization } = require("../config/tenantLocales");
const { register } = require("../controllers/userController");
const { getTenantUsage } = require("../controllers/superadminUsageController");
const { updateTenantFeatures } = require("../controllers/userController");


// Middleware local para asegurar SuperAdmin
function isSuperAdmin(req, res, next) {
    if (req.user && req.user.role === "SuperAdmin") return next();
    return res.status(403).json({ message: "SuperAdmin only" });
}

// Dedicated onboarding route; employee registration remains scoped to an existing tenant.
router.post("/tenants", verifyToken, isSuperAdmin, register);

// =========================
// GET: Lista de Tenants
// =========================
router.get("/tenants", verifyToken, isSuperAdmin, async (req, res) => {
    const tenants = await Tenant.find().sort({ createdAt: -1 });
    res.json({ success: true, data: tenants });
});

// =========================
// GET: Usage de todos los tenants
// =========================
router.get(
    "/tenant-usage",
    verifyToken,
    isSuperAdmin,       // <--- FIX: ya no usamos requireRole
    getTenantUsage
);

// =========================
// PATCH: Cambiar estado del tenant
// =========================
router.patch("/tenants/:tenantId/status", verifyToken, isSuperAdmin, async (req, res) => {
    const { tenantId } = req.params;
    const { status } = req.body; // "active" | "suspended"

    if (!["active", "suspended"].includes(status)) {
        return res.status(400).json({ message: "Invalid status" });
    }

    const tenant = await Tenant.findOneAndUpdate(
        { tenantId },
        { status },
        { new: true }
    );

    if (!tenant) {
        return res.status(404).json({ message: "Tenant not found" });
    }

    if (status === "suspended") {
        try {
            req.app?.get?.("io")
                ?.in?.(`tenant:${tenantId}`)
                ?.disconnectSockets?.(true);
        } catch (socketError) {
            console.error(
                "SOCKET_TENANT_DISCONNECT_FAILED",
                socketError?.message
            );
        }
    }

    res.json({ success: true, data: tenant });
});
// =========================
// PATCH: Features del tenant (tax/discount/fiscal)
// =========================
router.patch(
    "/tenants/:tenantId/features",
    verifyToken,
    isSuperAdmin,
    updateTenantFeatures
);
// =========================
// PATCH: Cambiar plan del tenant
// =========================
router.patch("/tenants/:tenantId/plan", verifyToken, isSuperAdmin, async (req, res) => {
    const { tenantId } = req.params;
    const { plan } = req.body; // "emprendedor" | "premium" | "estandar"

    if (!["emprendedor", "premium", "estandar", "pro"].includes(plan)) {
        return res.status(400).json({ message: "Invalid plan" });
    }

    const tenant = await Tenant.findOneAndUpdate(
        { tenantId },
        { plan },
        { new: true }
    );

    if (!tenant) {
        return res.status(404).json({ message: "Tenant not found" });
    }

    res.json({ success: true, data: tenant });
});

// Existing businesses: language/timezone can change; changing country after sales requires migration.
router.patch("/tenants/:tenantId/localization", verifyToken, isSuperAdmin, async (req, res, next) => {
    try {
        const tenant = await Tenant.findOne({ tenantId: req.params.tenantId });
        if (!tenant) return res.status(404).json({ message: "Tenant not found" });
        const existing = tenant.localization?.toObject?.() || tenant.localization || {};
        const nextLocalization = resolveTenantLocalization(req.body || {}, existing);
        if (nextLocalization.countryCode !== String(existing.countryCode || "DO").toUpperCase()) {
            const salesExist = await Order.exists({ tenantId: tenant.tenantId });
            if (salesExist) return res.status(409).json({ message: "COUNTRY_CHANGE_REQUIRES_MIGRATION" });
            if (nextLocalization.countryCode !== "DO") {
                tenant.set("fiscal.enabled", false);
                tenant.set("features.fiscal.enabled", false);
                tenant.set("fiscal.ncfConfig.B01.active", false);
                tenant.set("fiscal.ncfConfig.B02.active", false);
            }
        }
        for (const [key, value] of Object.entries(nextLocalization)) {
            tenant.set(`localization.${key}`, value);
        }
        await tenant.save();
        res.json({ success: true, data: { tenantId: tenant.tenantId, localization: tenant.localization } });
    } catch (error) {
        if (error.status === 400) return res.status(400).json({ message: error.message });
        next(error);
    }
});

// Eliminación DESTRUCTIVA, exclusivamente SuperAdmin; apagada por defecto.
// Actívala conscientemente con ENABLE_PERMANENT_TENANT_DELETE=true solo tras un respaldo.
const { scanTenant, deleteTenant } = require("../services/tenantPurgeService");
router.get("/tenants/:tenantId/delete-preview", verifyToken, isSuperAdmin, async (req, res, next) => {
    try {
        const report = await scanTenant(String(req.params.tenantId));
        if (!report) return res.status(404).json({ code: "TENANT_NOT_FOUND" });
        return res.json({ success: true, data: report,
            deletionEnabled: process.env.ENABLE_PERMANENT_TENANT_DELETE === "true" });
    } catch (e) { next(e); }
});
router.delete("/tenants/:tenantId", verifyToken, isSuperAdmin, async (req, res, next) => {
    try {
        if (process.env.ENABLE_PERMANENT_TENANT_DELETE !== "true")
            return res.status(403).json({ code: "PERMANENT_DELETION_DISABLED" });
        const tenantId = String(req.params.tenantId);
        const t = await Tenant.findOne({ tenantId }).select("tenantId name status").lean();
        if (!t) return res.status(404).json({ code: "TENANT_NOT_FOUND" });
        if (req.body?.tenantId !== tenantId ||
            req.body?.tenantName !== t.name ||
            req.body?.confirmation !== `BORRAR ${t.name}` ||
            req.body?.backupConfirmed !== true)
            return res.status(400).json({ code: "DELETION_CONFIRMATION_MISMATCH" });
        const result = await deleteTenant(tenantId);
        // Si la limpieza de Supabase es parcial se devuelve 207, nunca "100% eliminado".
        return res.status(result.complete ? 200 : 207).json({ success: result.complete, data: result });
    } catch (e) {
        if (e.status) return res.status(e.status).json({ code: e.message, details: e.details });
        next(e);
    }
});

// Gestión del padrón RNC exclusiva para SuperAdmin; no se expone en rutas de tenants.
const rncImport = require("../controllers/superAdminRncController");
router.get("/rnc/import/status", verifyToken, isSuperAdmin, rncImport.status);
router.post("/rnc/import/preview", verifyToken, isSuperAdmin, rncImport.uploadMiddleware, rncImport.preview);
router.post("/rnc/import/:id/commit", verifyToken, isSuperAdmin, rncImport.commit);
router.get("/rnc/import/:id", verifyToken, isSuperAdmin, rncImport.getJob);

// DGII producción: verificación externa documentada exclusivamente por SuperAdmin.
const ecfProduction = require("../controllers/superAdminEcfProductionController");
router.get("/ecf/authorizations", verifyToken, isSuperAdmin, ecfProduction.list);
router.get("/ecf/authorizations/:tenantId", verifyToken, isSuperAdmin, ecfProduction.detail);
router.post("/tenants/:tenantId/ecf/evidence", verifyToken, isSuperAdmin, ecfProduction.evidenceUpload, ecfProduction.uploadEvidence);
router.get("/tenants/:tenantId/ecf/evidence-url", verifyToken, isSuperAdmin, ecfProduction.evidenceUrl);
router.patch("/tenants/:tenantId/ecf/production-approval", verifyToken, isSuperAdmin, ecfProduction.approve);
router.post("/tenants/:tenantId/ecf/confirm-certification", verifyToken, isSuperAdmin, ecfProduction.confirmCertification);
router.post("/tenants/:tenantId/ecf/revoke-production", verifyToken, isSuperAdmin, ecfProduction.revoke);

module.exports = router;
