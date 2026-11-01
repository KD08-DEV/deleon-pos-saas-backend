// ======================================================
// PRESETS DE IDENTIFICACIÓN FISCAL POR PAÍS
// ======================================================
//
// IMPORTANTE:
//
// Esto NO representa impuestos.
// Esto NO configura ITBIS, VAT, GST, Sales Tax, etc.
//
// Su única responsabilidad es indicar cómo se llama
// normalmente la identificación fiscal principal de
// un negocio según el país.
//
// La información real del negocio se guarda en:
//
// tenant.taxIdentity
//
// ======================================================


// ======================================================
// FALLBACK GLOBAL
// ======================================================
//
// Se utiliza para cualquier país que todavía no tenga
// un preset específico.
//
// Esto permite que DeLeonSoft siga funcionando con
// cualquier país sin obligarnos a tener todos los
// sistemas fiscales del mundo codificados desde ahora.
// ======================================================

const DEFAULT_TAX_IDENTITY_PRESET = {
    legalNameLabel:
        "Nombre legal / Razón social",

    primaryTaxId: {
        type:
            "TAX_ID",

        label:
            "Identificación fiscal",

        shortLabel:
            "Tax ID",

        placeholder:
            "Número de identificación fiscal",

        helpText:
            "Ingresa la identificación fiscal principal del negocio.",

        inputMode:
            "text",

        maxLength:
            120,
    },
};


// ======================================================
// PRESETS ESPECÍFICOS
// ======================================================

export const TAX_IDENTITY_PRESETS = {

    // ==================================================
    // REPÚBLICA DOMINICANA
    // ==================================================

    DO: {
        countryCode:
            "DO",

        legalNameLabel:
            "Razón social",

        primaryTaxId: {
            type:
                "RNC",

            label:
                "RNC",

            shortLabel:
                "RNC",

            placeholder:
                "RNC del negocio",

            helpText:
                "Registro Nacional de Contribuyentes del negocio.",

            inputMode:
                "numeric",

            maxLength:
                11,
        },
    },


    // ==================================================
    // ESTADOS UNIDOS
    // ==================================================

    US: {
        countryCode:
            "US",

        legalNameLabel:
            "Legal business name",

        primaryTaxId: {
            type:
                "EIN",

            label:
                "EIN",

            shortLabel:
                "EIN",

            placeholder:
                "XX-XXXXXXX",

            helpText:
                "Employer Identification Number.",

            inputMode:
                "text",

            maxLength:
                10,
        },
    },


    // ==================================================
    // REINO UNIDO
    // ==================================================

    GB: {
        countryCode:
            "GB",

        legalNameLabel:
            "Legal business name",

        primaryTaxId: {
            type:
                "VAT",

            label:
                "VAT Registration Number",

            shortLabel:
                "VAT",

            placeholder:
                "GB123456789",

            helpText:
                "VAT registration number del negocio.",

            inputMode:
                "text",

            maxLength:
                20,
        },
    },


    // ==================================================
    // AUSTRALIA
    // ==================================================

    AU: {
        countryCode:
            "AU",

        legalNameLabel:
            "Legal business name",

        primaryTaxId: {
            type:
                "ABN",

            label:
                "Australian Business Number",

            shortLabel:
                "ABN",

            placeholder:
                "12 345 678 901",

            helpText:
                "Australian Business Number.",

            inputMode:
                "numeric",

            maxLength:
                14,
        },
    },


    // ==================================================
    // COLOMBIA
    // ==================================================

    CO: {
        countryCode:
            "CO",

        legalNameLabel:
            "Razón social",

        primaryTaxId: {
            type:
                "NIT",

            label:
                "NIT",

            shortLabel:
                "NIT",

            placeholder:
                "Número de Identificación Tributaria",

            helpText:
                "Número de Identificación Tributaria del negocio.",

            inputMode:
                "text",

            maxLength:
                20,
        },
    },


    // ==================================================
    // MÉXICO
    // ==================================================

    MX: {
        countryCode:
            "MX",

        legalNameLabel:
            "Razón social",

        primaryTaxId: {
            type:
                "RFC",

            label:
                "RFC",

            shortLabel:
                "RFC",

            placeholder:
                "Registro Federal de Contribuyentes",

            helpText:
                "Registro Federal de Contribuyentes.",

            inputMode:
                "text",

            maxLength:
                20,
        },
    },
};


// ======================================================
// NORMALIZAR CÓDIGO DE PAÍS
// ======================================================

function normalizeCountryCode(
    countryCode
) {
    return String(
        countryCode || ""
    )
        .trim()
        .toUpperCase();
}


// ======================================================
// OBTENER PRESET
// ======================================================
//
// Nunca devuelve null.
//
// Si el país tiene configuración específica,
// devuelve esa configuración.
//
// Si todavía no la tenemos definida,
// devuelve TAX_ID genérico.
//
// Esto es importante porque el sistema regional
// utiliza world-countries y puede permitir países
// que todavía no tengan preset fiscal específico.
// ======================================================

export function getTaxIdentityPreset(
    countryCode
) {
    const code =
        normalizeCountryCode(
            countryCode
        );

    const preset =
        TAX_IDENTITY_PRESETS[
            code
            ];

    if (preset) {
        return {
            ...DEFAULT_TAX_IDENTITY_PRESET,

            ...preset,

            primaryTaxId: {
                ...DEFAULT_TAX_IDENTITY_PRESET
                    .primaryTaxId,

                ...preset
                    .primaryTaxId,
            },
        };
    }

    return {
        ...DEFAULT_TAX_IDENTITY_PRESET,

        countryCode:
        code,

        primaryTaxId: {
            ...DEFAULT_TAX_IDENTITY_PRESET
                .primaryTaxId,
        },
    };
}


// ======================================================
// SABER SI EXISTE UN PRESET ESPECÍFICO
// ======================================================

export function hasTaxIdentityPreset(
    countryCode
) {
    const code =
        normalizeCountryCode(
            countryCode
        );

    return Boolean(
        TAX_IDENTITY_PRESETS[
            code
            ]
    );
}


// ======================================================
// CREAR IDENTIFICADOR VACÍO DESDE EL PRESET
// ======================================================
//
// Esto será utilizado en 2E.3 por TaxIdentityConfig.
//
// Ejemplo RD:
//
// {
//     type: "RNC",
//     label: "RNC",
//     value: "",
//     countryCode: "DO",
//     active: true
// }
//
// ======================================================

export function createPrimaryTaxIdentifier(
    countryCode
) {
    const preset =
        getTaxIdentityPreset(
            countryCode
        );

    return {
        type:
        preset
            .primaryTaxId
            .type,

        label:
            preset
                .primaryTaxId
                .shortLabel ||
            preset
                .primaryTaxId
                .label,

        value:
            "",

        countryCode:
        preset.countryCode,

        active:
            true,
    };
}


// ======================================================
// CREAR BORRADOR COMPLETO DE TAX IDENTITY
// ======================================================
//
// Todavía NO guarda nada.
//
// Solo prepara la estructura que luego utilizará
// TaxIdentityConfig.jsx.
//
// ======================================================

export function createTaxIdentityDraft(
    countryCode,
    legalName = ""
) {
    const preset =
        getTaxIdentityPreset(
            countryCode
        );

    return {
        enabled:
            false,

        countryCode:
        preset.countryCode,

        legalName:
            String(
                legalName || ""
            ).trim(),

        primaryTaxId:
            createPrimaryTaxIdentifier(
                preset.countryCode
            ),

        additionalTaxIds:
            [],
    };
}