const createHttpError = require("http-errors");
const mongoose = require("mongoose");

// const InventoryItem = require("../models/inventoryItemModel");
// const InventoryMovement = require("../models/inventoryMovementModel");
const Order = require("../models/orderModel");
const Dish = require("../models/dish");
const InventoryMovement = require("../models/inventoryMovementModel");
const MermaBatch = require("../models/mermaBatchModel");
const { hasPermission } = require("../middlewares/requirePermission");
function getCurrentRole(req) {
    return (
        req.authzMembership?.role ||
        req.scope?.membership?.role ||
        req.user?.role ||
        ""
    );
}

function isAdminLike(req) {
    return ["SuperAdmin", "Owner", "Admin"].includes(getCurrentRole(req));
}

async function upsertWasteMovement({ batch, tenantId, clientId, userId }) {
    const qty = Number(batch.wasteQty || 0);
    const unitCost = batch.unitCostOriginal != null ? Number(batch.unitCostOriginal) : null;
    const costAmount = Number(batch.wasteCostOriginal || 0);

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
        existing.beforeStock = existing.beforeStock ?? 0;
        existing.afterStock = existing.afterStock ?? 0;
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
        beforeStock: 0,
        afterStock: 0,
        createdBy: userId,
    });
}
function getScope(req) {
    const tenantId = req.scope?.tenantId || req.user?.tenantId || req.headers["x-tenant-id"];
    const clientId = req.scope?.clientId || req.clientId || "default";
    const userId = req.user?._id || null;
    return { tenantId, clientId, userId };
}

function isObjId(v) {
    return mongoose.Types.ObjectId.isValid(String(v || ""));
}

function weightedAvg(prevQty, prevUnitCost, addQty, addUnitCost) {
    const pQty = Number(prevQty || 0);
    const aQty = Number(addQty || 0);
    const pCost = Number(prevUnitCost || 0);
    const aCost = Number(addUnitCost || 0);
    const totalQty = pQty + aQty;
    if (totalQty <= 0) return aCost;
    return (pQty * pCost + aQty * aCost) / totalQty;
}


function getTenantId(req) {
    return req.scope?.tenantId || req.user?.tenantId || req.headers["x-tenant-id"];
}

function num(v, def = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
}
function getClientId(req) {
    return req.scope?.clientId || req.clientId || "default";
}

function isObjId(v) {
    return v && mongoose.Types.ObjectId.isValid(String(v));
}

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pickCostUnit(dish, fallback) {
    const a = dish?.avgCost;
    const l = dish?.lastCost;
    if (Number.isFinite(Number(a)) && Number(a) > 0) return Number(a);
    if (Number.isFinite(Number(l)) && Number(l) > 0) return Number(l);
    if (Number.isFinite(Number(fallback)) && Number(fallback) > 0) return Number(fallback);
    return 0;
}
const STOCK_INVENTORY_TYPES = ["direct", "ingredient"];

function normalizeInventoryType(dish = {}) {
    const t = String(dish?.inventoryType || "").trim();

    if (["none", "direct", "ingredient", "recipe"].includes(t)) {
        return t;
    }

    // Fallback para datos viejos
    if (Array.isArray(dish?.recipe) && dish.recipe.length > 0) {
        return "recipe";
    }

    if (dish?.isInventoryItem === true) {
        return "ingredient";
    }

    if (dish?.inventoryCategoryId) {
        return "direct";
    }

    return "none";
}

function isStockManagedItem(dish = {}) {
    return STOCK_INVENTORY_TYPES.includes(normalizeInventoryType(dish));
}

function stockManagedOrLegacyFilter() {
    return [
        // Nueva lógica: solo inventario real con stock.
        { inventoryType: { $in: STOCK_INVENTORY_TYPES } },

        // Compatibilidad segura con datos viejos.
        // Solo isInventoryItem=true debe contar como inventario legacy.
        { inventoryType: { $exists: false }, isInventoryItem: true },
    ];
}
function inventoryVisibleFilter() {
    return [
        // Inventario real
        ...stockManagedOrLegacyFilter(),

        // Platos normales nuevos o viejos que todavía NO manejan inventario,
        // pero pueden activarse automáticamente con una Entrada.
        {
            $and: [
                {
                    $or: [
                        { inventoryType: "none" },
                        { inventoryType: { $exists: false } },
                        { inventoryType: null },
                    ],
                },
                { isInventoryItem: { $ne: true } },
                { category: { $ne: "Inventario" } },
            ],
        },
    ];
}

/**
 * Aplica un delta a stockCurrent + crea movimiento (ATÓMICO si hay transacciones).
 * - qtyMagnitude: positiva
 * - delta: puede ser + o -
 */
async function applyStockMovement({
                                      tenantId,
                                      clientId,
                                      userId,
                                      itemId,
                                      type,
                                      qtyMagnitude,
                                      delta,
                                      unitCost,
                                      note,
                                      allowNegativeStock = false,
                                      sourceType = null,
                                      sourceId = null,
                                      session = null,
                                  }) {
    const dish = await Dish.findOne({
        _id: itemId,
        tenantId,
        clientId,
        isArchived: { $ne: true },
        $or: inventoryVisibleFilter(),
    }).session(session);

    if (!dish) throw createHttpError(404, "INVENTORY_ITEM_NOT_FOUND");

    const currentType = normalizeInventoryType(dish);

    const isInactiveMenuDish =
        currentType === "none" &&
        dish.isInventoryItem !== true &&
        String(dish.category || "").trim() !== "Inventario";

// Si es plato normal y recibe una Entrada, se convierte automáticamente en direct.
    if (isInactiveMenuDish) {
        if (type !== "purchase") {
            throw createHttpError(
                400,
                "Este plato todavía no maneja inventario. Primero debes registrar una Entrada."
            );
        }

        dish.inventoryType = "direct";
        dish.isInventoryItem = false;
        dish.stockCurrent = Number.isFinite(Number(dish.stockCurrent))
            ? Number(dish.stockCurrent)
            : 0;
        dish.stockMin = Number.isFinite(Number(dish.stockMin))
            ? Number(dish.stockMin)
            : 0;
        dish.allowNegativeStock = true;
    }

    const beforeStock = num(dish.stockCurrent, 0);
    const afterStock = beforeStock + Number(delta);

    const canGoNegative =
        isStockManagedItem(dish) &&
        dish.allowNegativeStock !== false;

    if (!canGoNegative && afterStock < 0) {
        throw createHttpError(
            409,
            `INSUFFICIENT_STOCK: ${dish.name} (have ${beforeStock}, need ${qtyMagnitude})`
        );
    }

    // costos: purchase actualiza lastCost y avgCost (promedio ponderado)
    let movementUnitCost = unitCost != null ? Number(unitCost) : null;
    if (movementUnitCost != null && !Number.isFinite(movementUnitCost)) movementUnitCost = null;

    if (type === "purchase") {
        if (movementUnitCost != null) {
            const prevQty = beforeStock;
            const prevAvg = pickCostUnit(dish, movementUnitCost);
            const inQty = Number(qtyMagnitude);

            const newAvg =
                prevQty + inQty > 0
                    ? (prevQty * prevAvg + inQty * movementUnitCost) / (prevQty + inQty)
                    : movementUnitCost;

            dish.lastCost = movementUnitCost;
            dish.avgCost = Number.isFinite(newAvg) ? Number(newAvg.toFixed(6)) : movementUnitCost;
        }
    }

    dish.stockCurrent = afterStock;
    await dish.save({ session });

    // costo del movimiento (sale/waste usa costo efectivo del dish si no mandas unitCost)
    const effectiveUnit = pickCostUnit(dish, movementUnitCost);
    const costAmount =
        ["sale", "waste"].includes(type) ? Number((Number(qtyMagnitude) * effectiveUnit).toFixed(2)) : null;

    const movement = await InventoryMovement.create(
        [
            {
                tenantId,
                clientId,
                itemId,
                type,
                qty: Number(qtyMagnitude),
                qtySigned: Number(delta),
                unitCost: ["purchase", "sale", "waste"].includes(type) ? effectiveUnit : movementUnitCost,
                costAmount,
                note: String(note || "").trim(),
                beforeStock,
                afterStock,
                createdBy: userId || null,
                sourceType,
                sourceId,
            },
        ],
        { session }
    );

    return { dish, movement: movement?.[0] };
}

async function runMaybeTransaction(fn) {
    const session = await mongoose.startSession();
    try {
        // si no hay replica set, esto puede fallar. Hacemos fallback.
        let out = null;
        try {
            await session.withTransaction(async () => {
                out = await fn(session);
            });
            return out;
        } catch (e) {
            const msg = String(e?.message || "");
            const noTxn =
                msg.includes("Transaction numbers are only allowed") ||
                msg.includes("replica set") ||
                msg.includes("not supported");
            if (!noTxn) throw e;
            // fallback sin tx
            return await fn(null);
        }
    } finally {
        session.endSession();
    }
}


// GET /api/inventory/items

// GET /api/inventory/items?q=&inventoryCategoryId=&supplierId=&includeArchived=
exports.listItems = async (req, res, next) => {
    try {
        const { tenantId, clientId } = getScope(req);
        if (!tenantId) return next(createHttpError(401, "TENANT_NOT_FOUND"));

        const q = String(req.query.q || "").trim();
        const includeArchived = String(req.query.includeArchived || "false") === "true";
        const inventoryCategoryId = req.query.inventoryCategoryId;
        const supplierId = req.query.supplierId;

        const filter = {
            tenantId,
            clientId,
            $or: inventoryVisibleFilter(),
        };

        if (!includeArchived) filter.isArchived = false;
        if (q) filter.name = { $regex: q, $options: "i" };
        if (inventoryCategoryId && isObjId(inventoryCategoryId)) {
            filter.inventoryCategoryId = new mongoose.Types.ObjectId(inventoryCategoryId);
        }
        if (supplierId && isObjId(supplierId)) {
            filter.supplierId = new mongoose.Types.ObjectId(supplierId);
        }

        const items = await Dish.find(filter)
            .select("_id name category inventoryType allowNegativeStock isInventoryItem unit stockCurrent stockMin lastCost avgCost inventoryCategoryId supplierId updatedAt isArchived")
            .populate({ path: "supplierId", select: "name companyName" })
            .sort({ updatedAt: -1 })
            .lean();

        return res.json({ items });
    } catch (e) {
        next(e);
    }
};

// POST /api/inventory/items
exports.createItem = async (req, res, next) => {
    try {
        const { tenantId, clientId } = getScope(req);

        const {
            existingDishId,
            name,
            unit,
            stockMin,
            lastCost,
            avgCost,
            inventoryCategoryId,
            supplierId,
            inventoryType,
            allowNegativeStock,
        } = req.body || {};

        // 1) Habilitar plato existente como inventario (sin duplicar)
        if (existingDishId) {
            if (!isObjId(existingDishId)) {
                return next(createHttpError(400, "existingDishId inválido"));
            }

            const dish = await Dish.findOne({
                _id: existingDishId,
                tenantId,
                clientId,
                isArchived: { $ne: true },
            });

            if (!dish) return next(createHttpError(404, "Dish base no encontrado"));

            // Si ya existe un inventario "fantasma" con el mismo nombre (viejo bug), bloquea para no chocar
            const conflict = await Dish.findOne({
                tenantId,
                clientId,
                isInventoryItem: true,
                name: dish.name,
                _id: { $ne: dish._id },
            }).lean();

            if (conflict) {
                return next(
                    createHttpError(
                        409,
                        "Ya existe un artículo de inventario con ese nombre. Debes fusionar/archivar el duplicado primero."
                    )
                );
            }

            const desiredType = String(inventoryType || "direct").trim();

            if (!["direct", "recipe"].includes(desiredType)) {
                return next(createHttpError(400, "INVALID_INVENTORY_TYPE_FOR_EXISTING_DISH"));
            }

// El plato existente puede convertirse en:
// direct = producto vendible con stock directo
// recipe = plato vendible que descuenta ingredientes
            dish.inventoryType = desiredType;
            dish.isInventoryItem = false;

// NO tocar dish.category ni dish.price para que siga apareciendo en el POS.
            if (unit !== undefined) dish.unit = String(unit);

            if (desiredType === "direct") {
                dish.allowNegativeStock =
                    allowNegativeStock === undefined ? true : Boolean(allowNegativeStock);

                if (!Number.isFinite(Number(dish.stockCurrent))) {
                    dish.stockCurrent = 0;
                }

                if (stockMin !== undefined) {
                    dish.stockMin = Number(stockMin || 0);
                } else if (!Number.isFinite(Number(dish.stockMin))) {
                    dish.stockMin = 0;
                }

                if (inventoryCategoryId !== undefined) {
                    if (!inventoryCategoryId) {
                        dish.inventoryCategoryId = null;
                    } else {
                        if (!isObjId(inventoryCategoryId)) {
                            return next(createHttpError(400, "inventoryCategoryId inválido"));
                        }

                        dish.inventoryCategoryId = inventoryCategoryId;
                    }
                }

                if (supplierId !== undefined) {
                    if (!supplierId) {
                        dish.supplierId = null;
                    } else {
                        if (!isObjId(supplierId)) {
                            return next(createHttpError(400, "supplierId inválido"));
                        }

                        dish.supplierId = supplierId;
                    }
                }

                if (lastCost !== undefined) {
                    dish.lastCost =
                        lastCost === null || lastCost === "" ? null : Number(lastCost);
                }

                if (avgCost !== undefined) {
                    dish.avgCost =
                        avgCost === null || avgCost === "" ? null : Number(avgCost);
                }
            }

            if (desiredType === "recipe") {
                // El plato con receta NO maneja stock directo.
                // Quienes reciben entrada/salida y pueden quedar negativos son los ingredientes.
                dish.allowNegativeStock = false;
                dish.stockCurrent = null;
                dish.stockMin = null;
                dish.inventoryCategoryId = null;
                dish.supplierId = null;
                dish.lastCost = null;
                dish.avgCost = null;
            }

            await dish.save();

            return res.status(200).json({ item: dish.toObject() });
        }

        // 2) Crear inventario nuevo (ingrediente/insumo)
        if (!name) return next(createHttpError(400, "Name required"));

        const newItem = await Dish.create({
            name,
            price: 0,
            category: "Inventario",
            inventoryType: "ingredient",
            isInventoryItem: true,
            allowNegativeStock:
                allowNegativeStock === undefined ? true : Boolean(allowNegativeStock),
            unit,
            stockCurrent: 0,
            stockMin: Number(stockMin || 0),
            lastCost,
            avgCost,
            tenantId,
            clientId,
            inventoryCategoryId: inventoryCategoryId || null,
            supplierId: supplierId || null,
        });

        return res.status(201).json({ item: newItem });
    } catch (err) {
        next(err);
    }
};


// PUT /api/inventory/items/:id
exports.updateItem = async (req, res, next) => {
    try {
        const { tenantId, clientId } = getScope(req);
        if (!tenantId) return next(createHttpError(401, "TENANT_NOT_FOUND"));

        const { id } = req.params;
        if (!isObjId(id)) return next(createHttpError(400, "INVALID_ITEM_ID"));

        if (req.body?.stockCurrent !== undefined) {
            return next(createHttpError(400, "STOCK_CANNOT_BE_EDITED_DIRECTLY_USE_ADJUST"));
        }

        const patch = {};
        if (req.body.name !== undefined) patch.name = String(req.body.name || "").trim();
        if (req.body.unit !== undefined) {
            patch.unit = ["unidad", "lb", "kg"].includes(String(req.body.unit)) ? String(req.body.unit) : "unidad";
        }
        if (req.body.stockMin !== undefined) patch.stockMin = Number(req.body.stockMin || 0);

        if (req.body.lastCost !== undefined) patch.lastCost = req.body.lastCost === null ? null : Number(req.body.lastCost);
        if (req.body.avgCost !== undefined) patch.avgCost = req.body.avgCost === null ? null : Number(req.body.avgCost);

        if (req.body.inventoryCategoryId !== undefined) {
            patch.inventoryCategoryId = req.body.inventoryCategoryId && isObjId(req.body.inventoryCategoryId)
                ? req.body.inventoryCategoryId
                : null;
        }

        if (req.body.supplierId !== undefined) {
            patch.supplierId = req.body.supplierId && isObjId(req.body.supplierId) ? req.body.supplierId : null;
        }
        if (req.body.allowNegativeStock !== undefined) {
            patch.allowNegativeStock = Boolean(req.body.allowNegativeStock);
        }

        if (req.body.inventoryType !== undefined) {
            const allowedTypes = ["direct", "ingredient"];

            if (!allowedTypes.includes(String(req.body.inventoryType))) {
                return next(createHttpError(400, "INVALID_INVENTORY_TYPE_FOR_STOCK_ITEM"));
            }

            patch.inventoryType = String(req.body.inventoryType);
            patch.isInventoryItem = String(req.body.inventoryType) === "ingredient";
        }

        const updated = await Dish.findOneAndUpdate(
            {
                _id: id,
                tenantId,
                clientId,
                $or: stockManagedOrLegacyFilter(),
            },

        { $set: patch },
            { new: true }
        ).lean();

        if (!updated) return next(createHttpError(404, "ITEM_NOT_FOUND"));
        return res.json({ item: updated });
    } catch (e) {
        next(e);
    }
};

// DELETE /api/inventory/items/:id  (soft delete)
exports.archiveItem = async (req, res, next) => {
    try {
        const { tenantId, clientId } = getScope(req);
        if (!tenantId) return next(createHttpError(401, "TENANT_NOT_FOUND"));

        const { id } = req.params;
        if (!isObjId(id)) return next(createHttpError(400, "INVALID_ITEM_ID"));

        const updated = await Dish.findOneAndUpdate(
            {
                _id: id,
                tenantId,
                clientId,
                $or: stockManagedOrLegacyFilter(),
            },
        { $set: { isArchived: true } },
            { new: true }
        ).lean();

        if (!updated) return next(createHttpError(404, "ITEM_NOT_FOUND"));
        return res.json({ success: true });
    } catch (e) {
        next(e);
    }
};
// GET /api/inventory/low-stock
exports.lowStock = async (req, res, next) => {
    try {
        const { tenantId, clientId } = getScope(req);
        if (!tenantId) return next(createHttpError(401, "TENANT_NOT_FOUND"));

        const items = await Dish.find({
            tenantId,
            clientId,
            $or: stockManagedOrLegacyFilter(),
            isArchived: false,
            $expr: { $lte: ["$stockCurrent", "$stockMin"] },
        })
            .select("_id name unit stockCurrent stockMin lastCost avgCost inventoryCategoryId supplierId updatedAt")
            .populate({ path: "supplierId", select: "name companyName" })
            .sort({ stockCurrent: 1 })
            .lean();

        return res.json({ items });
    } catch (e) {
        next(e);
    }
};
// POST /api/inventory/movements
exports.createMovement = async (req, res, next) => {
    try {
        const { tenantId, clientId, userId } = getScope(req);
        if (!tenantId) return next(createHttpError(401, "TENANT_NOT_FOUND"));

        const {
            type,
            itemId,
            qty,
            unitCost,
            direction,          // para adjust: "in" | "out"
            note,
            allowNegativeStock,
            sourceType,
            sourceId,
        } = req.body || {};

        const t = String(type || "").trim();
        if (!["purchase", "sale", "waste", "adjust", "transfer", "conversion"].includes(t)) {
            return next(createHttpError(400, "INVALID_TYPE"));
        }
        if (!isAdminLike(req)) {
            const canEntry = await hasPermission(req, "inventory.entry");
            const canExit = await hasPermission(req, "inventory.exit");
            const canAdjust = await hasPermission(req, "inventory.adjust");
            const canWaste = await hasPermission(req, "inventory.waste");

            if (t === "purchase" && !canEntry) {
                return next(createHttpError(403, "No tienes permiso para registrar entradas de inventario."));
            }

            if (t === "sale" && !canExit) {
                return next(createHttpError(403, "No tienes permiso para registrar salidas de inventario."));
            }

            if (t === "adjust" && !canAdjust) {
                return next(createHttpError(403, "No tienes permiso para realizar ajustes de inventario."));
            }

            if (t === "waste" && !canWaste) {
                return next(createHttpError(403, "No tienes permiso para registrar merma."));
            }

            if (["transfer", "conversion"].includes(t)) {
                return next(createHttpError(403, "No tienes permiso para realizar este movimiento de inventario."));
            }
        }
        if (!itemId || !isObjId(itemId)) return next(createHttpError(400, "INVALID_ITEM_ID"));

        const q = Number(qty || 0);
        if (!(q > 0)) return next(createHttpError(400, "QTY_MUST_BE_GT_0"));

        const allowNeg = Boolean(allowNegativeStock);

        const result = await runMaybeTransaction(async (session) => {
            let delta = 0;

            if (t === "purchase") delta = +q;
            else if (t === "sale" || t === "waste") delta = -q;
            else if (t === "adjust") {
                const dir = String(direction || "").toLowerCase();
                if (!["in", "out"].includes(dir)) throw createHttpError(400, "ADJUST_REQUIRES_DIRECTION");
                delta = dir === "in" ? +q : -q;
            } else {
                // transfer/conversion (por ahora simple)
                delta = 0;
            }

            const out = await applyStockMovement({
                tenantId,
                clientId,
                userId,
                itemId,
                type: t,
                qtyMagnitude: q,
                delta,
                unitCost,
                note,
                allowNegativeStock: allowNeg,
                sourceType: sourceType || null,
                sourceId: sourceId || null,
                session,
            });

            return out;
        });

        return res.status(201).json({ success: true, movement: result.movement, item: result.dish });
    } catch (e) {
        next(e);
    }
};


// GET /api/inventory/movements?itemId=&type=&from=&to=&limit=&skip=
// GET /api/inventory/movements?itemId=&type=&from=&to=&limit=&skip=
exports.listMovements = async (req, res, next) => {
    try {
        const { tenantId, clientId } = getScope(req);
        if (!tenantId) return next(createHttpError(401, "TENANT_NOT_FOUND"));

        const { itemId, type, from, to } = req.query;

        const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500);
        const skip = Math.max(Number(req.query.skip || 0), 0);

        const filter = { tenantId, clientId };

        if (itemId && isObjId(itemId)) {
            filter.itemId = itemId;
        }

        if (type) {
            filter.type = String(type);
        }

        if (from || to) {
            filter.createdAt = {};
            if (from) filter.createdAt.$gte = new Date(from);
            if (to) filter.createdAt.$lt = new Date(to);
        }

        const [total, movements] = await Promise.all([
            InventoryMovement.countDocuments(filter),
            InventoryMovement.find(filter)
                .populate({ path: "itemId", select: "name unit" })
                .populate({ path: "fromItemId", select: "name unit" })
                .populate({ path: "toItemId", select: "name unit" })
                .populate({ path: "createdBy", select: "name email role" })
                .sort({ createdAt: -1 })
                .limit(limit)
                .skip(skip)
                .lean(),
        ]);

        return res.json({
            success: true,
            movements,
            limit,
            skip,
            total,
        });
    } catch (e) {
        next(e);
    }
};
// GET /api/inventory/consumption?from=&to=

// GET /api/inventory/consumption?from=&to=&inventoryCategoryId=&page=&limit=
exports.consumption = async (req, res, next) => {
    try {
        const tenantId = getTenantId(req);
        const clientId = req.scope?.clientId || req.clientId || "default";

        if (!tenantId) return next(createHttpError(401, "TENANT_NOT_FOUND"));

        const { from, to, inventoryCategoryId } = req.query;

        const page = Math.max(Number(req.query.page || 1), 1);
        const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
        const skip = (page - 1) * limit;

        const match = {
            tenantId,
            clientId,
            orderStatus: "Completado",
        };

        if (from || to) {
            match.createdAt = {};
            if (from) match.createdAt.$gte = new Date(from);
            if (to) match.createdAt.$lt = new Date(to);
        }

        const dishCollection = Dish.collection.name;
        const InventoryCategory = require("../models/inventoryCategoryModel");
        const inventoryCategoryCollection = InventoryCategory.collection.name;

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
            {
                $lookup: {
                    from: inventoryCategoryCollection,
                    localField: "dish.inventoryCategoryId",
                    foreignField: "_id",
                    as: "inventoryCategory",
                },
            },
            { $unwind: { path: "$inventoryCategory", preserveNullAndEmptyArrays: true } },
        ];

        if (inventoryCategoryId && mongoose.Types.ObjectId.isValid(inventoryCategoryId)) {
            pipeline.push({
                $match: {
                    "dish.inventoryCategoryId": new mongoose.Types.ObjectId(inventoryCategoryId),
                },
            });
        }

        pipeline.push(
            {
                $project: {
                    dishId: "$_id",
                    name: { $ifNull: ["$dish.name", "(Plato eliminado)"] },
                    category: "$dish.category",
                    imageUrl: "$dish.imageUrl",
                    price: "$dish.price",

                    inventoryCategoryId: "$dish.inventoryCategoryId",
                    inventoryCategoryName: "$inventoryCategory.name",

                    qtySold: 1,
                    revenue: 1,
                    lines: 1,
                },
            },
            { $sort: { qtySold: -1, name: 1 } },
            {
                $facet: {
                    rows: [
                        { $skip: skip },
                        { $limit: limit },
                    ],
                    totalRows: [
                        { $count: "count" },
                    ],
                },
            }
        );

        const result = await Order.aggregate(pipeline);

        const rows = result?.[0]?.rows || [];
        const total = result?.[0]?.totalRows?.[0]?.count || 0;
        const totalPages = Math.max(Math.ceil(total / limit), 1);

        return res.json({
            success: true,
            rows,
            pagination: {
                page,
                limit,
                total,
                totalPages,
                hasPrev: page > 1,
                hasNext: page < totalPages,
            },
        });
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
// Crea lote OPEN (solo Entrada)
// POST /api/inventory/merma/batches
exports.createMermaBatch = async (req, res, next) => {
    try {
        const tenantId = req.user?.tenantId;
        const clientId = req.clientId || "default";
        if (!tenantId) return next(createHttpError(401, "TENANT_NOT_FOUND"));

        const { rawItemId, rawQty, unitCostOriginal, note, steps = [] } = req.body || {};

        if (!rawItemId || !mongoose.Types.ObjectId.isValid(rawItemId)) {
            return next(createHttpError(400, "INVALID_RAW_ITEM_ID"));
        }

        const q = num(rawQty, 0);
        if (q <= 0) return next(createHttpError(400, "RAW_QTY_MUST_BE_GT_0"));

        const dish = await Dish.findOne({ _id: rawItemId, tenantId, clientId }).lean();
        if (!dish) return next(createHttpError(404, "DISH_NOT_FOUND"));

        const uCost = unitCostOriginal != null ? num(unitCostOriginal, null) : null;
        const totalCost = uCost != null ? Number((q * uCost).toFixed(2)) : 0;

        const cleanedSteps = Array.isArray(steps)
            ? steps
                .map((s) => ({
                    label: String(s.label || "").trim(),
                    qtyAfter: Number(s.qtyAfter ?? s.qty ?? 0),
                }))
                .filter((s) => s.label && Number.isFinite(s.qtyAfter) && s.qtyAfter > 0)
            : [];

        const batch = await MermaBatch.create({
            tenantId,
            clientId,
            rawItemId,
            rawQty: q,
            unitCostOriginal: uCost,
            totalCost,
            note: String(note || "").trim(),
            steps: cleanedSteps, // ✅ nuevo
            status: "open",
            createdBy: req.user?._id || null,
        });

        return res.status(201).json({ success: true, batch });
    } catch (e) {
        next(e);
    }
};

async function upsertBatchInMovement({ batch, tenantId, clientId, userId }) {
    const qty = Number(batch.finalQty || 0);
    if (qty <= 0) return;

    const unitCost = batch.effectiveUnitCost != null ? Number(batch.effectiveUnitCost) : null;
    const costAmount = Number(batch.totalCost || 0);

    const dish = await Dish.findOne({ _id: batch.rawItemId, tenantId, clientId });
    const beforeStock = Number(dish?.stockCurrent || 0);
    const afterStock = beforeStock + qty;

    const existing = await InventoryMovement.findOne({
        tenantId,
        clientId,
        mermaBatchId: batch._id,
        type: "purchase", // entrada al inventario
    });

    if (existing) {
        existing.qty = qty;
        existing.unitCost = unitCost;
        existing.costAmount = costAmount;
        existing.note = batch.note || "";
        existing.beforeStock = beforeStock;
        existing.afterStock = afterStock;
        await existing.save();
    } else {
        await InventoryMovement.create({
            tenantId,
            clientId,
            itemId: batch.rawItemId,
            mermaBatchId: batch._id,
            type: "purchase",
            qty,
            unitCost,
            costAmount,
            note: batch.note || "",
            beforeStock,
            afterStock,
            createdBy: userId,
        });
    }

    // Actualiza stock + costos del dish (costo efectivo por rendimiento)
    if (dish) {
        const prevQty = beforeStock;
        const inQty = qty;

        // unitCost efectivo del batch
        const u = unitCost != null && Number.isFinite(Number(unitCost)) ? Number(unitCost) : null;

        if (u != null) {
            const prevAvg = pickCostUnit(dish, u);
            const newAvg = (prevQty + inQty) > 0
                ? ((prevQty * prevAvg) + (inQty * u)) / (prevQty + inQty)
                : u;

            dish.lastCost = u;
            dish.avgCost = Number.isFinite(newAvg) ? Number(newAvg.toFixed(6)) : u;
        }

        dish.stockCurrent = afterStock;
        await dish.save();
    }
}

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
            .populate({ path: "rawItemId", select: "name unit" })
            .sort({ createdAt: -1 })
            .lean();




        return res.json({ success: true, batches });
    } catch (e) {
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

        const { finalQty, note, steps } = req.body || {};
        const fq = num(finalQty, 0);
        if (fq < 0) return next(createHttpError(400, "FINAL_QTY_INVALID"));

        const batch = await MermaBatch.findOne({ _id: id, tenantId, clientId });
        if (!batch) return next(createHttpError(404, "BATCH_NOT_FOUND"));
        if (batch.status === "closed") return next(createHttpError(409, "BATCH_ALREADY_CLOSED"));

        const raw = Number(batch.rawQty || 0);
        const unitCostOriginal = batch.unitCostOriginal != null ? Number(batch.unitCostOriginal) : Number(batch.unitCost || 0);

        // totalCost debe existir; si vienes de tu código viejo usa batch.costAmount como fallback
        const totalCost = Number(batch.totalCost || batch.costAmount || (raw * unitCostOriginal) || 0);

        const wasteQty = Math.max(0, raw - fq);
        const wasteCostOriginal = wasteQty * unitCostOriginal;

        // POLÍTICA B:
        // costo efectivo = totalCost / usable(finalQty)
        const effectiveUnitCost = fq > 0 ? (totalCost / fq) : null;

        batch.finalQty = fq;
        batch.wasteQty = wasteQty;
        batch.totalCost = totalCost;
        batch.unitCostOriginal = unitCostOriginal;
        batch.wasteCostOriginal = Number(wasteCostOriginal.toFixed(2));
        batch.costPolicy = "EFFECTIVE_RECALC";
        batch.effectiveUnitCost = effectiveUnitCost != null ? Number(effectiveUnitCost.toFixed(6)) : null;

        batch.status = "closed";
        batch.closedAt = new Date();
        batch.closedBy = req.user?._id || null;
        if (note != null) batch.note = String(note).trim();
        if (Array.isArray(steps)) {
            const cleanedSteps = steps
                .map(s => ({
                    label: String(s.label || "").trim(),
                    qtyAfter: Number(s.qtyAfter ?? s.qty ?? 0)
                }))
                .filter(s => s.label && Number.isFinite(s.qtyAfter) && s.qtyAfter > 0);

            batch.steps = cleanedSteps;
        }

        await batch.save();

        // Mantén el movimiento "waste" para reportes (a costo original)
        await upsertWasteMovement({ batch, tenantId, clientId, userId: req.user?._id || null });

        // NUEVO: entrada al inventario con costo efectivo
        await upsertBatchInMovement({ batch, tenantId, clientId, userId: req.user?._id || null });

        return res.json({ success: true, batch });

    } catch (e) {
        next(e);
    }
};

exports.updateMermaBatch = async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const clientId = req.scope?.clientId || req.clientId || "default";
        const userId = req.user?._id || null;
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
        await upsertWasteMovement({ batch, tenantId, clientId, userId });
        await upsertBatchInMovement({ batch, tenantId, clientId, userId });

        await upsertBatchInMovement({ batch, tenantId, clientId, userId: req.user?._id || null });
        return res.json({ success: true, data: batch });
    } catch (err) {
        console.error("updateMermaBatch error:", err);
        return res.status(500).json({ success: false, message: "Error actualizando lote." });
    }
};
exports.unarchiveItem = async (req, res, next) => {
    try {
        const { tenantId, clientId } = getScope(req);
        if (!tenantId) return next(createHttpError(401, "TENANT_NOT_FOUND"));

        const { id } = req.params;
        if (!isObjId(id)) return next(createHttpError(400, "INVALID_ITEM_ID"));

        const updated = await Dish.findOneAndUpdate(
            {
                _id: id,
                tenantId,
                clientId,
                $or: stockManagedOrLegacyFilter(),
            },
            { $set: { isArchived: false } },
            { new: true }
        ).lean();

        if (!updated) return next(createHttpError(404, "ITEM_NOT_FOUND"));
        return res.json({ success: true, item: updated });
    } catch (e) {
        next(e);
    }
};
exports.processYield = async (req, res, next) => {
    const session = await mongoose.startSession();

    try {
        const tenantId = req.scope?.tenantId;
        const clientId = req.scope?.clientId || "default";
        const userId = req.scope?.userId || null;
        // 1) primero lee el body
        const {
            itemId,
            purchasedQty,
            totalCost,
            finalQty,
            steps = [],
            note = "",
            allowNegativeStock = false,
        } = req.body || {};

// 2) calcula stepsTxt y noteFinal con valores ya disponibles
        const stepsTxt = Array.isArray(steps) && steps.length
            ? ` | pasos: ${steps
                .map(s => `${String(s.label || "").trim()}:${Number(s.qtyAfter ?? s.qty ?? 0)}`)
                .join(", ")}`
            : "";

        const noteBase = String(note || "").trim();
        const noteFinal = `${noteBase || "Yield"} | comprado ${purchasedQty} | final ${finalQty}${stepsTxt}`;


        if (!tenantId) return res.status(401).json({ message: "No tenant scope." });
        if (!mongoose.Types.ObjectId.isValid(String(itemId))) {
            return res.status(400).json({ message: "itemId inválido" });
        }

        const bought = num(purchasedQty);
        const final = num(finalQty);
        const tCost = num(totalCost);

        if (bought <= 0 || final <= 0) {
            return res.status(400).json({ message: "purchasedQty y finalQty deben ser > 0" });
        }
        if (final > bought) {
            return res.status(400).json({ message: "finalQty no puede ser mayor que purchasedQty" });
        }
        if (tCost < 0) {
            return res.status(400).json({ message: "totalCost inválido" });
        }

        const wasteQty = Number((bought - final).toFixed(6));
        const purchaseUnitCost = bought > 0 ? Number((tCost / bought).toFixed(6)) : 0;
        const effectiveUnitCost = final > 0 ? Number((tCost / final).toFixed(6)) : 0;

        let out = null;

        await session.withTransaction(async () => {
            const dish = await Dish.findOne({
                _id: itemId,
                tenantId,
                clientId,
                isArchived: { $ne: true },
                $or: [
                    { isInventoryItem: true },
                    { inventoryCategoryId: { $ne: null } },
                ],
            }).session(session);

            if (!dish) {
                const err = new Error("INVENTORY_ITEM_NOT_FOUND");
                err.status = 404;
                throw err;
            }

            const beforeStock = num(dish.stockCurrent, 0);
            const afterStock = Number((beforeStock - wasteQty).toFixed(6));

            if (!allowNegativeStock && afterStock < 0) {
                const err = new Error("INSUFFICIENT_STOCK_FOR_YIELD");
                err.status = 409;
                throw err;
            }

            // 1) Reducir stock por la merma del proceso (waste)
            if (wasteQty > 0) {
                await InventoryMovement.create(
                    [{
                        tenantId,
                        clientId,
                        itemId: dish._id,
                        type: "waste",
                        qty: wasteQty,
                        qtySigned: -wasteQty,
                        unitCost: purchaseUnitCost || null,
                        costAmount: purchaseUnitCost ? Number((wasteQty * purchaseUnitCost).toFixed(2)) : null,
                        beforeStock,
                        afterStock,
                        note: noteFinal,
                        createdBy: userId,
                        sourceType: "yield",
                        sourceId: String(dish._id),
                    }],
                    { session }
                );
            }

            dish.stockCurrent = afterStock;

            // 2) Recalcular avgCost ponderado SIN “sumar stock” (porque ya lo registraste en compra)
            const avgBefore = num(dish.avgCost, 0);
            const stockBeforeLot = Number((beforeStock - bought).toFixed(6)); // stock que había antes de ese lote

            const denom = stockBeforeLot + final;
            const avgAfter =
                denom > 0
                    ? Number(((stockBeforeLot * avgBefore + tCost) / denom).toFixed(6))
                    : (effectiveUnitCost || avgBefore);

            dish.lastCost = effectiveUnitCost || dish.lastCost;
            dish.avgCost = avgAfter || dish.avgCost;

            // Opcional: guardar pasos/metadata si tienes dónde (si no, solo en note)
            await dish.save({ session });

            out = {
                itemId: String(dish._id),
                beforeStock,
                afterStock,
                wasteQty,
                purchaseUnitCost,
                effectiveUnitCost,
                avgCost: dish.avgCost,
                lastCost: dish.lastCost,
                steps,
            };
        });

        return res.json({ ok: true, data: out });
    } catch (e) {
        // fallback sin transacciones
        const msg = String(e?.message || "");
        const noTxn =
            msg.includes("Transaction numbers are only allowed") ||
            msg.includes("replica set") ||
            msg.includes("not supported");

        if (!noTxn) {
            const status = e.status || 500;
            return res.status(status).json({ message: e.message || "Error en yield" });
        }

        // retry sin session
        try {
            const tenantId = req.scope?.tenantId;
            const clientId = req.scope?.clientId || "default";
            const userId = req.scope?.userId || null;

            const {
                itemId,
                purchasedQty,
                totalCost,
                finalQty,
                steps = [],
                note = "",            // ✅ AGREGA ESTO
                allowNegativeStock = false,
            } = req.body || {};
            const bought = num(purchasedQty);
            const final = num(finalQty);
            const tCost = num(totalCost);
            const wasteQty = Number((bought - final).toFixed(6));
            const purchaseUnitCost = bought > 0 ? Number((tCost / bought).toFixed(6)) : 0;
            const effectiveUnitCost = final > 0 ? Number((tCost / final).toFixed(6)) : 0;

            const dish = await Dish.findOne({
                _id: itemId,
                tenantId,
                clientId,
                isArchived: { $ne: true },
                $or: [
                    { isInventoryItem: true },
                    { inventoryCategoryId: { $ne: null } },
                ],
            }).session(session);


            if (!dish) return res.status(404).json({ message: "INVENTORY_ITEM_NOT_FOUND" });

            const beforeStock = num(dish.stockCurrent, 0);
            const afterStock = Number((beforeStock - wasteQty).toFixed(6));
            if (!allowNegativeStock && afterStock < 0) return res.status(409).json({ message: "INSUFFICIENT_STOCK_FOR_YIELD" });

            if (wasteQty > 0) {
                await InventoryMovement.create({
                    tenantId,
                    clientId,
                    itemId: dish._id,
                    type: "waste",
                    qty: wasteQty,
                    qtySigned: -wasteQty,
                    unitCost: purchaseUnitCost || null,
                    costAmount: purchaseUnitCost ? Number((wasteQty * purchaseUnitCost).toFixed(2)) : null,
                    beforeStock,
                    afterStock,
                    note: noteFinal,
                    createdBy: userId,
                    sourceType: "yield",
                    sourceId: String(dish._id),
                });
            }

            const avgBefore = num(dish.avgCost, 0);
            const stockBeforeLot = Number((beforeStock - bought).toFixed(6));
            const denom = stockBeforeLot + final;
            const avgAfter =
                denom > 0
                    ? Number(((stockBeforeLot * avgBefore + tCost) / denom).toFixed(6))
                    : (effectiveUnitCost || avgBefore);

            dish.stockCurrent = afterStock;
            dish.lastCost = effectiveUnitCost || dish.lastCost;
            dish.avgCost = avgAfter || dish.avgCost;

            await dish.save();

            return res.json({
                ok: true,
                data: {
                    itemId: String(dish._id),
                    beforeStock,
                    afterStock,
                    wasteQty,
                    purchaseUnitCost,
                    effectiveUnitCost,
                    avgCost: dish.avgCost,
                    lastCost: dish.lastCost,
                },
            });
        } catch (e2) {
            return res.status(500).json({ message: e2?.message || "Error en yield (no-tx)" });
        }
    } finally {
        session.endSession();
    }
};




