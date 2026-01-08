const mongoose = require("mongoose");

const itemSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },

        // Nuevo: precio unitario real (lo que usas en el frontend)
        unitPrice: { type: Number, required: true, min: 0 },

        quantity: { type: Number, required: true, min: 1 },

        // Total por ítem (unitPrice * quantity)
        price: { type: Number, required: true, min: 0 },

        // Deprecated: precio antiguo — ya NO se usa, pero lo dejamos NO requerido
        pricePerQuantity: { type: Number, required: false },
    },
    { _id: false }
);

const orderSchema = new mongoose.Schema(
    {
        // 🔐 multi-tenant
        tenantId: { type: String, required: true, index: true },
        clientId: { type: String, required: true, index: true },

        customerDetails: {
            name: { type: String, trim: true },
            phone: { type: String, default: "" },
            guests: { type: Number, default: 0, min: 0 },
        },
        orderStatus: {
            type: String,
            enum: ["In Progress", "Ready", "Completed", "Cancelled"], // ⟵ añadimos Cancelled
            default: "In Progress",
        },
        invoicePath: { type: String, default: "" },
        invoiceUrl: { type: String, default: "" },
        bills: {
            total: { type: Number, default: 0 },        // Subtotal
            discount: { type: Number, default: 0 },
            tip: { type: Number, default: 0 },// Monto de descuento
            tax: { type: Number, default: 0 },
            totalWithTax: { type: Number, default: 0 }, // Total final
        },
        // --- FACTURACIÓN FISCAL (NCF) ---
        fiscal: {
            requested: { type: Boolean, default: false },
            ncfType: { type: String, default: "B02" },     // B01, B02, etc.
            ncfNumber: { type: String, default: null },    // B0200000001
            issuedAt: { type: Date, default: null },
        },

// Opcional: duplicado top-level (útil para búsquedas rápidas)
        ncfNumber: { type: String, default: null },
        items: { type: [itemSchema], default: [] },
        table: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Table",
            required: false,
            default: null,
        },
        paymentMethod: { type: String, enum: ["Cash", "Tarjeta"], default: "Cash" },
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // quien creó la orden
    },
    { timestamps: true }
);

// Ordenar y consultar por tenant + fecha de creación
orderSchema.index({ tenantId: 1, clientId: 1,createdAt: -1 });

module.exports = mongoose.model("Order", orderSchema);

