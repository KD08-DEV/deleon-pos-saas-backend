const { authorizeInventoryReturn } = require("./returnAuthorization");
const { customizedRecipe } = require("./customizedRecipe");
// pos-backend/services/inventory/deductInventoryForOrder.js
const mongoose = require("mongoose");
const createHttpError = require("http-errors");

const Order = require("../../models/orderModel");
const Dish = require("../../models/dish");
const InventoryMovement = require("../../models/inventoryMovementModel");

function num(v, def = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
}
function pickCostUnit(dish) {
    const a = Number(dish?.avgCost);
    const l = Number(dish?.lastCost);
    if (Number.isFinite(a) && a > 0) return a;
    if (Number.isFinite(l) && l > 0) return l;
    return 0;
}
//helper para debuggear sin llenar la consola en producción
const DBG_INV = process.env.DEBUG_INV === "1";
function dbg(...args) {
    if (DBG_INV) console.log("[INV_DEDUCT]", ...args);
}
const STOCK_INVENTORY_TYPES = ["direct", "ingredient"];

function normalizeInventoryType(dish = {}) {
    const t = String(dish?.inventoryType || "").trim();

    if (["none", "direct", "ingredient", "recipe"].includes(t)) {
        return t;
    }

    // Compatibilidad con datos viejos
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

function hasRecipe(dish = {}) {
    return Array.isArray(dish?.recipe) && dish.recipe.length > 0;
}

function shouldUseRecipe(dish = {}) {
    return normalizeInventoryType(dish) === "recipe" || hasRecipe(dish);
}

function shouldTrackDirectStock(dish = {}) {
    return normalizeInventoryType(dish) === "direct";
}

function isStockManagedItem(dish = {}) {
    return STOCK_INVENTORY_TYPES.includes(normalizeInventoryType(dish));
}

function stockManagedOrLegacyFilter() {
    return [
        { inventoryType: { $in: STOCK_INVENTORY_TYPES } },
        { inventoryType: { $exists: false }, isInventoryItem: true },
        {
            inventoryType: { $exists: false },
            inventoryCategoryId: { $ne: null, $exists: true },
        },
    ];
}
// Detecta si la línea es por peso (lb) o por quantity
function getSoldAmount(orderItem) {
    const w =
        num(orderItem?.weight) ||
        num(orderItem?.lbs) ||
        num(orderItem?.lb) ||
        num(orderItem?.weightLb) ||
        0;
    if (w > 0) return w;
    return Math.max(num(orderItem?.quantity, 0), 0);
}

/**
 * Los extras referenciados consumen inventario propio de la sucursal.
 * Un extra sin extraDishId es solo un modificador comercial (no stock).
 * Las referencias deben existir en customization.extras del plato original.
 */
async function getExtraStockLines({ soldDish, line, soldAmount, tenantId, clientId, session = null }) {
    const selected = Array.isArray(line?.addons) ? line.addons : [];
    const allowed = Array.isArray(soldDish?.customization?.extras) ? soldDish.customization.extras : [];
    const output = [];
    for (const extra of selected) {
        const configured = extra.extraId ? allowed.find(e => String(e._id) === String(extra.extraId)) : null;
        const supplied = extra?.extraDishId?._id || extra?.extraDishId || null;
        if (configured && supplied && String(configured.extraDishId || '') !== String(supplied)) throw createHttpError(409, "EXTRA_NOT_DEFINED_FOR_DISH");
        const ref = configured?.extraDishId || supplied;
        if (configured?.active === false) throw createHttpError(409, "EXTRA_NOT_DEFINED_FOR_DISH");
        if (!ref) continue;
        if (!mongoose.Types.ObjectId.isValid(String(ref))) throw createHttpError(400, "INVALID_EXTRA_DISH_ID");
        const definition = allowed.find((e) =>
            e?.active !== false && e.extraDishId && String(e.extraDishId) === String(ref) &&
            (!extra.extraId || String(e._id) === String(extra.extraId))
        );
        if (!definition) throw createHttpError(409, "EXTRA_NOT_DEFINED_FOR_DISH");
        const perDish = Number(extra?.quantity ?? extra?.extraQuantity ?? 1);
        if (!Number.isInteger(perDish) || perDish < 1 || perDish > Number(definition.maxQuantity || 5)) {
            throw createHttpError(400, "INVALID_EXTRA_QUANTITY");
        }
        const amount = Number((perDish * soldAmount).toFixed(6));
        const query = Dish.findOne({ _id: ref, tenantId, clientId, isArchived: { $ne: true } })
            .select("_id recipe inventoryType allowNegativeStock isInventoryItem inventoryCategoryId name").lean();
        const extraDish = await (session ? query.session(session) : query);
        if (!extraDish) throw createHttpError(409, "EXTRA_DISH_NOT_FOUND_IN_BRANCH");
        if (shouldUseRecipe(extraDish)) {
            if (!Array.isArray(extraDish.recipe) || extraDish.recipe.length === 0) {
                throw createHttpError(409, "EXTRA_RECIPE_EMPTY");
            }
            for (const ing of extraDish.recipe || []) {
                const ingId = ing?.ingredientDishId || ing?.dishId || ing?.inventoryItemId;
                const qty = num(ing?.qty, 0);
                if (!ingId || !mongoose.Types.ObjectId.isValid(String(ingId)) || qty <= 0) {
                    throw createHttpError(409, "INVALID_EXTRA_RECIPE_INGREDIENT");
                }
                output.push({ itemId: ingId, qty: Number((amount * qty).toFixed(6)) });
            }
        } else if (isStockManagedItem(extraDish)) {
            output.push({ itemId: extraDish._id, qty: amount });
        }
    }
    return output.filter(({ qty }) => qty > 0);
}

async function applyDeduction({
                                  tenantId,
                                  clientId,
                                  userId,
                                  itemId,
                                  qty,
                                  allowNegativeStock,
                                  orderId,
                                  session,
                              }) {
    const dish = await Dish.findOne({
        _id: itemId,
        tenantId,
        clientId,
        isArchived: { $ne: true },
        $or: stockManagedOrLegacyFilter(),
    }).session(session);

    dbg("applyDeduction()", {
        itemId: String(itemId),
        qty,
        tenantId: String(tenantId),
        clientId: String(clientId),
        found: Boolean(dish),
        dishName: dish?.name,
        isInventoryItem: dish?.isInventoryItem,
        inventoryCategoryId: dish?.inventoryCategoryId ? String(dish.inventoryCategoryId) : null,
        stockCurrent: dish?.stockCurrent,
    });

    if (!dish) {
        throw createHttpError(409, "STOCK_ITEM_NOT_FOUND_IN_BRANCH");
    }

    const beforeStock = num(dish.stockCurrent, 0);
    const afterStock = beforeStock - qty;

    const canGoNegative =
        isStockManagedItem(dish) &&
        dish.allowNegativeStock !== false;

    if (!canGoNegative && afterStock < 0) {
        const itemName = dish?.name || String(itemId);
        const have = Number(beforeStock.toFixed(6));
        const need = Number(qty.toFixed(6));

        throw createHttpError(
            409,
            `INSUFFICIENT_STOCK: ${itemName} (have ${have}, need ${need})`
        );
    }


    dish.stockCurrent = afterStock;
    await dish.save({ session });

    const unitCost = pickCostUnit(dish);
    const costAmount = Number((qty * unitCost).toFixed(2));

    const mv = await InventoryMovement.create(
        [
            {
                tenantId,
                clientId,
                itemId,
                type: "sale",
                qty, // positiva
                qtySigned: -Math.abs(Number(qty)),
                unitCost,
                costAmount,
                beforeStock,
                afterStock,
                note: `Auto sale by order ${String(orderId)}`,
                createdBy: userId || null,
                sourceType: "order",
                sourceId: String(orderId),
            },
        ],
        { session }
    );

    return { costAmount, movement: mv?.[0] };
}

/**
 * Idempotente:
 * - si order.inventoryDeducted === true => no hace nada
 */
async function deductInventoryForOrder(orderId, opts = {}) {
// Por defecto permitimos negativo SOLO en productos que manejan stock.
// El control final se hace por item con allowNegativeStock.
    const allowNegativeStock = opts.allowNegativeStock !== false;
    const userId = opts.userId || null;
    const externalSession = opts.session || null;
    if (!orderId || !mongoose.Types.ObjectId.isValid(String(orderId))) {
        throw createHttpError(400, "INVALID_ORDER_ID");
    }

    const session = externalSession || await mongoose.startSession();

    try {
        let result = null;

        const performInventoryWork = async () => {
            const order = await Order.findOne({ _id: orderId }).session(session);
            if (!order) throw createHttpError(404, "ORDER_NOT_FOUND");

            const tenantId = order.tenantId || order?.scope?.tenantId;
            const clientId = order.clientId || "default";
            if (!tenantId) throw createHttpError(500, "ORDER_MISSING_TENANT_SCOPE");

            if (order.inventoryDeducted === true) {
                result = { skipped: true, orderId: String(orderId) };
                return;
            }

            const items = Array.isArray(order.items) ? order.items : [];
            let cogsTotal = 0;
            const movements = [];

            for (const line of items) {
                const soldDishId = line?.dishId || line?.dish || null;
                if (!soldDishId || !mongoose.Types.ObjectId.isValid(String(soldDishId))) continue;

                const soldDish = await Dish.findOne({ _id: soldDishId, tenantId, clientId })
                    .select("_id recipe customization inventoryType allowNegativeStock isInventoryItem inventoryCategoryId stockCurrent stockMin name avgCost lastCost")                    .lean()

                    .session(session);

                if (!soldDish) {
                    if (externalSession) throw createHttpError(409, "SOLD_DISH_NOT_FOUND_IN_BRANCH");
                    continue;
                }

                const soldAmount = getSoldAmount(line);
                if (soldAmount <= 0) continue;

                // Si tiene receta => descuenta ingredientes
                // Si es plato con receta => descuenta ingredientes.
// Si es producto direct => descuenta el mismo producto.
// Si es none => no descuenta nada.
                if (shouldUseRecipe(soldDish)) {
                    if (!Array.isArray(soldDish.recipe) || soldDish.recipe.length === 0) {
                        throw createHttpError(409, "RECIPE_EMPTY");
                    }
                    for (const ing of customizedRecipe(soldDish, line)) {
                        const ingId = ing?.ingredientDishId || ing?.dishId || ing?.inventoryItemId;
                        const ingQty = num(ing?.qty, 0);
                        if (!ingId || !mongoose.Types.ObjectId.isValid(String(ingId)) || ingQty <= 0) {
                            throw createHttpError(409, "INVALID_RECIPE_INGREDIENT");
                        }

                        const qtyToDeduct = Number((ingQty * soldAmount).toFixed(6));
                        if (qtyToDeduct <= 0) continue;

                        const out = await applyDeduction({
                            tenantId,
                            clientId,
                            userId,
                            itemId: ingId,
                            qty: qtyToDeduct,
                            allowNegativeStock,
                            orderId,
                            session,
                        });

                        cogsTotal += out.costAmount;
                        movements.push(out.movement);
                    }
                } else if (shouldTrackDirectStock(soldDish)) {
                    const qtyToDeduct = Number(soldAmount.toFixed(6));

                    const out = await applyDeduction({
                        tenantId,
                        clientId,
                        userId,
                        itemId: soldDish._id,
                        qty: qtyToDeduct,
                        allowNegativeStock,
                        orderId,
                        session,
                    });

                    cogsTotal += out.costAmount;
                    movements.push(out.movement);
                } else {
                    dbg("route=non_inventory_skip", {
                        soldDishId: String(soldDish._id),
                        name: soldDish?.name,
                        inventoryType: soldDish?.inventoryType,
                        isInventoryItem: soldDish?.isInventoryItem,
                        inventoryCategoryId: soldDish?.inventoryCategoryId ? String(soldDish.inventoryCategoryId) : null,
                    });
                }

                // Extras vinculados: el plato principal puede ser inventoryType=none.
                for (const extraLine of await getExtraStockLines({
                    soldDish, line, soldAmount, tenantId, clientId, session,
                })) {
                    const out = await applyDeduction({ tenantId, clientId, userId,
                        itemId: extraLine.itemId, qty: extraLine.qty, allowNegativeStock, orderId, session });
                    cogsTotal += out.costAmount;
                    movements.push(out.movement);
                }
            }

            const createdCount = movements.filter(Boolean).length;

            order.cogsTotal = Number((cogsTotal || 0).toFixed(2));

            if (createdCount > 0) {
                order.inventoryDeducted = true;
                order.inventoryDeductedAt = new Date();
            } else {
                // Si no se descontó nada, NO marques como descontado
                order.inventoryDeducted = false;
                order.inventoryDeductedAt = null;
            }

            await order.save({ session });

            result = {
                skipped: createdCount === 0,
                orderId: String(orderId),
                movementsCreated: createdCount,
                cogsTotal: order.cogsTotal,
            };
            dbg("result", result);
        };
        if (externalSession) await performInventoryWork();
        else await session.withTransaction(performInventoryWork);

        return result;
    } catch (e) {
        // Sin transacciones, rechazar la operacion sin escrituras alternativas.
        throw e;
    } finally {
        if (!externalSession) await session.endSession();
    }
}

/**
 * ✅ Restore (cuando Cancelas)
 * Idempotente:
 * - si order.inventoryDeducted !== true => no hace nada
 */
async function restoreInventoryForOrder(orderId, opts = {}) {
    const userId = opts.userId || null;
    const externalSession = opts.session || null;

    if (!orderId || !mongoose.Types.ObjectId.isValid(String(orderId))) {
        throw createHttpError(400, "INVALID_ORDER_ID");
    }

    const session = externalSession || await mongoose.startSession();
    try {
        let result = null;

        const performInventoryWork = async () => {
            const order = await Order.findOne({ _id: orderId }).session(session);
            if (!order) throw createHttpError(404, "ORDER_NOT_FOUND");

            const tenantId = order.tenantId;
            const clientId = order.clientId || "default";
            if (!tenantId) throw createHttpError(500, "ORDER_MISSING_TENANT_SCOPE");

            if (order.inventoryDeducted !== true) {
                result = { skipped: true, orderId: String(orderId) };
                return;
            }

            const approvedReturn = await authorizeInventoryReturn(order, opts.returnAuthorization, session);
            let movementsCreated = 0;

            const addBackOne = async (ingId, qtyToAdd) => {
                const dish = await Dish.findOne({
                    _id: ingId,
                    tenantId,
                    clientId,
                    isArchived: { $ne: true },
                    $or: stockManagedOrLegacyFilter(),
                }).session(session);

                if (!dish) {
                    throw createHttpError(409, "INVENTORY_RESTORE_ITEM_NOT_FOUND");
                }

                const beforeStock = num(dish.stockCurrent, 0);
                const afterStock = beforeStock + qtyToAdd;

                dish.stockCurrent = afterStock;
                await dish.save({ session });

                await InventoryMovement.create(
                    [
                        {
                            tenantId,
                            clientId,
                            itemId: ingId,
                            type: "adjust",
                            qty: Number(qtyToAdd),
                            qtySigned: Number(qtyToAdd),
                            unitCost: pickCostUnit(dish),
                            costAmount: null,
                            beforeStock,
                            afterStock,
                            note: `Restore by cancel order ${String(orderId)}${approvedReturn ? "; devolución física confirmada por administrador" : ""}`,
                            createdBy: userId || null,
                            sourceType: "order_cancel",
                            sourceId: String(orderId),
                        },
                    ],
                    { session }
                );

                movementsCreated += 1;
            };

            // Restaurar EXACTAMENTE lo descontado al cobrar, no recalcular recetas actuales.
            // Esto incluye extras inventariados y evita cambios de configuración posteriores.
            const soldMovements = await InventoryMovement.find({
                tenantId, clientId, sourceType: { $in: ["order", "order_correction"] }, sourceId: String(orderId),
                $or: [{ type: "sale" }, { sourceType: "order_correction", type: "adjust" }]
            }).select("itemId qty qtySigned type sourceType").lean().session(session);
            const quantities = new Map();
            for (const movement of soldMovements) {
                const itemId = String(movement.itemId);
                const signed = movement.qtySigned == null
                    ? (movement.type === "sale" ? -num(movement.qty, 0) : num(movement.qty, 0))
                    : num(movement.qtySigned, 0);
                quantities.set(itemId, (quantities.get(itemId) || 0) - signed);
            }
            for (const [itemId, qtyToAdd] of quantities) {
                if (qtyToAdd > 0) await addBackOne(itemId, qtyToAdd);
            }

            order.inventoryDeducted = false;
            order.inventoryRestoredAt = new Date();
            await order.save({ session });

            result = { skipped: false, orderId: String(orderId), movementsCreated };

        };
        if (externalSession) await performInventoryWork();
        else await session.withTransaction(performInventoryWork);
        return result;
    } catch (e) {
        // si no hay replica set, mejor que te falle explícito para que lo veas
        throw e;
    } finally {
        if (!externalSession) await session.endSession();
    }
}

module.exports = { deductInventoryForOrder, restoreInventoryForOrder, getExtraStockLines, shouldUseRecipe, shouldTrackDirectStock };
