const createHttpError = require("http-errors");

const Order = require("../models/orderModel");
const InventoryMovement = require("../models/inventoryMovementModel");
const Expense = require("../models/expenseModel");
const PayrollRun = require("../models/payrollRunModel");

const getScope = (req) => {
    const tenantId = req.user?.tenantId || req.scope?.tenantId || req.headers["x-tenant-id"];
    const clientId = req.headers["x-client-id"] || req.scope?.clientId || req.clientId || "default";
    return { tenantId, clientId };
};

// Mismo enfoque de rangos por día que ya usas en cash-session y merma summary :contentReference[oaicite:2]{index=2} :contentReference[oaicite:3]{index=3}
const toRange = (ymd, end) => new Date(`${ymd}T${end ? "23:59:59.999" : "00:00:00.000"}`);

exports.getFinanceSummary = async (req, res, next) => {
    try {
        const { tenantId, clientId } = getScope(req);
        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));

        const from = String(req.query.from || "").trim();
        const to = String(req.query.to || "").trim();
        if (!from || !to) return next(createHttpError(400, "MISSING_FROM_TO"));

        const clientFilter = (req.query.clientId || "").trim();
        const useAllClients = clientFilter.toLowerCase() === "all";
        const effectiveClientId = useAllClients ? null : (clientFilter || clientId);

        const start = toRange(from, false);
        const end = toRange(to, true);

        // 1) Ventas (Orders)
        const orderMatch = { tenantId, orderStatus: "Completado", createdAt: { $gte: start, $lte: end } };
        if (!useAllClients) orderMatch.clientId = effectiveClientId;

        const salesAgg = await Order.aggregate([
            { $match: orderMatch },
            {
                $group: {
                    _id: null,
                    count: { $sum: 1 },
                    total: { $sum: { $ifNull: ["$bills.totalWithTax", 0] } },
                },
            },
        ]);

        const salesCount = Number(salesAgg?.[0]?.count || 0);
        const salesTotal = Number(salesAgg?.[0]?.total || 0);

        // 2) Compras (si las registras como InventoryMovement type "purchase")
        const purchaseMatch = { tenantId, type: "purchase", createdAt: { $gte: start, $lte: end } };
        if (!useAllClients) purchaseMatch.clientId = effectiveClientId;

        const purchasesAgg = await InventoryMovement.aggregate([
            { $match: purchaseMatch },
            {
                $group: {
                    _id: null,
                    qty: { $sum: "$qty" },
                    cost: { $sum: { $ifNull: ["$costAmount", 0] } },
                },
            },
        ]);

        const purchasesTotal = Number(purchasesAgg?.[0]?.cost || 0);

        // 3) Merma (InventoryMovement type "waste") igual a tu summary actual :contentReference[oaicite:4]{index=4}
        const wasteMatch = { tenantId, type: "waste", createdAt: { $gte: start, $lte: end } };
        if (!useAllClients) wasteMatch.clientId = effectiveClientId;

        const mermaAgg = await InventoryMovement.aggregate([
            { $match: wasteMatch },
            { $group: { _id: null, qty: { $sum: "$qty" }, cost: { $sum: { $ifNull: ["$costAmount", 0] } } } },
        ]);

        const mermaTotal = Number(mermaAgg?.[0]?.cost || 0);

        // 4) Gastos varios (Expense) excluyendo los que vengan de nómina
        const expenseFilter = { tenantId, status: "posted", dateYMD: { $gte: from, $lte: to } };
        if (!useAllClients) expenseFilter.clientId = effectiveClientId;

        const expensesAgg = await Expense.aggregate([
            {
                $match: {
                    ...expenseFilter,
                    $or: [
                        { "source.type": { $exists: false } },
                        { "source.type": { $ne: "payroll" } },
                    ],
                },
            },
            { $group: { _id: null, total: { $sum: "$amount" } } },
        ]);

        const expensesTotal = Number(expensesAgg?.[0]?.total || 0);

        // 5) Nómina (PayrollRun) (y ya además queda registrada como Expense al “postear”)
        const payrollFilter = { tenantId, status: "posted", payDateYMD: { $gte: from, $lte: to } };
        if (!useAllClients) payrollFilter.clientId = effectiveClientId;

        const payrollAgg = await PayrollRun.aggregate([
            { $match: payrollFilter },
            { $group: { _id: null, totalNet: { $sum: "$totals.net" } } },
        ]);

        const payrollTotal = Number(payrollAgg?.[0]?.totalNet || 0);

        const totalCosts = purchasesTotal + expensesTotal + payrollTotal + mermaTotal;
        const net = salesTotal - totalCosts;
        const cogsAgg = await InventoryMovement.aggregate([
            { $match: { tenantId, clientId, type: "sale", createdAt: { $gte: start, $lte: end } } },
            { $group: { _id: null, cogsTotal: { $sum: { $ifNull: ["$costAmount", 0] } } } }
        ]);

        const cogsTotal = Number(cogsAgg?.[0]?.cogsTotal || 0);
        const grossProfit = Number((salesTotal - cogsTotal).toFixed(2));

        return res.json({
            success: true,
            data: {
                range: { from, to, clientId: useAllClients ? "all" : effectiveClientId },
                sales: { count: salesCount, total: Number(salesTotal.toFixed(2)) },
                purchases: { total: Number(purchasesTotal.toFixed(2)) },
                expenses: { total: Number(expensesTotal.toFixed(2)) },
                payroll: { total: Number(payrollTotal.toFixed(2)) },
                merma: { total: Number(mermaTotal.toFixed(2)) },
                totals: { costs: Number(totalCosts.toFixed(2)), net: Number(net.toFixed(2)) },
                netTotal: Number((grossProfit - expensesTotal - payrollTotal).toFixed(2)),

            },
        });
    } catch (e) {
        next(e);
    }
};
