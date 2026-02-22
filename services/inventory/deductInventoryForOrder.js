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
function shouldTrackStock(dish) {
    if (!dish) return false;
    if (dish.isInventoryItem === true) return true;

    // Compatibilidad con tu data actual: algunos inventariables no tienen isInventoryItem=true
    const hasInvCat = dish.inventoryCategoryId != null;
    const hasStock = Number.isFinite(Number(dish.stockCurrent));
    const hasMin = Number.isFinite(Number(dish.stockMin));

    return hasInvCat && hasStock && hasMin;
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
        $or: [
            { isInventoryItem: true },
            { $and: [
                    { inventoryCategoryId: { $ne: null } },
                    { stockCurrent: { $type: "number" } },
                    { stockMin: { $type: "number" } },
                ]
            },
        ],
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
        return { skipped: true, costAmount: 0, movement: null };
    }

    const beforeStock = num(dish.stockCurrent, 0);
    const afterStock = beforeStock - qty;

    if (!allowNegativeStock && afterStock < 0) {
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
    const allowNegativeStock = Boolean(opts.allowNegativeStock);
    const userId = opts.userId || null;

    if (!orderId || !mongoose.Types.ObjectId.isValid(String(orderId))) {
        throw createHttpError(400, "INVALID_ORDER_ID");
    }

    const session = await mongoose.startSession();

    try {
        let result = null;

        await session.withTransaction(async () => {
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
                    .select("_id recipe isInventoryItem inventoryCategoryId stockCurrent stockMin name")
                    .lean()
                    .session(session);

                if (!soldDish) continue;

                const soldAmount = getSoldAmount(line);
                if (soldAmount <= 0) continue;

                // Si tiene receta => descuenta ingredientes
                if (Array.isArray(soldDish.recipe) && soldDish.recipe.length > 0) {
                    for (const ing of soldDish.recipe) {
                        const ingId = ing?.ingredientDishId || ing?.dishId || ing?.inventoryItemId;
                        if (!ingId || !mongoose.Types.ObjectId.isValid(String(ingId))) continue;

                        const ingQty = num(ing?.qty, 0);
                        if (ingQty <= 0) continue;

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
                } else if (shouldTrackStock(soldDish)) {                    // Venta directa de inventario (sin receta)
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
                }else {
                dbg("route=non_inventory_skip", {
                    soldDishId: String(soldDish._id),
                    name: soldDish?.name,
                    isInventoryItem: soldDish?.isInventoryItem,
                    inventoryCategoryId: soldDish?.inventoryCategoryId ? String(soldDish.inventoryCategoryId) : null,
                });
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
        });


        return result;
    } catch (e) {
        // Fallback si no hay replica set
        const msg = String(e?.message || "");
        const noTxn =
            msg.includes("Transaction numbers are only allowed") ||
            msg.includes("replica set") ||
            msg.includes("not supported");

        if (!noTxn) throw e;

        const order = await Order.findOne({ _id: orderId });
        if (!order) throw createHttpError(404, "ORDER_NOT_FOUND");
        if (order.inventoryDeducted === true) return { skipped: true, orderId: String(orderId) };

        const tenantId = order.tenantId;
        const clientId = order.clientId || "default";

        let cogsTotal = 0;
        let movementsCreated = 0;

        for (const line of order.items || []) {
            const soldDishId = line?.dishId || line?.dish || null;
            if (!soldDishId || !mongoose.Types.ObjectId.isValid(String(soldDishId))) continue;

            const soldDish = await Dish.findOne({ _id: soldDishId, tenantId, clientId })
                .select("_id recipe isInventoryItem inventoryCategoryId")
                .lean();

            if (!soldDish) continue;

            const soldAmount = getSoldAmount(line);
            if (soldAmount <= 0) continue;

            const deductOne = async (ingId, qtyToDeduct) => {
                const dish = await Dish.findOne({
                    _id: ingId,
                    tenantId,
                    clientId,
                    isArchived: { $ne: true },
                    $or: [{ isInventoryItem: true }, { inventoryCategoryId: { $ne: null } }],
                });

                if (!dish) throw createHttpError(404, "INVENTORY_INGREDIENT_NOT_FOUND");

                const beforeStock = num(dish.stockCurrent, 0);
                const afterStock = beforeStock - qtyToDeduct;
                if (!allowNegativeStock && afterStock < 0) throw createHttpError(
                    409,
                    `INSUFFICIENT_STOCK: ${dish.name} (have ${beforeStock}, need ${qtyToDeduct})`
                );


                dish.stockCurrent = afterStock;
                await dish.save();

                const unitCost = pickCostUnit(dish);
                const costAmount = Number((qtyToDeduct * unitCost).toFixed(2));
                cogsTotal += costAmount;

                await InventoryMovement.create({
                    tenantId,
                    clientId,
                    itemId: ingId,
                    type: "sale",
                    qty: qtyToDeduct,
                    unitCost,
                    costAmount,
                    beforeStock,
                    afterStock,
                    note: `Auto sale by order ${String(orderId)}`,
                    createdBy: userId || null,
                    sourceType: "order",
                    sourceId: String(orderId),
                });

                movementsCreated += 1;
            };

            if (Array.isArray(soldDish.recipe) && soldDish.recipe.length > 0) {
                for (const ing of soldDish.recipe) {
                    const ingId = ing?.ingredientDishId || ing?.dishId || ing?.inventoryItemId;
                    if (!ingId || !mongoose.Types.ObjectId.isValid(String(ingId))) continue;

                    const ingQty = num(ing?.qty, 0);
                    if (ingQty <= 0) continue;

                    const qtyToDeduct = Number((ingQty * soldAmount).toFixed(6));
                    if (qtyToDeduct <= 0) continue;

                    await deductOne(ingId, qtyToDeduct);
                }
            } else if (soldDish.isInventoryItem === true || soldDish.inventoryCategoryId != null) {
                await deductOne(soldDish._id, Number(soldAmount.toFixed(6)));
            }
        }

        order.cogsTotal = Number((cogsTotal || 0).toFixed(2));
        order.inventoryDeducted = true;
        order.inventoryDeductedAt = new Date();
        await order.save();

        return {
            skipped: false,
            orderId: String(orderId),
            movementsCreated,
            cogsTotal: order.cogsTotal,
        };
    } finally {
        session.endSession();
    }
}

/**
 * ✅ Restore (cuando Cancelas)
 * Idempotente:
 * - si order.inventoryDeducted !== true => no hace nada
 */
async function restoreInventoryForOrder(orderId, opts = {}) {
    const userId = opts.userId || null;

    if (!orderId || !mongoose.Types.ObjectId.isValid(String(orderId))) {
        throw createHttpError(400, "INVALID_ORDER_ID");
    }

    const session = await mongoose.startSession();
    try {
        let result = null;

        await session.withTransaction(async () => {
            const order = await Order.findOne({ _id: orderId }).session(session);
            if (!order) throw createHttpError(404, "ORDER_NOT_FOUND");

            const tenantId = order.tenantId;
            const clientId = order.clientId || "default";
            if (!tenantId) throw createHttpError(500, "ORDER_MISSING_TENANT_SCOPE");

            if (order.inventoryDeducted !== true) {
                result = { skipped: true, orderId: String(orderId) };
                return;
            }

            const items = Array.isArray(order.items) ? order.items : [];
            let movementsCreated = 0;

            const addBackOne = async (ingId, qtyToAdd) => {
                const dish = await Dish.findOne({
                    _id: ingId,
                    tenantId,
                    clientId,
                    isArchived: { $ne: true },
                    $or: [
                        { isInventoryItem: true },
                        { inventoryCategoryId: { $ne: null } }, // <- permitir inventario por categoría
                    ],
                }).session(session);


                if (!dish) return;

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
                            note: `Auto restore by cancel order ${String(orderId)}`,
                            createdBy: userId || null,
                            sourceType: "order_cancel",
                            sourceId: String(orderId),
                        },
                    ],
                    { session }
                );

                movementsCreated += 1;
            };

            for (const line of items) {
                const soldDishId = line?.dishId || line?.dish || null;
                dbg("line", {
                    soldDishId: soldDishId ? String(soldDishId) : null,
                    quantity: line?.quantity,
                    weight: line?.weight,
                    lbs: line?.lbs,
                });
                if (!soldDishId || !mongoose.Types.ObjectId.isValid(String(soldDishId))) continue;

                const soldDish = await Dish.findOne({ _id: soldDishId, tenantId, clientId })
                    .select("_id recipe isInventoryItem inventoryCategoryId")
                    .lean()
                    .session(session);


                if (!soldDish) continue;

                const soldAmount = getSoldAmount(line);
                if (soldAmount <= 0) continue;

                if (Array.isArray(soldDish.recipe) && soldDish.recipe.length > 0) {
                    for (const ing of soldDish.recipe) {
                        const ingId = ing?.ingredientDishId || ing?.dishId || ing?.inventoryItemId;
                        if (!ingId || !mongoose.Types.ObjectId.isValid(String(ingId))) continue;

                        const ingQty = num(ing?.qty, 0);
                        if (ingQty <= 0) continue;

                        const qtyToAdd = Number((ingQty * soldAmount).toFixed(6));
                        if (qtyToAdd <= 0) continue;

                        await addBackOne(ingId, qtyToAdd);
                    }
                } else if (soldDish.isInventoryItem === true || soldDish.inventoryCategoryId != null) {
                    await addBackOne(soldDish._id, Number(soldAmount.toFixed(6)));
                }
            }

            order.inventoryDeducted = false;
            order.inventoryRestoredAt = new Date();
            await order.save({ session });

            result = { skipped: false, orderId: String(orderId), movementsCreated };

        });

        dbg("soldDish loaded", {
            soldDishId: String(soldDishId),
            found: Boolean(soldDish),
            recipeLen: soldDish?.recipe?.length || 0,
            isInventoryItem: soldDish?.isInventoryItem,
            inventoryCategoryId: soldDish?.inventoryCategoryId ? String(soldDish.inventoryCategoryId) : null,
        });
        return result;
    } catch (e) {
        // si no hay replica set, mejor que te falle explícito para que lo veas
        throw e;
    } finally {
        session.endSession();
    }
}

module.exports = { deductInventoryForOrder, restoreInventoryForOrder };
