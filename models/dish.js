const mongoose = require("mongoose");

const dishSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },

        // Para platos (menú). Para inventario lo dejaremos en 0 / "Inventario"
        price: { type: Number, required: true, min: 0 },
        category: { type: String, required: true, trim: true },

        productionArea: {
            type: String,
            enum: ["kitchen", "bar", "other"],
            default: "kitchen",
            index: true,
        },

        // Inventario
        inventoryCategoryId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "InventoryCategory",
            default: null,
            index: true,
        },

        // Compatibilidad con lógica vieja.
        // Se mantiene para no romper datos actuales.
        isInventoryItem: { type: Boolean, default: false, index: true },

        // Nueva clasificación clara de inventario:
        // none       = plato normal, no descuenta inventario
        // direct     = producto vendible con stock directo
        // ingredient = ingrediente/insumo para recetas
        // recipe     = plato que descuenta ingredientes
        inventoryType: {
            type: String,
            enum: ["none", "direct", "ingredient", "recipe"],
            default: "none",
            index: true,
        },

        // Solo aplica para productos que sí manejan stock:
        // direct e ingredient.
        // Esto permite que una venta/salida deje el stock en negativo.
        allowNegativeStock: {
            type: Boolean,
            default: true,
            index: true,
        },

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
        stockCurrent: { type: Number, default: null },
        stockMin: { type: Number, default: null },
        lastCost: { type: Number, default: null },
        avgCost: { type: Number, default: null },

        // Ventas por peso (menú)
        sellMode: { type: String, enum: ["unit", "weight"], default: "unit" },
        weightUnit: { type: String, enum: ["lb", "kg"], default: "lb" },
        pricePerLb: { type: Number, default: null },

        tenantId: { type: String, required: true, index: true },
        clientId: { type: String, required: true, index: true },

        allowCustomPrice: { type: Boolean, default: false, index: true },
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
    { tenantId: 1, clientId: 1, category: 1, name: 1, isInventoryItem: 1 },
    { unique: true }
);

module.exports = mongoose.model("dish", dishSchema);
