// pos-backend/middlewares/scope.js
const Membership = require("../models/membershipModel");
const Tenant = require("../models/tenantModel");

module.exports = function requireScope(opts = { level: "client" }) {
    return async (req, res, next) => {
        try {
            if (req.user && req.user.role === "SuperAdmin") {
                return next();
            }

            const tenantId = req.headers["x-tenant-id"] || req.user?.tenantId;

            const clientId =
                req.headers["x-client-id"] ||
                req.params.clientId ||
                req.query.clientId ||
                req.body?.clientId ||
                "default";

            if (!tenantId) {
                return res.status(400).json({ message: "Missing tenantId" });
            }

            const tenant = await Tenant.findOne({ tenantId });
            if (!tenant || tenant.status !== "active") {
                return res.status(403).json({ message: "Tenant suspended" });
            }

            const membership = await Membership.findOne({
                user: req.user._id,
                tenantId,
                status: "active",
            });

            if (!membership) {
                return res.status(403).json({ message: "No membership" });
            }

            const role = membership.role;
            const isOwnerOrAdmin = role === "Owner" || role === "Admin";

            if (opts.level === "client") {
                const normalizedClientId = String(clientId || "default");

                const membershipClientIds = Array.isArray(membership.clientIds)
                    ? membership.clientIds.map((x) => String(x))
                    : [];

                // Compatibilidad para usuarios viejos:
                // Si la membresía no tiene clientIds, permitimos "default".
                const isLegacyDefaultClient =
                    membershipClientIds.length === 0 &&
                    normalizedClientId === "default";

                if (
                    !isOwnerOrAdmin &&
                    !isLegacyDefaultClient &&
                    !membershipClientIds.includes(normalizedClientId)
                ) {
                    return res.status(403).json({
                        message: "Client access denied",
                        details: {
                            requestedClientId: normalizedClientId,
                            membershipClientIds,
                            role,
                        },
                    });
                }
            }

            req.scope = {
                tenantId,
                clientId: clientId || "default",
                membership,
            };

            next();
        } catch (e) {
            console.error("SCOPE_ERROR:", e);
            res.status(500).json({ message: "SCOPE_ERROR" });
        }
    };
};