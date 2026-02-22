const mongoose = require("mongoose");

const payrollItemSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        employeeName: { type: String, required: true, trim: true },
        roleName: { type: String, default: "" },

        gross: { type: Number, default: 0, min: 0 },
        deductions: { type: Number, default: 0, min: 0 },
        net: { type: Number, default: 0, min: 0 },

        note: { type: String, default: "" },
    },
    { _id: false }
);

const payrollRunSchema = new mongoose.Schema(
    {
        tenantId: { type: String, required: true, index: true },
        clientId: { type: String, required: true, index: true, default: "default" },

        periodFromYMD: { type: String, required: true, index: true },
        periodToYMD: { type: String, required: true, index: true },
        payDateYMD: { type: String, required: true, index: true },

        status: { type: String, enum: ["draft", "posted", "void"], default: "draft", index: true },

        totals: {
            gross: { type: Number, default: 0, min: 0 },
            deductions: { type: Number, default: 0, min: 0 },
            net: { type: Number, default: 0, min: 0 },
        },

        items: { type: [payrollItemSchema], default: [] },

        note: { type: String, default: "" },

        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        postedAt: { type: Date, default: null },
        postedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },
    { timestamps: true }
);

payrollRunSchema.index({ tenantId: 1, clientId: 1, payDateYMD: 1 });

module.exports = mongoose.model("PayrollRun", payrollRunSchema);
