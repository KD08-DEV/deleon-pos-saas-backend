const mongoose = require("mongoose");
// ======================================================
// SNAPSHOT DE IMPUESTO
// ======================================================
//
// Se copia dentro de cada línea de venta.
// Así una factura vieja NO cambia aunque el cliente
// posteriormente modifique o desactive un impuesto.
// ======================================================

const taxSnapshotSchema =
    new mongoose.Schema(
        {
            taxId: {
                type: String,
                default: null,
            },

            name: {
                type: String,
                default: "",
            },

            code: {
                type: String,
                default: "",
            },

            ratePercent: {
                type: Number,
                default: 0,
            },

            includedInPrice: {
                type: Boolean,
                default: false,
            },

            taxableBase: {
                type: Number,
                default: 0,
            },

            amount: {
                type: Number,
                default: 0,
            },
        },
        {
            _id: false,
        }
    );
const serviceChargeBreakdownSchema =
    new mongoose.Schema(
        {
            chargeId: {
                type: String,
                default: null,
            },

            name: {
                type: String,
                default: "",
            },

            code: {
                type: String,
                default: "",
            },

            ratePercent: {
                type: Number,
                default: 0,
            },

            calculationBase: {
                type: String,
                default: "NET",
            },

            baseAmount: {
                type: Number,
                default: 0,
            },

            amount: {
                type: Number,
                default: 0,
            },
            appliesToDeliveryOrders: {
                type: Boolean,
                default: true,
            },

            appliesToDeliveryFee: {
                type: Boolean,
                default: false,
            },

            addToTotal: {
                type: Boolean,
                default: true,
            },
        },
        {
            _id: false,
        }
    );

// ======================================================
// DESGLOSE TOTAL POR IMPUESTO
// ======================================================

const taxBreakdownSchema =
    new mongoose.Schema(
        {
            taxId: {
                type: String,
                default: null,
            },

            name: {
                type: String,
                default: "",
            },

            code: {
                type: String,
                default: "",
            },

            ratePercent: {
                type: Number,
                default: 0,
            },

            includedInPrice: {
                type: Boolean,
                default: false,
            },

            taxableBase: {
                type: Number,
                default: 0,
            },

            amount: {
                type: Number,
                default: 0,
            },

            grossAmount: {
                type: Number,
                default: 0,
            },
        },
        {
            _id: false,
        }
    );


const itemSchema = new mongoose.Schema(
    {
        lineId: { type: String, required: true, trim: true },

        dishId: { type: mongoose.Schema.Types.ObjectId, ref: "dish", required: false },

        name: { type: String, required: true, trim: true },

        presentation: { type: String, default: "Regular", trim: true },

        category: { type: String, default: "", trim: true },

        unitCost: { type: Number, default: 0 },

        // Impuesto seleccionado para esta línea.
        taxId: {
            type: String,
            default: null,
            trim: true,
        },

// Descuento proporcional aplicado a la línea.
        discountAmount: {
            type: Number,
            default: 0,
        },


// Total de la línea una vez aplicado su impuesto.
// Si el impuesto estaba incluido, puede ser igual
// al precio descontado.
        lineTotalWithTax: {
            type: Number,
            default: 0,
        },

// Copia histórica del impuesto.
        taxSnapshot: {
            type: taxSnapshotSchema,
            default: null,
        },
        taxIncludedOverride: {
            type: Boolean,
            default: null,
        },
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
// ======================================================
// SNAPSHOT DE IDENTIFICACIÓN FISCAL DEL CLIENTE
// ======================================================
//
// Este dato queda congelado dentro de la orden.
//
// Si posteriormente el cliente cambia su EIN, RNC,
// VAT, NIT, etc., la factura histórica mantiene la
// identificación utilizada al momento de la venta.
// ======================================================

const customerTaxIdentitySnapshotSchema =
    new mongoose.Schema(
        {
            countryCode: {
                type: String,
                default: "",
                trim: true,
                uppercase: true,
                maxlength: 2,
            },

            type: {
                type: String,
                default: "TAX_ID",
                trim: true,
                uppercase: true,
                maxlength: 40,
            },

            label: {
                type: String,
                default: "Tax ID",
                trim: true,
                maxlength: 80,
            },

            value: {
                type: String,
                default: "",
                trim: true,
                maxlength: 120,
            },
        },
        {
            _id: false,
        }
    );

const orderSchema = new mongoose.Schema(
    {
        // 🔐 multi-tenant
        tenantId: { type: String, required: true, index: true },
        clientId: { type: String, required: true, index: true },
        customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },


        customerDetails: {
            name: {
                type: String,
                trim: true,
            },

            phone: {
                type: String,
                default: "",
            },

            address: {
                type: String,
                default: "",
            },

            guests: {
                type: Number,
                default: 1,
                min: 0,
            },


            // ==============================================
            // IDENTIFICACIÓN FISCAL INTERNACIONAL
            // ==============================================

            taxIdentity: {
                type:
                customerTaxIdentitySnapshotSchema,

                default:
                    null,
            },


            // ==============================================
            // COMPATIBILIDAD DGII LEGACY
            // ==============================================

            rnc: {
                type: String,
                default: "",
            },

            rncCedula: {
                type: String,
                default: "",
            },
        },
        orderStatus: {
            type: String,
            enum: ["En Progreso", "Listo", "Completado", "Cancelado"], // ⟵ añadimos Cancelled
            default: "En Progreso",
        },
        isDraft: { type: Boolean, default: true, index: true },
        paymentStatus: {
            type: String,
            enum: ["Pendiente", "Pagado", "Anulado"],
            default: "Pendiente",
            index: true,
        },
        invoicedAt: {
            type: Date,
            default: null,
            index: true,
        },

// No. interno de factura, secuencial y cronológico
        invoiceNumber: { type: String, default: null, index: true },
        facturaNo: { type: String, default: null, index: true },

        invoicePath: { type: String, default: "" },
        invoiceUrl: { type: String, default: "" },
        orderSource: {
            type: String,
            enum: ["DINE_IN", "TAKEOUT", "PEDIDOSYA", "UBEREATS", "DELIVERY"],
            default: "DINE_IN",
            index: true,
        },

        registerId: { type: String, default: "MAIN", index: true },
        paidAt: { type: Date, default: null, index: true },
        paidBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        cashSessionId: { type: mongoose.Schema.Types.ObjectId, ref: "CashSession", default: null, index: true },

    // Comisión congelada en el momento de crear/cambiar el canal
        commissionRate: { type: Number, default: 0 },     // 0.26, 0.22, etc
        commissionAmount: { type: Number, default: 0 },   // monto calculado
        netTotal: { type: Number, default: 0 },
        bills: {
            // subtotal real (antes de ITBIS y propina)
            subtotal: { type: Number, default: 0 },
            serviceChargeTotal: {
                type: Number,
                default: 0,
            },

            serviceChargeBreakdown: {
                type: [
                    serviceChargeBreakdownSchema
                ],
                default: [],
            },
            // compat (tu app usa total como "subtotal" a veces)
            total: { type: Number, default: 0 },

            discount: { type: Number, default: 0 },
            tipEnabled: { type: Boolean, default: true },

            // propina (guardamos ambos por compatibilidad)
            tip: { type: Number, default: 0 },
            tipAmount: { type: Number, default: 0 },

            // ITBIS
            taxEnabled: { type: Boolean, default: true },
            tax: { type: Number, default: 0 },

            // Versión del motor usado para calcular esta venta.
            taxEngineVersion: {
                type: Number,
                default: 1,
            },

// Subtotal después de distribuir el descuento.
            subtotalAfterDiscount: {
                type: Number,
                default: 0,
            },

// Base neta sin impuestos.
            netAmount: {
                type: Number,
                default: 0,
            },

// Impuesto generado específicamente por delivery.
            deliveryTaxAmount: {
                type: Number,
                default: 0,
            },

// Desglose por cada impuesto utilizado.
            taxBreakdown: {
                type: [taxBreakdownSchema],
                default: [],
            },
            deliveryFee: { type: Number, default: 0 },

            // total final
            totalWithTax: { type: Number, default: 0 },
        },
        // --- FACTURACIÓN FISCAL (NCF) ---
        fiscal: {
            ecfDocumentType: {
                type: String,
                enum: ["31", "32", "33", "34", "41", "43", "44", "45", "46", "47", null],
                default: null,
            },
            requested: { type: Boolean, default: false },
            ncfType: {
                type: String,
                enum: ["B01", "B02", null],
                default: null,
            },
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
        inventoryRestoredAt: { type: Date, default: null },
        cogsTotal: { type: Number, default: 0 },

// Opcional: duplicado top-level (útil para búsquedas rápidas)
        ncfNumber: { type: String, default: null },
        operationSeq: {
            type: Number,
            default: null,
            index: true,
        },

        operationNumber: {
            type: String,
            default: null,
            index: true,
        },
        orderNote: { type: String, default: "", trim: true },
        correctionHistory: {
            type: [{
                at: { type: Date, default: Date.now },
                correctionCode: { type: String, default: null },
                by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
                reason: { type: String, required: true },
                changed: { type: [String], default: [] },
                previousPaymentMethod: { type: String, default: "" },
                nextPaymentMethod: { type: String, default: "" },
                previousNote: { type: String, default: "" },
                nextNote: { type: String, default: "" },
                previousTotal: {type: Number, default: null},
                nextTotal: {type: Number, default: null},
                previousItems: {type: [mongoose.Schema.Types.Mixed], default: []},
                nextItems: {type: [mongoose.Schema.Types.Mixed], default: []},
                previousBills: {type: mongoose.Schema.Types.Mixed, default: null},
                nextBills: {type: mongoose.Schema.Types.Mixed, default: null},
                settlement: {type: mongoose.Schema.Types.Mixed, default: null},
            }],
            default: [],
            select: false,
        },
        items: { type: [itemSchema], default: [] },
        tableSessionId: {type:String,default:null,index:true},
        table: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Table",
            required: false,
            default: null,
        },
        paymentMethod: {
            type: String,
            enum: [
                "Efectivo",
                "Tarjeta",
                "Transferencia",
                "Pedido Ya",
                "Uber Eats",
                "Otros",
                "Credito",
            ],
            default: "Efectivo",
        },

        creditStatus: {
            type: String,
            enum: ["none", "pending", "partial", "paid"],
            default: "none",
            index: true,
        },

        accountReceivableId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "AccountReceivable",
            default: null,
            index: true,
        },        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // quien creó la orden
    },
    { timestamps: true }
);

// Ordenar y consultar por tenant + fecha de creación

orderSchema.index({
    tenantId: 1,
    clientId: 1,
    createdAt: -1,
});

orderSchema.index({
    tenantId: 1,
    clientId: 1,
    orderStatus: 1,
    createdAt: -1,
});

orderSchema.index({
    tenantId: 1,
    clientId: 1,
    isDraft: 1,
    createdAt: -1,
});
module.exports = mongoose.model("Order", orderSchema);

