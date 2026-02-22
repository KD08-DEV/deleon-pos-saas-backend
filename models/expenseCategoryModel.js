const mongoose = require("mongoose");

const expenseCategorySchema = new mongoose.Schema(
    {
        tenantId: { type: String, required: true, index: true },
        clientId: { type: String, required: true, index: true, default: "default" },

        name: { type: String, required: true, trim: true },
        description: { type: String, default: "" },

        // Para categorías del sistema (ej. Nómina)
        systemKey: { type: String, default: null, index: true },

        status: { type: String, enum: ["active", "inactive"], default: "active" },
    },
    { timestamps: true }
);

// Unicidad por tenant+client+name
expenseCategorySchema.index({ tenantId: 1, clientId: 1, name: 1 }, { unique: true });

// Unicidad por tenant+client+systemKey (cuando exista)
expenseCategorySchema.index(
    { tenantId: 1, clientId: 1, systemKey: 1 },
    { unique: true, partialFilterExpression: { systemKey: { $type: "string" } } }
);

module.exports = mongoose.model("ExpenseCategory", expenseCategorySchema);
