// pos-backend/middlewares/tenantMiddleware.js
const Tenant = require("../models/tenantModel");

async function tenantMiddleware(req, res, next) {
    try {
        // 🔥 SUPERADMIN no usa tenant
        if (req.user && req.user.role === "SuperAdmin") {
            return next();
        }

        const tenantFromToken = req.user && req.user.tenantId;
        const tenantFromHeader = req.headers["x-tenant-id"];

        const tenantId = tenantFromToken || tenantFromHeader;
        if (!tenantId) {
            return res.status(403).json({ message: "Tenant not identified" });
        }

        // Verificar que el tenant exista y no esté suspendido
        const tenant = await Tenant.findOne({ tenantId });
        if (!tenant) {
            return res.status(404).json({ message: "Tenant not found" });
        }
        if (tenant.status !== "active") {
            return res.status(403).json({ message: "Tenant suspended" });
        }

        req.tenantId = tenantId;
        req.clientId = req.headers["x-client-id"] || "default";
        next();
    } catch (e) {
        console.error("tenantMiddleware error:", e);
        return res.status(500).json({ message: "TENANT_MIDDLEWARE_ERROR" });
    }
}

module.exports = {
    tenantMiddleware,
    protectTenant: tenantMiddleware,
};
