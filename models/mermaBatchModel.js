const mongoose = require("mongoose");

const mermaBatchSchema = new mongoose.Schema(
    {
        tenantId: { type: String, required: true, index: true },
        mermaBatchId: { type: mongoose.Schema.Types.ObjectId, ref: "MermaBatch" },

        clientId: { type: String, required: true, index: true },

        // Producto crudo (Dish)
        rawItemId: { type: mongoose.Schema.Types.ObjectId, ref: "Dish", required: true },

        // Cantidad cruda registrada al inicio
        rawQty: { type: Number, required: true },

        // Cantidad final (lo que quedó) al cerrar el lote
        finalQty: { type: Number, default: null },

        // Merma calculada al cerrar: rawQty - finalQty
        wasteQty: { type: Number, default: 0 },

        // Costos opcionales
        unitCost: { type: Number, default: null },
        costAmount: { type: Number, default: 0 },

        note: { type: String, default: "" },

        status: { type: String, enum: ["open", "closed"], default: "open", index: true },

        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        closedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        closedAt: { type: Date, default: null },
    },
    { timestamps: true }
);

module.exports = mongoose.model("MermaBatch", mermaBatchSchema);
