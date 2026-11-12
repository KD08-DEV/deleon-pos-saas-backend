const createHttpError = require("http-errors");

const Tenant = require("../models/tenantModel");
const { getTenantTimezone, getUtcRangeForYMDRange } = require("../utils/timezone");
const { buildLegacyReportFilter, buildCreditReportFilter } = require("../utils/salesReportFilter");
const Order = require("../models/orderModel");
const InventoryMovement = require("../models/inventoryMovementModel");
const Expense = require("../models/expenseModel");
const PayrollRun = require("../models/payrollRunModel");

const getScope = (req) => {
    const tenantId = req.scope?.tenantId || req.user?.tenantId;
    const clientId = req.scope?.clientId || req.clientId || req.headers["x-client-id"] || "default";
    return { tenantId, clientId };
};

exports.getFinanceSummary = async (req, res, next) => {
    try {
        const { tenantId, clientId } = getScope(req);
        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));

        const from = String(req.query.from || "").trim();
        const to = String(req.query.to || "").trim();
        if (!from || !to) return next(createHttpError(400, "MISSING_FROM_TO"));

        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to)
            return next(createHttpError(400, "INVALID_REPORT_DATE_RANGE"));
        if (req.query.clientId && req.query.clientId !== clientId)
            return next(createHttpError(403, "BRANCH_SCOPE_MISMATCH"));
        const tenant = await Tenant.findOne({ tenantId }).select("localization.timezone").lean();
        const timezone = getTenantTimezone(tenant);
        const range = getUtcRangeForYMDRange(from, to, timezone);
        if (!range) return next(createHttpError(400, "INVALID_REPORT_DATE_RANGE"));
        const { start, end } = range;
        const effectiveClientId = clientId;
        const branchScope = clientId === "default"
            ? { $or: [{ clientId: "default" }, { clientId: { $exists: false } }, { clientId: null }, { clientId: "" }] }
            : { clientId };
        const criteria = { tenantId, clientId, startDate: start, endDate: end };
        const cashMatch = buildLegacyReportFilter(criteria);
        cashMatch.$and.push({ paymentMethod: { $not: /^(Credito|Crédito|Credit)$/i } });
        const orderMatch = { $or: [cashMatch, buildCreditReportFilter(criteria)] };
        const isCredit = { $or: [{ $eq: ["$settledFromCredit", true] }, { $regexMatch: { input: { $ifNull: ["$paymentMethod", ""] }, regex: "^(Credito|Crédito|Credit)$", options: "i" } }] };

        const salesAgg = await Order.aggregate([
            { $match: orderMatch },
            {
                $group: {
                    _id: null,
                    count: { $sum: { $cond: [isCredit, 0, 1] } },
                    creditCount: { $sum: { $cond: [isCredit, 1, 0] } },
                    creditTotal: { $sum: { $cond: [isCredit, { $ifNull: ["$bills.totalWithTax", 0] }, 0] } },
                    cogs: { $sum: { $cond: [isCredit, 0, { $ifNull: ["$cogsTotal", 0] }] } },
                    missingCost: { $sum: { $cond: [isCredit, 0, { $cond: [{ $eq: [{ $ifNull: ["$cogsTotal", null] }, null] }, 1, 0] }] } },
                    total: { $sum: { $cond: [isCredit, 0, { $ifNull: ["$bills.totalWithTax", 0] }] } },
                },
            },
        ]);

        const salesCount = Number(salesAgg?.[0]?.count || 0);
        const salesTotal = Number(salesAgg?.[0]?.total || 0);

        // 2) Compras (si las registras como InventoryMovement type "purchase")
        const purchaseMatch = { tenantId, type: "purchase", createdAt: { $gte: start, $lte: end } };
        Object.assign(purchaseMatch, branchScope);

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
        Object.assign(wasteMatch, branchScope);

        const mermaAgg = await InventoryMovement.aggregate([
            { $match: wasteMatch },
            { $group: { _id: null, qty: { $sum: "$qty" }, cost: { $sum: { $ifNull: ["$costAmount", 0] } } } },
        ]);

        const mermaTotal = Number(mermaAgg?.[0]?.cost || 0);

        // 4) Gastos varios (Expense) excluyendo los que vengan de nómina
        const expenseFilter = { tenantId, status: "posted", dateYMD: { $gte: from, $lte: to } };
        Object.assign(expenseFilter, branchScope);

        const expensesAgg = await Expense.aggregate([
            {
                $match: {
                    ...expenseFilter,
                    "source.type": { $ne: "payroll" },
                },
            },
            { $group: { _id: null, total: { $sum: "$amount" } } },
        ]);

        const expensesTotal = Number(expensesAgg?.[0]?.total || 0);

        // 5) Nómina (PayrollRun) (y ya además queda registrada como Expense al “postear”)
        const payrollFilter = { tenantId, status: "posted", payDateYMD: { $gte: from, $lte: to } };
        Object.assign(payrollFilter, branchScope);

        const payrollAgg = await PayrollRun.aggregate([
            { $match: payrollFilter },
            { $group: { _id: null, totalNet: { $sum: "$totals.net" } } },
        ]);

        const payrollTotal = Number(payrollAgg?.[0]?.totalNet || 0);

        const cogsTotal = Number(salesAgg?.[0]?.cogs || 0);
        const grossProfit = Number((salesTotal - cogsTotal).toFixed(2));
        const totalCosts = cogsTotal + expensesTotal + payrollTotal + mermaTotal;
        const net = salesTotal - totalCosts;

        return res.json({
            success: true,
            data: {
                range: { from, to, clientId: effectiveClientId, timezone },
                cogsTotal, grossProfit,
                missingCostCount: Number(salesAgg?.[0]?.missingCost || 0),
                sales: { count: salesCount, total: Number(salesTotal.toFixed(2)), creditTotal: Number(salesAgg?.[0]?.creditTotal || 0), creditCount: Number(salesAgg?.[0]?.creditCount || 0), collectedTotal: Number(salesTotal.toFixed(2)) },
                purchases: { total: Number(purchasesTotal.toFixed(2)) },
                expenses: { total: Number(expensesTotal.toFixed(2)) },
                payroll: { total: Number(payrollTotal.toFixed(2)) },
                merma: { total: Number(mermaTotal.toFixed(2)) },
                totals: { costs: Number(totalCosts.toFixed(2)), net: Number(net.toFixed(2)) },
                netTotal: Number(net.toFixed(2)),

            },
        });
    } catch (e) {
        next(e);
    }
};
