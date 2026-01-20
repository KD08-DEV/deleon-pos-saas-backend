const mongoose = require("mongoose");

const cashSessionSchema = new mongoose.Schema(
    {
        tenantId: { type: String, required: true, index: true },
        clientId: { type: String, required: true, index: true },

        status: { type: String, enum: ["OPEN", "CLOSED"], default: "OPEN", index: true },

        openedAt: { type: Date, default: Date.now },
        openedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

        // ✅ Fondo inicial (menudo)
        openingFloat: { type: Number, default: 0, min: 0 },

        closedAt: { type: Date, default: null },
        closedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

        notes: { type: String, default: "" },
    },
    { timestamps: true }
);

// ✅ Solo 1 caja abierta por tenant+client
cashSessionSchema.index(
    { tenantId: 1, clientId: 1, status: 1 },
    { unique: true, partialFilterExpression: { status: "OPEN" } }
);

module.exports = mongoose.model("CashSession", cashSessionSchema);
