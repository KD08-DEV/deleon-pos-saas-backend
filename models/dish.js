const mongoose = require("mongoose");

const dishSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        price: { type: Number, required: true, min: 0 },
        category: { type: String, required: true, trim: true },

        // Vinculo con Categoria de Inventario (para control de stock por plato)
        inventoryCategoryId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "InventoryCategory",
            default: null,
            index: true,
        },

        imageUrl: { type: String },

        // 🔐 multi-tenant
        tenantId: { type: String, required: true, index: true },
        clientId: { type: String, required: true, index: true },
        sellMode: {
            type: String,
            enum: ["unit", "weight"],
            default: "unit",
        },
        weightUnit: {
            type: String,
            enum: ["lb", "kg"],
            default: "lb",
        },
        pricePerLb: {
            type: Number,
            default: null, // solo aplica si sellMode === "weight"
        },

        recipe: [
            {
                inventoryItemId: {
                    type: require("mongoose").Schema.Types.ObjectId,
                    ref: "InventoryItem",
                    required: true,
                },
                qty: { type: Number, required: true, min: 0.0001 }, // por 1 unidad o por 1 lb (según sellMode)
                unit: { type: String, default: "unidad" }, // solo display
            },
        ],
    },
    { timestamps: true } // crea createdAt / updatedAt automáticos
);


dishSchema.index({ tenantId: 1,clientId: 1, name: 1, }, { unique: true });

module.exports = mongoose.model("dish", dishSchema);