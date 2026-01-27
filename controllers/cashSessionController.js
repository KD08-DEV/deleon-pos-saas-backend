// cashSessionController.js
const createHttpError = require("http-errors");
const CashSession = require("../models/cashSessionModel");

const toYMD = (v) => String(v || "").split("T")[0];

const dbg = (...args) => {
    if (process.env.NODE_ENV !== "production") {
        console.log(...args);
    }
};

/**
 * Opción A (patch):
 * - NO usar req.scope (porque te está llegando undefined o distinto entre requests)
 * - Usar req.tenantId / req.clientId que setea tenantMiddleware
 * - Fallbacks: headers/body/query/default
 */
const getScope = (req) => {
    const tenantId =
        req.tenantId ||
        req.scope?.tenantId ||
        req.user?.tenantId ||
        req.headers["x-tenant-id"] ||
        req.headers["x-tenant"];

    const clientId =
        req.clientId ||
        req.scope?.clientId ||
        req.headers["x-client-id"] ||
        req.body?.clientId ||
        req.query?.clientId ||
        "default";

    const userId = req.user?._id || null;
    const role = req.user?.role || req.scope?.membership?.role || null;

    return { tenantId, clientId, userId, role };
};

const getDateFromReq = (req) => {
    // Acepta dateYMD tanto por query como por body
    const q = req.query?.dateYMD || req.query?.date || "";
    const b = req.body?.dateYMD || req.body?.date || "";
    const ymd = toYMD(q || b);
    return ymd || new Date().toISOString().split("T")[0];
};

const getRegisterIdFromReq = (req) => {
    return String(req.query?.registerId || req.body?.registerId || "default");
};

// GET /cash-session?dateYMD=YYYY-MM-DD&registerId=default
const getCashSessionByDate = async (req, res, next) => {
    try {
        const { tenantId, clientId, userId, role } = getScope(req);

        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!clientId) return next(createHttpError(400, "MISSING_CLIENT_ID"));

        const dateYMD = getDateFromReq(req);
        const registerId = getRegisterIdFromReq(req);

        dbg("[GET cash-session] scope", { tenantId, clientId, userId, role });
        dbg("[GET cash-session] query", { dateYMD, registerId });

        const session = await CashSession.findOne({ tenantId, clientId, dateYMD, registerId })
            .populate("openedBy", "name role")
            .populate("movements.by", "name role");

        dbg("[GET cash-session] response", { found: !!session });

        return res.status(200).json({ success: true, data: session });
    } catch (err) {
        dbg("[GET cash-session] ERROR", err);
        return next(createHttpError(500, "GET_CASH_SESSION_FAILED"));
    }
};

// GET /cash-session/current?dateYMD=YYYY-MM-DD&registerId=default
const getCurrentCashSession = async (req, res, next) => {
    try {
        const { tenantId, clientId, userId, role } = getScope(req);

        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!clientId) return next(createHttpError(400, "MISSING_CLIENT_ID"));

        const dateYMD = getDateFromReq(req);
        const registerId = getRegisterIdFromReq(req);

        dbg("[GET cash-session/current] scope", { tenantId, clientId, userId, role });
        dbg("[GET cash-session/current] query", { dateYMD, registerId });

        const session = await CashSession.findOne({ tenantId, clientId, dateYMD, registerId })
            .populate("openedBy", "name role")
            .populate("movements.by", "name role");

        dbg("[GET cash-session/current] response", { found: !!session });

        return res.status(200).json({ success: true, data: session });
    } catch (err) {
        dbg("[GET cash-session/current] ERROR", err);
        return next(createHttpError(500, "GET_CASH_SESSION_FAILED"));
    }
};

// GET /cash-session/range?from=YYYY-MM-DD&to=YYYY-MM-DD&registerId=default
const getCashSessionsRange = async (req, res, next) => {
    try {
        const { tenantId, clientId } = getScope(req);

        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!clientId) return next(createHttpError(400, "MISSING_CLIENT_ID"));

        const from = String(req.query?.from || req.query?.dateFrom || "").trim();
        const to = String(req.query?.to || req.query?.dateTo || "").trim();
        const registerId = getRegisterIdFromReq(req);

        if (!from || !to) return next(createHttpError(400, "MISSING_DATE_RANGE"));
        if (from > to) return next(createHttpError(400, "INVALID_DATE_RANGE"));

        const sessions = await CashSession.find({
            tenantId,
            clientId,
            registerId,
            dateYMD: { $gte: from, $lte: to },
        }).select("dateYMD openingFloatInitial addedFloatTotal");

        const totals = sessions.reduce(
            (acc, s) => {
                acc.openingTotal += Number(s.openingFloatInitial || 0);
                acc.addedTotal += Number(s.addedFloatTotal || 0);
                return acc;
            },
            { openingTotal: 0, addedTotal: 0 }
        );

        return res.status(200).json({
            success: true,
            data: {
                from,
                to,
                registerId,
                openingTotal: totals.openingTotal,
                addedTotal: totals.addedTotal,
                menudoTotal: totals.openingTotal + totals.addedTotal,
                sessions,
            },
        });
    } catch (err) {
        return next(createHttpError(500, "GET_CASH_SESSION_RANGE_FAILED"));
    }
};

// POST /cash-session/open
const openCashSession = async (req, res, next) => {
    try {
        const { tenantId, clientId, userId, role } = getScope(req);

        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!clientId) return next(createHttpError(400, "MISSING_CLIENT_ID"));

        const dateYMD = getDateFromReq(req);
        const registerId = getRegisterIdFromReq(req);

        const openingFloat = Number(req.body?.openingFloat ?? 0);
        if (Number.isNaN(openingFloat) || openingFloat < 0) {
            return next(createHttpError(400, "INVALID_OPENING_FLOAT"));
        }

        dbg("[POST open] scope", { tenantId, clientId, userId, role });
        dbg("[POST open] payload", { dateYMD, registerId, openingFloat });

        const existing = await CashSession.findOne({ tenantId, clientId, dateYMD, registerId });

        // Si ya existe y ya se abrió, cajera NO puede editar
        if (existing && safeNumber(existing.openingFloatInitial) > 0) {
            if (role === "Cajera") return next(createHttpError(409, "OPENING_ALREADY_SET"));
            return next(createHttpError(409, "USE_ADJUST_ENDPOINT"));
        }

        if (existing) {
            existing.openingFloatInitial = openingFloat;
            existing.openedBy = userId;
            existing.openedAt = new Date();
            existing.status = "OPEN";
            existing.movements.push({
                type: "OPEN",
                amount: openingFloat,
                by: userId,
            });

            await existing.save();
            return res.status(200).json({ success: true, data: existing });
        }

        const created = await CashSession.create({
            tenantId,
            clientId,
            dateYMD,
            registerId,
            status: "OPEN",
            openingFloatInitial: openingFloat,
            addedFloatTotal: 0,
            openedBy: userId,
            openedAt: new Date(),
            movements: [{ type: "OPEN", amount: openingFloat, by: userId }],
        });

        return res.status(201).json({ success: true, data: created });
    } catch (err) {
        dbg("[POST open] ERROR", err);
        if (err?.code === 11000) {
            return next(createHttpError(409, "SESSION_ALREADY_EXISTS"));
        }
        return next(createHttpError(500, "OPEN_CASH_SESSION_FAILED"));
    }
};

// POST /cash-session/add
const addCashToSession = async (req, res, next) => {
    try {
        const { tenantId, clientId, userId, role } = getScope(req);

        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!clientId) return next(createHttpError(400, "MISSING_CLIENT_ID"));

        const dateYMD = getDateFromReq(req);
        const registerId = getRegisterIdFromReq(req);

        const amount = Number(req.body?.amount ?? 0);
        if (!Number.isFinite(amount) || amount <= 0) {
            return next(createHttpError(400, "INVALID_ADD_AMOUNT"));
        }

        dbg("[POST add] scope", { tenantId, clientId, userId, role });
        dbg("[POST add] payload", { dateYMD, registerId, amount });

        let session = await CashSession.findOne({ tenantId, clientId, dateYMD, registerId });

        // Diagnóstico extra: si no aparece con este clientId, revisa si existe con otro clientId
        if (!session) {
            const anyClient = await CashSession.findOne({ tenantId, dateYMD, registerId });
            dbg("[POST add] session not found with clientId. anyClientExists?", {
                anyClientExists: !!anyClient,
                anyClientId: anyClient?.clientId || null,
            });

            return next(createHttpError(404, "SESSION_NOT_FOUND"));
        }

        if (session.status === "CLOSED") return next(createHttpError(409, "SESSION_CLOSED"));

        session.addedFloatTotal = safeNumber(session.addedFloatTotal) + amount;
        session.movements.push({ type: "ADD", amount, by: userId });

        await session.save();
        return res.status(200).json({ success: true, data: session });
    } catch (err) {
        dbg("[POST add] ERROR", err);
        return next(createHttpError(500, "ADD_CASH_FAILED"));
    }
};

// PATCH /cash-session/adjust (solo admin/owner)
const adjustOpeningFloat = async (req, res, next) => {
    try {
        const { tenantId, clientId, userId, role } = getScope(req);
        const isAdmin = role === "Admin" || role === "Owner";
        if (!isAdmin) return next(createHttpError(403, "FORBIDDEN"));


        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!clientId) return next(createHttpError(400, "MISSING_CLIENT_ID"));

        const dateYMD = getDateFromReq(req);
        const registerId = getRegisterIdFromReq(req);

        const openingFloat = Number(req.body?.openingFloat ?? 0);
        if (Number.isNaN(openingFloat) || openingFloat < 0) {
            return next(createHttpError(400, "INVALID_OPENING_FLOAT"));
        }

        dbg("[PATCH adjust] scope", { tenantId, clientId, userId, role });
        dbg("[PATCH adjust] payload", { dateYMD, registerId, openingFloat });

        const session = await CashSession.findOne({ tenantId, clientId, dateYMD, registerId });
        if (!session) return next(createHttpError(404, "SESSION_NOT_FOUND"));

        session.openingFloatInitial = openingFloat;
        session.movements.push({
            type: "ADJUST",
            amount: openingFloat,
            by: userId,
            note: String(req.body?.note || ""),
        });

        await session.save();
        return res.status(200).json({ success: true, data: session });
    } catch (err) {
        dbg("[PATCH adjust] ERROR", err);
        return next(createHttpError(500, "ADJUST_CASH_SESSION_FAILED"));
    }
};

function safeNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

module.exports = {
    getCashSessionByDate,
    getCurrentCashSession,
    openCashSession,
    addCashToSession,
    adjustOpeningFloat,
    getCashSessionsRange,
};
