// cashSessionController.js
const createHttpError = require("http-errors");
const CashSession = require("../models/cashSessionModel");
const Order = require("../models/orderModel"); // agrega arriba

const getRangeForDay = (dateYMD) => {
    // OJO: puedes enviar from/to desde el front si quieres exactitud local
    const start = new Date(`${dateYMD}T00:00:00.000`);
    const end   = new Date(`${dateYMD}T23:59:59.999`);
    return { start, end };
};

const normalize = (v) => String(v || "").trim().toLowerCase();

const coerceMoney = (v) => {
    if (typeof v === "string") v = v.replace(/,/g, "");
    const n = Number(v);
    return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
};

// Intenta deducir el método real para el cierre (cash/card/transfer),
// incluso si "paymentMethod" a veces guarda "Delivery", "Pedido Ya", etc.
const getEffectivePaymentMethod = (o) => {
    const pm = normalize(o?.paymentMethod);

    if (pm === "efectivo" || pm === "cash") return "Efectivo";
    if (pm === "tarjeta" || pm === "card") return "Tarjeta";
    if (pm === "transferencia" || pm === "transfer") return "Transferencia";

    // fallback: si paymentMethod es canal (delivery/plataforma), busca un campo alterno
    const alt = normalize(
        o?.paymentMethodType ||
        o?.paymentMethodReal ||
        o?.deliveryPaymentMethod ||
        o?.payment?.method ||
        o?.paidWith
    );

    if (alt === "efectivo" || alt === "cash") return "Efectivo";
    if (alt === "tarjeta" || alt === "card") return "Tarjeta";
    if (alt === "transferencia" || alt === "transfer") return "Transferencia";

    return null;
};

const bcrypt = require("bcryptjs");
const TenantSettings = require("../models/tenantSettingsModel");

const assertManagerCode = async (req, tenantId) => {
    const provided = String(req.body?.managerCode || req.headers["x-manager-code"] || "").trim();
    if (!provided) throw createHttpError(400, "MISSING_MANAGER_CODE");

    const settings = await TenantSettings.findOne({ tenantId }).select("managerCodeHash managerCodeHint");
    if (!settings?.managerCodeHash) throw createHttpError(500, "MANAGER_CODE_NOT_CONFIGURED");

    const ok = await bcrypt.compare(provided, settings.managerCodeHash);
    if (!ok) throw createHttpError(403, "INVALID_MANAGER_CODE");

    return { codeHint: settings.managerCodeHint || `***${provided.slice(-2)}` };
};


// cashSessionController.js

const closeCashSession = async (req, res, next) => {
    try {



        const { tenantId, clientId, userId } = getScope(req);
        const dateYMD = getDateFromReq(req);
        const registerId = getRegisterIdFromReq(req);

        const session = await CashSession.findOne({ tenantId, clientId, dateYMD, registerId });
        if (!session) return next(createHttpError(404, "SESSION_NOT_FOUND"));
        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!clientId) return next(createHttpError(400, "MISSING_CLIENT_ID"));



        // 1) BUSCAR LA SESIÓN ANTES DE USARLA
        // 0) SIEMPRE exigir manager code para cerrar
        const { codeHint } = await assertManagerCode(req, tenantId);

        // 0.1) leer fondo inicial y agregado desde la sesión
        const openingInitial = Number(session.openingFloatInitial || 0);

        const addedTotal = Number(session.addedFloatTotal || 0);



        let breakdown = Array.isArray(req.body?.breakdown) ? req.body.breakdown : [];
        const note = String(req.body?.note || "");

        // 2) Aceptar countedTotal aunque venga con comas: "2,000"
        let countedTotalRaw = req.body?.countedTotal;
        if (typeof countedTotalRaw === "string") countedTotalRaw = countedTotalRaw.replace(/,/g, "");
        let countedTotal = Number(countedTotalRaw);

        // Si no hay breakdown, aceptamos countedTotal directo
        if (!breakdown.length) {
            if (!Number.isFinite(countedTotal) || countedTotal < 0) {
                return next(createHttpError(400, "MISSING_BREAKDOWN_OR_COUNTEDTOTAL"));
            }
            countedTotal = Number(countedTotal.toFixed(2));
        } else {
            // Validar breakdown
            for (const d of breakdown) {
                const value = Number(d?.value);
                const count = Number(d?.count);
                if (!Number.isFinite(value) || value <= 0) return next(createHttpError(400, "INVALID_DENOM_VALUE"));
                if (!Number.isFinite(count) || count < 0) return next(createHttpError(400, "INVALID_DENOM_COUNT"));
            }

            countedTotal = Number(
                breakdown.reduce((sum, d) => sum + (Number(d.value) * Number(d.count)), 0).toFixed(2)
            );
        }

        // Ventas en efectivo del día (excluye canceladas)
        const { start, end } = getRangeForDay(dateYMD);

        const orders = await Order.find({
            tenantId,
            clientId,
            createdAt: { $gte: start, $lte: end },
            orderStatus: { $ne: "Cancelado" },
        }).select("paymentMethod paymentMethodType paymentMethodReal deliveryPaymentMethod payment.method paidWith bills.totalWithTax");

        const expectedCashSales = Number(
            orders
                .filter((o) => getEffectivePaymentMethod(o) === "Efectivo")
                .reduce((s, o) => s + (Number(o.bills?.totalWithTax) || 0), 0)
                .toFixed(2)
        );
        if (!Number.isFinite(openingInitial)) return next(createHttpError(400, "OPENING_NOT_SET"));

        // efectivo esperado en caja = fondo inicial + agregado + ventas en efectivo
        const expectedInRegister = Number((openingInitial + addedTotal + expectedCashSales).toFixed(2));

        const difference = Number((countedTotal - expectedInRegister).toFixed(2));

        session.closing = {
            ...session.closing,
            expectedCashSales,
            expectedInRegister,
            countedTotal,
            difference,
            note,
            managerCodeHint: codeHint,

        };

        // IMPORTANTE: duplicar nota aquí para que “aparezca” si tu UI usa session.notes
        session.notes = note;


        session.status = "CLOSED";
        session.closedAt = new Date();
        session.closedBy = userId;

        session.movements.push({
            type: "CLOSE",
            amount: countedTotal,
            by: userId,
            note,
        });

        await session.save();

        return res.status(200).json({ success: true, data: session });
    } catch (err) {
        // Para que puedas ver el error real en consola del server
        if (process.env.NODE_ENV !== "production") console.log("[POST close] ERROR", err);
        return next(createHttpError(500, "CLOSE_CASH_SESSION_FAILED"));
    }
};

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
    const q = req.query?.dateYMD || req.query?.date || "";
    const b = req.body?.dateYMD || req.body?.date || "";
    const raw = q || b;

    const ymd = toYMD(raw);

    if (!ymd) {
        console.log("❌ [MISSING dateYMD]", {
            path: req.originalUrl,
            method: req.method,
            query: req.query,
            body: req.body,
            now_local: new Date().toString(),
            now_iso: new Date().toISOString(),
        });
        // fuerza error para que lo veas y no cree cosas malas
        throw createHttpError(400, "MISSING_DATEYMD");
    }

    return ymd;
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
        const hasOpenMovement = (s) => Array.isArray(s?.movements) && s.movements.some(m => m.type === "OPEN");

        if (existing && hasOpenMovement(existing)) {
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
const adjustCashSessionClosing = async (req, res, next) => {
    try {
        const { tenantId, clientId, userId, role } = getScope(req);
        const isAdmin = role === "Admin" || role === "Owner";
        if (!isAdmin) return next(createHttpError(403, "FORBIDDEN"));

        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!clientId) return next(createHttpError(400, "MISSING_CLIENT_ID"));

        // exige código del manager
        const { codeHint } = await assertManagerCode(req, tenantId);

        const dateYMD = getDateFromReq(req);
        const registerId = getRegisterIdFromReq(req);

        const session = await CashSession.findOne({ tenantId, clientId, dateYMD, registerId });
        if (!session) return next(createHttpError(404, "SESSION_NOT_FOUND"));
        if (session.status !== "CLOSED") return next(createHttpError(409, "SESSION_NOT_CLOSED"));

        let breakdown = Array.isArray(req.body?.breakdown) ? req.body.breakdown : [];
        const note = String(req.body?.note || session.closing?.note || "");

        // Parse countedTotal como en closeCashSession
        let countedTotal = coerceMoney(req.body?.countedTotal);
        if (breakdown.length) {
            for (const d of breakdown) {
                const value = Number(d?.value);
                const count = Number(d?.count);
                if (!Number.isFinite(value) || value <= 0) return next(createHttpError(400, "INVALID_DENOM_VALUE"));
                if (!Number.isFinite(count) || count < 0) return next(createHttpError(400, "INVALID_DENOM_COUNT"));
            }
            countedTotal = Number(
                breakdown.reduce((sum, d) => sum + (Number(d.value) * Number(d.count)), 0).toFixed(2)
            );
        } else {
            if (!Number.isFinite(countedTotal) || countedTotal < 0) {
                return next(createHttpError(400, "MISSING_BREAKDOWN_OR_COUNTEDTOTAL"));
            }
        }

        // Recalcular expectedCashSales con reglas “delivery efectivo cuenta como efectivo”
        const { start, end } = getRangeForDay(dateYMD);

        const orders = await Order.find({
            tenantId,
            clientId,
            createdAt: { $gte: start, $lte: end },
            orderStatus: { $ne: "Cancelado" },
        }).select("paymentMethod paymentMethodType paymentMethodReal deliveryPaymentMethod payment.method paidWith bills.totalWithTax");

        const expectedCashSales = Number(
            orders
                .filter((o) => getEffectivePaymentMethod(o) === "Efectivo")
                .reduce((s, o) => s + (Number(o.bills?.totalWithTax) || 0), 0)
                .toFixed(2)
        );
        const openingInitial = Number(
            session?.opening?.initial ??
            session?.opening?.initialFloat ??
            session?.openingFloat ??
            session?.openingInitial ??
            0
        );

        const addedTotal = Number(
            session?.opening?.addedTotal ??
            session?.addedTotal ??
            session?.addedCash ??
            0
        );

        const expectedInRegister = Number((openingInitial + addedTotal + expectedCashSales).toFixed(2));
        const difference = Number((countedTotal - expectedInRegister).toFixed(2));


        // Guardar auditoría
        const previous = session.closing?.countedTotal ?? null;

        session.closing = {
            ...session.closing,
            breakdown,
            countedTotal,
            expectedCashSales,
            expectedInRegister,
            difference,
            note,
            adjustedAt: new Date(),
            adjustedBy: userId,
            managerCodeHint: codeHint,
            previousCountedTotal: previous,

        };

        session.notes = note;

        session.movements.push({
            type: "CLOSE_ADJUST",
            amount: countedTotal,
            by: userId,
            note: `${note} (manager ${codeHint})`,
        });

        await session.save();
        return res.status(200).json({ success: true, data: session });
    } catch (err) {
        if (process.env.NODE_ENV !== "production") console.log("[PATCH close-adjust] ERROR", err);
        return next(createHttpError(500, "ADJUST_CLOSE_FAILED"));
    }
};

module.exports = {
    getCashSessionByDate,
    getCurrentCashSession,
    openCashSession,
    addCashToSession,
    adjustOpeningFloat,
    closeCashSession,
    getCashSessionsRange,
    adjustCashSessionClosing,
};
