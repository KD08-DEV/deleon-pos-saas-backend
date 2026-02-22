const createHttpError = require("http-errors");
const mongoose = require("mongoose");

const PayrollRun = require("../models/payrollRunModel");
const ExpenseCategory = require("../models/expenseCategoryModel");
const Expense = require("../models/expenseModel");

const getScope = (req) => {
    const tenantId = req.user?.tenantId || req.scope?.tenantId || req.headers["x-tenant-id"];
    const clientId = req.headers["x-client-id"] || req.scope?.clientId || req.clientId || "default";
    const userId = req.user?._id || null;
    return { tenantId, clientId, userId };
};

const cleanStr = (v) => String(v || "").trim();
const num = (v) => {
    if (typeof v === "string") v = v.replace(/,/g, "");
    const n = Number(v);
    return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
};

const computeTotals = (items) => {
    let gross = 0, deductions = 0, net = 0;

    const normalized = (items || []).map((it) => {
        const g = num(it?.gross);
        const d = num(it?.deductions);
        const n = it?.net != null ? num(it?.net) : Math.max(0, g - d);

        gross += g;
        deductions += d;
        net += n;

        return {
            userId: it?.userId || null,
            employeeName: cleanStr(it?.employeeName) || "Sin nombre",
            roleName: cleanStr(it?.roleName),
            gross: g,
            deductions: d,
            net: n,
            note: cleanStr(it?.note),
        };
    });

    return {
        items: normalized,
        totals: {
            gross: Number(gross.toFixed(2)),
            deductions: Number(deductions.toFixed(2)),
            net: Number(net.toFixed(2)),
        },
    };
};

exports.listPayrollRuns = async (req, res, next) => {
    try {
        const { tenantId, clientId } = getScope(req);
        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));

        const { from, to, status } = req.query;

        const filter = { tenantId, clientId };
        if (status) filter.status = status;
        if (from && to) filter.payDateYMD = { $gte: String(from), $lte: String(to) };

        const runs = await PayrollRun.find(filter).sort({ payDateYMD: -1, createdAt: -1 }).lean();
        return res.json({ success: true, data: runs });
    } catch (e) {
        next(e);
    }
};

exports.getPayrollRun = async (req, res, next) => {
    try {
        const { tenantId, clientId } = getScope(req);
        const { id } = req.params;
        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!mongoose.Types.ObjectId.isValid(id)) return next(createHttpError(400, "INVALID_ID"));

        const run = await PayrollRun.findOne({ _id: id, tenantId, clientId }).lean();
        if (!run) return next(createHttpError(404, "PAYROLL_NOT_FOUND"));

        return res.json({ success: true, data: run });
    } catch (e) {
        next(e);
    }
};

exports.createPayrollRun = async (req, res, next) => {
    try {
        const { tenantId, clientId, userId } = getScope(req);
        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));

        const periodFromYMD = cleanStr(req.body?.periodFromYMD);
        const periodToYMD = cleanStr(req.body?.periodToYMD);
        const payDateYMD = cleanStr(req.body?.payDateYMD);

        if (!periodFromYMD || !periodToYMD || !payDateYMD) {
            return next(createHttpError(400, "MISSING_DATES"));
        }

        const { items, totals } = computeTotals(req.body?.items || []);

        const run = await PayrollRun.create({
            tenantId,
            clientId,
            periodFromYMD,
            periodToYMD,
            payDateYMD,
            items,
            totals,
            note: cleanStr(req.body?.note),
            createdBy: userId,
            status: "draft",
        });

        return res.status(201).json({ success: true, data: run });
    } catch (e) {
        next(e);
    }
};

exports.updatePayrollRun = async (req, res, next) => {
    try {
        const { tenantId, clientId } = getScope(req);
        const { id } = req.params;

        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!mongoose.Types.ObjectId.isValid(id)) return next(createHttpError(400, "INVALID_ID"));

        const run = await PayrollRun.findOne({ _id: id, tenantId, clientId });
        if (!run) return next(createHttpError(404, "PAYROLL_NOT_FOUND"));
        if (run.status !== "draft") return next(createHttpError(409, "PAYROLL_NOT_EDITABLE"));

        if (req.body?.periodFromYMD != null) run.periodFromYMD = cleanStr(req.body.periodFromYMD);
        if (req.body?.periodToYMD != null) run.periodToYMD = cleanStr(req.body.periodToYMD);
        if (req.body?.payDateYMD != null) run.payDateYMD = cleanStr(req.body.payDateYMD);
        if (req.body?.note != null) run.note = cleanStr(req.body.note);

        if (req.body?.items != null) {
            const { items, totals } = computeTotals(req.body.items || []);
            run.items = items;
            run.totals = totals;
        }

        await run.save();
        return res.json({ success: true, data: run });
    } catch (e) {
        next(e);
    }
};

exports.postPayrollRun = async (req, res, next) => {
    try {
        const { tenantId, clientId, userId } = getScope(req);
        const { id } = req.params;

        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!mongoose.Types.ObjectId.isValid(id)) return next(createHttpError(400, "INVALID_ID"));

        const run = await PayrollRun.findOne({ _id: id, tenantId, clientId });
        if (!run) return next(createHttpError(404, "PAYROLL_NOT_FOUND"));
        if (run.status === "posted") return res.json({ success: true, data: run }); // idempotente
        if (run.status === "void") return next(createHttpError(409, "PAYROLL_VOIDED"));

        // 1) Upsert categoría del sistema: Nómina
        const cat = await ExpenseCategory.findOneAndUpdate(
            { tenantId, clientId, systemKey: "payroll" },
            { $setOnInsert: { name: "Nómina", description: "Gasto generado por nómina", status: "active" } },
            { new: true, upsert: true }
        );

        // 2) Crear gasto asociado (si no existe)
        await Expense.create({
            tenantId,
            clientId,
            dateYMD: run.payDateYMD,
            amount: Number(run.totals?.net || 0),
            categoryId: cat._id,
            paymentMethod: "other",
            note: `Nómina ${run.periodFromYMD} a ${run.periodToYMD}`,
            reference: String(run._id),
            source: { type: "payroll", refId: run._id },
            status: "posted",
            createdBy: userId,
        });

        run.status = "posted";
        run.postedAt = new Date();
        run.postedBy = userId;
        await run.save();

        return res.json({ success: true, data: run });
    } catch (e) {
        // Si ya existía el gasto (índice unique), seguimos
        if (e?.code === 11000) {
            return res.json({ success: true, message: "Payroll posteado (ya existía gasto)", data: null });
        }
        next(e);
    }
};
