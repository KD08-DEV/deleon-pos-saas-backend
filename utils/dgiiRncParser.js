"use strict";
const clean = v => String(v ?? "").replace(/\s+/g, " ").trim();
function parseDgiiRncLine(line) {
    const cols = String(line || "").replace(/^\uFEFF/, "").split("|");
    // Archivo DGII_RNC.TXT: 11 columnas SIN encabezado.
    if (cols.length !== 11) return null;
    const rnc = clean(cols[0]).replace(/\D/g, "");
    const nombre = clean(cols[1]);
    if (!/^\d{9}(?:\d{2})?$/.test(rnc) || !nombre || nombre.length > 500) return null;
    return { rnc, nombre };
}
module.exports = { parseDgiiRncLine };
