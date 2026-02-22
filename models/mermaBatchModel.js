const mongoose = require("mongoose");

const mermaBatchSchema = new mongoose.Schema(
    {
        tenantId: { type: String, required: true, index: true },
        clientId: { type: String, default: "default", index: true },

        supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", default: null, index: true },
        purchaseId: { type: mongoose.Schema.Types.ObjectId, ref: "Purchase", default: null, index: true },

        rawItemId: { type: mongoose.Schema.Types.ObjectId, ref: "dish", required: true, index: true },

        steps: [
            { label: { type: String, default: "", trim: true }, qtyAfter: { type: Number, required: true } },
        ],

        rawQty: { type: Number, required: true },
        unitCostOriginal: { type: Number, default: null },
        totalCost: { type: Number, default: 0 },

        status: { type: String, enum: ["open", "closed"], default: "open", index: true },

        finalQty: { type: Number, default: null },
        wasteQty: { type: Number, default: 0 },

        costPolicy: { type: String, enum: ["NONE", "EFFECTIVE_RECALC"], default: "EFFECTIVE_RECALC" },

        effectiveUnitCost: { type: Number, default: null },
        wasteCostOriginal: { type: Number, default: 0 },

        note: { type: String, default: "", trim: true },

        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        closedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        closedAt: { type: Date, default: null },
    },
    { timestamps: true }
);

mermaBatchSchema.index({ tenantId: 1, clientId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("MermaBatch", mermaBatchSchema);
