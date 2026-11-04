const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
// ======================================================
// IMPUESTOS CONFIGURABLES
// ======================================================
const serviceChargeDefinitionSchema =
    new mongoose.Schema(
        {
            id: {
                type: String,
                required: true,
                trim: true,
            },

            name: {
                type: String,
                required: true,
                trim: true,
            },

            code: {
                type: String,
                required: true,
                trim: true,
                uppercase: true,
            },

            ratePercent: {
                type: Number,
                required: true,
                min: 0,
                max: 100,
            },

            active: {
                type: Boolean,
                default: true,
            },

            calculationBase: {
                type: String,
                enum: [
                    "NET",
                    "AFTER_TAX",
                ],
                default: "NET",
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
const taxDefinitionSchema =
    new mongoose.Schema(
        {
            id: {
                type: String,
                required: true,
                trim: true,
            },

            name: {
                type: String,
                required: true,
                trim: true,
            },

            code: {
                type: String,
                required: true,
                trim: true,
                uppercase: true,
            },

            // Guardamos porcentaje humano:
            // 18 = 18%
            // 7.5 = 7.5%
            // 0 = exento
            ratePercent: {
                type: Number,
                required: true,
                min: 0,
                max: 100,
            },

            active: {
                type: Boolean,
                default: true,
            },

            // Ej:
            // UK normalmente puede manejar
            // precios con VAT incluido.
            includedInPrice: {
                type: Boolean,
                default: false,
            },

            // Decide si este impuesto también
            // aplica al cargo de delivery.
            appliesToDeliveryFee: {
                type: Boolean,
                default: false,
            },
        },
        {
            _id: false,
        }
    );
// ======================================================
// IDENTIFICACIÓN FISCAL INTERNACIONAL
// ======================================================

const taxIdentifierSchema =
    new mongoose.Schema(
        {
            type: {
                type: String,
                trim: true,
                uppercase: true,
                maxlength: 40,
                default: "",
            },

            label: {
                type: String,
                trim: true,
                maxlength: 80,
                default: "",
            },

            value: {
                type: String,
                trim: true,
                maxlength: 120,
                default: "",
            },

            countryCode: {
                type: String,
                trim: true,
                uppercase: true,
                maxlength: 2,
                default: "",
            },

            active: {
                type: Boolean,
                default: true,
            },
        },
        {
            _id: false,
        }
    );
const tenantSchema = new mongoose.Schema(
    {
        tenantId: {
            type: String,
            required: true,
            unique: true,
            default: uuidv4,
        },


        name: { type: String, required: true, trim: true },
        // ======================================================
// LOCALIZACIÓN INTERNACIONAL
// ======================================================

        localization: {
            countryCode: {
                type: String,
                trim: true,
                uppercase: true,
                default: "DO",
            },

            language: {
                type: String,
                trim: true,
                lowercase: true,
                default: "es",
            },

            locale: {
                type: String,
                trim: true,
                default: "es-DO",
            },

            currency: {
                type: String,
                trim: true,
                uppercase: true,
                default: "DOP",
            },

            timezone: {
                type: String,
                trim: true,
                default: "America/Santo_Domingo",
            },

            dateFormat: {
                type: String,

                enum: [
                    "DD/MM/YYYY",
                    "MM/DD/YYYY",
                    "YYYY-MM-DD",
                ],

                default:
                    "DD/MM/YYYY",
            },

            timeFormat: {
                type: String,

                enum: [
                    "12h",
                    "24h",
                ],

                default:
                    "12h",
            },

            measurementSystem: {
                type: String,

                enum: [
                    "metric",
                    "imperial",
                ],

                default:
                    "imperial",
            },

            weightUnit: {
                type: String,

                enum: [
                    "lb",
                    "kg",
                ],

                default:
                    "lb",
            },
        },

        // ======================================================
// IDENTIDAD FISCAL INTERNACIONAL
// ======================================================
//
// No representa el impuesto.
//
// Ejemplos:
// DO → RNC
// US → EIN
// GB → VAT
// AU → ABN
// CO → NIT
// MX → RFC
//
// DGII / NCF / e-CF siguen viviendo
// independientemente en tenant.fiscal.
// ======================================================

        taxIdentity: {
            enabled: {
                type: Boolean,
                default: false,
            },

            countryCode: {
                type: String,
                trim: true,
                uppercase: true,
                default: "DO",
            },

            legalName: {
                type: String,
                trim: true,
                maxlength: 160,
                default: "",
            },

            primaryTaxId: {
                type: taxIdentifierSchema,
                default: null,
            },

            additionalTaxIds: {
                type: [taxIdentifierSchema],
                default: [],
            },
        },

// ======================================================
// MOTOR GENÉRICO DE IMPUESTOS
// ======================================================
//
// IMPORTANTE:
// No depende del país.
//
// El usuario decide:
// - nombre
// - porcentaje
// - si está incluido
// - cuál es el predeterminado
// ======================================================

        taxConfig: {
            enabled: {
                type: Boolean,
                default: true,
            },

            defaultTaxId: {
                type: String,
                default: null,
            },

            taxes: {
                type: [taxDefinitionSchema],
                default: [],
            },
        },

        // pos-backend/models/tenantModel.js

        fiscal: {
            // ✅ flag principal para saber si el tenant puede facturar con NCF
            enabled: { type: Boolean, default: false },     // NCF/Comprobante fiscal
            allowRequest: { type: Boolean, default: true }, // si el cajero puede pedirlo
            defaultType: { type: String, default: "B02" },

            // ✅ Punto de emisión / sucursal (se muestran en la factura)
            emissionPoint: { type: String, default: "001" },
            branchName: { type: String, default: "Principal" },

            // número interno de factura (por tenant)
            nextInvoiceNumber: { type: Number, default: 1 },

            // rangos NCF por tipo (por tenant)
            ncfConfig: {
                B01: {
                    start: { type: Number, default: 1 },
                    current: { type: Number, default: 1 }, // next to use
                    max: { type: Number, default: 0 },     // 0 = no configurado
                    active: { type: Boolean, default: false },

                    // ✅ FECHA DE VENCIMIENTO del rango NCF (DGII)
                    expiresAt: { type: Date, default: null },
                },
                B02: {
                    start: { type: Number, default: 1 },
                    current: { type: Number, default: 1 },
                    max: { type: Number, default: 0 },
                    active: { type: Boolean, default: false },

                    // ✅ FECHA DE VENCIMIENTO del rango NCF (DGII)
                    expiresAt: { type: Date, default: null },
                },
            },

            // ⚠️ recomendado: NO usar esto en tenant (issueDate es por factura)
            issueDate: { type: String, default: null },
        },

        counters: {
            nextOrderNumber: { type: Number, default: 1 },
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
            serviceCharges: {
                enabled: {
                    type: Boolean,
                    default: false,
                },

                charges: {
                    type: [
                        serviceChargeDefinitionSchema
                    ],
                    default: [],
                },
            },
            tip: {
                enabled: { type: Boolean, default: true },
                allowToggle: { type: Boolean, default: true },
            },
            preInvoice: {
                enabled: { type: Boolean, default: false },
            },
            checkout: {
                chargeMode: {
                    type: String,
                    enum: ["AT_INVOICE", "AT_COMPLETE"],
                    default: "AT_COMPLETE",
                },
            },
            productCustomization: {
                enabled: {
                    type: Boolean,
                    default: false,
                },
            },
            // Dentro de features.orderSources
            orderSources: {
                pedidosYa: {
                    enabled: { type: Boolean, default: false },
                    commissionRate: { type: Number, default: 0.26 },
                },
                uberEats: {
                    enabled: { type: Boolean, default: false },
                    commissionRate: { type: Number, default: 0.22 },
                },

                // ADD:
                delivery: {
                    enabled: { type: Boolean, default: false },
                    defaultFee: { type: Number, default: 0 },// canal "DELIVERY" interno
                },
            },

        },

        status: {
            type: String,
            enum: ["active", "suspended"],
            default: "active",
        },

        plan: {
            type: String,
            enum: ["emprendedor", "estandar", "premium", "pro"],
            default: "emprendedor",
        },

        business: {
            name: { type: String, required: false, default: null },
            rnc: { type: String, default: null },
            address: { type: String, default: null },
            phone: { type: String, default: null },

            // ✅ Logo del negocio para facturas
            logoUrl: { type: String, default: null },
            logoPath: { type: String, default: null },
            logoMime: { type: String, default: null },
            logoUpdatedAt: { type: Date, default: null },
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model("Tenant", tenantSchema);
