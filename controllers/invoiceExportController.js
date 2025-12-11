// controllers/invoiceExportController.js
const ExcelJS = require("exceljs");
const Order = require("../models/orderModel");
const path = require("path");

exports.exportInvoicesExcel = async (req, res) => {
    try {
        const orders = await Order.find().populate("user");

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet("Facturas");

        sheet.columns = [
            { header: "Order ID", key: "id", width: 30 },
            { header: "Fecha", key: "date", width: 20 },
            { header: "Cliente", key: "client", width: 25 },
            { header: "Método", key: "method", width: 15 },
            { header: "Subtotal", key: "subtotal", width: 15 },
            { header: "Descuento", key: "discount", width: 15 },
            { header: "Propina", key: "tip", width: 15 },
            { header: "ITBIS", key: "tax", width: 15 },
            { header: "Total", key: "total", width: 15 },
        ];

        orders.forEach((o) => {
            sheet.addRow({
                id: o._id.toString(),
                date: new Date(o.createdAt).toLocaleString(),
                client: o.customerName || "N/A",
                method: o.paymentMethod || "Cash",
                subtotal: o.bills?.subtotal || 0,
                discount: o.bills?.discount || 0,
                tip: o.bills?.tipValue || 0,
                tax: o.bills?.tax || 0,
                total: o.bills?.totalWithTax || 0,
            });
        });

        res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        res.setHeader("Content-Disposition", "attachment; filename=facturas.xlsx");

        await workbook.xlsx.write(res);
        res.end();

    } catch (err) {
        console.error("Excel export error:", err);
        res.status(500).json({ error: "Error generando Excel" });
    }
};
