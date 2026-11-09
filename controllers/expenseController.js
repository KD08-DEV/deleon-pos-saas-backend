const createHttpError = require("http-errors");
const mongoose = require("mongoose");

const ExpenseCategory = require("../models/expenseCategoryModel");
const Expense = require("../models/expenseModel");
const { writeCategory, withCategoryLock } = require("../services/expenseCategoryService");
const Supplier = require("../models/supplierModel");

const getScope = (req) => {
    const tenantId = req.scope?.tenantId || req.user?.tenantId || req.headers["x-tenant-id"];
    const clientId = req.scope?.clientId || req.headers["x-client-id"] || req.clientId || "default";
    const userId = req.user?._id || null;
    return { tenantId, clientId, userId };
};

const cleanStr = (v) => String(v || "").trim();
const coerceMoney = (v) => {
    if (typeof v === "string") v = v.replace(/,/g, "");
    const n = Number(v);
    return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
};

exports.listExpenseCategories = async (req, res, next) => {
    try {
        const { tenantId, clientId } = getScope(req);
        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));

        const categories = await ExpenseCategory.find({ tenantId, clientId })
            .sort({ name: 1 })
            .lean();

        return res.json({ success: true, data: categories });
    } catch (e) {
        next(e);
    }
};

exports.createExpenseCategory = async (req, res, next) => {
    try {
        const { tenantId, clientId } = getScope(req);
        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));

        const name = cleanStr(req.body?.name);
        if (!name) return next(createHttpError(400, "NAME_REQUIRED"));

        const doc = await writeCategory({ tenantId, clientId, body: req.body });

        return res.status(201).json({ success: true, data: doc });
    } catch (e) {
        if (e?.code === 11000) return next(createHttpError(400, "CATEGORY_ALREADY_EXISTS"));
        next(e);
    }
};

exports.updateExpenseCategory = async (req, res, next) => {
    try {
        const { tenantId, clientId } = getScope(req);
        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));

        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) return next(createHttpError(400, "INVALID_ID"));

        const doc = await writeCategory({ tenantId, clientId, id, body: req.body });

        return res.json({ success: true, data: doc });
    } catch (e) {
        if (e?.code === 11000) return next(createHttpError(400, "CATEGORY_ALREADY_EXISTS"));
        next(e);
    }
};

exports.deleteExpenseCategory = async (req, res, next) => {
    try {
        const { tenantId, clientId } = getScope(req);
        const { id } = req.params;
        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!mongoose.Types.ObjectId.isValid(id)) return next(createHttpError(400, "INVALID_ID"));

        await withCategoryLock({ tenantId, clientId, id }, async (category, session) => {
            if (category.systemKey) throw createHttpError(409, "SYSTEM_CATEGORY_PROTECTED");
            const used = await Expense.exists({ tenantId, clientId, categoryId: id }).session(session);
            if (used) throw createHttpError(409, "CATEGORY_IN_USE");
            await ExpenseCategory.deleteOne({ _id: id, tenantId, clientId }, { session });
        });

        return res.json({ success: true });
    } catch (e) {
        next(e);
    }
};

exports.listExpenses = async (req, res, next) => {
    try {
        const { tenantId, clientId } = getScope(req);
        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        const { from, to, categoryId, supplierId, includeVoided, sourceType } = req.query;

        const filter = { tenantId, clientId };

        if (includeVoided !== "true") filter.status = "posted";
        if (from && to) filter.dateYMD = { $gte: String(from), $lte: String(to) };
        if (categoryId && mongoose.Types.ObjectId.isValid(categoryId)) filter.categoryId = categoryId;
        if (supplierId && mongoose.Types.ObjectId.isValid(supplierId)) filter.supplierId = supplierId;

        if (sourceType === "manual") {
            filter.$or = [
                { source: { $exists: false } },
                { source: null },
                { "source.type": { $exists: false } },
            ];
        }

        if (sourceType === "payroll") {
            filter["source.type"] = "payroll";
        }

        const rows = await Expense.find(filter)
            .populate("categoryId", "name systemKey")
            .populate("supplierId", "name")
            .sort({ dateYMD: -1, createdAt: -1 })
            .lean();

        return res.json({ success: true, data: rows });
    } catch (e) {
        next(e);
    }
};

exports.createExpense = async (req, res, next) => {
    try {
        const { tenantId, clientId, userId } = getScope(req);
        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));

        const dateYMD = cleanStr(req.body?.dateYMD);
        const amount = coerceMoney(req.body?.amount);
        const categoryId = req.body?.categoryId;

        if (!dateYMD) return next(createHttpError(400, "DATE_REQUIRED"));
        if (amount == null || amount < 0) return next(createHttpError(400, "AMOUNT_INVALID"));
        if (!mongoose.Types.ObjectId.isValid(categoryId)) return next(createHttpError(400, "CATEGORY_INVALID"));

        const cat = await ExpenseCategory.findOne({ _id: categoryId, tenantId, clientId }).lean();
        if (!cat) return next(createHttpError(404, "CATEGORY_NOT_FOUND"));
        if (cat.status === "inactive") return next(createHttpError(409, "CATEGORY_INACTIVE"));

        let supplierId = req.body?.supplierId || null;
        if (supplierId) {
            if (!mongoose.Types.ObjectId.isValid(supplierId)) return next(createHttpError(400, "SUPPLIER_INVALID"));
            const s = await Supplier.findOne({ _id: supplierId, tenantId, clientId }).select("_id").lean();
            if (!s) return next(createHttpError(404, "SUPPLIER_NOT_FOUND"));
        }

        const doc = await withCategoryLock({ tenantId, clientId, id: categoryId }, async (category, session) => {
            if (category.status === "inactive") throw createHttpError(409, "CATEGORY_INACTIVE");
            const [doc] = await Expense.create([{
            tenantId,
            clientId,
            dateYMD,
            amount,
            categoryId,
            supplierId,
            paymentMethod: req.body?.paymentMethod || "cash",
            note: cleanStr(req.body?.note),
            reference: cleanStr(req.body?.reference),
            payable: {
                isPayable: Boolean(req.body?.payable?.isPayable),
                dueDateYMD: cleanStr(req.body?.payable?.dueDateYMD),
                status: req.body?.payable?.status || "unpaid",
                paidAmount: coerceMoney(req.body?.payable?.paidAmount) || 0,
                paidAt: req.body?.payable?.paidAt || null,
            },
            createdBy: userId,
                    }], { session });
            return doc;
        });

        return res.status(201).json({ success: true, data: doc });
    } catch (e) {
        next(e);
    }
};

exports.updateExpense = async (req, res, next) => {
    try {
        const { tenantId, clientId } = getScope(req);
        const { id } = req.params;

        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!mongoose.Types.ObjectId.isValid(id)) return next(createHttpError(400, "INVALID_ID"));

        const doc = await Expense.findOne({ _id: id, tenantId, clientId });
        if (!doc) return next(createHttpError(404, "EXPENSE_NOT_FOUND"));
        if (doc.status === "void") return next(createHttpError(409, "EXPENSE_VOIDED"));

        if (req.body?.dateYMD != null) doc.dateYMD = cleanStr(req.body.dateYMD);
        if (req.body?.amount != null) {
            const amt = coerceMoney(req.body.amount);
            if (amt == null || amt < 0) return next(createHttpError(400, "AMOUNT_INVALID"));
            doc.amount = amt;
        }

        if (req.body?.categoryId != null) {
            if (!mongoose.Types.ObjectId.isValid(req.body.categoryId)) return next(createHttpError(400, "CATEGORY_INVALID"));
            const cat = await ExpenseCategory.findOne({ _id: req.body.categoryId, tenantId, clientId }).lean();
            if (!cat) return next(createHttpError(404, "CATEGORY_NOT_FOUND"));
            if (cat.status === "inactive" && String(doc.categoryId) !== String(cat._id)) return next(createHttpError(409, "CATEGORY_INACTIVE"));
            doc.categoryId = req.body.categoryId;
        }

        if (req.body?.supplierId !== undefined) {
            if (req.body.supplierId === null || req.body.supplierId === "") {
                doc.supplierId = null;
            } else {
                if (!mongoose.Types.ObjectId.isValid(req.body.supplierId)) return next(createHttpError(400, "SUPPLIER_INVALID"));
                const s = await Supplier.findOne({ _id: req.body.supplierId, tenantId, clientId }).select("_id").lean();
                if (!s) return next(createHttpError(404, "SUPPLIER_NOT_FOUND"));
                doc.supplierId = req.body.supplierId;
            }
        }

        if (req.body?.paymentMethod != null) doc.paymentMethod = req.body.paymentMethod;
        if (req.body?.note != null) doc.note = cleanStr(req.body.note);
        if (req.body?.reference != null) doc.reference = cleanStr(req.body.reference);

        if (req.body?.payable != null) {
            const p = req.body.payable || {};
            if (p.isPayable != null) doc.payable.isPayable = Boolean(p.isPayable);
            if (p.dueDateYMD != null) doc.payable.dueDateYMD = cleanStr(p.dueDateYMD);
            if (p.status != null) doc.payable.status = p.status;
            if (p.paidAmount != null) doc.payable.paidAmount = coerceMoney(p.paidAmount) || 0;
            if (p.paidAt !== undefined) doc.payable.paidAt = p.paidAt || null;
        }

        const previous = await Expense.findOne({ _id: id, tenantId, clientId }).select("categoryId").lean();
        await withCategoryLock({ tenantId, clientId, id: doc.categoryId }, async (category, session) => {
            if (category.status === "inactive" && String(previous?.categoryId) !== String(category._id)) throw createHttpError(409, "CATEGORY_INACTIVE");
            await doc.save({ session });
        });
        return res.json({ success: true, data: doc });
    } catch (e) {
        next(e);
    }
};

exports.voidExpense = async (req, res, next) => {
    try {
        const { tenantId, clientId, userId } = getScope(req);
        const { id } = req.params;

        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!mongoose.Types.ObjectId.isValid(id)) return next(createHttpError(400, "INVALID_ID"));

        const doc = await Expense.findOne({ _id: id, tenantId, clientId });
        if (!doc) return next(createHttpError(404, "EXPENSE_NOT_FOUND"));

        if (doc?.source?.type === "payroll") {
            return next(createHttpError(409, "PAYROLL_EXPENSE_VOID_FROM_PAYROLL_MODULE"));
        }

        doc.status = "void";
        doc.voidedAt = new Date();
        doc.voidedBy = userId;
        await doc.save();

        return res.json({ success: true, data: doc });
    } catch (e) {
        next(e);
    }
};
