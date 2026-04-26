const mongoose = require("mongoose");

const registerSchema = new mongoose.Schema(
    {
        tenantId: { type: String, required: true, index: true },
        clientId: { type: String, required: true, index: true },

        code: { type: String, required: true, trim: true },   // CAJA1
        name: { type: String, required: true, trim: true },   // Caja 1
        location: { type: String, default: "" },              // Salón, Barra
        isActive: { type: Boolean, default: true },
        sortOrder: { type: Number, default: 0 },
        defaultCashierUserId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null
        }
    },
    { timestamps: true }
);

// No repetir el mismo code dentro del mismo tenant/client
registerSchema.index({ tenantId: 1, clientId: 1, code: 1 }, { unique: true });

// Para listar ordenadas
registerSchema.index({ tenantId: 1, clientId: 1, isActive: 1, sortOrder: 1 });

module.exports = mongoose.model("Register", registerSchema);