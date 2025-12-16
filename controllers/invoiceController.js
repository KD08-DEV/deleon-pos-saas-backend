// controllers/invoiceController.js  (PDF-LIB VERSION FINAL)
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const path = require("path");
const fs = require("fs");
const Order = require("../models/orderModel");
const { generateInvoicePDF } = require("../utils/generateInvoicePDF");

exports.createInvoice = async (req, res) => {
    try {
        const { orderId } = req.body;
        const tenantId = req.user.tenantId;

        if (!orderId) {
            return res.status(400).json({ message: "orderId is required" });
        }

        // 👇 AQUÍ se genera el PDF
        const invoiceData = await generateInvoicePDF(orderId, tenantId);
        // invoiceData = { path, url }

        // 👇 AQUÍ MISMO se guarda en la orden (ESTA ES LA RESPUESTA A TU PREGUNTA)
        await Order.findByIdAndUpdate(orderId, {
            invoicePath: invoiceData.path,
            invoiceUrl: invoiceData.url
        });

        return res.status(200).json({
            message: "Invoice generated successfully",
            invoiceUrl: invoiceData.url
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
