const mongoose = require("mongoose");

// customerModel.js
const normalizePhone = (value) => {
    const digits = String(value || "").replace(/\D/g, "");
    if (!digits) return "";

    // RD: 809/829/849 con 10 dígitos => convertir a formato con 1 delante
    if (digits.length === 10 && /^(809|829|849)/.test(digits)) return `1${digits}`;

    // Si ya viene con 11 y empieza con 1, lo dejamos igual
    if (digits.length === 11 && digits.startsWith("1")) return digits;

    // fallback (otros países / formatos)
    return digits;
};


const customerSchema = new mongoose.Schema(
    {
        tenantId: { type: String, required: true, index: true },
        clientId: { type: String, required: true, index: true },

        name: { type: String, default: "Consumidor Final", trim: true },
        phone: { type: String, default: "", trim: true },

        // NUEVO: teléfono limpio (solo dígitos)
        phoneNormalized: { type: String, default: "", index: true },

        address: { type: String, default: "", trim: true },
        isActive: { type: Boolean, default: true },
    },
    { timestamps: true }
);

// Index básico
customerSchema.index({ tenantId: 1, clientId: 1, createdAt: -1 });

// Índice ÚNICO por tenant+client+phoneNormalized (solo si no está vacío)
customerSchema.index(
    { tenantId: 1, clientId: 1, phoneNormalized: 1 },
    {
        unique: true,
        partialFilterExpression: { phoneNormalized: { $type: "string", $ne: "" } },
    }
);

// Auto-set phoneNormalized antes de guardar
customerSchema.pre("save", function (next) {
    this.phoneNormalized = normalizePhone(this.phone);
    next();
});

module.exports = mongoose.model("Customer", customerSchema);
