const express = require("express");
const router = express.Router();
const Tenant = require("../models/tenantModel");
const verifyToken = require("../middlewares/tokenVerification");
const { tenantMiddleware } = require("../middlewares/tenantMiddleware");
router.get("/:tenantId", verifyToken, tenantMiddleware, async (req, res, next) => {
    try {
        if (req.user.role === "SuperAdmin") {
            return res.status(403).json({ message: "Use the SuperAdmin tenants API" });
        }
        if (req.params.tenantId !== req.tenantId) {
            return res.status(404).json({ message: "Tenant not found" });
        }
        const adminLike = ["Owner", "Admin"].includes(req.scope.membership.role);
        // Explicit allowlist keeps fiscal credentials and internal tenant state out of staff responses.
        const fields = adminLike
            ? "tenantId name plan status localization business features fiscal taxConfig taxIdentity printing"
            : "tenantId name plan status localization business features taxConfig printing";
        const tenant = await Tenant.findOne({ tenantId: req.tenantId }).select(fields).lean();
        if (!tenant) return res.status(404).json({ message: "Tenant not found" });
        return res.json({ success: true, data: tenant });
    } catch (e) { next(e); }
});
module.exports = router;
