const mongoose = require("mongoose");

const cashMovementSchema = new mongoose.Schema(
    {
        type: { type: String, enum: ["OPEN", "ADD", "ADJUST", "CLOSE"], required: true },
        amount: { type: Number, required: true },
        by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        at: { type: Date, default: Date.now },
        note: { type: String, default: "" },
    },
    { _id: false }
);

const cashSessionSchema = new mongoose.Schema(
    {
        tenantId: { type: String, required: true, index: true },
        clientId: { type: String, required: true, index: true },

        // ✅ CLAVE PARA HISTÓRICO
        dateYMD: { type: String, required: true, index: true }, // "YYYY-MM-DD"
        registerId: { type: String, default: "default", index: true },

        status: { type: String, enum: ["OPEN", "CLOSED"], default: "OPEN", index: true },

        openedAt: { type: Date, default: Date.now },
        openedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

        // ✅ Menudo inicial (solo 1 vez)
        openingFloatInitial: { type: Number, default: 0, min: 0 },

        // ✅ Solo sumas (agregados)
        addedFloatTotal: { type: Number, default: 0, min: 0 },

        // ✅ Auditoría
        movements: { type: [cashMovementSchema], default: [] },

        closedAt: { type: Date, default: null },
        closedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

        notes: { type: String, default: "" },
    },
    { timestamps: true }
);

// ✅ Una sesión por tenant+client+date+register
cashSessionSchema.index(
    { tenantId: 1, clientId: 1, dateYMD: 1, registerId: 1 },
    { unique: true }
);

module.exports = mongoose.model("CashSession", cashSessionSchema);
