const mongoose = require("mongoose");


// ======================================================
// NORMALIZAR TELÉFONO
// ======================================================

const normalizePhone = (value) => {
    const digits =
        String(value || "")
            .replace(/\D/g, "");

    if (!digits) {
        return "";
    }

    /*
     * Compatibilidad República Dominicana.
     *
     * 809 / 829 / 849 con 10 dígitos
     * se almacenan normalizados con el 1.
     */
    if (
        digits.length === 10 &&
        /^(809|829|849)/.test(digits)
    ) {
        return `1${digits}`;
    }

    if (
        digits.length === 11 &&
        digits.startsWith("1")
    ) {
        return digits;
    }

    /*
     * Otros países:
     * simplemente conservamos los dígitos.
     */
    return digits;
};


// ======================================================
// NORMALIZAR VALOR FISCAL
// ======================================================

const normalizeTaxValue = (value) => {
    return String(value || "")
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
};


// ======================================================
// NORMALIZAR IDENTIDAD FISCAL
// ======================================================

const normalizeTaxIdentity = (raw) => {
    if (
        !raw ||
        typeof raw !== "object"
    ) {
        return null;
    }

    const value =
        String(
            raw?.value || ""
        ).trim();

    /*
     * Si no hay número fiscal,
     * consideramos que no existe identidad fiscal.
     */
    if (!value) {
        return null;
    }

    const countryCode =
        String(
            raw?.countryCode || ""
        )
            .trim()
            .toUpperCase()
            .slice(0, 2);

    const type =
        String(
            raw?.type ||
            "TAX_ID"
        )
            .trim()
            .toUpperCase()
            .slice(0, 40);

    const label =
        String(
            raw?.label ||
            type ||
            "Tax ID"
        )
            .trim()
            .slice(0, 80);

    return {
        countryCode,
        type,
        label,
        value,
        valueNormalized:
            normalizeTaxValue(value),
    };
};


// ======================================================
// SUBSCHEMA IDENTIFICACIÓN FISCAL
// ======================================================

const customerTaxIdentitySchema =
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

            /*
             * Versión limpia para búsquedas.
             *
             * Ej:
             *
             * 12-3456789
             * ↓
             * 123456789
             *
             * GB 123 456 789
             * ↓
             * GB123456789
             */
            valueNormalized: {
                type: String,
                default: "",
                trim: true,
                index: true,
            },
        },
        {
            _id: false,
        }
    );


// ======================================================
// CUSTOMER
// ======================================================

const customerSchema =
    new mongoose.Schema(
        {
            tenantId: {
                type: String,
                required: true,
                index: true,
            },

            clientId: {
                type: String,
                required: true,
                index: true,
            },

            name: {
                type: String,
                default:
                    "Consumidor Final",
                trim: true,
            },

            phone: {
                type: String,
                default: "",
                trim: true,
            },

            phoneNormalized: {
                type: String,
                default: "",
                index: true,
            },

            address: {
                type: String,
                default: "",
                trim: true,
            },


            // ==========================================
            // IDENTIFICACIÓN FISCAL INTERNACIONAL
            // ==========================================

            taxIdentity: {
                type:
                customerTaxIdentitySchema,

                default:
                    null,
            },


            isActive: {
                type: Boolean,
                default: true,
            },
        },
        {
            timestamps: true,
        }
    );


// ======================================================
// ÍNDICES
// ======================================================

customerSchema.index({
    tenantId: 1,
    clientId: 1,
    createdAt: -1,
});


/*
 * Teléfono único únicamente cuando existe.
 */
customerSchema.index(
    {
        tenantId: 1,
        clientId: 1,
        phoneNormalized: 1,
    },
    {
        unique: true,

        partialFilterExpression: {
            phoneNormalized: {
                $type:
                    "string",

                $ne:
                    "",
            },
        },
    }
);


/*
 * NO hacemos el Tax ID unique todavía.
 *
 * Lo indexamos para buscarlo rápidamente,
 * pero evitamos romper datos existentes o
 * casos especiales con registros compartidos.
 */
customerSchema.index({
    tenantId: 1,
    clientId: 1,
    "taxIdentity.valueNormalized": 1,
});


// ======================================================
// NORMALIZAR ANTES DE GUARDAR
// ======================================================

customerSchema.pre(
    "save",

    function (next) {
        this.phoneNormalized =
            normalizePhone(
                this.phone
            );

        this.taxIdentity =
            normalizeTaxIdentity(
                this.taxIdentity
            );

        next();
    }
);


// ======================================================
// HELPERS DEL MODELO
// ======================================================

customerSchema.statics.normalizePhone =
    normalizePhone;

customerSchema.statics.normalizeTaxValue =
    normalizeTaxValue;

customerSchema.statics.normalizeTaxIdentity =
    normalizeTaxIdentity;


// ======================================================
// EXPORT
// ======================================================

module.exports =
    mongoose.model(
        "Customer",
        customerSchema
    );