const createHttpError = require("http-errors");
const mongoose = require("mongoose");
const InventoryItem = require("../models/inventoryItemModel");
const InventoryMovement = require("../models/inventoryMovementModel");

function getTenantId(req) {
    return req.scope?.tenantId || req.user?.tenantId || req.headers["x-tenant-id"];
}

function num(v, def = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
}

// GET /api/inventory/items
exports.listItems = async (req, res, next) => {
    try {
        const tenantId = getTenantId(req);
        if (!tenantId) return next(createHttpError(400, "Missing tenantId"));

        const q = (req.query.q || "").toString().trim();
        const category = (req.query.category || "").toString().trim();
        const includeArchived = (req.query.includeArchived || "false") === "true";

        const filter = { tenantId };
        if (!includeArchived) filter.isArchived = false;
        if (q) filter.name = { $regex: q, $options: "i" };
        if (category) filter.category = category;

        const items = await InventoryItem.find(filter).sort({ createdAt: -1 }).lean();
        res.json({ items });
    } catch (e) {
        next(e);
    }
};

// POST /api/inventory/items
exports.createItem = async (req, res, next) => {
    try {
        const tenantId = getTenantId(req);
        if (!tenantId) return next(createHttpError(400, "Missing tenantId"));

        const { name, category, unit } = req.body || {};
        if (!name || !name.toString().trim()) {
            return next(createHttpError(400, "name is required"));
        }

        const item = await InventoryItem.create({
            tenantId,
            name: name.toString().trim(),
            category: (category || "General").toString().trim(),
            unit: (unit || "unidad").toString().trim(),
            cost: num(req.body.cost, 0),
            stockCurrent: num(req.body.stockCurrent, 0),
            stockMin: num(req.body.stockMin, 0),
            createdBy: req.user?._id || null,
        });

        res.status(201).json({ item });
    } catch (e) {
        next(e);
    }
};

// PUT /api/inventory/items/:id
exports.updateItem = async (req, res, next) => {
    try {
        const tenantId = getTenantId(req);
        if (!tenantId) return next(createHttpError(400, "Missing tenantId"));

        const id = req.params.id;
        const patch = {};

        if (req.body.name !== undefined) patch.name = req.body.name.toString().trim();
        if (req.body.category !== undefined) patch.category = req.body.category.toString().trim();
        if (req.body.unit !== undefined) patch.unit = req.body.unit.toString().trim();
        if (req.body.cost !== undefined) patch.cost = num(req.body.cost, 0);
        if (req.body.stockMin !== undefined) patch.stockMin = num(req.body.stockMin, 0);

        // Por seguridad, stockCurrent se cambia por movimientos, no por update directo.
        // Si quieres permitirlo, mejor usa movement type "adjustment".

        const item = await InventoryItem.findOneAndUpdate(
            { _id: id, tenantId },
            { $set: patch },
            { new: true }
        );

        if (!item) return next(createHttpError(404, "Item not found"));
        res.json({ item });
    } catch (e) {
        next(e);
    }
};

// DELETE /api/inventory/items/:id  (soft delete)
exports.archiveItem = async (req, res, next) => {
    try {
        const tenantId = getTenantId(req);
        if (!tenantId) return next(createHttpError(400, "Missing tenantId"));

        const id = req.params.id;

        const item = await InventoryItem.findOneAndUpdate(
            { _id: id, tenantId },
            { $set: { isArchived: true } },
            { new: true }
        );

        if (!item) return next(createHttpError(404, "Item not found"));
        res.json({ item });
    } catch (e) {
        next(e);
    }
};

// POST /api/inventory/movements
exports.createMovement = async (req, res, next) => {
    const session = await mongoose.startSession();
    try {
        const tenantId = getTenantId(req);
        if (!tenantId) return next(createHttpError(400, "Missing tenantId"));

        const { itemId, type, note } = req.body || {};
        if (!itemId) return next(createHttpError(400, "itemId is required"));
        if (!["purchase", "adjustment", "waste"].includes(type)) {
            return next(createHttpError(400, "Invalid movement type"));
        }

        const rawQty = num(req.body.qty, NaN);
        if (!Number.isFinite(rawQty) || rawQty === 0) {
            return next(createHttpError(400, "qty must be a non-zero number"));
        }

        // Reglas:
        // - purchase/waste => qty positivo
        // - adjustment => qty puede ser +/- (ej: -2 por corrección)
        let delta = rawQty;
        if (type === "purchase") delta = Math.abs(rawQty);
        if (type === "waste") delta = -Math.abs(rawQty);

        const unitCost = req.body.unitCost === undefined ? null : num(req.body.unitCost, null);

        await session.withTransaction(async () => {
            const item = await InventoryItem.findOne({ _id: itemId, tenantId, isArchived: false }).session(session);
            if (!item) throw createHttpError(404, "Item not found");

            const beforeStock = num(item.stockCurrent, 0);
            const afterStock = beforeStock + delta;

            if (afterStock < 0) {
                throw createHttpError(400, "Insufficient stock for this movement");
            }

            item.stockCurrent = afterStock;
            // Opcional: si fue compra y mandas unitCost, puedes actualizar cost
            if (type === "purchase" && unitCost !== null && Number.isFinite(unitCost)) {
                item.cost = unitCost;
            }
            await item.save({ session });

            const movement = await InventoryMovement.create(
                [
                    {
                        tenantId,
                        itemId: item._id,
                        type,
                        qty: rawQty,
                        unitCost,
                        note: (note || "").toString(),
                        beforeStock,
                        afterStock,
                        createdBy: req.user?._id || null,
                    },
                ],
                { session }
            );

            res.status(201).json({ item, movement: movement[0] });
        });
    } catch (e) {
        next(e);
    } finally {
        session.endSession();
    }
};

// GET /api/inventory/movements?itemId=&type=&from=&to=&limit=&skip=
exports.listMovements = async (req, res, next) => {
    try {
        const tenantId = getTenantId(req);
        if (!tenantId) return next(createHttpError(400, "Missing tenantId"));

        const { itemId, type, from, to } = req.query;

        const filter = { tenantId };
        if (itemId) filter.itemId = itemId;
        if (type && ["purchase", "adjustment", "waste"].includes(type)) filter.type = type;

        if (from || to) {
            filter.createdAt = {};
            if (from) filter.createdAt.$gte = new Date(from);
            if (to) filter.createdAt.$lte = new Date(to);
        }

        const limit = Math.min(num(req.query.limit, 50), 200);
        const skip = Math.max(num(req.query.skip, 0), 0);

        const movements = await InventoryMovement.find(filter)
            .populate("itemId", "name category unit")
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        res.json({ movements, limit, skip });
    } catch (e) {
        next(e);
    }
};

// GET /api/inventory/low-stock
exports.lowStock = async (req, res, next) => {
    try {
        const tenantId = getTenantId(req);
        if (!tenantId) return next(createHttpError(400, "Missing tenantId"));

        const items = await InventoryItem.find({
            tenantId,
            isArchived: false,
            $expr: { $lte: ["$stockCurrent", "$stockMin"] },
        })
            .sort({ stockCurrent: 1 })
            .lean();

        res.json({ items });
    } catch (e) {
        next(e);
    }
};
