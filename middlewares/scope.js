// pos-backend/middlewares/scope.js
const Membership = require("../models/membershipModel");
const Tenant = require("../models/tenantModel");

module.exports = function requireScope(opts = { level: "client" }) {
    return async (req, res, next) => {
        try {
            if (req.user && req.user.role === "SuperAdmin") {
                return next();
            }

            const tenantId = req.user?.tenantId;
            if (req.headers["x-tenant-id"] && req.headers["x-tenant-id"] !== tenantId) {
                return res.status(403).json({ message: "Tenant access denied" });
            }

            // En rutas administrativas de sucursales el clientId de la URL es el
            // recurso de destino, NO la sucursal activa del navegador.
            const requestedClients = [
                req.headers["x-client-id"],
                ...(opts.ignoreRouteClientId ? [] : [req.params.clientId]),
                req.query.clientId,
                req.body?.clientId,
            ].filter((v) => v !== undefined && v !== null && v !== "").map(String);
            if (requestedClients.length && requestedClients.some((v) => v !== requestedClients[0])) {
                return res.status(403).json({ message: "Conflicting branch scope" });
            }
            const clientId = req.clientId || requestedClients[0] || "default";
            if (req.clientId && requestedClients.some((v) => v !== req.clientId)) {
                return res.status(403).json({ message: "Branch access denied" });
            }

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

            if (clientId !== "default") {
                const Client = require("../models/clientModel");
                const exists = await Client.exists({ tenantId, clientId: String(clientId), isActive: true });
                if (!exists) return res.status(403).json({ message: "Branch unavailable" });
            }
            const role = membership.role;
            const isOwnerOrAdmin = role === "Owner" || role === "Admin";

            // Every route must respect branch membership, even when the route only
            // requests tenant-level access. A tenant-scoped endpoint may still
            // consume x-client-id in downstream controllers.
            if (true) {
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