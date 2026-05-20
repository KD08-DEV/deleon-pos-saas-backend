const ECF_DOCUMENT_TYPES = {
    "31": {
        code: "31",
        key: "e31",
        label: "Factura de Crédito Fiscal Electrónica",
        shortLabel: "Crédito Fiscal",
        group: "ventas_normales",
        issueSupportedFromOrder: true,
    },
    "32": {
        code: "32",
        key: "e32",
        label: "Factura de Consumo Electrónica",
        shortLabel: "Consumo",
        group: "ventas_normales",
        issueSupportedFromOrder: true,
    },
    "33": {
        code: "33",
        key: "e33",
        label: "Nota de Débito Electrónica",
        shortLabel: "Nota de Débito",
        group: "ajustes",
        requiresReference: true,
        issueSupportedFromOrder: false,
    },
    "34": {
        code: "34",
        key: "e34",
        label: "Nota de Crédito Electrónica",
        shortLabel: "Nota de Crédito",
        group: "ajustes",
        requiresReference: true,
        issueSupportedFromOrder: false,
    },
    "41": {
        code: "41",
        key: "e41",
        label: "Compras Electrónico",
        shortLabel: "Compras",
        group: "especiales",
        issueSupportedFromOrder: false,
    },
    "43": {
        code: "43",
        key: "e43",
        label: "Gastos Menores Electrónico",
        shortLabel: "Gastos Menores",
        group: "especiales",
        issueSupportedFromOrder: false,
    },
    "44": {
        code: "44",
        key: "e44",
        label: "Regímenes Especiales Electrónico",
        shortLabel: "Regímenes Especiales",
        group: "especiales",
        issueSupportedFromOrder: false,
    },
    "45": {
        code: "45",
        key: "e45",
        label: "Gubernamental Electrónico",
        shortLabel: "Gubernamental",
        group: "especiales",
        issueSupportedFromOrder: false,
    },
    "46": {
        code: "46",
        key: "e46",
        label: "Exportación Electrónico",
        shortLabel: "Exportación",
        group: "especiales",
        issueSupportedFromOrder: false,
    },
    "47": {
        code: "47",
        key: "e47",
        label: "Pagos al Exterior Electrónico",
        shortLabel: "Pagos al Exterior",
        group: "especiales",
        issueSupportedFromOrder: false,
    },
};

function normalizeEcfDocumentType(value = "32") {
    const clean = String(value || "32")
        .trim()
        .toLowerCase()
        .replace(/^e/, "");

    if (!ECF_DOCUMENT_TYPES[clean]) {
        const err = new Error("UNSUPPORTED_ECF_DOCUMENT_TYPE");
        err.statusCode = 400;
        err.allowed = Object.keys(ECF_DOCUMENT_TYPES);
        throw err;
    }

    return clean;
}

function getEcfDocumentTypeKey(value = "32") {
    const code = normalizeEcfDocumentType(value);
    return ECF_DOCUMENT_TYPES[code].key;
}

function getEcfDocumentTypeLabel(value = "32") {
    const code = normalizeEcfDocumentType(value);
    return ECF_DOCUMENT_TYPES[code].label;
}
function canIssueEcfDocumentTypeFromOrder(value = "32") {
    const code = normalizeEcfDocumentType(value);
    return ECF_DOCUMENT_TYPES[code]?.issueSupportedFromOrder === true;
}

module.exports = {
    ECF_DOCUMENT_TYPES,
    normalizeEcfDocumentType,
    getEcfDocumentTypeKey,
    getEcfDocumentTypeLabel,
    canIssueEcfDocumentTypeFromOrder,
};