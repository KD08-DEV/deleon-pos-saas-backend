"use strict";

// Fase 12.2 — validación XSD real mediante libxml2-wasm.
// Los esquemas originales de DGII se preservan; las variantes para compilación
// y preflight se documentan y hashean en xsd/manifest.json.
// IMPORTANTE: "report" diagnostica; NO confirma conformidad ni bloquea.
const fs = require("node:fs");
const path = require("node:path");

const SCHEMAS = Object.freeze({
    "31": "31", "E31": "31",
    "32": "32", "E32": "32",
    "33": "33", "E33": "33",
    "34": "34", "E34": "34",
    "RFCE": "RFCE32", "RFCE32": "RFCE32",
});
const MODES = new Set(["off", "report", "enforce"]);
const MAX_XML_BYTES = 4 * 1024 * 1024;

function fiscalXsdError(code, details = {}) {
    const err = new Error(code);
    err.code = code;
    err.statusCode = 422;
    err.details = details;
    return err;
}

function normalizeMode(mode = process.env.ECF_XSD_MODE || "enforce") {
    const value = String(mode).trim().toLowerCase();
    if (!MODES.has(value)) {
        throw fiscalXsdError("ECF_XSD_MODE_INVALID", { mode: value });
    }
    return value;
}

function schemaPath(format, stage = "signed") {
    const code = SCHEMAS[String(format || "").trim().toUpperCase()];
    if (!code) throw fiscalXsdError("ECF_XSD_FORMAT_NOT_SUPPORTED", { format });
    if (!["signed", "preflight"].includes(stage)) {
        throw fiscalXsdError("ECF_XSD_STAGE_INVALID", { stage });
    }
    return path.join(__dirname, "xsd", stage === "signed" ? "compilables" : "preflight", `${code}.xsd`);
}

// La librería es ESM: require() no funciona en versiones anteriores de Node.
// El import dinámico se realiza una sola vez por proceso.
let libPromise;
function loadLibrary() {
    if (!libPromise) libPromise = import("libxml2-wasm");
    return libPromise;
}

async function validateAgainstSchema({ xml, format, stage = "signed" }) {
    const file = schemaPath(format, stage);
    if (typeof xml !== "string" || !xml.trim()) {
        throw fiscalXsdError("ECF_XSD_EMPTY_XML");
    }
    if (Buffer.byteLength(xml, "utf8") > MAX_XML_BYTES) {
        throw fiscalXsdError("ECF_XSD_XML_TOO_LARGE");
    }
    // No procesar DTD ni entidades de documentos recibidos externamente.
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
        throw fiscalXsdError("ECF_XSD_DTD_NOT_ALLOWED");
    }

    const { XmlDocument, XsdValidator } = await loadLibrary();
    let xsdDocument, xmlDocument, validator;
    try {
        xsdDocument = XmlDocument.fromBuffer(fs.readFileSync(file));
        validator = XsdValidator.fromDoc(xsdDocument);
        xmlDocument = XmlDocument.fromString(xml);
        validator.validate(xmlDocument);
        return { valid: true, format: String(format).toUpperCase(), stage, errors: [] };
    } catch (cause) {
        // No mostrar el XML: podría contener datos del contribuyente.
        return {
            valid: false,
            format: String(format).toUpperCase(),
            stage,
            errors: [String(cause?.message || cause).slice(0, 1000)],
        };
    } finally {
        if (xmlDocument) xmlDocument.dispose();
        if (validator) validator.dispose();
        if (xsdDocument) xsdDocument.dispose();
    }
}

async function checkEcfXsd({ xml, format, stage = "signed", mode, validate = validateAgainstSchema }) {
    const effectiveMode = normalizeMode(mode);
    if (effectiveMode === "off") {
        return { checked: false, valid: null, format, stage, mode: effectiveMode };
    }

    let result;
    try {
        result = await validate({ xml, format, stage });
    } catch (e) {
        result = { valid: false, format, stage, errors: [String(e?.message || e).slice(0, 1000)] };
    }

    if (result.valid !== true) {
        const details = { format, stage, errors: (result.errors || []).slice(0, 6) };
        if (effectiveMode === "enforce") {
            throw fiscalXsdError("ECF_XSD_VALIDATION_FAILED", details);
        }
        // Diagnóstico: no guardar XML ni datos fiscales personales en logs.
        console.warn("[ECF_XSD_REPORT]", JSON.stringify(details));
    }
    return { ...result, checked: true, mode: effectiveMode };
}

module.exports = {
    schemaPath,
    normalizeMode,
    validateAgainstSchema,
    checkEcfXsd,
};
