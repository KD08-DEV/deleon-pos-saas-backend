const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid"); // si ya usas uuid en otro lado, reutilízalo

const tenantSchema = new mongoose.Schema(
    {
        // ID legible para relacionar usuarios, membresías, facturas, etc.
        tenantId: {
            type: String,
            required: true,
            unique: true,
            default: uuidv4,      // genera algo tipo "0473b4ad-f298-4500-a2e7-81ec0303f9c9"
        },

        name: { type: String, required: true, trim: true },

        status: {
            type: String,
            enum: ["active", "suspended"],
            default: "active",
        },

        plan: {
            type: String,
            enum: ["emprendedor", "pro", "vip"],
            default: "emprendedor",
        },

        business: {
            name: { type: String, required: false, default: null },
            rnc: { type: String, default: null },
            address: { type: String, default: null },
            phone: { type: String, default: null },
        },

        fiscal: {
            ncfType: { type: String, default: "B02" },
            nextNcfNumber: { type: String, default: "1" },
            issueDate: { type: String, default: null },
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model("Tenant", tenantSchema);
