const mongoose = require("mongoose");

const inventoryMovementSchema = new mongoose.Schema(
    {
        tenantId: { type: String, required: true, index: true },

        // ✅ IMPORTANTE: para cierres/reporte por sucursal/cliente
        clientId: { type: String, default: "default", index: true },

        // ✅ En tu sistema el inventario realmente está ligado a Dish (platos/productos)
        itemId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Dish",
            required: true,
            index: true,
        },

        type: {
            type: String,
            enum: ["purchase", "adjustment", "waste", "sale", "conversion"],
            required: true,
            index: true,
        },

        // waste (merma) => positivo (qty perdida)
        // adjustment => puede ser +/-.
        qty: { type: Number, required: true },

        unitCost: { type: Number, default: null },

        // ✅ costo total del movimiento (para merma es clave)
        costAmount: { type: Number, default: null },

        // ✅ si es conversión crudo->cocido
        fromItemId: { type: mongoose.Schema.Types.ObjectId, ref: "Dish", default: null },
        toItemId: { type: mongoose.Schema.Types.ObjectId, ref: "Dish", default: null },
        toQty: { type: Number, default: null },

        note: { type: String, default: "", trim: true },

        beforeStock: { type: Number, required: true },
        afterStock: { type: Number, required: true },

        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },
    { timestamps: true }
);

inventoryMovementSchema.index({ tenantId: 1, clientId: 1, type: 1, createdAt: -1 });

module.exports = mongoose.model("InventoryMovement", inventoryMovementSchema);
