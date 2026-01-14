const mongoose = require("mongoose");

const inventoryMovementSchema = new mongoose.Schema(
    {
        tenantId: { type: String, required: true, index: true },
        itemId: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryItem", required: true, index: true },

        type: {
            type: String,
            enum: ["purchase", "adjustment", "waste", "sale"],
            required: true,
            index: true,
        },

        qty: { type: Number, required: true }, // purchase/waste => positivo; adjustment => puede ser +/-.
        unitCost: { type: Number, default: null }, // útil para compras

        note: { type: String, default: "", trim: true },

        beforeStock: { type: Number, required: true },
        afterStock: { type: Number, required: true },

        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },
    { timestamps: true }
);

inventoryMovementSchema.index({ tenantId: 1, createdAt: -1 });

module.exports = mongoose.model("InventoryMovement", inventoryMovementSchema);
