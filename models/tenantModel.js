const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const tenantSchema = new mongoose.Schema(
    {
        tenantId: {
            type: String,
            required: true,
            unique: true,
            default: uuidv4,
        },


        name: { type: String, required: true, trim: true },

        fiscal: {
            // ✅ IMPORTANTE: flag principal para saber si el tenant puede facturar con NCF
            enabled: { type: Boolean, default: false },     // NCF/Comprobante fiscal
            allowRequest: { type: Boolean, default: true }, // si el cajero puede pedirlo
            defaultType: { type: String, default: "B02" },

            // número interno de factura (por tenant)
            nextInvoiceNumber: { type: Number, default: 1 },

            // rangos NCF por tipo (por tenant)
            ncfConfig: {
                B01: {
                    start: { type: Number, default: 1 },
                    current: { type: Number, default: 1 }, // next to use
                    max: { type: Number, default: 0 }, // 0 = no configurado
                    active: { type: Boolean, default: false },
                },
                B02: {
                    start: { type: Number, default: 1 },
                    current: { type: Number, default: 1 },
                    max: { type: Number, default: 0 },
                    active: { type: Boolean, default: false },
                },
            },

            // ⚠️ recomendado: NO usar esto en tenant (issueDate es por factura)
            issueDate: { type: String, default: null },
        },

        features: {
            tax: {
                enabled: { type: Boolean, default: true },
                allowToggle: { type: Boolean, default: true }, // si el cajero puede prender/apagar
                rate: { type: Number, default: 0.18 },         // por si algún día varía
            },
            discount: {
                enabled: { type: Boolean, default: true },
                allowToggle: { type: Boolean, default: true },
            },

        },

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
    },
    { timestamps: true }
);

module.exports = mongoose.model("Tenant", tenantSchema);
