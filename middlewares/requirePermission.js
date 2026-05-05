const Membership = require("../models/membershipModel");

function getNestedValue(obj, path) {
    return String(path || "")
        .split(".")
        .reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
}

function getTenantId(req) {
    return (
        req.scope?.tenantId ||
        req.tenantId ||
        req.user?.tenantId ||
        req.headers["x-tenant-id"]
    );
}

function getRole(req, membership) {
    return (
        membership?.role ||
        req.scope?.membership?.role ||
        req.user?.role ||
        ""
    );
}

function isAdminLikeRole(role) {
    return ["SuperAdmin", "Owner", "Admin"].includes(String(role || ""));
}

async function getMembershipFromReq(req) {
    if (req.scope?.membership) return req.scope.membership;
    if (req.authzMembership) return req.authzMembership;

    const tenantId = getTenantId(req);
    const userId = req.user?._id;

    if (!tenantId || !userId) return null;

    const membership = await Membership.findOne({
        tenantId,
        user: userId,
        status: "active",
    });

    if (membership) {
        req.authzMembership = membership;
    }

    return membership;
}

async function hasPermission(req, permissionKey) {
    if (req.user?.role === "SuperAdmin") return true;

    const membership = await getMembershipFromReq(req);
    const role = getRole(req, membership);

    if (isAdminLikeRole(role)) return true;

    return getNestedValue(membership?.permissions || {}, permissionKey) === true;
}

function requirePermission(permissionKey) {
    return async (req, res, next) => {
        try {
            const allowed = await hasPermission(req, permissionKey);

            if (!allowed) {
                return res.status(403).json({
                    success: false,
                    code: "PERMISSION_DENIED",
                    permission: permissionKey,
                    message: "No tienes permiso para realizar esta acción.",
                });
            }

            return next();
        } catch (error) {
            return next(error);
        }
    };
}

module.exports = requirePermission;
module.exports.hasPermission = hasPermission;
module.exports.getNestedValue = getNestedValue;
module.exports.getMembershipFromReq = getMembershipFromReq;