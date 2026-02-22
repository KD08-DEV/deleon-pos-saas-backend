// controllers/purchaseController.js
const createHttpError = require("http-errors");
const mongoose = require("mongoose");
const Purchase = require("../models/purchaseModel");
const Supplier = require("../models/supplierModel");
const MermaBatch = require("../models/mermaBatchModel");
const SupplierPayment = require("../models/supplierPaymentModel");

const n = (v, def = 0) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : def;
};

exports.listPurchases = async (req, res, next) => {
    try {
        const tenantId = req.user?.tenantId;
        const clientId = req.headers["x-client-id"] || "default";
        const { supplierId, status, withBalance } = req.query;

        const filter = { tenantId, clientId };
        if (supplierId && mongoose.Types.ObjectId.isValid(supplierId)) filter.supplierId = supplierId;
        if (status) filter.status = status;
        if (withBalance === "true") filter.balance = { $gt: 0 };

        const rows = await Purchase.find(filter).sort({ date: -1 }).lean();
        return res.json({ success: true, data: rows });
    } catch (e) {
        next(e);
    }
};

exports.createPurchase = async (req, res, next) => {
    try {
        const tenantId = req.user?.tenantId;
        const clientId = req.headers["x-client-id"] || "default";
        if (!tenantId) return next(createHttpError(401, "TENANT_NOT_FOUND"));

        const { supplierId, items, invoiceNo, note, paymentType, dueDate, paidAmount } = req.body || {};
        if (!supplierId || !mongoose.Types.ObjectId.isValid(supplierId)) {
            return next(createHttpError(400, "INVALID_SUPPLIER_ID"));
        }

        const supplier = await Supplier.findOne({ _id: supplierId, tenantId, clientId }).lean();
        if (!supplier) return next(createHttpError(404, "SUPPLIER_NOT_FOUND"));

        const safeItems = Array.isArray(items) ? items : [];
        if (!safeItems.length) return next(createHttpError(400, "ITEMS_REQUIRED"));

        let subtotal = 0;
        const normItems = safeItems.map((it) => {
            const qty = n(it.qty, 0);
            const unitCost = n(it.unitCost, 0);
            if (!it.itemId || !mongoose.Types.ObjectId.isValid(it.itemId)) {
                throw createHttpError(400, "INVALID_ITEM_ID");
            }
            if (qty <= 0) throw createHttpError(400, "QTY_MUST_BE_GT_0");
            if (unitCost < 0) throw createHttpError(400, "UNITCOST_INVALID");

            const lineTotal = Number((qty * unitCost).toFixed(2));
            subtotal += lineTotal;

            return {
                itemId: it.itemId,
                qty,
                unitCost,
                lineTotal,
                createMermaBatch: !!it.createMermaBatch,
                note: String(it.note || "").trim(),
            };
        });

        const total = Number(subtotal.toFixed(2));
        const paid = Number(n(paidAmount, 0).toFixed(2));
        const balance = Number((total - paid).toFixed(2));

        const purchase = await Purchase.create({
            tenantId,
            clientId,
            supplierId,
            invoiceNo: String(invoiceNo || "").trim(),
            note: String(note || "").trim(),
            paymentType: paymentType === "CREDITO" ? "CREDITO" : "CONTADO",
            dueDate: dueDate ? new Date(dueDate) : null,
            subtotal: total,
            total,
            paidAmount: paid,
            balance,
            items: normItems,
            createdBy: req.user?._id || null,
        });

        // Crear lotes de merma (B) desde la compra (opcional por item)
        for (let i = 0; i < purchase.items.length; i++) {
            const it = purchase.items[i];
            if (!it.createMermaBatch) continue;

            const batch = await MermaBatch.create({
                tenantId,
                clientId,
                supplierId,
                purchaseId: purchase._id,
                rawItemId: it.itemId,
                rawQty: it.qty,
                unitCostOriginal: it.unitCost,
                totalCost: it.lineTotal,
                costPolicy: "EFFECTIVE_RECALC",
                status: "open",
                createdBy: req.user?._id || null,
                note: "",
            });

            purchase.items[i].mermaBatchId = batch._id;
        }
        await purchase.save();

        // Si pagó algo, registra el pago
        if (paid > 0) {
            await SupplierPayment.create({
                tenantId,
                clientId,
                supplierId,
                purchaseId: purchase._id,
                amount: paid,
                method: "EFECTIVO",
                reference: "",
                note: "Pago inicial",
                createdBy: req.user?._id || null,
            });
        }

        return res.status(201).json({ success: true, data: purchase });
    } catch (e) {
        next(e);
    }
};

exports.addPurchasePayment = async (req, res, next) => {
    try {
        const tenantId = req.user?.tenantId;
        const clientId = req.headers["x-client-id"] || "default";
        const { id } = req.params;

        if (!id || !mongoose.Types.ObjectId.isValid(id)) return next(createHttpError(400, "INVALID_PURCHASE_ID"));

        const { amount, method, reference, note } = req.body || {};
        const pay = Number(n(amount, 0).toFixed(2));
        if (pay <= 0) return next(createHttpError(400, "AMOUNT_MUST_BE_GT_0"));

        const purchase = await Purchase.findOne({ _id: id, tenantId, clientId });
        if (!purchase) return next(createHttpError(404, "PURCHASE_NOT_FOUND"));
        if (purchase.status === "ANULADA") return next(createHttpError(409, "PURCHASE_CANCELLED"));

        await SupplierPayment.create({
            tenantId,
            clientId,
            supplierId: purchase.supplierId,
            purchaseId: purchase._id,
            amount: pay,
            method: method || "EFECTIVO",
            reference: String(reference || "").trim(),
            note: String(note || "").trim(),
            createdBy: req.user?._id || null,
        });

        purchase.paidAmount = Number((n(purchase.paidAmount, 0) + pay).toFixed(2));
        purchase.balance = Number((n(purchase.total, 0) - purchase.paidAmount).toFixed(2));

        if (purchase.balance <= 0) {
            purchase.balance = 0;
            purchase.status = "CERRADA";
        }

        await purchase.save();

        return res.json({ success: true, data: purchase });
    } catch (e) {
        next(e);
    }
};
