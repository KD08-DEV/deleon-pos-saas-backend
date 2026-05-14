const createHttpError = require("http-errors");
const mongoose = require("mongoose");

const AccountReceivable = require("../models/accountReceivableModel");
const Order = require("../models/orderModel");
const Customer = require("../models/customerModel");

const ALL_REGISTERS_ID = "__ALL_REGISTERS__";

function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}

function normalizeMethod(value) {
    const v = String(value || "").trim();

    if (["Efectivo", "Tarjeta", "Transferencia", "Otros"].includes(v)) {
        return v;
    }

    const lower = v.toLowerCase();

    if (lower === "cash" || lower === "efectivo") return "Efectivo";
    if (lower === "card" || lower === "tarjeta") return "Tarjeta";
    if (lower === "transfer" || lower === "transferencia") return "Transferencia";

    return "Otros";
}

function normalizeRegisterId(value) {
    return String(value || "MAIN").trim().toUpperCase() || "MAIN";
}

function isAdminLikeRole(role) {
    return ["Owner", "Admin", "SuperAdmin"].includes(String(role || "").trim());
}

function getScope(req) {
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
}

function parseBoundary(value, endOfDay = false) {
    const raw = String(value || "").trim();
    if (!raw) return null;

    const tzOffset = process.env.REPORT_TZ_OFFSET || "-04:00";
    const ymd = raw.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];

    if (ymd) {
        return new Date(`${ymd}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}${tzOffset}`);
    }

    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return null;

    if (endOfDay) d.setHours(23, 59, 59, 999);
    else d.setHours(0, 0, 0, 0);

    return d;
}

async function createReceivableForOrder({ order, userId = null }) {
    if (!order?._id) {
        throw createHttpError(400, "ORDER_REQUIRED_FOR_RECEIVABLE");
    }

    const orderId = order._id;
    const tenantId = order.tenantId;
    const clientId = order.clientId || "default";

    const customerId = order.customerId;
    if (!customerId) {
        throw createHttpError(400, "CUSTOMER_REQUIRED_FOR_CREDIT_SALE");
    }

    const originalAmount = round2(order?.bills?.totalWithTax || 0);

    if (!Number.isFinite(originalAmount) || originalAmount <= 0) {
        throw createHttpError(400, "INVALID_RECEIVABLE_AMOUNT");
    }

    const existing = await AccountReceivable.findOne({
        tenantId,
        clientId,
        orderId,
        status: { $ne: "void" },
    });

    if (existing) {
        return existing;
    }

    const created = await AccountReceivable.create({
        tenantId,
        clientId,
        customerId,
        orderId,
        registerId: normalizeRegisterId(order.registerId || "MAIN"),
        invoiceNumber: order.invoiceNumber || order.facturaNo || "",
        facturaNo: order.facturaNo || order.invoiceNumber || "",
        customerSnapshot: {
            name: order?.customerDetails?.name || "",
            phone: order?.customerDetails?.phone || "",
            address: order?.customerDetails?.address || "",
            rnc: order?.customerDetails?.rnc || "",
            rncCedula: order?.customerDetails?.rncCedula || "",
        },
        originalAmount,
        paidAmount: 0,
        balance: originalAmount,
        status: "pending",
        createdBy: userId || order.user || null,
    });

    await Order.updateOne(
        { _id: orderId, tenantId, clientId },
        {
            $set: {
                accountReceivableId: created._id,
                creditStatus: "pending",
                paymentStatus: "Pendiente",
                paidAt: null,
                paidBy: null,
            },
        }
    );

    return created;
}

async function listReceivables(req, res, next) {
    try {
        const { tenantId, clientId } = getScope(req);

        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!clientId) return next(createHttpError(400, "MISSING_CLIENT_ID"));

        const status = String(req.query?.status || "open").trim();
        const q = String(req.query?.q || "").trim();
        const from = parseBoundary(req.query?.from, false);
        const to = parseBoundary(req.query?.to, true);

        const filter = { tenantId, clientId };

        if (status === "open") {
            filter.status = { $in: ["pending", "partial"] };
        } else if (["pending", "partial", "paid", "void"].includes(status)) {
            filter.status = status;
        }

        if (from || to) {
            filter.createdAt = {};
            if (from) filter.createdAt.$gte = from;
            if (to) filter.createdAt.$lte = to;
        }

        if (q) {
            const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
            filter.$or = [
                { invoiceNumber: rx },
                { facturaNo: rx },
                { "customerSnapshot.name": rx },
                { "customerSnapshot.phone": rx },
                { "customerSnapshot.rnc": rx },
                { "customerSnapshot.rncCedula": rx },
            ];
        }

        const rows = await AccountReceivable.find(filter)
            .populate("customerId", "name phone address")
            .populate("orderId", "invoiceNumber facturaNo bills orderStatus paymentStatus paymentMethod createdAt")
            .populate("createdBy", "name role")
            .populate("payments.receivedBy", "name role")
            .sort({ status: 1, createdAt: -1 })
            .limit(Math.min(Number(req.query?.limit || 200), 500));

        return res.json({
            success: true,
            data: rows,
        });
    } catch (error) {
        return next(error);
    }
}

async function getReceivableSummary(req, res, next) {
    try {
        const { tenantId, clientId } = getScope(req);

        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!clientId) return next(createHttpError(400, "MISSING_CLIENT_ID"));

        const rows = await AccountReceivable.aggregate([
            {
                $match: {
                    tenantId,
                    clientId,
                    status: { $ne: "void" },
                },
            },
            {
                $group: {
                    _id: "$status",
                    count: { $sum: 1 },
                    originalAmount: { $sum: "$originalAmount" },
                    paidAmount: { $sum: "$paidAmount" },
                    balance: { $sum: "$balance" },
                },
            },
        ]);

        const summary = {
            pending: { count: 0, originalAmount: 0, paidAmount: 0, balance: 0 },
            partial: { count: 0, originalAmount: 0, paidAmount: 0, balance: 0 },
            paid: { count: 0, originalAmount: 0, paidAmount: 0, balance: 0 },
            totalOpenBalance: 0,
            totalPaid: 0,
            totalOriginal: 0,
        };

        for (const row of rows) {
            const key = row._id;
            if (!summary[key]) continue;

            summary[key] = {
                count: Number(row.count || 0),
                originalAmount: round2(row.originalAmount),
                paidAmount: round2(row.paidAmount),
                balance: round2(row.balance),
            };
        }

        summary.totalOpenBalance = round2(summary.pending.balance + summary.partial.balance);
        summary.totalPaid = round2(summary.pending.paidAmount + summary.partial.paidAmount + summary.paid.paidAmount);
        summary.totalOriginal = round2(
            summary.pending.originalAmount +
            summary.partial.originalAmount +
            summary.paid.originalAmount
        );

        return res.json({
            success: true,
            data: summary,
        });
    } catch (error) {
        return next(error);
    }
}

async function addReceivablePayment(req, res, next) {
    try {
        const { tenantId, clientId, userId } = getScope(req);

        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!clientId) return next(createHttpError(400, "MISSING_CLIENT_ID"));

        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return next(createHttpError(400, "INVALID_RECEIVABLE_ID"));
        }

        const doc = await AccountReceivable.findOne({
            _id: id,
            tenantId,
            clientId,
        });

        if (!doc) return next(createHttpError(404, "RECEIVABLE_NOT_FOUND"));
        if (doc.status === "void") return next(createHttpError(409, "RECEIVABLE_VOIDED"));
        if (doc.status === "paid") return next(createHttpError(409, "RECEIVABLE_ALREADY_PAID"));

        const amount = round2(req.body?.amount);

        if (!Number.isFinite(amount) || amount <= 0) {
            return next(createHttpError(400, "INVALID_PAYMENT_AMOUNT"));
        }

        if (amount > round2(doc.balance) + 0.001) {
            return next(createHttpError(400, "PAYMENT_EXCEEDS_BALANCE"));
        }

        const method = normalizeMethod(req.body?.method || "Efectivo");
        const registerId = normalizeRegisterId(req.body?.registerId || "MAIN");
        const paidAt = req.body?.paidAt ? new Date(req.body.paidAt) : new Date();

        if (Number.isNaN(paidAt.getTime())) {
            return next(createHttpError(400, "INVALID_PAID_AT"));
        }

        doc.payments.push({
            amount,
            method,
            registerId,
            cashSessionId: mongoose.Types.ObjectId.isValid(req.body?.cashSessionId)
                ? req.body.cashSessionId
                : null,
            paidAt,
            receivedBy: userId,
            note: String(req.body?.note || "").trim(),
        });

        doc.paidAmount = round2(Number(doc.paidAmount || 0) + amount);
        doc.balance = round2(Number(doc.originalAmount || 0) - Number(doc.paidAmount || 0));
        doc.status = doc.balance <= 0 ? "paid" : "partial";
        doc.closedAt = doc.status === "paid" ? paidAt : null;

        await doc.save();

        await Order.updateOne(
            {
                _id: doc.orderId,
                tenantId,
                clientId,
            },
            {
                $set: {
                    accountReceivableId: doc._id,
                    creditStatus: doc.status,
                    paymentStatus: doc.status === "paid" ? "Pagado" : "Pendiente",
                    ...(doc.status === "paid"
                        ? {
                            paidAt,
                            paidBy: userId,
                        }
                        : {}),
                },
            }
        );

        const fresh = await AccountReceivable.findById(doc._id)
            .populate("customerId", "name phone address")
            .populate("orderId", "invoiceNumber facturaNo bills orderStatus paymentStatus paymentMethod createdAt")
            .populate("payments.receivedBy", "name role");

        return res.json({
            success: true,
            data: fresh,
        });
    } catch (error) {
        return next(error);
    }
}

async function voidReceivable(req, res, next) {
    try {
        const { tenantId, clientId, userId } = getScope(req);

        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!clientId) return next(createHttpError(400, "MISSING_CLIENT_ID"));

        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return next(createHttpError(400, "INVALID_RECEIVABLE_ID"));
        }

        const doc = await AccountReceivable.findOne({
            _id: id,
            tenantId,
            clientId,
        });

        if (!doc) return next(createHttpError(404, "RECEIVABLE_NOT_FOUND"));

        if (Number(doc.paidAmount || 0) > 0) {
            return next(createHttpError(409, "CANNOT_VOID_RECEIVABLE_WITH_PAYMENTS"));
        }

        doc.status = "void";
        doc.voidedAt = new Date();
        doc.voidedBy = userId;
        doc.voidReason = String(req.body?.reason || "").trim();

        await doc.save();

        await Order.updateOne(
            {
                _id: doc.orderId,
                tenantId,
                clientId,
            },
            {
                $set: {
                    creditStatus: "none",
                },
                $unset: {
                    accountReceivableId: "",
                },
            }
        );

        return res.json({
            success: true,
            data: doc,
        });
    } catch (error) {
        return next(error);
    }
}

async function summarizeReceivablePaymentsForCash({
                                                      tenantId,
                                                      clientId,
                                                      registerId,
                                                      start,
                                                      end,
                                                      userId,
                                                      role,
                                                  }) {
    const paymentMatch = {
        "payments.paidAt": { $gte: start, $lte: end },
    };

    const reg = String(registerId || "").trim().toUpperCase();

    if (reg && reg !== ALL_REGISTERS_ID) {
        paymentMatch["payments.registerId"] = reg;
    }

    if (!isAdminLikeRole(role) && userId) {
        paymentMatch["payments.receivedBy"] = new mongoose.Types.ObjectId(String(userId));
    }

    const rows = await AccountReceivable.aggregate([
        {
            $match: {
                tenantId,
                clientId,
                status: { $ne: "void" },
            },
        },
        { $unwind: "$payments" },
        { $match: paymentMatch },
        {
            $group: {
                _id: "$payments.method",
                total: { $sum: "$payments.amount" },
                count: { $sum: 1 },
            },
        },
    ]);

    const byMethod = {
        Efectivo: 0,
        Tarjeta: 0,
        Transferencia: 0,
        Otros: 0,
    };

    let total = 0;

    for (const row of rows) {
        const method = normalizeMethod(row._id);
        byMethod[method] = round2(row.total);
        total += Number(row.total || 0);
    }

    return {
        total: round2(total),
        byMethod,
    };
}

async function summarizeCreditSalesForCash({
                                               tenantId,
                                               clientId,
                                               registerId,
                                               start,
                                               end,
                                               userId,
                                               role,
                                           }) {
    const match = {
        tenantId,
        clientId,
        status: { $ne: "void" },
        createdAt: { $gte: start, $lte: end },
    };

    const reg = String(registerId || "").trim().toUpperCase();

    if (reg && reg !== ALL_REGISTERS_ID) {
        match.registerId = reg;
    }

    if (!isAdminLikeRole(role) && userId) {
        match.createdBy = new mongoose.Types.ObjectId(String(userId));
    }

    const rows = await AccountReceivable.aggregate([
        { $match: match },
        {
            $group: {
                _id: null,
                total: { $sum: "$originalAmount" },
                count: { $sum: 1 },
            },
        },
    ]);

    return {
        total: round2(rows?.[0]?.total || 0),
        count: Number(rows?.[0]?.count || 0),
    };
}
async function getReceivableCashSummary(req, res, next) {
    try {
        const { tenantId, clientId, userId, role } = getScope(req);

        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!clientId) return next(createHttpError(400, "MISSING_CLIENT_ID"));

        const rawFrom = req.query?.from || req.query?.dateYMD;
        const rawTo = req.query?.to || req.query?.dateYMD || rawFrom;

        const start = parseBoundary(rawFrom, false);
        const end = parseBoundary(rawTo, true);

        if (!start || !end) {
            return next(createHttpError(400, "INVALID_DATE_RANGE"));
        }

        const registerId = String(req.query?.registerId || ALL_REGISTERS_ID)
            .trim()
            .toUpperCase();

        const paymentsSummary = await summarizeReceivablePaymentsForCash({
            tenantId,
            clientId,
            registerId,
            start,
            end,
            userId,
            role,
        });

        const creditSalesSummary = await summarizeCreditSalesForCash({
            tenantId,
            clientId,
            registerId,
            start,
            end,
            userId,
            role,
        });

        const creditSales = round2(creditSalesSummary?.total || 0);
        const paymentsTotal = round2(paymentsSummary?.total || 0);
        const byMethod = paymentsSummary?.byMethod || {};

        return res.json({
            success: true,
            data: {
                creditSales,
                creditSalesNegative: round2(creditSales * -1),
                creditSalesCount: Number(creditSalesSummary?.count || 0),

                paymentsTotal,
                paymentsCash: round2(byMethod.Efectivo || 0),
                paymentsCard: round2(byMethod.Tarjeta || 0),
                paymentsTransfer: round2(byMethod.Transferencia || 0),
                paymentsOther: round2(byMethod.Otros || 0),

                netReceivableImpact: round2(paymentsTotal - creditSales),
            },
        });
    } catch (error) {
        return next(error);
    }
}

module.exports = {
    createReceivableForOrder,
    listReceivables,
    getReceivableSummary,
    getReceivableCashSummary,
    addReceivablePayment,
    voidReceivable,
    summarizeReceivablePaymentsForCash,
    summarizeCreditSalesForCash,
};