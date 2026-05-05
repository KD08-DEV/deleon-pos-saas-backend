// pos-backend/middlewares/requirePlan.js
const Tenant = require("../models/tenantModel");
const TIERS = require("../config/planTiers");

function normalizePlan(plan) {
    const normalized = String(plan || "emprendedor").trim().toLowerCase();
    return TIERS[normalized] ? normalized : "emprendedor";
}

function getTierByPlan(plan) {
    const normalizedPlan = normalizePlan(plan);
    return {
        plan: normalizedPlan,
        tier: TIERS[normalizedPlan] || TIERS.emprendedor,
    };
}

function getPlanFeatures(plan) {
    return getTierByPlan(plan).tier.features || {};
}

function getPlanLimits(plan) {
    return getTierByPlan(plan).tier.limits || {};
}

function isUnlimited(value) {
    return value === null || value === undefined;
}

async function getTenantFromReq(req) {
    const tenantId =
        req.scope?.tenantId ||
        req.tenantId ||
        req.user?.tenantId ||
        req.headers["x-tenant-id"];

    if (!tenantId) {
        return {
            error: {
                status: 400,
                message: "MISSING_TENANT_ID",
            },
        };
    }

    const tenant = await Tenant.findOne({ tenantId }).select("tenantId name plan status");
    if (!tenant) {
        return {
            error: {
                status: 404,
                message: "TENANT_NOT_FOUND",
            },
        };
    }

    if (tenant.status !== "active") {
        return {
            error: {
                status: 403,
                message: "TENANT_SUSPENDED",
            },
        };
    }

    const normalizedPlan = normalizePlan(tenant.plan);
    const tier = TIERS[normalizedPlan] || TIERS.emprendedor;

    return {
        tenant,
        plan: normalizedPlan,
        tier,
        features: tier.features || {},
        limits: tier.limits || {},
    };
}

function attachPlanContext(req, context) {
    req.tenantPlan = context.tenant;
    req.plan = context.plan;
    req.planTier = context.tier;
    req.planFeatures = context.features;
    req.planLimits = context.limits;
}

// Mantiene compatibilidad con tu forma vieja:
// requirePlan((tenant, req) => ({ ok: true }))
function requirePlan(checkFn) {
    return async (req, res, next) => {
        try {
            const context = await getTenantFromReq(req);

            if (context.error) {
                return res.status(context.error.status).json({
                    success: false,
                    message: context.error.message,
                });
            }

            attachPlanContext(req, context);

            const result = await checkFn(context.tenant, req, context);

            if (result?.ok === false) {
                return res.status(result.status || 403).json({
                    success: false,
                    code: result.code || "PLAN_LIMIT_REACHED",
                    message: result.reason || "Tu plan actual no permite esta acción.",
                    plan: context.plan,
                });
            }

            return next();
        } catch (error) {
            return next(error);
        }
    };
}

// Nueva forma recomendada:
// requireFeature("inventory")
function requireFeature(featureKey) {
    return async (req, res, next) => {
        try {
            const context = await getTenantFromReq(req);

            if (context.error) {
                return res.status(context.error.status).json({
                    success: false,
                    message: context.error.message,
                });
            }

            attachPlanContext(req, context);

            const allowed = Boolean(context.features?.[featureKey]);

            if (!allowed) {
                return res.status(403).json({
                    success: false,
                    code: "PLAN_FEATURE_NOT_ALLOWED",
                    feature: featureKey,
                    plan: context.plan,
                    message: "Tu plan actual no incluye esta función. Mejora tu plan para desbloquearla.",
                });
            }

            return next();
        } catch (error) {
            return next(error);
        }
    };
}

// Útil para rutas donde solo quieres cargar plan sin bloquear.
function attachPlan() {
    return async (req, res, next) => {
        try {
            const context = await getTenantFromReq(req);

            if (context.error) {
                return res.status(context.error.status).json({
                    success: false,
                    message: context.error.message,
                });
            }

            attachPlanContext(req, context);
            return next();
        } catch (error) {
            return next(error);
        }
    };
}

module.exports = requirePlan;
module.exports.requireFeature = requireFeature;
module.exports.attachPlan = attachPlan;
module.exports.normalizePlan = normalizePlan;
module.exports.getTierByPlan = getTierByPlan;
module.exports.getPlanFeatures = getPlanFeatures;
module.exports.getPlanLimits = getPlanLimits;
module.exports.isUnlimited = isUnlimited;