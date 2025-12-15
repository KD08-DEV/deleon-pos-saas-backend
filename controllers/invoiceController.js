// controllers/invoiceController.js  (PDF-LIB VERSION FINAL)
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const path = require("path");
const fs = require("fs");
const Order = require("../models/orderModel");
const generateInvoicePDF = require("../utils/generateInvoicePDF");

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
