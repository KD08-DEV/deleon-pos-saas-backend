// pos-backend/middlewares/scope.js
const Membership = require("../models/membershipModel");
const Tenant = require("../models/tenantModel");

module.exports = function requireScope(opts = { level: "client" }) {
    return async (req, res, next) => {
        try {
            // 🔥 SUPERADMIN no usa memberships ni tenant scope
            if (req.user && req.user.role === "SuperAdmin") {
                return next();
            }

            const tenantId = req.headers["x-tenant-id"] || req.user?.tenantId;
            const clientId =
                req.headers["x-client-id"] ||
                req.params.clientId ||
                req.query.clientId ||
                null;

            if (!tenantId) {
                return res.status(400).json({ message: "Missing tenantId" });
            }

            // Verificar tenant activo
            const tenant = await Tenant.findOne({ tenantId });
            if (!tenant || tenant.status !== "active") {
                return res.status(403).json({ message: "Tenant suspended" });
            }

            // Membership del usuario en este tenant
            const membership = await Membership.findOne({
                user: req.user._id,
                tenantId,
                status: "active",
            });

            if (!membership) {
                return res.status(403).json({ message: "No membership" });
            }

            const role = membership.role; // Owner/Admin/Cashier/Waiter
            const isOwnerOrAdmin = role === "Owner" || role === "Admin";

            if (opts.level === "client") {
                if (!clientId) {
                    return res.status(400).json({ message: "Missing clientId" });
                }
                if (!isOwnerOrAdmin && !membership.clientIds.includes(clientId)) {
                    return res.status(403).json({ message: "Client access denied" });
                }
            }

            req.scope = { tenantId, clientId, membership };
            next();
        } catch (e) {
            console.error("SCOPE_ERROR:", e);
            res.status(500).json({ message: "SCOPE_ERROR" });
        }
    };
};
