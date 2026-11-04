"use strict";
const Tenant = require("../models/tenantModel");
const Membership = require("../models/membershipModel");
const Client = require("../models/clientModel");

async function tenantMiddleware(req, res, next) {
    try {
        if (!req.user) return res.status(401).json({ message: "Authentication required" });
        if (req.user.role === "SuperAdmin") return next();
        // Tenant belongs to the verified JWT/user. Never to the request header.
        const tenantId = String(req.user.tenantId || "");
        if (!tenantId) return res.status(403).json({ message: "Tenant not identified" });
        const suppliedTenant = req.headers["x-tenant-id"];
        if (suppliedTenant && suppliedTenant !== tenantId) {
            return res.status(403).json({ message: "Tenant access denied" });
        }
        const tenant = await Tenant.findOne({ tenantId }).select("status").lean();
        if (!tenant || tenant.status !== "active") {
            return res.status(403).json({ message: "Tenant unavailable" });
        }
        const membership = await Membership.findOne({
            tenantId, user: req.user._id, status: "active",
        });
        if (!membership) return res.status(403).json({ message: "No active membership" });

        const clientId = String(req.headers["x-client-id"] || "default").trim();
        if (!clientId || clientId.length > 100 || clientId === "__proto__") {
            return res.status(400).json({ message: "Invalid branch" });
        }
        if (clientId !== "default") {
            const exists = await Client.exists({ tenantId, clientId, isActive: true });
            if (!exists) return res.status(403).json({ message: "Branch unavailable" });
        }
        const allowedIds = (membership.clientIds || []).map(String);
        const adminLike = ["Owner", "Admin"].includes(membership.role);
        const legacyDefault = clientId === "default" && allowedIds.length === 0;
        if (!adminLike && !legacyDefault && !allowedIds.includes(clientId)) {
            return res.status(403).json({ message: "Branch access denied" });
        }
        req.tenantId = tenantId;
        req.clientId = clientId;
        req.scope = { tenantId, clientId, membership };
        req.authzMembership = membership;
        next();
    } catch (error) { next(error); }
}

module.exports = { tenantMiddleware, protectTenant: tenantMiddleware };
