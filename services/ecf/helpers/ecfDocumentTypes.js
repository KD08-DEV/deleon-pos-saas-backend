const ECF_DOCUMENT_TYPES = {
    "31": {
        code: "31",
        key: "e31",
        label: "Factura de Crédito Fiscal Electrónica",
    },
    "32": {
        code: "32",
        key: "e32",
        label: "Factura de Consumo Electrónica",
    },
    "33": {
        code: "33",
        key: "e33",
        label: "Nota de Débito Electrónica",
    },
    "34": {
        code: "34",
        key: "e34",
        label: "Nota de Crédito Electrónica",
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

module.exports = {
    ECF_DOCUMENT_TYPES,
    normalizeEcfDocumentType,
    getEcfDocumentTypeKey,
    getEcfDocumentTypeLabel,
};