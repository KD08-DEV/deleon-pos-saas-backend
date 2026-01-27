const createHttpError = require("http-errors");
const mongoose = require("mongoose");
// DEPRECATED: Ya no se usa InventoryItem, solo Dish
// const InventoryItem = require("../models/inventoryItemModel");
// const InventoryMovement = require("../models/inventoryMovementModel");
const Order = require("../models/orderModel");
const Dish = require("../models/dish");
const InventoryMovement = require("../models/inventoryMovementModel");
const MermaBatch = require("../models/mermaBatchModel");

async function upsertWasteMovement({ batch, tenantId, clientId, userId }) {
    const qty = Number(batch.wasteQty || 0);
    const unitCost = Number(batch.unitCost || 0);
    const costAmount = Number(batch.costAmount || 0);

    // Si no hay merma, borra movimiento si existe
    const existing = await InventoryMovement.findOne({
        tenantId,
        clientId,
        mermaBatchId: batch._id,
        type: "waste",
    });

    if (qty <= 0) {
        if (existing) await existing.deleteOne();
        return;
    }

    if (existing) {
        existing.qty = qty;
        existing.unitCost = unitCost;
        existing.costAmount = costAmount;
        existing.note = batch.note || "";
        await existing.save();
        return;
    }

    await InventoryMovement.create({
        tenantId,
        clientId,
        itemId: batch.rawItemId,
        mermaBatchId: batch._id,
        type: "waste",
        qty,
        unitCost,
        costAmount,
        note: batch.note || "",
        createdBy: userId,
    });
}


function getTenantId(req) {
    return req.scope?.tenantId || req.user?.tenantId || req.headers["x-tenant-id"];
}

function num(v, def = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
}

// GET /api/inventory/items
// DEPRECATED: Usa /api/dishes en su lugar
exports.listItems = async (req, res, next) => {
    try {
        return res.json({ items: [] }); // Retorna vacío porque ya no se usa InventoryItem
        // DEPRECATED CODE:
        // const tenantId = getTenantId(req);
        // if (!tenantId) return next(createHttpError(400, "Missing tenantId"));
        // const q = (req.query.q || "").toString().trim();
        // const category = (req.query.category || "").toString().trim();
        // const includeArchived = (req.query.includeArchived || "false") === "true";
        // const filter = { tenantId };
        // if (!includeArchived) filter.isArchived = false;
        // if (q) filter.name = { $regex: q, $options: "i" };
        // if (category) filter.category = category;
        // const items = await InventoryItem.find(filter).sort({ createdAt: -1 }).lean();
        // res.json({ items });
    } catch (e) {
        next(e);
    }
};

// POST /api/inventory/items
// DEPRECATED: Usa /api/dishes en su lugar
exports.createItem = async (req, res, next) => {
    try {
        return next(createHttpError(410, "Este endpoint está deprecado. Usa /api/dishes en su lugar."));
        // DEPRECATED CODE:
        // const tenantId = getTenantId(req);
        // if (!tenantId) return next(createHttpError(400, "Missing tenantId"));
        // const { name, category, unit } = req.body || {};
        // if (!name || !name.toString().trim()) {
        //     return next(createHttpError(400, "name is required"));
        // }
        // const item = await InventoryItem.create({
        //     tenantId,
        //     name: name.toString().trim(),
        //     category: (category || "General").toString().trim(),
        //     unit: (unit || "unidad").toString().trim(),
        //     cost: num(req.body.cost, 0),
        //     stockCurrent: num(req.body.stockCurrent, 0),
        //     stockMin: num(req.body.stockMin, 0),
        //     createdBy: req.user?._id || null,
        // });
        // res.status(201).json({ item });
    } catch (e) {
        next(e);
    }
};

// PUT /api/inventory/items/:id
// DEPRECATED: Usa /api/dishes/:id en su lugar
exports.updateItem = async (req, res, next) => {
    try {
        return next(createHttpError(410, "Este endpoint está deprecado. Usa /api/dishes/:id en su lugar."));
        // DEPRECATED CODE REMOVED
    } catch (e) {
        next(e);
    }
};

// DELETE /api/inventory/items/:id  (soft delete)
// DEPRECATED: Usa /api/dishes/:id en su lugar
exports.archiveItem = async (req, res, next) => {
    try {
        return next(createHttpError(410, "Este endpoint está deprecado. Usa /api/dishes/:id en su lugar."));
        // DEPRECATED CODE REMOVED
    } catch (e) {
        next(e);
    }
};

// POST /api/inventory/movements
// DEPRECATED: Ya no se usa InventoryItem
exports.createMovement = async (req, res, next) => {
    try {
        return next(createHttpError(410, "Este endpoint está deprecado. Ya no se usa InventoryItem."));
        // DEPRECATED CODE REMOVED
    } catch (e) {
        next(e);
    }
};

// GET /api/inventory/movements?itemId=&type=&from=&to=&limit=&skip=
// DEPRECATED: Ya no se usa InventoryMovement
exports.listMovements = async (req, res, next) => {
    try {
        return res.json({ movements: [], limit: 0, skip: 0 });
        // DEPRECATED CODE REMOVED
    } catch (e) {
        next(e);
    }
};

// GET /api/inventory/low-stock
// DEPRECATED: Ya no se usa InventoryItem
exports.lowStock = async (req, res, next) => {
    try {
        return res.json({ items: [] });
        // DEPRECATED CODE REMOVED
    } catch (e) {
        next(e);
    }
};
// GET /api/inventory/consumption?from=&to=
// DEPRECATED: Ya no se usa InventoryMovement
exports.consumption = async (req, res, next) => {
    try {
        const tenantId = getTenantId(req);
        const clientId = req.scope?.clientId || req.clientId || "default";
        if (!tenantId) return next(createHttpError(401, "TENANT_NOT_FOUND"));


        const { from, to, inventoryCategoryId } = req.query;

        const match = {
            tenantId,
            clientId,
            orderStatus: "Completado",
        };

        if (from || to) {
            match.createdAt = {};
            if (from) match.createdAt.$gte = new Date(from);
            if (to) match.createdAt.$lt = new Date(to); // fin exclusivo recomendado
        }

        const dishCollection = Dish.collection.name; // normalmente "dishes"

        const pipeline = [
            { $match: match },
            { $unwind: "$items" },
            { $match: { "items.dishId": { $ne: null } } },
            {
                $group: {
                    _id: "$items.dishId",
                    qtySold: { $sum: { $ifNull: ["$items.quantity", 0] } },
                    revenue: { $sum: { $ifNull: ["$items.price", 0] } },
                    lines: { $sum: 1 },
                },
            },
            {
                $lookup: {
                    from: dishCollection,
                    localField: "_id",
                    foreignField: "_id",
                    as: "dish",
                },
            },
            { $unwind: { path: "$dish", preserveNullAndEmptyArrays: true } },
        ];

        // filtro opcional por categoria inventario
        if (inventoryCategoryId && mongoose.Types.ObjectId.isValid(inventoryCategoryId)) {
            pipeline.push({
                $match: { "dish.inventoryCategoryId": new mongoose.Types.ObjectId(inventoryCategoryId) },
            });
        }

        pipeline.push({
            $project: {
                dishId: "$_id",
                name: { $ifNull: ["$dish.name", "(Plato eliminado)"] },
                inventoryCategoryId: "$dish.inventoryCategoryId",
                qtySold: 1,
                revenue: 1,
                lines: 1,
            },
        });

        const rows = await Order.aggregate(pipeline);

        return res.json({ rows });
    } catch (e) {
        next(e);
    }
};
// POST /api/inventory/merma
// Registra MERMA como movimiento tipo "waste" (usa Dish como itemId)
exports.createMerma = async (req, res, next) => {
    try {
        const tenantId = req.user?.tenantId;
        const clientId = req.clientId || "default";
        if (!tenantId) return next(createHttpError(401, "TENANT_NOT_FOUND"));

        const { itemId, qty, unitCost, costAmount, note } = req.body || {};
        if (!itemId || !mongoose.Types.ObjectId.isValid(itemId)) {
            return next(createHttpError(400, "INVALID_ITEM_ID"));
        }

        const q = num(qty, 0);
        if (q <= 0) return next(createHttpError(400, "QTY_MUST_BE_GT_0"));

        // Asegurar que el Dish exista
        const dish = await Dish.findOne({ _id: itemId, tenantId, clientId }).lean();
        if (!dish) return next(createHttpError(404, "DISH_NOT_FOUND"));

        // Si tu Dish maneja stock, úsalo; si no, guarda before/after = 0
        const beforeStock = num(dish.stockCurrent, 0);
        const afterStock = beforeStock - q;

        const uCost = unitCost != null ? num(unitCost, null) : null;
        const cAmount =
            costAmount != null ? num(costAmount, 0) : (uCost != null ? (q * uCost) : 0);

        const movement = await InventoryMovement.create({
            tenantId,
            clientId,
            itemId,
            type: "waste", // ✅ merma
            qty: q,
            unitCost: uCost,
            costAmount: cAmount,
            note: String(note || "").trim(),
            beforeStock,
            afterStock,
            createdBy: req.user?._id || null,
        });

        // Opcional: actualizar stock del dish si lo manejas
        // await Dish.updateOne({ _id: itemId, tenantId, clientId }, { $set: { stockCurrent: afterStock } });

        return res.status(201).json({ success: true, movement });
    } catch (e) {
        next(e);
    }
};
// GET /api/inventory/merma/summary?dateYMD=YYYY-MM-DD
// o /api/inventory/merma/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
exports.getMermaSummary = async (req, res, next) => {
    try {
        const tenantId = req.user?.tenantId;
        const clientId = req.clientId || "default";
        const { dateYMD, from, to } = req.query;

        const match = { tenantId, clientId, type: "waste" };

        const toRange = (ymd, end) =>
            new Date(`${ymd}T${end ? "23:59:59.999" : "00:00:00.000"}`);

        if (dateYMD) {
            match.createdAt = { $gte: toRange(dateYMD, false), $lte: toRange(dateYMD, true) };
        } else if (from && to) {
            match.createdAt = { $gte: toRange(from, false), $lte: toRange(to, true) };
        }

        const agg = await InventoryMovement.aggregate([
            { $match: match },
            {
                $group: {
                    _id: null,
                    mermaQty: { $sum: "$qty" },
                    mermaCost: { $sum: { $ifNull: ["$costAmount", 0] } },
                },
            },
        ]);

        const mermaQty = Number(agg?.[0]?.mermaQty || 0);
        const mermaCost = Number(agg?.[0]?.mermaCost || 0);

        return res.json({ success: true, data: { mermaQty, mermaCost } });
    } catch (e) {
        next(e);
    }
};
// POST /api/inventory/merma/batches
// Crea lote OPEN (solo crudo)
exports.createMermaBatch = async (req, res, next) => {
    try {
        const tenantId = req.user?.tenantId;
        const clientId = req.clientId || "default";
        if (!tenantId) return next(createHttpError(401, "TENANT_NOT_FOUND"));

        const { rawItemId, rawQty, unitCost, costAmount, note } = req.body || {};

        if (!rawItemId || !mongoose.Types.ObjectId.isValid(rawItemId)) {
            return next(createHttpError(400, "INVALID_RAW_ITEM_ID"));
        }

        const q = num(rawQty, 0);
        if (q <= 0) return next(createHttpError(400, "RAW_QTY_MUST_BE_GT_0"));

        const dish = await Dish.findOne({ _id: rawItemId, tenantId, clientId }).lean();
        if (!dish) return next(createHttpError(404, "DISH_NOT_FOUND"));

        const uCost = unitCost != null ? num(unitCost, null) : null;
        const cAmount =
            costAmount != null ? num(costAmount, 0) : (uCost != null ? q * uCost : 0);

        const batch = await MermaBatch.create({
            tenantId,
            clientId,
            rawItemId,
            rawQty: q,
            unitCost: uCost,
            costAmount: cAmount,
            note: String(note || "").trim(),
            status: "open",
            createdBy: req.user?._id || null,
        });

        return res.status(201).json({ success: true, batch });
    } catch (e) {
        next(e);
    }
};

// GET /api/inventory/merma/batches?dateYMD=YYYY-MM-DD&status=open|closed
exports.listMermaBatches = async (req, res, next) => {
    try {
        const tenantId = getTenantId(req);
        const clientId = req.scope?.clientId || req.clientId || "default";
        if (!tenantId) return next(createHttpError(401, "TENANT_NOT_FOUND"));

        const { dateYMD, status } = req.query;

        const filter = { tenantId, clientId };
        if (status === "open" || status === "closed") filter.status = status;

        if (dateYMD) {
            const start = new Date(`${dateYMD}T00:00:00.000`);
            const end = new Date(`${dateYMD}T23:59:59.999`);
            filter.createdAt = { $gte: start, $lte: end };
        }

        const batches = await MermaBatch.find(filter)
            .sort({ createdAt: -1 })
            .lean();

        console.log("[listMermaBatches] scope:", req.scope);
        console.log("[listMermaBatches] user:", req.user);
        console.log("[listMermaBatches] query:", req.query);


        return res.json({ success: true, batches });
    } catch (e) {
        console.error("[listMermaBatches] ERROR:", e);
        next(e);

    }
};

// PATCH /api/inventory/merma/batches/:id/close
// Cierra lote: finalQty => calcula waste => crea InventoryMovement waste
exports.closeMermaBatch = async (req, res, next) => {
    try {
        const tenantId = req.user?.tenantId;
        const clientId = req.clientId || "default";
        if (!tenantId) return next(createHttpError(401, "TENANT_NOT_FOUND"));

        const { id } = req.params;
        if (!id || !mongoose.Types.ObjectId.isValid(id)) {
            return next(createHttpError(400, "INVALID_BATCH_ID"));
        }

        const { finalQty, note } = req.body || {};
        const fq = num(finalQty, 0);
        if (fq < 0) return next(createHttpError(400, "FINAL_QTY_INVALID"));

        const batch = await MermaBatch.findOne({ _id: id, tenantId, clientId });
        if (!batch) return next(createHttpError(404, "BATCH_NOT_FOUND"));
        if (batch.status === "closed") return next(createHttpError(409, "BATCH_ALREADY_CLOSED"));

        const wasteQty = Math.max(0, num(batch.rawQty, 0) - fq);

        // Crea movimiento de merma (waste) para que cierre/reporte lo tome
        if (wasteQty > 0) {
            await InventoryMovement.create({
                tenantId,
                clientId,
                itemId: batch.rawItemId,
                type: "waste",
                qty: wasteQty,
                unitCost: batch.unitCost,
                costAmount: batch.unitCost != null ? wasteQty * batch.unitCost : (batch.costAmount || 0),
                note: String(note || batch.note || "").trim(),
                beforeStock: 0,
                afterStock: 0,
                createdBy: req.user?._id || null,
            });
        }

        batch.finalQty = fq;
        batch.wasteQty = wasteQty;
        batch.status = "closed";
        batch.closedAt = new Date();
        batch.closedBy = req.user?._id || null;
        if (note != null) batch.note = String(note).trim();
        await batch.save();
        await upsertWasteMovement({ batch, tenantId, clientId, userId });


        return res.json({ success: true, batch });
    } catch (e) {
        next(e);
    }
};
exports.updateMermaBatch = async (req, res) => {
    try {
        const { tenantId, clientId, userId } = req;
        const { id } = req.params;

        const { rawQty, unitCost, note } = req.body;

        const batch = await MermaBatch.findOne({ _id: id, tenantId, clientId });
        if (!batch) {
            return res.status(404).json({ success: false, message: "Lote no encontrado." });
        }

        if (rawQty !== undefined) batch.rawQty = Number(rawQty);
        if (unitCost !== undefined) batch.unitCost = Number(unitCost);
        if (note !== undefined) batch.note = note;

        // Recalcular si ya estaba cerrado
        if (batch.status === "closed") {
            const raw = Number(batch.rawQty || 0);
            const fin = Number(batch.finalQty || 0);
            const waste = Math.max(raw - fin, 0);
            batch.wasteQty = waste;
            batch.costAmount = waste * Number(batch.unitCost || 0);
        }

        await batch.save();

        if (batch.status === "closed") {
            await upsertWasteMovement({ batch, tenantId, clientId, userId });
        }

        return res.json({ success: true, data: batch });
    } catch (err) {
        console.error("updateMermaBatch error:", err);
        return res.status(500).json({ success: false, message: "Error actualizando lote." });
    }
};




