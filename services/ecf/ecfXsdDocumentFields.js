"use strict";

// Campos obligatorios en la estructura DGII, derivados de datos autorizados.
// Nunca fabricar vencimientos reales ni sustituir fechas de comprobantes emitidos.
function ecfFieldError(code) {
    const error = new Error(code);
    error.code = code;
    error.statusCode = 422;
    return error;
}

function localDateParts(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) throw ecfFieldError("ECF_INVALID_DATE");
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Santo_Domingo", year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(d).map(p => [p.type, p.value]));
    return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function formatDateDOStrict(date) {
    const { year, month, day } = localDateParts(date);
    return `${String(day).padStart(2,"0")}-${String(month).padStart(2,"0")}-${year}`;
}

function dateFromDmy(value) {
    const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(value || "").trim());
    if (!match) throw ecfFieldError("ECF_REFERENCE_DATE_INVALID");
    const day = Number(match[1]), month=Number(match[2]), year=Number(match[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCDate()!==day || parsed.getUTCMonth()!==month-1 || parsed.getUTCFullYear()!==year) {
        throw ecfFieldError("ECF_REFERENCE_DATE_INVALID");
    }
    return parsed;
}

function datePartsAsUtc(parts) {
    return Date.UTC(parts.year,parts.month-1,parts.day);
}

function sequenceExpiryForXml({ profile, type }) {
    if (type !== "31" && type !== "33") return null;
    const key = `e${type}`;
    let value = profile?.documentTypes?.[key]?.validUntil;
    // SOLO para el sandbox interno, y únicamente si el desarrollador configuró
    // explícitamente la fecha de prueba. En certificación/producción no se utiliza.
    if (!value && profile?.environment === "internal_sandbox") {
        value = process.env.ECF_INTERNAL_TEST_SEQUENCE_VALID_UNTIL || null;
    }
    if (!value) throw ecfFieldError("ECF_SEQUENCE_EXPIRY_REQUIRED");
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) throw ecfFieldError("ECF_SEQUENCE_EXPIRY_INVALID");
    // La expiración es una FECHA civil (no un instante): MongoDB suele guardar
    // 2030-12-31 como 2030-12-31T00:00:00Z. No retroceder al día 30 por TZ -04.
    const expiry = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    const today = localDateParts(new Date());
    if (datePartsAsUtc(expiry) < datePartsAsUtc(today)) throw ecfFieldError("ECF_SEQUENCE_EXPIRY_PASSED");
    return `${String(expiry.day).padStart(2,"0")}-${String(expiry.month).padStart(2,"0")}-${expiry.year}`;
}

function creditNoteIndicator({ reference, issuedAt }) {
    if (!reference?.modifiedDate) throw ecfFieldError("E34_REFERENCE_DATE_REQUIRED");
    const issued = datePartsAsUtc(localDateParts(issuedAt));
    const original = dateFromDmy(reference.modifiedDate).getTime();
    const days = Math.round((issued-original)/86400000);
    if (days < 0) throw ecfFieldError("E34_REFERENCE_DATE_IN_FUTURE");
    return days > 30 ? "1" : "0";
}

function buyerForRfce(document) {
    const source = document?.customer || {};
    const id = String(source.document || "").replace(/\D/g, "");
    const buyerName = String(source.name || "").trim();
    // Comprador es obligatorio en RFCE; su RNC puede omitirse para consumo final.
    // No inventar un RNC ni completar con un número ajeno al documento.
    return { id: [9,11].includes(id.length) ? id : "", name: buyerName && buyerName.toLowerCase()!=="consumidor final" ? buyerName : "" };
}

module.exports = {
    sequenceExpiryForXml, creditNoteIndicator, buyerForRfce,
    dateFromDmy, formatDateDOStrict,
};
