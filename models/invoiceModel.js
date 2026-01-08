const mongoose = require("mongoose");

const invoiceSchema = new mongoose.Schema(
    {
        tenantId: { type: String, required: true, index: true },
        clientId: { type: String, required: true, index: true },

        // ----- NEGOCIO -----
        businessName: { type: String, required: true },
        businessRNC: { type: String },
        businessAddress: { type: String },
        businessPhone: { type: String },

        // ----- FISCAL -----
        invoiceNumber: { type: Number, required: true }, // correlativo por tenant
        customerDocument: { type: String }, // RNC o Cédula
        customerDocumentType: { type: String, enum: ["RNC", "CEDULA", null], default: null },
        ncfType: { type: String, default: "B02" },
        ncfNumber: { type: String },
        date: { type: Date, default: Date.now },

        // ----- CLIENTE -----
        customerName: { type: String },
        customerRNC: { type: String },  // solo si quiere crédito fiscal

        // ----- DETALLE -----
        items: [
            {
                productName: String,
                quantity: Number,
                price: Number,
                subtotal: Number,
            }
        ],

        itbis: { type: Number, default: 0 },
        tip: { type: Number, default: 0 },
        total: { type: Number, required: true },

        // ----- PAGO -----
        paymentMethod: { type: String, enum: ["cash", "transfer", "tarjeta"], default: "cash" },
    },
    { timestamps: true }
);

module.exports = mongoose.model("Invoice", invoiceSchema);
