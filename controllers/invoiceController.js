// controllers/invoiceController.js  (PDF-LIB VERSION FINAL)
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const path = require("path");
const fs = require("fs");
const Order = require("../models/orderModel");
const { generateInvoicePDF } = require("../utils/generateInvoicePDF");


exports.createInvoice = async (req, res) => {
    try {
        const { orderId } = req.body;

        // Usa SIEMPRE el tenantId/clientId resuelto por tu middleware multi-tenant
        // (si aún no lo estás usando en la ruta, te lo digo más abajo)
        const tenantId = req.tenantId || req.user?.tenantId;
        const clientId = req.clientId;

        if (!orderId) {
            return res.status(400).json({ message: "orderId is required" });
        }
        if (!tenantId) {
            return res.status(400).json({ message: "tenantId missing (middleware not applied?)" });
        }

        // ✅ Query seguro (igual que getInvoice)
        const query = { _id: orderId, tenantId };
        query.$or = clientId
            ? [
                { clientId },                    // órdenes nuevas
                { clientId: { $exists: false } }, // órdenes viejas
                { clientId: "default" },         // compat
            ]
            : [
                { clientId: { $exists: false } },
                { clientId: "default" },
            ];

        // ✅ Verifica pertenencia ANTES de generar el PDF
        const order = await Order.findOne(query).select("_id invoiceUrl").lean();
        if (!order) {
            return res.status(404).json({ message: "Order not found for this tenant/client" });
        }

        // Si ya existe invoice, devuelve la misma
        if (order.invoiceUrl) {
            return res.status(200).json({
                message: "Invoice already generated",
                invoiceUrl: order.invoiceUrl,
            });
        }

        // Genera PDF (ya validaste pertenencia)
        const invoiceData = await generateInvoicePDF(orderId, tenantId); // { path, url }

        // ✅ Actualiza de forma segura (no por findByIdAndUpdate)
        await Order.findOneAndUpdate(query, {
            invoicePath: invoiceData.path,
            invoiceUrl: invoiceData.url,
        });

        return res.status(200).json({
            message: "Invoice generated successfully",
            invoiceUrl: invoiceData.url,
        });
    } catch (error) {
        console.error("Invoice Create Error:", error);
        return res.status(500).json({
            message: "Error generating invoice",
            error: error.message,
        });
    }
};

exports.getInvoice = async (req, res) => {
    try {
        const { orderId } = req.params;
        const tenantId = req.user?.tenantId;
        const clientId = req.clientId;

        if (!orderId) {
            return res.status(400).json({ success: false, message: "orderId is required" });
        }

        // ✅ Compatibilidad: órdenes viejas sin clientId o con "default"
        const query = { _id: orderId, tenantId };

        query.$or = clientId
            ? [
                { clientId },                 // órdenes nuevas
                { clientId: { $exists: false } }, // órdenes viejas
                { clientId: "default" },       // compat
            ]
            : [
                { clientId: { $exists: false } },
                { clientId: "default" },
            ];

        const order = await Order.findOne(query).lean();

        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }

        if (order.invoiceUrl) {
            return res.status(200).json({ success: true, url: order.invoiceUrl });
        }

        const invoiceData = await generateInvoicePDF(orderId, tenantId); // { path, url }

        await Order.findByIdAndUpdate(orderId, {
            invoicePath: invoiceData.path,
            invoiceUrl: invoiceData.url,
        });

        return res.status(200).json({ success: true, url: invoiceData.url });
    } catch (error) {
        console.error("Get Invoice Error:", error);
        return res.status(500).json({
            success: false,
            message: "Error getting invoice",
            error: error.message,
        });
    }
};
