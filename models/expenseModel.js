const mongoose = require("mongoose");

const expenseSchema = new mongoose.Schema(
    {
        tenantId: { type: String, required: true, index: true },
        clientId: { type: String, required: true, index: true, default: "default" },

        dateYMD: { type: String, required: true, index: true }, // "YYYY-MM-DD"
        amount: { type: Number, required: true, min: 0 },

        categoryId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "ExpenseCategory",
            required: true,
            index: true,
        },

        // Opcional: enlazar gasto a proveedor (para cuentas por pagar simples)
        supplierId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Supplier",
            default: null,
            index: true,
        },

        paymentMethod: {
            type: String,
            enum: ["cash", "card", "transfer", "other"],
            default: "cash",
        },

        note: { type: String, default: "" },
        reference: { type: String, default: "" },

        // Cuentas por pagar (simple)
        payable: {
            isPayable: { type: Boolean, default: false },
            dueDateYMD: { type: String, default: "" },
            status: { type: String, enum: ["unpaid", "partial", "paid"], default: "unpaid" },
            paidAmount: { type: Number, default: 0, min: 0 },
            paidAt: { type: Date, default: null },
        },

        // Para evitar duplicar nómina si “posteas” 2 veces
        source: {
            type: {
                type: String, // "payroll"
                default: null,
                index: true,
            },
            refId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
        },

        status: { type: String, enum: ["posted", "void"], default: "posted", index: true },

        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        voidedAt: { type: Date, default: null },
        voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },
    { timestamps: true }
);

expenseSchema.index({ tenantId: 1, clientId: 1, dateYMD: 1 });
expenseSchema.index({ tenantId: 1, clientId: 1, supplierId: 1, dateYMD: 1 });

// Idempotencia: un PayrollRun solo crea 1 Expense
expenseSchema.index(
    { tenantId: 1, clientId: 1, "source.type": 1, "source.refId": 1 },
    { unique: true, partialFilterExpression: { "source.type": { $type: "string" } } }
);

module.exports = mongoose.model("Expense", expenseSchema);
