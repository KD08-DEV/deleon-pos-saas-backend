"use strict";

const Order = require("../models/orderModel");
const ElectronicTaxDocument = require("../models/electronicTaxDocumentModel");
const { isValidYMD, buildScopedFiscalDocumentPipeline } = require("../services/cashCloseFiscalScope");

exports.listCashCloseFiscalDocuments = async (req, res, next) => {
    try {
        const tenantId = String(req.scope?.tenantId || req.tenantId || "").trim();
        const clientId = String(req.scope?.clientId || req.clientId || "default").trim() || "default";
        if (!tenantId) return res.status(403).json({ success: false, code: "TENANT_SCOPE_REQUIRED" });

        const dateYMD = String(req.query.dateYMD || "");
        if (!isValidYMD(dateYMD)) return res.status(400).json({ success: false, code: "INVALID_DATE_YMD" });
        const page = Number(req.query.page || 1);
        if (!Number.isSafeInteger(page) || page < 1 || page > 10000) {
            return res.status(400).json({ success: false, code: "INVALID_PAGE" });
        }
        const registerId = String(req.query.registerId || "").trim().toUpperCase();
        if (registerId.length > 100) return res.status(400).json({ success: false, code: "INVALID_REGISTER_ID" });
        const pipeline = buildScopedFiscalDocumentPipeline({
            tenantId, clientId, dateYMD, registerId, page, pageSize: 30,
            orderCollection: Order.collection.name,
        });
        const [result] = await ElectronicTaxDocument.aggregate(pipeline);
        const documents = (result?.documents || []).map((doc) => ({
            documentId: String(doc._id),
            orderId: String(doc.orderId),
            documentType: String(doc.ecf?.documentType || ""),
            eNCF: doc.ecf?.eNCF || "",
            status: doc.ecf?.status || "",
            trackId: doc.ecf?.trackId || "",
            qrUrl: doc.ecf?.qrUrl || "",
            securityCode: doc.ecf?.securityCode || "",
            fechaHoraFirma: doc.ecf?.fechaHoraFirma || "",
            createdAt: doc.createdAt,
            registerId: doc.registerId || "MAIN",
            totals: doc.totals || {},
            customer: doc.customer || {},
            reference: doc.reference || {},
        }));
        res.set("Cache-Control", "private, no-store");
        return res.json({ success: true, data: { documents, page, pageSize: 30, total: result?.count?.[0]?.value || 0 } });
    } catch (err) { return next(err); }
};
