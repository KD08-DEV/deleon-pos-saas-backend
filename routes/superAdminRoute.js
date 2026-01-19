const express = require("express");
const router = express.Router();
const verifyToken = require("../middlewares/tokenVerification");
const Tenant = require("../models/tenantModel");
const { getTenantUsage } = require("../controllers/superadminUsageController");
const { updateTenantFeatures } = require("../controllers/userController");


// Middleware local para asegurar SuperAdmin
function isSuperAdmin(req, res, next) {
    if (req.user && req.user.role === "SuperAdmin") return next();
    return res.status(403).json({ message: "SuperAdmin only" });
}

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
    const { plan } = req.body; // "emprendedor" | "premium" | "vip"

    if (!["emprendedor", "premium", "vip"].includes(plan)) {
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

module.exports = router;
