"use strict";

// Datos que puede mostrar la representación impresa al consultar una orden.
// La consulta del documento se hace siempre con tenant/sucursal verificados.
const PRINTABLE_STATUSES = Object.freeze(["accepted", "accepted_with_observation"]);

function buildEcfDocumentScope({ orderId, tenantId, clientId = "default" }) {
    if (!orderId || !tenantId || !clientId) {
        throw new Error("ECF_INVOICE_SCOPE_REQUIRED");
    }
    const branchScope = clientId === "default"
        ? { $or: [{ clientId: "default" }, { clientId: { $exists: false } }] }
        : { clientId };

    return {
        tenantId: String(tenantId),
        orderId,
        sourceDocumentType: "ORDER",
        "ecf.documentType": { $in: ["31", "32"] },
        "ecf.status": { $in: PRINTABLE_STATUSES },
        ...branchScope,
    };
}

function mapEcfForInvoice(document) {
    if (!document || !PRINTABLE_STATUSES.includes(document?.ecf?.status)) return null;
    const details = document.ecf || {};
    if (!details.eNCF) return null;
    return {
        exists: true,
        documentType: details.documentType,
        eNCF: details.eNCF,
        status: details.status,
        trackId: details.trackId || "",
        securityCode: details.securityCode || "",
        qrUrl: details.qrUrl || "",
        fechaHoraFirma: details.fechaHoraFirma || "",
        internalSandbox: /^SANDBOX-/i.test(String(details.trackId || "")),
    };
}

module.exports = { buildEcfDocumentScope, mapEcfForInvoice, PRINTABLE_STATUSES };
