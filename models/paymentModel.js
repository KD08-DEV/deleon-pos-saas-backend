const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
    {
        paymentId: String,
        orderId: { type: String }, // Si más adelante lo manejas como ObjectId: { type: mongoose.Schema.Types.ObjectId, ref: "Order" }
        amount: Number,
        currency: String,
        status: String,
        method: String,
        email: String,
        contact: String,

        // 🔐 multi-tenant
        tenantId: { type: String, required: true, index: true },
        clientId: { type: String, required: true, index: true },
    },
    { timestamps: true } // createdAt/updatedAt
);

// Búsquedas por empresa y fecha
paymentSchema.index({ tenantId: 1, clientId: 1, createdAt: -1 });

module.exports = mongoose.model("Payment", paymentSchema);