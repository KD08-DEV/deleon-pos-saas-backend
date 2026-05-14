const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
    {
        amount: { type: Number, required: true, min: 0.01 },
        method: {
            type: String,
            enum: ["Efectivo", "Tarjeta", "Transferencia", "Otros"],
            required: true,
            default: "Efectivo",
        },
        registerId: { type: String, default: "MAIN", index: true },
        cashSessionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "CashSession",
            default: null,
            index: true,
        },
        paidAt: { type: Date, default: Date.now, index: true },
        receivedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
            index: true,
        },
        note: { type: String, default: "", trim: true },
    },
    { _id: true }
);

const accountReceivableSchema = new mongoose.Schema(
    {
        tenantId: { type: String, required: true, index: true },
        clientId: { type: String, required: true, index: true },

        customerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Customer",
            required: true,
            index: true,
        },

        orderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Order",
            required: true,
            index: true,
        },

        registerId: { type: String, default: "MAIN", index: true },

        invoiceNumber: { type: String, default: "", index: true },
        facturaNo: { type: String, default: "", index: true },

        customerSnapshot: {
            name: { type: String, default: "", trim: true },
            phone: { type: String, default: "", trim: true },
            address: { type: String, default: "", trim: true },
            rnc: { type: String, default: "", trim: true },
            rncCedula: { type: String, default: "", trim: true },
        },

        originalAmount: { type: Number, required: true, min: 0 },
        paidAmount: { type: Number, default: 0, min: 0 },
        balance: { type: Number, required: true, min: 0 },

        status: {
            type: String,
            enum: ["pending", "partial", "paid", "void"],
            default: "pending",
            index: true,
        },

        dueDate: { type: Date, default: null, index: true },

        payments: { type: [paymentSchema], default: [] },

        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },

        closedAt: { type: Date, default: null },
        voidedAt: { type: Date, default: null },
        voidedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },
        voidReason: { type: String, default: "", trim: true },
    },
    { timestamps: true }
);

accountReceivableSchema.index(
    { tenantId: 1, clientId: 1, orderId: 1 },
    { unique: true }
);

accountReceivableSchema.index({
    tenantId: 1,
    clientId: 1,
    status: 1,
    createdAt: -1,
});

accountReceivableSchema.index({
    tenantId: 1,
    clientId: 1,
    customerId: 1,
    status: 1,
});

module.exports = mongoose.model("AccountReceivable", accountReceivableSchema);