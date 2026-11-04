// controllers/invoiceExportController.js
const ExcelJS = require("exceljs");
const Order = require("../models/orderModel");
const Tenant =
    require(
        "../models/tenantModel"
    );

const {
    getTenantLocalization,
    formatDateTime,
} = require(
    "../utils/localization"
);

const {
    getTodayYMDInTimeZone,
} = require(
    "../utils/timezone"
);

exports.exportInvoicesExcel = async (req, res) => {
    try {
        const tenantId = req.tenantId || req.user?.tenantId;
        const clientId = req.clientId;
        const tenant =
            await Tenant
                .findOne({
                    tenantId,
                })
                .select(
                    "localization"
                )
                .lean();

        const localization =
            getTenantLocalization(
                tenant
            );
        if (!tenantId) {
            return res.status(400).json({ error: "tenantId missing (middleware not applied?)" });
        }

        // ✅ Query seguro por tenant + client compat
        const query = { tenantId };
        // Scope comes from tenantMiddleware, never from a URL parameter.
        // Legacy missing-clientId orders belong to Principal only.
        query.$or = clientId && clientId !== "default"
            ? [{ clientId }]
            : [{ clientId: "default" }, { clientId: { $exists: false } }, { clientId: null }];

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
            { header: "Cajera", key: "user", width: 22 },
            { header: "PDF almacenado", key: "storedPdf", width: 18 },
        ];

        orders.forEach((o) => {
            sheet.addRow({
                id: o._id.toString(),
                date:
                    formatDateTime(
                        o.createdAt,
                        localization
                    ),
                client: o.customerDetails?.name || "N/A",
                method: o.paymentMethod || "Efectivo",
                subtotal: o.bills?.total || 0,
                discount: o.bills?.discount || 0,
                tip: o.bills?.tip || 0,
                tax: o.bills?.tax || 0,
                total: o.bills?.totalWithTax || 0,
                user: o.user?.name || o.user?.email || "N/A",
                storedPdf: (o.invoicePath || o.invoiceUrl) ? "Sí" : "No",
            });
        });

        res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        const todayYMD =
            getTodayYMDInTimeZone(
                localization.timezone
            );

        res.setHeader(
            "Content-Disposition",
            `attachment; filename=facturas_${todayYMD}.xlsx`
        );

        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        console.error("Excel export error:", err);
        res.status(500).json({ error: "Error generando Excel" });
    }
};
