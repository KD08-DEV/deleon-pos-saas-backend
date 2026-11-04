// Control 4 — confirmación atómica de orden + inventario (MongoDB replica set/Atlas).
// No usa el fallback no transaccional; sin transacciones, NO se finaliza.
// Dependencias inyectadas para poder probar rechazo, reintentos y commit sin Mongo real.
async function persistOrderWithInventory({ mongoose, Order, orderScope, safeUpdate,
                                           mustSyncInventory, syncInventory }) {
    if (!mustSyncInventory) {
        const updated = await Order.findOneAndUpdate(orderScope, safeUpdate, { new: true });
        if (!updated) {
            const error = new Error("ORDER_NOT_FOUND");
            error.statusCode = 404;
            throw error;
        }
        return updated;
    }

    // En el mismo write transaction: estado/pago, stock, Kardex e idempotencia.
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            const updated = await Order.findOneAndUpdate(orderScope, safeUpdate, {
                new: true, session,
            });
            if (!updated) {
                const error = new Error("ORDER_NOT_FOUND");
                error.statusCode = 404;
                throw error;
            }
            await syncInventory({ session, orderId: updated._id });
        }, {
            readConcern: { level: "snapshot" },
            writeConcern: { w: "majority" },
        });
    } finally {
        await session.endSession();
    }
    // Leer fuera de la transacción, después del commit, para obtener inventarioDeducted
    // y cogsTotal actualizados por el servicio sin sobrescribirlos accidentalmente.
    // Lectura posterior al commit usando identidad estable.
    // Las condiciones mutables permanecen en el update original.
    if (!orderScope || !orderScope._id) {
        throw new Error("ORDER_SCOPE_MISSING_ID_AFTER_COMMIT");
    }
    const committedScope = { _id: orderScope._id };
    for (const key of ["tenantId", "clientId", "branchId", "scope.tenantId", "scope.clientId"]) {
        if (Object.prototype.hasOwnProperty.call(orderScope, key)) {
            committedScope[key] = orderScope[key];
        }
    }
    // Conservar el filtro de sucursal legacy si solo consulta clientId.
    if (Array.isArray(orderScope.$or) && orderScope.$or.every(part =>
        part && typeof part === "object" &&
        Object.keys(part).length === 1 &&
        Object.prototype.hasOwnProperty.call(part, "clientId")
    )) {
        committedScope.$or = orderScope.$or;
    }
    const result = await Order.findOne(committedScope);
    if (!result) {
        const error = new Error("ORDER_NOT_FOUND_AFTER_COMMIT");
        error.statusCode = 500;
        throw error;
    }
    return result;
}
module.exports = { persistOrderWithInventory };
