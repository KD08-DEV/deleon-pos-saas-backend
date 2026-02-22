const mongoose = require("mongoose");

const dishSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },

        // Para platos (menú). Para inventario lo dejaremos en 0 / "Inventario"
        price: { type: Number, required: true, min: 0 },
        category: { type: String, required: true, trim: true },

        // Inventario
        inventoryCategoryId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "InventoryCategory",
            default: null,
            index: true,
        },
        isInventoryItem: { type: Boolean, default: false, index: true },

        // unidad del artículo
        unit: { type: String, enum: ["unidad", "lb", "kg"], default: "unidad" },

        // proveedor actual (opcional)
        supplierId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Supplier",
            default: null,
            index: true,
        },

        // soft delete
        isArchived: { type: Boolean, default: false, index: true },

        // Stock y costos
        stockCurrent: { type: Number, default: 0 },
        stockMin: { type: Number, default: 0 },
        lastCost: { type: Number, default: null },
        avgCost: { type: Number, default: null },

        // Ventas por peso (menú)
        sellMode: { type: String, enum: ["unit", "weight"], default: "unit" },
        weightUnit: { type: String, enum: ["lb", "kg"], default: "lb" },
        pricePerLb: { type: Number, default: null },

        tenantId: { type: String, required: true, index: true },
        clientId: { type: String, required: true, index: true },

        recipe: [
            {
                ingredientDishId: {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: "dish",
                    required: true,
                },
                qty: { type: Number, required: true, min: 0.0001 },
                unit: { type: String, default: "unidad" },
            },
        ],
    },
    { timestamps: true }
);

// permitir mismo name para plato vs inventario
dishSchema.index(
    { tenantId: 1, clientId: 1, name: 1, isInventoryItem: 1 },
    { unique: true }
);

module.exports = mongoose.model("dish", dishSchema);
