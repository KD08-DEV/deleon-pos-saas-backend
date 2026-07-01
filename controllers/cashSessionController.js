// cashSessionController.js
const createHttpError = require("http-errors");
const mongoose = require("mongoose");
const CashSession = require("../models/cashSessionModel");
const Order = require("../models/orderModel");
const {
    summarizeReceivablePaymentsForCash,
    summarizeCreditSalesForCash,
} = require("./accountReceivableController");

const getRangeForDay = (dateYMD) => {
    const tzOffset = process.env.REPORT_TZ_OFFSET || "-04:00"; // República Dominicana
    const start = new Date(`${dateYMD}T00:00:00.000${tzOffset}`);
    const end = new Date(`${dateYMD}T23:59:59.999${tzOffset}`);
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
function buildLegacyCashOrdersFilter({ tenantId, clientId, registerId, start, end, userId, role }) {
    const baseFilter = {
        tenantId,
        clientId,
        registerId,
        orderStatus: { $ne: "Cancelado" },
        $or: [
            {
                paymentStatus: "Pagado",
                orderStatus: "Completado",
                paidAt: { $gte: start, $lte: end },
            },
            {
                $or: [
                    { paymentStatus: { $exists: false } },
                    { paymentStatus: null },
                    { paymentStatus: "" },
                    { paymentStatus: "Pendiente" },
                ],
                orderStatus: "Completado",
                createdAt: { $gte: start, $lte: end },
            },
            {
                $or: [
                    { paymentStatus: { $exists: false } },
                    { paymentStatus: null },
                    { paymentStatus: "" },
                    { paymentStatus: "Pendiente" },
                ],
                "fiscal.requested": true,
                createdAt: { $gte: start, $lte: end },
            },
        ],
    };

    const cashierFilter = buildCashierOrdersFilter({ role, userId });

    if (!Object.keys(cashierFilter).length) {
        return baseFilter;
    }

    return {
        ...baseFilter,
        $and: [cashierFilter],
    };
}

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



        const { tenantId, clientId, userId, role } = getScope(req);
        const dateYMD = getDateFromReq(req);
        const registerId = getRegisterIdFromWriteReq(req);

        const fid = String(
            req.body?.fid ||
            req.body?.sessionId ||
            req.query?.fid ||
            req.query?.sessionId ||
            ""
        ).trim();

        let session = null;

        if (fid) {
            if (!mongoose.Types.ObjectId.isValid(fid)) {
                return next(createHttpError(400, "INVALID_CASH_SESSION_ID"));
            }

            const exactFilter = {
                _id: fid,
                tenantId,
                clientId,
                dateYMD,
                registerId,
            };

            // Admin puede cerrar una sesión específica de cualquier cajera.
            // Cajera solo puede cerrar su propia sesión.
            if (!isAdminLikeRole(role)) {
                exactFilter.openedBy = userId;
            }

            session = await CashSession.findOne(exactFilter);
        } else {
            const registerFilter = buildLegacyRegisterReadFilter(registerId);
            const cashierFilter = buildCashierSessionFilter({ role, userId });

            session = await CashSession.findOne({
                tenantId,
                clientId,
                dateYMD,
                ...registerFilter,
                ...cashierFilter,
            }).sort({ updatedAt: -1, createdAt: -1 });
        }

        if (!session) return next(createHttpError(404, "SESSION_NOT_FOUND"));

        if (String(session.status || "").toUpperCase() === "CLOSED" || session.closedAt) {
            return next(createHttpError(409, "CASH_SESSION_ALREADY_CLOSED"));
        }
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
        const transferCountedTotal = coerceMoney(req.body?.transferCountedTotal) || 0;
        const otherCountedTotal = coerceMoney(req.body?.otherCountedTotal) || 0;

        // 2) Aceptar countedTotal aunque venga con comas: "2,000"
        let countedTotalRaw = req.body?.countedTotal;
        if (typeof countedTotalRaw === "string") countedTotalRaw = countedTotalRaw.replace(/,/g, "");
        let countedTotal = Number(countedTotalRaw);
        const ticketTotal = Number(
            breakdown
                .filter((d) => String(d?.kind || "").toLowerCase() === "ticket")
                .reduce((sum, d) => sum + Number(d.value || 0) * Number(d.count || 0), 0)
                .toFixed(2)
        );

        const totalDeclaredAtClose = Number(
            (
                countedTotal +
                transferCountedTotal +
                otherCountedTotal
            ).toFixed(2)
        );

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
        const targetCashierId = session.openedBy ? String(session.openedBy) : String(userId || "");

        const cashOwnerUserId = isAdminLikeRole(role)
            ? targetCashierId
            : userId;

        const cashOwnerRole = isAdminLikeRole(role)
            ? "Cajera"
            : role;
        const orders = await Order.find(
            buildLegacyCashOrdersFilter({
                tenantId,
                clientId,
                registerId,
                start,
                end,
                userId: cashOwnerUserId,
                role: cashOwnerRole,
            })
        ).select("paymentMethod paymentMethodType paymentMethodReal deliveryPaymentMethod payment.method paidWith bills.totalWithTax registerId paidAt createdAt paymentStatus orderStatus fiscal");

        const expectedCashSales = Number(
            orders
                .filter((o) => getEffectivePaymentMethod(o) === "Efectivo")
                .reduce((s, o) => s + (Number(o.bills?.totalWithTax) || 0), 0)
                .toFixed(2)
        );
        const receivablePaymentsSummary = await summarizeReceivablePaymentsForCash({
            tenantId,
            clientId,
            registerId,
            start,
            end,
            userId: cashOwnerUserId,
            role: cashOwnerRole,
        });

        const creditSalesSummary = await summarizeCreditSalesForCash({
            tenantId,
            clientId,
            registerId,
            start,
            end,
            userId: cashOwnerUserId,
            role: cashOwnerRole,
        });

        const receivablePaymentsCash = Number(receivablePaymentsSummary?.byMethod?.Efectivo || 0);
        const receivablePaymentsCard = Number(receivablePaymentsSummary?.byMethod?.Tarjeta || 0);
        const receivablePaymentsTransfer = Number(receivablePaymentsSummary?.byMethod?.Transferencia || 0);
        const receivablePaymentsOther = Number(receivablePaymentsSummary?.byMethod?.Otros || 0);
        const receivablePaymentsTotal = Number(receivablePaymentsSummary?.total || 0);
        const creditSales = Number(creditSalesSummary?.total || 0);
        if (!Number.isFinite(openingInitial)) return next(createHttpError(400, "OPENING_NOT_SET"));

        // efectivo esperado en caja = fondo inicial + agregado + ventas en efectivo
        const expectedInRegister = Number(
            (openingInitial + addedTotal + expectedCashSales + receivablePaymentsCash).toFixed(2)
        );

        const difference = Number((countedTotal - expectedInRegister).toFixed(2));

        session.closing = {
            ...session.closing,
            expectedCashSales,
            creditSales,

            ticketTotal,
            transferCountedTotal,
            otherCountedTotal,
            totalDeclaredAtClose,
            receivablePaymentsCash,
            receivablePaymentsCard,
            receivablePaymentsTransfer,
            receivablePaymentsOther,
            receivablePaymentsTotal,

            breakdown,
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
            note: isAdminLikeRole(role)
                ? `${note || "Cierre realizado por admin"} | Sesión de cajera: ${targetCashierId}`
                : note,
        });

        await session.save();

        return res.status(200).json({ success: true, data: session });
    } catch (err) {
        if (process.env.NODE_ENV !== "production") console.log("[POST close] ERROR", err);

        // No conviertas errores 400/403/409 en 500.
        if (err?.status || err?.statusCode) {
            return next(err);
        }

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

    const userId =
        req.user?._id ||
        req.user?.id ||
        req.user?.userId ||
        req.user?.sub ||
        req.user?.user?._id ||
        req.user?.user?.id ||
        null;
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

const getRegisterIdFromReadReq = (req) => {
    return String(req.query?.registerId || req.body?.registerId || "")
        .trim()
        .toUpperCase();
};

const getRegisterIdFromWriteReq = (req) => {
    const reg = String(req.body?.registerId || req.query?.registerId || "")
        .trim()
        .toUpperCase();

    if (!reg || reg === ALL_REGISTERS_ID) {
        throw createHttpError(400, "MISSING_REGISTER_ID_FOR_CASH_SESSION");
    }

    return reg;
};

const ALL_REGISTERS_ID = "__ALL_REGISTERS__";

function buildLegacyRegisterReadFilter(registerId) {
    const reg = String(registerId || "").trim().toUpperCase();

    if (!reg || reg === ALL_REGISTERS_ID) {
        return {};
    }

    // Solo MAIN usa compatibilidad con registros viejos.
    // Esto evita que CAJA2 o cualquier otra caja lea sesiones de MAIN/default.
    if (reg === "MAIN" || reg === "DEFAULT") {
        return {
            $or: [
                { registerId: "MAIN" },
                { registerId: "default" },
                { registerId: { $exists: false } },
                { registerId: null },
                { registerId: "" },
            ],
        };
    }

    // Cajas reales deben ser estrictas.
    return { registerId: reg };
}
const isAdminLikeRole = (role) =>
    ["Owner", "Admin", "SuperAdmin"].includes(String(role || "").trim());

function buildCashierSessionFilter({ role, userId, cashierId = null }) {
    if (isAdminLikeRole(role)) {
        if (cashierId) return { openedBy: cashierId };
        return {};
    }

    if (userId) return { openedBy: userId };

    // Seguridad: si una cajera no trae userId válido,
    // NO debe leer ni crear una sesión compartida con openedBy:null.
    return { _id: { $exists: false } };
}

function buildCashierOrdersFilter({ role, userId }) {
    if (isAdminLikeRole(role)) return {};

    if (!userId) {
        return { _id: { $exists: false } };
    }

    return {
        $or: [
            { paidBy: userId },
            { paidBy: { $exists: false }, user: userId },
            { paidBy: null, user: userId },
        ],
    };
}

// GET /cash-session?dateYMD=YYYY-MM-DD&registerId=default
const getCashSessionByDate = async (req, res, next) => {
    try {
        const { tenantId, clientId, userId, role } = getScope(req);

        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!clientId) return next(createHttpError(400, "MISSING_CLIENT_ID"));

        const dateYMD = getDateFromReq(req);
        const registerId = getRegisterIdFromReadReq(req);

        dbg("[GET cash-session] scope", { tenantId, clientId, userId, role });
        dbg("[GET cash-session] query", { dateYMD, registerId });

        const registerFilter = buildLegacyRegisterReadFilter(registerId);
        const cashierFilter = buildCashierSessionFilter({ role, userId });

        const session = await CashSession.findOne({
            tenantId,
            clientId,
            dateYMD,
            ...registerFilter,
            ...cashierFilter,
        })
            .sort({ updatedAt: -1, createdAt: -1 })
            .populate("openedBy", "name role")
            .populate("closedBy", "name role")
            .populate("closing.adjustedBy", "name role")
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
        const registerId = getRegisterIdFromReadReq(req);

        dbg("[GET cash-session/current] scope", { tenantId, clientId, userId, role });
        dbg("[GET cash-session/current] query", { dateYMD, registerId });

        const registerFilter = buildLegacyRegisterReadFilter(registerId);
        const cashierFilter = buildCashierSessionFilter({ role, userId });

        const session = await CashSession.findOne({
            tenantId,
            clientId,
            dateYMD,
            ...registerFilter,
            ...cashierFilter,
        })
            .sort({ updatedAt: -1, createdAt: -1 })
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
        const { tenantId, clientId, userId, role } = getScope(req);

        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!clientId) return next(createHttpError(400, "MISSING_CLIENT_ID"));

        const from = String(req.query?.from || req.query?.dateFrom || "").trim();
        const to = String(req.query?.to || req.query?.dateTo || "").trim();
        const registerId = getRegisterIdFromReadReq(req);

        if (!from || !to) return next(createHttpError(400, "MISSING_DATE_RANGE"));
        if (from > to) return next(createHttpError(400, "INVALID_DATE_RANGE"));

        const registerFilter = buildLegacyRegisterReadFilter(registerId);
        const cashierFilter = buildCashierSessionFilter({ role, userId });

        const sessions = await CashSession.find({
            tenantId,
            clientId,
            dateYMD: { $gte: from, $lte: to },
            ...registerFilter,
            ...cashierFilter,
        })
            .sort({ dateYMD: -1, updatedAt: -1, createdAt: -1 })
            .select(
                "dateYMD registerId status openingFloatInitial addedFloatTotal closing closedAt closedBy openedAt openedBy notes movements"
            )
            .populate("openedBy", "name role")
            .populate("closedBy", "name role")
            .populate("closing.adjustedBy", "name role")
            .populate("movements.by", "name role");

        const normalizedSessions = sessions.map((s) => {
            const raw = typeof s.toObject === "function" ? s.toObject() : s;
            const countedTotalResolved = getResolvedCountedTotal(raw);

            return {
                ...raw,
                closing: {
                    ...(raw.closing || {}),
                    countedTotalResolved,
                },
            };
        });

        const totals = normalizedSessions.reduce(
            (acc, s) => {
                acc.openingTotal += Number(s.openingFloatInitial || 0);
                acc.addedTotal += Number(s.addedFloatTotal || 0);
                acc.countedTotal += Number(s?.closing?.countedTotalResolved || 0);
                acc.expectedInRegisterTotal += Number(s?.closing?.expectedInRegister || 0);
                acc.differenceTotal += Number(s?.closing?.difference || 0);
                return acc;
            },
            {
                openingTotal: 0,
                addedTotal: 0,
                countedTotal: 0,
                expectedInRegisterTotal: 0,
                differenceTotal: 0,
            }
        );

        return res.status(200).json({
            success: true,
            data: {
                from,
                to,
                registerId: registerId || ALL_REGISTERS_ID,
                openingTotal: totals.openingTotal,
                addedTotal: totals.addedTotal,
                menudoTotal: totals.openingTotal + totals.addedTotal,
                countedTotal: totals.countedTotal,
                expectedInRegisterTotal: totals.expectedInRegisterTotal,
                differenceTotal: totals.differenceTotal,
                sessions: normalizedSessions,
            },
        });
    } catch (err) {
        return next(createHttpError(500, "GET_CASH_SESSION_RANGE_FAILED"));
    }
};

// GET /cash-session/pending-close?dateYMD=YYYY-MM-DD&registerId=MAIN
const getPendingCashSession = async (req, res, next) => {
    try {
        const { tenantId, clientId, userId, role } = getScope(req);

        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!clientId) return next(createHttpError(400, "MISSING_CLIENT_ID"));

        const dateYMD = getDateFromReq(req);
        const registerId = getRegisterIdFromReadReq(req) || "MAIN";
        const registerFilter = buildLegacyRegisterReadFilter(registerId);
        const cashierFilter = buildCashierSessionFilter({ role, userId });

        const pending = await CashSession.findOne({
            tenantId,
            clientId,
            dateYMD: { $lt: dateYMD },
            status: "OPEN",
            ...registerFilter,
            ...cashierFilter,
        })
            .sort({ dateYMD: -1, updatedAt: -1, createdAt: -1 })
            .populate("openedBy", "name role")
            .populate("movements.by", "name role");

        return res.status(200).json({
            success: true,
            data: pending || null,
        });
    } catch (err) {
        return next(createHttpError(500, "GET_PENDING_CASH_SESSION_FAILED"));
    }
};
// POST /cash-session/open
// POST /cash-session/open
const openCashSession = async (req, res, next) => {
    try {
        const { tenantId, clientId, userId, role } = getScope(req);

        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!clientId) return next(createHttpError(400, "MISSING_CLIENT_ID"));

        const dateYMD = getDateFromReq(req);
        const registerId = getRegisterIdFromWriteReq(req);

        const openingFloat = Number(req.body?.openingFloat ?? 0);
        if (!Number.isFinite(openingFloat) || openingFloat < 0) {
            return next(createHttpError(400, "INVALID_OPENING_FLOAT"));
        }

        // 1) No permitir abrir hoy si existe una caja anterior abierta.
        const cashierFilter = buildCashierSessionFilter({ role, userId });

        const previousOpen = await CashSession.findOne({
            tenantId,
            clientId,
            dateYMD: { $lt: dateYMD },
            registerId,
            status: "OPEN",
            ...cashierFilter,
        }).sort({ dateYMD: -1, updatedAt: -1, createdAt: -1 });

        if (previousOpen) {
            return res.status(409).json({
                success: false,
                message: "PENDING_CASH_SESSION_CLOSE",
                data: previousOpen,
            });
        }

        // 2) Buscar sesión del mismo día/caja.
        const existing = await CashSession.findOne({
            tenantId,
            clientId,
            dateYMD,
            registerId,
            ...cashierFilter,
        }).sort({ updatedAt: -1, createdAt: -1 });

        const hasOpenMovement = (s) =>
            Array.isArray(s?.movements) &&
            s.movements.some((m) => String(m?.type || "").toUpperCase() === "OPEN");

        if (existing) {
            // Si ya cerró ese día, no se puede abrir otra vez.
            if (
                String(existing.status || "").toUpperCase() === "CLOSED" ||
                existing.closedAt
            ) {
                return res.status(409).json({
                    success: false,
                    message: "CASH_SESSION_ALREADY_CLOSED",
                    data: existing,
                });
            }

            // Si ya está abierta, no falles con 409.
            // Devuelve success para que el frontend no piense que no tomó la apertura.
            const shouldRepairOpening =
                !hasOpenMovement(existing) ||
                Number(existing.openingFloatInitial || 0) <= 0;

            if (shouldRepairOpening) {
                existing.openingFloatInitial = openingFloat;
                existing.openedBy = existing.openedBy || userId;
                existing.openedAt = existing.openedAt || new Date();
                existing.status = "OPEN";

                if (!hasOpenMovement(existing)) {
                    existing.movements.push({
                        type: "OPEN",
                        amount: openingFloat,
                        by: userId,
                        note: "Apertura reparada/registrada",
                    });
                }

                await existing.save();
            }

            return res.status(200).json({
                success: true,
                alreadyOpen: true,
                data: existing,
            });
        }

        // 3) Crear nueva sesión.
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
            movements: [
                {
                    type: "OPEN",
                    amount: openingFloat,
                    by: userId,
                    note: role === "Cajera" ? "Apertura por cajera" : "Apertura de caja",
                },
            ],
        });

        return res.status(201).json({
            success: true,
            data: created,
        });
    } catch (err) {
        dbg("[POST open] ERROR", err);

        if (err?.status || err?.statusCode) {
            return next(err);
        }

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

        const registerId = getRegisterIdFromWriteReq(req);
        const amount = Number(req.body?.amount ?? 0);
        if (!Number.isFinite(amount) || amount <= 0) {
            return next(createHttpError(400, "INVALID_ADD_AMOUNT"));
        }

        dbg("[POST add] scope", { tenantId, clientId, userId, role });
        dbg("[POST add] payload", { dateYMD, registerId, amount });

        const cashierFilter = buildCashierSessionFilter({ role, userId });

        let session = await CashSession.findOne({
            tenantId,
            clientId,
            dateYMD,
            registerId,
            ...cashierFilter,
        });
        // Diagnóstico extra: si no aparece con este clientId, revisa si existe con otro clientId
        if (!session) {
            const anyClient = await CashSession.findOne({ tenantId, dateYMD, registerId });
            dbg("[POST add] session not found with clientId. anyClientExists?", {
                anyClientExists: !!anyClient,
                anyClientId: anyClient?.clientId || null,
            });

            return next(createHttpError(404, "SESSION_NOT_FOUND"));
        }

        const isAdmin = role === "Admin" || role === "Owner";

        if (session.status === "CLOSED" && !isAdmin) {
            return next(createHttpError(409, "SESSION_CLOSED"));
        }

        session.addedFloatTotal = safeNumber(session.addedFloatTotal) + amount;

        session.movements.push({
            type: session.status === "CLOSED" ? "ADD_AFTER_CLOSE" : "ADD",
            amount,
            by: userId,
            note: session.status === "CLOSED"
                ? "Dinero agregado por admin después del cierre"
                : "",
        });

// si estaba cerrada y el admin agrega dinero, recalcula el cierre esperado
        if (session.status === "CLOSED" && session.closing) {
            const openingInitial = Number(session.openingFloatInitial || 0);
            const addedTotal = Number(session.addedFloatTotal || 0);
            const expectedCashSales = Number(session.closing.expectedCashSales || 0);
            const countedTotal = Number(session.closing.countedTotal || 0);

            const { start, end } = getRangeForDay(dateYMD);
            const receivablePaymentsSummary = await summarizeReceivablePaymentsForCash({
                tenantId,
                clientId,
                registerId,
                start,
                end,
                userId,
                role,
            });

            const receivablePaymentsCash = Number(receivablePaymentsSummary?.byMethod?.Efectivo || 0);
            const receivablePaymentsCard = Number(receivablePaymentsSummary?.byMethod?.Tarjeta || 0);
            const receivablePaymentsTransfer = Number(receivablePaymentsSummary?.byMethod?.Transferencia || 0);
            const receivablePaymentsOther = Number(receivablePaymentsSummary?.byMethod?.Otros || 0);
            const receivablePaymentsTotal = Number(receivablePaymentsSummary?.total || 0);

            const expectedInRegister = Number(
                (openingInitial + addedTotal + expectedCashSales + receivablePaymentsCash).toFixed(2)
            );

            const difference = Number((countedTotal - expectedInRegister).toFixed(2));
            session.closing.expectedInRegister = expectedInRegister;
            session.closing.difference = difference;
        }

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
        const isAdmin = isAdminLikeRole(role);

        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!clientId) return next(createHttpError(400, "MISSING_CLIENT_ID"));

        if (!isAdmin && !userId) {
            return next(createHttpError(401, "MISSING_USER_ID_FOR_CASH_SESSION"));
        }

// Si no es admin, debe autorizar con código manager.
        let codeHint = "";
        if (!isAdmin) {
            const result = await assertManagerCode(req, tenantId);
            codeHint = result.codeHint;
        }

        const dateYMD = getDateFromReq(req);
        const registerId = getRegisterIdFromWriteReq(req);

        let openingFloatRaw = req.body?.openingFloat ?? 0;
        if (typeof openingFloatRaw === "string") {
            openingFloatRaw = openingFloatRaw.replace(/,/g, "");
        }

        const openingFloat = Number(openingFloatRaw);

        if (!Number.isFinite(openingFloat) || openingFloat < 0) {
            return next(createHttpError(400, "INVALID_OPENING_FLOAT"));
        }

        dbg("[PATCH adjust] scope", { tenantId, clientId, userId, role });
        dbg("[PATCH adjust] payload", { dateYMD, registerId, openingFloat });

        // Usamos filtro compatible para MAIN/default/sesiones viejas
        const registerFilter = buildLegacyRegisterReadFilter(registerId);

        const cashierFilter = buildCashierSessionFilter({ role, userId });

        const session = await CashSession.findOne({
            tenantId,
            clientId,
            dateYMD,
            ...registerFilter,
            ...cashierFilter,
        }).sort({ updatedAt: -1, createdAt: -1 });

        if (!session) return next(createHttpError(404, "SESSION_NOT_FOUND"));
        if (!isAdmin && String(session.status || "").toUpperCase() === "CLOSED") {
            return next(createHttpError(409, "SESSION_CLOSED"));
        }

        const previousOpeningFloat = Number(session.openingFloatInitial || 0);
        const note = String(req.body?.note || "");

        // 1) Actualiza el valor principal
        session.openingFloatInitial = Number(openingFloat.toFixed(2));

        // 2) Actualiza también el movimiento original OPEN
        const openMovementIndex = Array.isArray(session.movements)
            ? session.movements.findIndex(
                (m) => String(m?.type || "").trim().toUpperCase() === "OPEN"
            )
            : -1;

        if (openMovementIndex >= 0) {
            session.movements[openMovementIndex].amount = Number(openingFloat.toFixed(2));
            session.movements[openMovementIndex].note =
                session.movements[openMovementIndex].note || "Apertura de caja";
        } else {
            // Si por alguna razón la sesión no tenía movimiento OPEN, lo reparamos
            session.movements.push({
                type: "OPEN",
                amount: Number(openingFloat.toFixed(2)),
                by: session.openedBy || userId,
                note: "Apertura reparada al editar fondo inicial",
            });
        }

        // 3) Mantén auditoría del ajuste
        session.movements.push({
            type: "ADJUST",
            amount: Number(openingFloat.toFixed(2)),
            by: userId,
            note:
                note ||
                (
                    isAdmin
                        ? `Fondo inicial ajustado de ${previousOpeningFloat} a ${openingFloat}`
                        : `Fondo inicial ajustado con autorización manager ${codeHint}`
                ),
        });

        // 4) Si la caja ya estaba cerrada, recalcula el cierre esperado
        if (String(session.status || "").toUpperCase() === "CLOSED" && session.closing) {
            const addedTotal = Number(session.addedFloatTotal || 0);
            const expectedCashSales = Number(session.closing.expectedCashSales || 0);
            const countedTotal = Number(session.closing.countedTotal || 0);
            const receivablePaymentsCash = Number(session.closing.receivablePaymentsCash || 0);

            const expectedInRegister = Number(
                (
                    openingFloat +
                    addedTotal +
                    expectedCashSales +
                    receivablePaymentsCash
                ).toFixed(2)
            );

            const difference = Number(
                (countedTotal - expectedInRegister).toFixed(2)
            );

            session.closing.expectedInRegister = expectedInRegister;
            session.closing.difference = difference;
            session.closing.adjustedAt = new Date();
            session.closing.adjustedBy = userId;
        }

        await session.save();

        return res.status(200).json({ success: true, data: session });
    } catch (err) {
        dbg("[PATCH adjust] ERROR", err);

        if (err?.status || err?.statusCode) {
            return next(err);
        }

        return next(createHttpError(500, "ADJUST_CASH_SESSION_FAILED"));
    }
};

function safeNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}
const getResolvedCountedTotal = (session) => {
    const direct = Number(session?.closing?.countedTotal);

    const movements = Array.isArray(session?.movements) ? session.movements : [];

    const latestCloseMovement = [...movements]
        .filter((m) =>
            ["CLOSE", "CLOSE_ADJUST"].includes(
                String(m?.type || "").trim().toUpperCase()
            )
        )
        .sort((a, b) => {
            const da = new Date(a?.at || 0).getTime();
            const db = new Date(b?.at || 0).getTime();
            return db - da;
        })[0];

    const movementAmount = Number(latestCloseMovement?.amount);

    // Si el contado guardado explícitamente es mayor que 0, úsalo.
    if (Number.isFinite(direct) && direct > 0) {
        return direct;
    }

    // Si el campo viejo quedó en 0 por default, usa el movimiento de cierre.
    if (Number.isFinite(movementAmount)) {
        return movementAmount;
    }

    // Último fallback
    return Number.isFinite(direct) ? direct : 0;
};
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
        const registerId = getRegisterIdFromWriteReq(req);
        
        const session = await CashSession.findOne({ tenantId, clientId, dateYMD, registerId });
        if (!session) return next(createHttpError(404, "SESSION_NOT_FOUND"));
        if (session.status !== "CLOSED") return next(createHttpError(409, "SESSION_NOT_CLOSED"));

        const normalizeBreakdown = (items = []) => {
            return items
                .map((d) => {
                    const value = Number(d?.value);
                    const count = Number(d?.count);

                    return {
                        label: String(d?.label || `RD$ ${value}`).trim(),
                        value,
                        count,
                    };
                })
                .filter((d) => Number.isFinite(d.value) && d.value > 0 && Number.isFinite(d.count) && d.count > 0);
        };

        let breakdown = normalizeBreakdown(Array.isArray(req.body?.breakdown) ? req.body.breakdown : []);
        const note = String(req.body?.note || "").trim();

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
            registerId,
            paidAt: { $gte: start, $lte: end },
            paymentStatus: "Pagado",
            orderStatus: "Completado",
        }).select("paymentMethod paymentMethodType paymentMethodReal deliveryPaymentMethod payment.method paidWith bills.totalWithTax registerId paidAt");

        const expectedCashSales = Number(
            orders
                .filter((o) => getEffectivePaymentMethod(o) === "Efectivo")
                .reduce((s, o) => s + (Number(o.bills?.totalWithTax) || 0), 0)
                .toFixed(2)
        );
        const openingInitial = Number(session?.openingFloatInitial || 0);
        const addedTotal = Number(session?.addedFloatTotal || 0);

        const receivablePaymentsSummary = await summarizeReceivablePaymentsForCash({
            tenantId,
            clientId,
            registerId,
            start,
            end,
            userId,
            role,
        });

        const receivablePaymentsCash = Number(receivablePaymentsSummary?.byMethod?.Efectivo || 0);
        const receivablePaymentsCard = Number(receivablePaymentsSummary?.byMethod?.Tarjeta || 0);
        const receivablePaymentsTransfer = Number(receivablePaymentsSummary?.byMethod?.Transferencia || 0);
        const receivablePaymentsOther = Number(receivablePaymentsSummary?.byMethod?.Otros || 0);
        const receivablePaymentsTotal = Number(receivablePaymentsSummary?.total || 0);

        const expectedInRegister = Number(
            (openingInitial + addedTotal + expectedCashSales + receivablePaymentsCash).toFixed(2)
        );

        const difference = Number((countedTotal - expectedInRegister).toFixed(2));


        // Guardar auditoría
        const previous = session.closing?.countedTotal ?? null;

        session.closing = {
            ...session.closing,

            breakdown,
            countedTotal,
            expectedCashSales,

            receivablePaymentsCash,
            receivablePaymentsCard,
            receivablePaymentsTransfer,
            receivablePaymentsOther,
            receivablePaymentsTotal,

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
    getPendingCashSession,
    openCashSession,
    addCashToSession,
    adjustOpeningFloat,
    closeCashSession,
    getCashSessionsRange,
    adjustCashSessionClosing,
};
