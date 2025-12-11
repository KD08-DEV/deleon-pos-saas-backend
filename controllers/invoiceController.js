// controllers/invoiceController.js  (PDF-LIB VERSION FINAL)
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const path = require("path");
const fs = require("fs");
const Order = require("../models/orderModel");
const generateInvoicePDF = require("../utils/generateInvoicePDF");

exports.createInvoice = async (req, res) => {
    try {
        const { orderId } = req.body;

        if (!orderId) {
            return res.status(400).json({
                message: "orderId is required"
            });
        }

        // Llamamos la función que genera el PDF
        const invoiceUrl = await generateInvoicePDF(orderId);

        return res.status(200).json({
            message: "Invoice generated successfully",
            invoiceUrl,
        });

    } catch (error) {
        console.error("Invoice Create Error:", error);
        return res.status(500).json({
            message: "Error generating invoice",
            error: error.message,
        });
    }
};