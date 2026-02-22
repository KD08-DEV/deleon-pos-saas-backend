const mongoose = require("mongoose");

const inventoryMovementSchema = new mongoose.Schema(
    {
        tenantId: { type: String, required: true, index: true },
        clientId: { type: String, default: "default", index: true },

        itemId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "dish",
            required: true,
            index: true,
        },

        mermaBatchId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "MermaBatch",
            default: null,
            index: true,
        },

        type: {
            type: String,
            enum: ["purchase", "sale", "waste", "adjust", "transfer", "conversion"],
            required: true,
            index: true,
        },

        qty: { type: Number, required: true },      // siempre positiva
        qtySigned: { type: Number, default: null }, // + / -

        unitCost: { type: Number, default: null },
        costAmount: { type: Number, default: null },

        fromItemId: { type: mongoose.Schema.Types.ObjectId, ref: "dish", default: null },
        toItemId: { type: mongoose.Schema.Types.ObjectId, ref: "dish", default: null },
        toQty: { type: Number, default: null },

        // NUEVO: trazabilidad (orden, compra, etc.)
        sourceType: { type: String, default: null, index: true }, // "order" | "manual" | ...
        sourceId: { type: String, default: null, index: true },

        note: { type: String, default: "", trim: true },

        beforeStock: { type: Number, default: 0 },
        afterStock: { type: Number, default: 0 },

        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },
    { timestamps: true }
);

inventoryMovementSchema.index({ tenantId: 1, clientId: 1, type: 1, createdAt: -1 });
inventoryMovementSchema.index({ tenantId: 1, clientId: 1, itemId: 1, createdAt: -1 });

module.exports = mongoose.model("InventoryMovement", inventoryMovementSchema);
