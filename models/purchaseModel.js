// models/purchaseModel.js
const mongoose = require("mongoose");

const purchaseItemSchema = new mongoose.Schema(
    {
        itemId: { type: mongoose.Schema.Types.ObjectId, ref: "Dish", required: true },
        qty: { type: Number, required: true },
        unitCost: { type: Number, required: true },
        lineTotal: { type: Number, required: true },

        // Si esta compra crea un lote de merma para aplicar política B
        createMermaBatch: { type: Boolean, default: false },
        mermaBatchId: { type: mongoose.Schema.Types.ObjectId, ref: "MermaBatch", default: null },

        note: { type: String, default: "", trim: true },
    },
    { _id: false }
);

const purchaseSchema = new mongoose.Schema(
    {
        tenantId: { type: String, required: true, index: true },
        clientId: { type: String, default: "default", index: true },

        supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", required: true, index: true },

        date: { type: Date, default: Date.now },
        invoiceNo: { type: String, default: "", trim: true },
        note: { type: String, default: "", trim: true },

        paymentType: { type: String, enum: ["CONTADO", "CREDITO"], default: "CONTADO" },
        dueDate: { type: Date, default: null },

        subtotal: { type: Number, default: 0 },
        total: { type: Number, default: 0 },

        paidAmount: { type: Number, default: 0 },
        balance: { type: Number, default: 0 },

        status: { type: String, enum: ["ABIERTA", "CERRADA", "ANULADA"], default: "ABIERTA", index: true },

        items: { type: [purchaseItemSchema], default: [] },

        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },
    { timestamps: true }
);

purchaseSchema.index({ tenantId: 1, clientId: 1, supplierId: 1, date: -1 });

module.exports = mongoose.model("Purchase", purchaseSchema);
