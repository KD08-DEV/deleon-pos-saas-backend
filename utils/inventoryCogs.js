const Dish = require("../models/dish");
const InventoryMovement = require("../models/inventoryMovementModel");

/**
 * Aplica COGS + descuento de inventario cuando una Order pasa a "Completado".
 * - Solo corre una vez (order.inventoryDeducted)
 * - Usa dish.avgCost || dish.lastCost como costo unitario
 * - Crea movimientos type="sale" por cada item vendible (dishId)
 */
async function applyInventoryForCompletedOrder(order, { tenantId, clientId, userId }) {
    if (!order) return { ok: false, reason: "ORDER_NULL" };
    if (order.inventoryDeducted === true) return { ok: true, skipped: true };

    let totalCogs = 0;

    for (const it of (order.items || [])) {
        if (!it?.dishId) continue;

        const dish = await Dish.findOne({ _id: it.dishId, tenantId, clientId });
        if (!dish) continue;

        // Solo descontamos inventario si ese dish es inventariable
        if (dish.isInventoryItem !== true) continue;

        const qty = Number(it.quantity || 0);
        if (!Number.isFinite(qty) || qty <= 0) continue;

        const unitCost =
            dish.avgCost != null ? Number(dish.avgCost) :
                dish.lastCost != null ? Number(dish.lastCost) :
                    0;

        const costAmount = Number((qty * unitCost).toFixed(2));

        const beforeStock = Number(dish.stockCurrent || 0);
        const afterStock = beforeStock - qty;

        // Movimiento de venta (COGS)
        await InventoryMovement.create({
            tenantId,
            clientId,
            itemId: dish._id,
            type: "sale",
            qty,                 // qty positiva (tipo sale)
            unitCost,
            costAmount,
            note: `COGS Order ${String(order._id)}`,
            beforeStock,
            afterStock,
            createdBy: userId || null,
        });

        // Actualiza stock
        dish.stockCurrent = afterStock;
        await dish.save();

        totalCogs += costAmount;
    }

    order.inventoryDeducted = true;
    order.inventoryDeductedAt = new Date();
    order.cogsTotal = Number(totalCogs.toFixed(2));
    await order.save();

    return { ok: true, totalCogs: order.cogsTotal };
}
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

            const tenantId = order.tenantId || order?.scope?.tenantId;
            const clientId = order.clientId || "default";
            if (!tenantId) throw createHttpError(500, "ORDER_MISSING_TENANT_SCOPE");

            // idempotente: si no se descontó, no hay nada que restaurar
            if (order.inventoryDeducted !== true) {
                result = { skipped: true, orderId: String(orderId) };
                return;
            }

            const items = Array.isArray(order.items) ? order.items : [];
            let movementsCreated = 0;

            // helper para detectar cantidad vendida (peso o unidades)
            const getSoldAmountLocal = (orderItem) => {
                const w =
                    num(orderItem?.weight) ||
                    num(orderItem?.lbs) ||
                    num(orderItem?.lb) ||
                    num(orderItem?.weightLb) ||
                    0;
                if (w > 0) return w;
                return Math.max(num(orderItem?.quantity, 0), 0);
            };

            const addBackOne = async (ingId, qtyToAdd) => {
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


                if (!dish) return; // si no existe ya, no rompas la orden

                const beforeStock = num(dish.stockCurrent, 0);
                const afterStock = beforeStock + qtyToAdd;

                dish.stockCurrent = afterStock;
                await dish.save({ session });

                const unitCost = pickCostUnit(dish);
                const costAmount = Number((qtyToAdd * unitCost).toFixed(2));

                await InventoryMovement.create(
                    [
                        {
                            tenantId,
                            clientId,
                            itemId: ingId,
                            type: "adjust",
                            qty: Number(qtyToAdd),
                            qtySigned: Number(qtyToAdd), // entrada
                            unitCost,
                            costAmount: null, // adjust no tiene por qué afectar cogs
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
                if (!soldDishId || !mongoose.Types.ObjectId.isValid(String(soldDishId))) continue;

                const soldDish = await Dish.findOne({
                    _id: soldDishId,
                    tenantId,
                    clientId,
                })
                    .select("_id recipe isInventoryItem")
                    .lean()
                    .session(session);

                if (!soldDish) continue;

                const soldAmount = getSoldAmountLocal(line);
                if (soldAmount <= 0) continue;

                if (Array.isArray(soldDish.recipe) && soldDish.recipe.length > 0) {
                    for (const ing of soldDish.recipe) {
                        const ingId = ing?.ingredientDishId;
                        if (!ingId || !mongoose.Types.ObjectId.isValid(String(ingId))) continue;

                        const ingQty = num(ing?.qty, 0);
                        if (ingQty <= 0) continue;

                        const qtyToAdd = Number((ingQty * soldAmount).toFixed(6));
                        if (qtyToAdd <= 0) continue;

                        await addBackOne(ingId, qtyToAdd);
                    }
                } else if (soldDish.isInventoryItem === true) {
                    await addBackOne(soldDish._id, Number(soldAmount.toFixed(6)));
                }
            }

            // marca como restaurado para no duplicar
            order.inventoryDeducted = false;
            order.inventoryRestoredAt = new Date();
            await order.save({ session });

            result = { skipped: false, orderId: String(orderId), movementsCreated };
        });

        return result;
    } finally {
        session.endSession();
    }
}


module.exports = { deductInventoryForOrder, restoreInventoryForOrder };
