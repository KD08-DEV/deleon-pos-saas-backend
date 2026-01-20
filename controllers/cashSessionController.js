const createHttpError = require("http-errors");
const CashSession = require("../models/cashSessionModel");

const getCurrentCashSession = async (req, res, next) => {
    try {
        const tenantId = req.scope?.tenantId || req.user?.tenantId;
        const clientId = req.scope?.clientId;

        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!clientId) return next(createHttpError(400, "MISSING_CLIENT_ID"));

        const session = await CashSession.findOne({ tenantId, clientId, status: "OPEN" })
            .populate("openedBy", "name role");

        return res.status(200).json({ success: true, data: session });
    } catch (err) {
        return next(createHttpError(500, "GET_CASH_SESSION_FAILED"));
    }
};

const openCashSession = async (req, res, next) => {
    try {
        const tenantId = req.scope?.tenantId || req.user?.tenantId;
        const clientId = req.scope?.clientId;

        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!clientId) return next(createHttpError(400, "MISSING_CLIENT_ID"));

        const openingFloat = Number(req.body.openingFloat ?? 0);
        if (Number.isNaN(openingFloat) || openingFloat < 0) {
            return next(createHttpError(400, "INVALID_OPENING_FLOAT"));
        }

        // si ya hay una abierta, la actualizamos (idempotente)
        const existing = await CashSession.findOne({ tenantId, clientId, status: "OPEN" });
        if (existing) {
            existing.openingFloat = openingFloat;
            existing.openedBy = req.user?._id ?? null;
            await existing.save();
            return res.status(200).json({ success: true, data: existing });
        }

        const created = await CashSession.create({
            tenantId,
            clientId,
            status: "OPEN",
            openingFloat,
            openedBy: req.user?._id ?? null,
            openedAt: new Date(),
        });

        return res.status(201).json({ success: true, data: created });
    } catch (err) {
        // si choca el índice único por carrera, reintenta leyendo
        if (err?.code === 11000) {
            const tenantId = req.scope?.tenantId || req.user?.tenantId;
            const clientId = req.scope?.clientId;

            if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
            if (!clientId) return next(createHttpError(400, "MISSING_CLIENT_ID"));

            if (!clientId) {
                return next(createHttpError(400, "MISSING_CLIENT_ID"));
            }

            const session = await CashSession.findOne({ tenantId, clientId, status: "OPEN" });
            return res.status(200).json({ success: true, data: session });
        }
        return next(createHttpError(500, "OPEN_CASH_SESSION_FAILED"));
    }
};

module.exports = {
    // ...lo que ya exportas
    getCurrentCashSession,
    openCashSession,
};
