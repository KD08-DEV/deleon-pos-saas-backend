// controllers/invoiceExportController.js
const ExcelJS = require("exceljs");
const Order = require("../models/orderModel");

exports.exportInvoicesExcel = async (req, res) => {
    try {
        const tenantId = req.tenantId || req.user?.tenantId;
        const clientId = req.clientId;

        if (!tenantId) {
            return res.status(400).json({ error: "tenantId missing (middleware not applied?)" });
        }

        // ✅ Query seguro por tenant + client compat
        const query = { tenantId };
        query.$or = clientId
            ? [
                { clientId },
                { clientId: { $exists: false } },
                { clientId: "default" },
            ]
            : [
                { clientId: { $exists: false } },
                { clientId: "default" },
            ];

        const orders = await Order.find(query).populate("user");

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet("Facturas");

        sheet.columns = [
            { header: "Order ID", key: "id", width: 30 },
            { header: "Fecha", key: "date", width: 22 },
            { header: "Cliente", key: "client", width: 28 },
            { header: "Método", key: "method", width: 12 },
            { header: "Subtotal", key: "subtotal", width: 14 },
            { header: "Descuento", key: "discount", width: 14 },
            { header: "Propina", key: "tip", width: 14 },
            { header: "ITBIS", key: "tax", width: 14 },
            { header: "Total", key: "total", width: 14 },
            { header: "Cajero", key: "user", width: 22 },
            { header: "Invoice URL", key: "invoiceUrl", width: 40 },
        ];

        orders.forEach((o) => {
            sheet.addRow({
                id: o._id.toString(),
                date: new Date(o.createdAt).toLocaleString(),
                client: o.customerDetails?.name || "N/A",
                method: o.paymentMethod || "Efectivo",
                subtotal: o.bills?.total || 0,
                discount: o.bills?.discount || 0,
                tip: o.bills?.tip || 0,
                tax: o.bills?.tax || 0,
                total: o.bills?.totalWithTax || 0,
                user: o.user?.name || o.user?.email || "N/A",
                invoiceUrl: o.invoiceUrl || "",
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
