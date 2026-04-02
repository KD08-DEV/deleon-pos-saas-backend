const mongoose = require("mongoose");

const itemSchema = new mongoose.Schema(
    {
        lineId: { type: String, required: true, trim: true },

        dishId: { type: mongoose.Schema.Types.ObjectId, ref: "dish", required: false },

        name: { type: String, required: true, trim: true },

        presentation: { type: String, default: "Regular", trim: true },

        category: { type: String, default: "", trim: true },

        unitCost: { type: Number, default: 0 },

        taxAmount: { type: Number, default: 0 },

        qtyType: { type: String, enum: ["unit", "weight"], default: "unit" },
        weightUnit: { type: String, enum: ["lb", "kg"], default: "lb" },

        unitPrice: { type: Number, required: true, min: 0 },
        quantity: { type: Number, required: true, min: 0.001 },
        price: { type: Number, required: true, min: 0 },

        note: { type: String, default: "", trim: true },
        addons: { type: [mongoose.Schema.Types.Mixed], default: [] },
        modifiers: { type: [mongoose.Schema.Types.Mixed], default: [] },

        productionArea: {
            type: String,
            enum: ["kitchen", "bar", "other"],
            default: "kitchen",
        },

        printedQty: { type: Number, default: 0, min: 0 },
    },
    { _id: false }
);


const orderSchema = new mongoose.Schema(
    {
        // 🔐 multi-tenant
        tenantId: { type: String, required: true, index: true },
        clientId: { type: String, required: true, index: true },
        customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },


        customerDetails: {
            name: { type: String, trim: true },
            phone: { type: String, default: "" },
            address: { type: String, default: "" },
            guests: { type: Number, default: 1, min: 0 },
            rnc: String,
            rncCedula: String,

        },
        orderStatus: {
            type: String,
            enum: ["En Progreso", "Listo", "Completado", "Cancelado"], // ⟵ añadimos Cancelled
            default: "En Progreso",
        },
        isDraft: { type: Boolean, default: true, index: true },

        invoicePath: { type: String, default: "" },
        invoiceUrl: { type: String, default: "" },
        orderSource: {
            type: String,
            enum: ["DINE_IN", "TAKEOUT", "PEDIDOSYA", "UBEREATS", "DELIVERY"],
            default: "DINE_IN",
            index: true,
        },


    // Comisión congelada en el momento de crear/cambiar el canal
        commissionRate: { type: Number, default: 0 },     // 0.26, 0.22, etc
        commissionAmount: { type: Number, default: 0 },   // monto calculado
        netTotal: { type: Number, default: 0 },
        bills: {
            // subtotal real (antes de ITBIS y propina)
            subtotal: { type: Number, default: 0 },

            // compat (tu app usa total como "subtotal" a veces)
            total: { type: Number, default: 0 },

            discount: { type: Number, default: 0 },

            // propina (guardamos ambos por compatibilidad)
            tip: { type: Number, default: 0 },
            tipAmount: { type: Number, default: 0 },

            // ITBIS
            taxEnabled: { type: Boolean, default: true },
            tax: { type: Number, default: 0 },
            deliveryFee: { type: Number, default: 0 },

            // total final
            totalWithTax: { type: Number, default: 0 },
        },
        // --- FACTURACIÓN FISCAL (NCF) ---
        fiscal: {
            requested: { type: Boolean, default: false },
            ncfType: { type: String, default: "B02" },
            ncfNumber: { type: String, default: null },
            issuedAt: { type: Date, default: null },

            expirationDate: { type: Date, default: null },

            internalSeq: { type: Number, default: null },
            internalNumber: { type: String, default: null },

            emissionPoint: { type: String, default: "001" },
            branchName: { type: String, default: "Principal" },

            printedAt: { type: Date, default: null },
            preInvoice: { type: Boolean, default: false },
        },
        inventoryDeducted: { type: Boolean, default: false },
        inventoryDeductedAt: { type: Date, default: null },
        cogsTotal: { type: Number, default: 0 },

// Opcional: duplicado top-level (útil para búsquedas rápidas)
        ncfNumber: { type: String, default: null },
        operationNumber: { type: Number, index: true },
        orderNote: { type: String, default: "", trim: true },
        items: { type: [itemSchema], default: [] },
        table: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Table",
            required: false,
            default: null,
        },
        paymentMethod: { type: String, enum: ["Efectivo", "Tarjeta", "Transferencia", "Pedido Ya", "Uber Eats", "Otros"], default: "Efectivo" },
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // quien creó la orden
    },
    { timestamps: true }
);

// Ordenar y consultar por tenant + fecha de creación
orderSchema.index({ tenantId: 1, clientId: 1,createdAt: -1 });

module.exports = mongoose.model("Order", orderSchema);

