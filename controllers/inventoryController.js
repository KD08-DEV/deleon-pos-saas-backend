const createHttpError = require("http-errors");
const mongoose = require("mongoose");
// DEPRECATED: Ya no se usa InventoryItem, solo Dish
// const InventoryItem = require("../models/inventoryItemModel");
// const InventoryMovement = require("../models/inventoryMovementModel");
const Order = require("../models/orderModel");
const Dish = require("../models/dish");
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
        const tenantId = req.user?.tenantId;
        const clientId = req.clientId;

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

