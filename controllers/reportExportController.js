// pos-backend/controllers/reportExportController.js
const XLSX = require("xlsx");
const Order = require("../models/orderModel");

// Helper para propina
function resolveTip(bills = {}, order = {}) {
    if (bills.tipAmount !== undefined) return Number(bills.tipAmount || 0);
    if (bills.tip !== undefined) return Number(bills.tip || 0);
    if (order.tip !== undefined) return Number(order.tip || 0);
    return 0;
}

// FUNCION PRINCIPAL
async function exportExcel(req, res) {
    try {
        const orders = await Order.find({})
            .populate("user")
            .lean();

        if (!orders || orders.length === 0) {
            return res.status(404).json({ success: false, message: "No orders found" });
        }

        const rows = [];
        let totalGeneral = 0;

        for (const order of orders) {
            const itemsNames = (order.items || [])
                .map((i) => `${i.name} x${i.quantity}`)
                .join(", ");

            const bills = order.bills || {};
            const subtotal = Number(bills.total || 0);
            const descuento = Number(bills.discount || 0);
            const itbs = Number(bills.tax || 0);
            const grandTotal = Number(bills.totalWithTax || 0);
            const propina = resolveTip(bills, order);

            totalGeneral += grandTotal;

            rows.push({
                "Order ID": order._id.toString(),
                "Date": new Date(order.createdAt).toLocaleDateString(),
                "Item": itemsNames,
                "name cx": order.customerDetails?.name || "Consumidor",
                "sub total": subtotal,
                "descuento": descuento,
                "itbs": itbs,
                "propina": propina,
                "método de pago": order.paymentMethod || "Cash",
                "usuario": order.user?.name || "—",
                "grand total": grandTotal
            });
        }

        rows.push({
            "Order ID": "",
            "Date": "",
            "Item": "",
            "name cx": "",
            "sub total": "",
            "descuento": "",
            "itbs": "",
            "propina": "",
            "método de pago": "TOTAL:",
            "usuario": "",
            "grand total": totalGeneral,
        });

        const worksheet = XLSX.utils.json_to_sheet(rows);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Reportes");

        const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

        res.setHeader("Content-Disposition", "attachment; filename=reporte_ordenes.xlsx");
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

        return res.send(buffer);

    } catch (error) {
        console.error("Excel export error:", error);
        res.status(500).json({ success: false, message: "Export failed" });
    }
}

function exportAllInvoices(req, res) {
    return res.json({ success: false, message: "Not implemented yet" });
}

// 👇 ESTA LÍNEA ES LA CLAVE
module.exports = {
    exportExcel,
    exportAllInvoices
};
