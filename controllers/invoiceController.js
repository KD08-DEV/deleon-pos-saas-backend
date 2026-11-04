"use strict";
const mongoose = require("mongoose");
const Order = require("../models/orderModel");
const generateInvoicePDF = require("../utils/generateInvoicePDF");
const { signStoredInvoice } = require("../utils/invoiceStorageAccess");
const { supabase } = require("../config/supabaseClient");

function scopedOrderQuery(req, orderId) {
    const tenantId = req.tenantId;
    const clientId = req.clientId || "default";
    return {
        _id: orderId,
        tenantId,
        ...(clientId === "default"
            ? { $or: [{ clientId: "default" }, { clientId: { $exists: false } }] }
            : { clientId }),
    };
}

async function temporaryInvoiceUrl(req, orderId) {
    const signed = await signStoredInvoice({
        storage: supabase.storage,
        tenantId: req.tenantId,
        orderId,
        ttlSeconds: 120,
    });
    return signed?.url || null;
}

function validInvoiceRequest(req, res, orderId) {
    if (!req.tenantId) {
        res.status(403).json({ success: false, message: "Tenant unavailable" });
        return false;
    }
    if (!mongoose.isValidObjectId(orderId)) {
        res.status(404).json({ success: false, message: "Order not found" });
        return false;
    }
    return true;
}

exports.createInvoice = async (req, res) => {
    try {
        const { orderId } = req.body || {};
        if (!validInvoiceRequest(req, res, orderId)) return;
        const query = scopedOrderQuery(req, orderId);
        const order = await Order.findOne(query).select("_id invoicePath invoiceUrl").lean();
        if (!order) return res.status(404).json({ success: false, message: "Order not found" });

        // Old PDFs remain valid: issue a short-lived link on demand.
        // Never echo a legacy public URL even when it is stored in MongoDB.
        if (order.invoicePath || order.invoiceUrl) {
            const url = await temporaryInvoiceUrl(req, orderId);
            if (!url) return res.status(404).json({ success: false, message: "Stored PDF unavailable" });
            res.set("Cache-Control", "no-store");
            return res.status(200).json({ success: true, message: "Invoice already generated", url, invoiceUrl: url });
        }

        const output = await generateInvoicePDF(orderId, req.tenantId);
        if (!output || typeof output.path !== "string") {
            throw new Error("INVOICE_STORAGE_PATH_MISSING");
        }
        // Only a stable object path is stored, not a public or expiring URL.
        await Order.findOneAndUpdate(query, { $set: { invoicePath: output.path, invoiceUrl: "" } });
        const url = await temporaryInvoiceUrl(req, orderId);
        if (!url) return res.status(502).json({ success: false, message: "PDF stored but signed download unavailable" });
        res.set("Cache-Control", "no-store");
        return res.status(200).json({ success: true, message: "Invoice generated successfully", url, invoiceUrl: url });
    } catch (error) {
        console.error("Invoice Create Error:", error?.message || error);
        return res.status(500).json({ success: false, message: "Error generating invoice" });
    }
};

exports.getInvoice = async (req, res) => {
    try {
        const { orderId } = req.params;
        if (!validInvoiceRequest(req, res, orderId)) return;
        const order = await Order.findOne(scopedOrderQuery(req, orderId))
            .select("_id invoicePath invoiceUrl").lean();
        if (!order) return res.status(404).json({ success: false, message: "Order not found" });
        res.set("Cache-Control", "no-store");
        if (order.invoicePath || order.invoiceUrl) {
            const url = await temporaryInvoiceUrl(req, orderId);
            if (!url) return res.status(404).json({ success: false, message: "Stored PDF unavailable" });
            return res.status(200).json({ success: true, url });
        }
        // The normal visual invoice uses existing order data and does not
        // upload a PDF automatically.
        return res.status(200).json({
            success: true,
            orderId,
            previewAvailable: true,
            invoiceUrl: null,
            message: "Stored order available for invoice preview; no PDF generated",
        });
    } catch (error) {
        console.error("Get Invoice Error:", error?.message || error);
        return res.status(500).json({ success: false, message: "Error getting invoice" });
    }
};
