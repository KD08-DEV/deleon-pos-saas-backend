// pos-backend/middlewares/requirePlan.js
const Tenant = require("../models/tenantModel");

module.exports = function requirePlan(checkFn) {
    return async (req, res, next) => {
        try {
            const tenantId = req.scope?.tenantId || req.user?.tenantId;
            if (!tenantId) return res.status(400).json({ message: "Missing tenantId" });

            const tenant = await Tenant.findOne({ tenantId });
            if (!tenant) return res.status(404).json({ message: "Tenant not found" });

            const r = await checkFn(tenant, req); // { ok:boolean, reason?:string }
            if (r?.ok === false) {
                return res.status(402).json({
                    message: r.reason || "Upgrade required",
                    plan: tenant.billing?.plan, status: tenant.billing?.status
                });
            }
            req.tenantPlan = tenant; // opcional, por si el controlador lo necesita
            next();
        } catch (e) {
            next(e);
        }
    };
};
