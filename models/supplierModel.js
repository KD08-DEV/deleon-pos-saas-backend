const mongoose = require("mongoose");

const supplierSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        rnc: { type: String, default: "" },
        phone: { type: String, default: "" },
        email: { type: String, default: "" },
        address: { type: String, default: "" },
        contactPerson: { type: String, default: "" },
        notes: { type: String, default: "" },
        status: { type: String, enum: ["active", "inactive"], default: "active" },

        // 🔐 multi-tenant
        tenantId: { type: String, required: true, index: true },
        clientId: { type: String, required: true, index: true, default: "default" },
    },
    { timestamps: true }
);

supplierSchema.index({ tenantId: 1, clientId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("Supplier", supplierSchema);
