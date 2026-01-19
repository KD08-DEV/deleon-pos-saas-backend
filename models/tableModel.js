const mongoose = require("mongoose");

const tableSchema = new mongoose.Schema(
    {
        tableNo: { type: Number, required: true }, // ❌ sin unique global
        status: { type: String, default: "Disponible" },
        seats: { type: Number, required: true, min: 1 },
        currentOrder: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },

        // 🔐 multi-tenant
        tenantId: { type: String, required: true, index: true },
        clientId: { type: String, required: true, index: true, default: "default" },
    },
    { timestamps: true }
);

// Unicidad por empresa: cada tenant puede tener su propia Mesa 1, 2, …
tableSchema.index({ tenantId: 1, tableNo: 1, clientId: 1 }, { unique: true });

module.exports = mongoose.model("Table", tableSchema);
