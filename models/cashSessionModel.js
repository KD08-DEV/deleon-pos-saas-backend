const mongoose = require("mongoose");

const cashMovementSchema = new mongoose.Schema(
    {
        type: { type: String, enum: ["OPEN", "ADD", "ADD_AFTER_CLOSE", "ADJUST", "CLOSE", "CLOSE_ADJUST"], required: true },
        amount: { type: Number, required: true },
        by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        at: { type: Date, default: Date.now },
        note: { type: String, default: "" },
    },
    { _id: false }
);
const denomSchema = new mongoose.Schema(
    {
        label: { type: String, required: true },
        value: { type: Number, required: true },
        count: { type: Number, required: true, min: 0 },

        // cash = billete/moneda normal
        // ticket = ticket/crédito físico contado como efectivo
        kind: {
            type: String,
            enum: ["cash", "ticket"],
            default: "cash",
        },
    },
    { _id: false }
);

const cashSessionSchema = new mongoose.Schema(
    {
        tenantId: { type: String, required: true, index: true },
        clientId: { type: String, required: true, index: true },

        dateYMD: { type: String, required: true, index: true }, // "YYYY-MM-DD"
        registerId: { type: String, default: "default", index: true },

        status: { type: String, enum: ["OPEN", "CLOSED"], default: "OPEN", index: true },

        openedAt: { type: Date, default: Date.now },
        openedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

        openingFloatInitial: { type: Number, default: 0, min: 0 },

        addedFloatTotal: { type: Number, default: 0, min: 0 },

        movements: { type: [cashMovementSchema], default: [] },

        closedAt: { type: Date, default: null },
        closedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

        notes: { type: String, default: "" },
        closing: {
            creditSales: { type: Number, default: 0 },
            ticketTotal: { type: Number, default: 0 },

            transferCountedTotal: { type: Number, default: 0 },
            otherCountedTotal: { type: Number, default: 0 },

            totalDeclaredAtClose: { type: Number, default: 0 },

            expectedTicketSales: { type: Number, default: 0 },
            expectedTransferSales: { type: Number, default: 0 },
            expectedOtherSales: { type: Number, default: 0 },

            transferDifference: { type: Number, default: 0 },
            otherDifference: { type: Number, default: 0 },

            receivablePaymentsCash: { type: Number, default: 0 },
            receivablePaymentsCard: { type: Number, default: 0 },
            receivablePaymentsTransfer: { type: Number, default: 0 },
            receivablePaymentsOther: { type: Number, default: 0 },
            receivablePaymentsTotal: { type: Number, default: 0 },
            breakdown: { type: [denomSchema], default: [] },
            countedTotal: { type: Number, default: 0 },
            expectedCashSales: { type: Number, default: 0 },
            expectedInRegister: { type: Number, default: 0 },
            difference: { type: Number, default: 0 },
            note: { type: String, default: "" },

            // NUEVO: auditoría de ajuste
            adjustedAt: { type: Date, default: null },
            adjustedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
            managerCodeHint: { type: String, default: "" },  // ej "***12"
            previousCountedTotal: { type: Number, default: null },
        },
    },

    { timestamps: true }
);

cashSessionSchema.index(
    { tenantId: 1, clientId: 1, dateYMD: 1, registerId: 1, openedBy: 1 },
    {
        unique: true,
        name: "uniq_cash_session_per_cashier_register_day",
    }
);

cashSessionSchema.index({
    tenantId: 1,
    clientId: 1,
    dateYMD: 1,
    registerId: 1,
    status: 1,
    openedBy: 1,
});

module.exports = mongoose.model("CashSession", cashSessionSchema);
