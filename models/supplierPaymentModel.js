// models/supplierPaymentModel.js
const mongoose = require("mongoose");

const supplierPaymentSchema = new mongoose.Schema(
    {
        tenantId: { type: String, required: true, index: true },
        clientId: { type: String, default: "default", index: true },

        supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", required: true, index: true },
        purchaseId: { type: mongoose.Schema.Types.ObjectId, ref: "Purchase", required: true, index: true },

        amount: { type: Number, required: true },
        method: { type: String, enum: ["EFECTIVO", "TRANSFERENCIA", "TARJETA", "OTRO"], default: "EFECTIVO" },
        reference: { type: String, default: "", trim: true },
        note: { type: String, default: "", trim: true },

        date: { type: Date, default: Date.now },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },
    { timestamps: true }
);

supplierPaymentSchema.index({ tenantId: 1, clientId: 1, supplierId: 1, date: -1 });

module.exports = mongoose.model("SupplierPayment", supplierPaymentSchema);
