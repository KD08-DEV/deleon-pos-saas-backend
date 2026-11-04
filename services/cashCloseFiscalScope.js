"use strict";

const { getUtcRangeForYMDRange } = require("../utils/timezone");

const isValidYMD = (text) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(text || ""))) return false;
    const [y, m, d] = text.split("-").map(Number);
    const parsed = new Date(Date.UTC(y, m - 1, d));
    return parsed.getUTCFullYear() === y && parsed.getUTCMonth() + 1 === m && parsed.getUTCDate() === d;
};

const buildScopedFiscalDocumentPipeline = ({
    tenantId, clientId = "default", dateYMD, registerId = "", page = 1, pageSize = 30,
    orderCollection = "orders"
}) => {
    if (!tenantId || !isValidYMD(dateYMD)) throw new Error("INVALID_FISCAL_CLOSING_SCOPE");
    const range = getUtcRangeForYMDRange(dateYMD, dateYMD, "America/Santo_Domingo");
    if (!range || !range.start || !range.end) throw new Error("INVALID_CLOSING_DATE_RANGE");
    const client = String(clientId || "default");
    const branch = client === "default"
        ? { $or: [{ clientId: "default" }, { clientId: { $exists: false } }, { clientId: null }, { clientId: "" }] }
        : { clientId: client };
    const register = String(registerId || "").trim().toUpperCase();
    const byRegister = !register || register === "__ALL_REGISTERS__" || register === "ALL"
        ? null
        : register === "MAIN" || register === "DEFAULT"
            ? { $or: [
                { "linkedOrder.registerId": { $in: ["MAIN", "DEFAULT", "default", ""] } },
                { "linkedOrder.registerId": { $exists: false } },
                { "linkedOrder.registerId": null },
            ] }
            : { "linkedOrder.registerId": register };
    const matchOrder = { tenantId, ...branch };
    return [
        { $match: {
            tenantId, ...branch,
            "ecf.documentType": { $in: ["31", "32", "33", "34"] },
            createdAt: { $gte: range.start, $lte: range.end },
        } },
        { $lookup: {
            from: orderCollection,
            localField: "orderId",
            foreignField: "_id",
            pipeline: [
                { $match: matchOrder },
                { $project: { _id: 1, registerId: 1, facturaNo: 1, invoiceNumber: 1 } },
            ],
            as: "linkedOrder",
        } },
        { $unwind: "$linkedOrder" }, // No exponer documentos sin orden autorizada.
        ...(byRegister ? [{ $match: byRegister }] : []),
        { $sort: { createdAt: -1, _id: -1 } },
        { $facet: {
            documents: [
                { $skip: (page - 1) * pageSize }, { $limit: pageSize },
                { $project: {
                    _id: 1, orderId: 1, createdAt: 1,
                    "ecf.documentType": 1, "ecf.eNCF": 1, "ecf.status": 1,
                    "ecf.trackId": 1, "ecf.qrUrl": 1, "ecf.securityCode": 1,
                    "ecf.fechaHoraFirma": 1,
                    "reference.modifiedENCF": 1, "reference.reason": 1,
                    "reference.modificationCode": 1,
                    "customer.name": 1, "customer.document": 1,
                    "totals.subtotal": 1, "totals.tax": 1,
                    "totals.discount": 1, "totals.total": 1,
                    registerId: "$linkedOrder.registerId",
                } },
            ],
            count: [{ $count: "value" }],
        } },
    ];
};

module.exports = { isValidYMD, buildScopedFiscalDocumentPipeline };
