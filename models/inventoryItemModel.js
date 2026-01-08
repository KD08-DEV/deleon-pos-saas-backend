const mongoose = require("mongoose");

const inventoryItemSchema = new mongoose.Schema(
    {
        tenantId: { type: String, required: true, index: true },

        name: { type: String, required: true, trim: true },
        category: { type: String, default: "General", trim: true },
        unit: { type: String, default: "unidad", trim: true }, // unidad, lb, kg, etc.

        cost: { type: Number, default: 0, min: 0 },

        stockCurrent: { type: Number, default: 0 },
        stockMin: { type: Number, default: 0 },

        isArchived: { type: Boolean, default: false },

        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },
    { timestamps: true }
);

inventoryItemSchema.index({ tenantId: 1, name: 1 });

module.exports = mongoose.model("InventoryItem", inventoryItemSchema);
