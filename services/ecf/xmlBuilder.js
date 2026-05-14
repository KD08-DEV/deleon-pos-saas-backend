const { normalizeEcfDocumentType } = require("./helpers/ecfDocumentTypes");

function escapeXml(value = "") {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function onlyDigits(value = "") {
    return String(value || "").replace(/\D/g, "");
}

function money(value = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

function qty(value = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? String(Number(n.toFixed(3))) : "0";
}

function formatDateDO(date = new Date()) {
    const d = date ? new Date(date) : new Date();

    if (Number.isNaN(d.getTime())) {
        return formatDateDO(new Date());
    }

    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();

    return `${dd}-${mm}-${yyyy}`;
}

function formatDateTimeDO(date = new Date()) {
    const d = date ? new Date(date) : new Date();

    if (Number.isNaN(d.getTime())) {
        return formatDateTimeDO(new Date());
    }

    const parts = new Intl.DateTimeFormat("es-DO", {
        timeZone: "America/Santo_Domingo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).formatToParts(d);

    const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));

    return `${map.day}-${map.month}-${map.year} ${map.hour}:${map.minute}:${map.second}`;
}

function getBuyerDocument(order) {
    return onlyDigits(
        order?.customerDetails?.rnc ||
        order?.customerDetails?.rncCedula ||
        ""
    );
}

function getBuyerName(order) {
    return String(order?.customerDetails?.name || "Consumidor Final").trim();
}

function getPaymentCode(order) {
    const method = String(order?.paymentMethod || "").trim().toLowerCase();

    if (method.includes("efectivo")) return "1";
    if (method.includes("cheque")) return "2";
    if (method.includes("tarjeta")) return "3";
    if (method.includes("credito") || method.includes("crédito")) return "4";
    if (method.includes("transferencia")) return "5";

    return "1";
}

function getIncomeType() {
    // 01 = Ingresos por operaciones no financieros.
    return "01";
}

function getIsTaxIncludedIndicator(order) {
    // En tu POS los precios de línea normalmente vienen sin ITBIS y el ITBIS se calcula aparte.
    // 0 = montos sin ITBIS incluido.
    // 1 = montos con ITBIS incluido.
    return order?.bills?.taxEnabled ? "0" : "0";
}

function getItemInvoiceIndicator({ item, order }) {
    const taxTotal = Number(order?.bills?.tax || 0);

    // 1 = ITBIS tasa 1, 18%.
    // 4 = Exento.
    return taxTotal > 0 ? "1" : "4";
}

function getItemGoodOrServiceIndicator() {
    // 1 = Bien.
    // 2 = Servicio.
    // Para restaurante/comida lo dejamos como bien.
    return "1";
}

function getTotals(order) {
    const subtotal = Number(order?.bills?.subtotal || 0);
    const discount = Number(order?.bills?.discount || 0);
    const tax = Number(order?.bills?.tax || 0);
    const tip = Number(order?.bills?.tipAmount || order?.bills?.tip || 0);
    const total = Number(order?.bills?.totalWithTax || 0);
    const taxable = Math.max(subtotal - discount, 0);

    return {
        subtotal,
        discount,
        tax,
        tip,
        total,
        taxable,
        exempt: tax > 0 ? 0 : taxable,
        gravadoI1: tax > 0 ? taxable : 0,
        itbis1: tax > 0 ? 18 : 0,
    };
}

function validateIssuer(profile) {
    if (!onlyDigits(profile?.issuer?.rnc)) {
        const err = new Error("ECF_ISSUER_RNC_REQUIRED");
        err.statusCode = 400;
        throw err;
    }

    if (!String(profile?.issuer?.legalName || "").trim()) {
        const err = new Error("ECF_ISSUER_LEGAL_NAME_REQUIRED");
        err.statusCode = 400;
        throw err;
    }

    if (!String(profile?.issuer?.taxAddress || "").trim()) {
        const err = new Error("ECF_ISSUER_TAX_ADDRESS_REQUIRED");
        err.statusCode = 400;
        throw err;
    }
}

function validateEcfBuyer({ type, order }) {
    const buyerDoc = getBuyerDocument(order);
    const buyerName = getBuyerName(order);
    const total = Number(order?.bills?.totalWithTax || 0);

    if (type === "31" && ![9, 11].includes(buyerDoc.length)) {
        const err = new Error("E31_REQUIRES_VALID_BUYER_DOCUMENT");
        err.statusCode = 400;
        throw err;
    }

    if (type === "31" && !buyerName) {
        const err = new Error("E31_REQUIRES_BUYER_NAME");
        err.statusCode = 400;
        throw err;
    }

    if (type === "32" && total >= 250000 && ![9, 11].includes(buyerDoc.length)) {
        const err = new Error("E32_OVER_250K_REQUIRES_BUYER_DOCUMENT");
        err.statusCode = 400;
        throw err;
    }
}

function validateReference({ type, reference }) {
    if ((type === "33" || type === "34") && !reference?.modifiedENCF) {
        const err = new Error(`E${type}_REQUIRES_REFERENCE_ECF`);
        err.statusCode = 400;
        throw err;
    }
}

function buildBuyerXml({ type, order }) {
    const buyerDoc = getBuyerDocument(order);
    const buyerName = getBuyerName(order);

    if (!buyerDoc && type === "32") {
        return "";
    }

    return `
        <Comprador>
            ${buyerDoc ? `<RNCComprador>${escapeXml(buyerDoc)}</RNCComprador>` : ""}
            ${buyerName ? `<RazonSocialComprador>${escapeXml(buyerName)}</RazonSocialComprador>` : ""}
        </Comprador>`;
}

function buildItemsXml(order) {
    return (order.items || [])
        .map((item, index) => {
            const lineNumber = index + 1;
            const quantity = Number(item.quantity || 0);
            const unitPrice = Number(item.unitPrice || 0);
            const amount = Number(item.price || quantity * unitPrice || 0);
            const indicator = getItemInvoiceIndicator({ item, order });

            return `
        <Item>
            <NumeroLinea>${lineNumber}</NumeroLinea>
            <IndicadorFacturacion>${indicator}</IndicadorFacturacion>
            <NombreItem>${escapeXml(item.name || "Producto")}</NombreItem>
            <IndicadorBienoServicio>${getItemGoodOrServiceIndicator(item)}</IndicadorBienoServicio>
            <CantidadItem>${qty(quantity)}</CantidadItem>
            <PrecioUnitarioItem>${money(unitPrice)}</PrecioUnitarioItem>
            <MontoItem>${money(amount)}</MontoItem>
        </Item>`;
        })
        .join("");
}

function buildReferenceXml({ type, reference }) {
    if (type !== "33" && type !== "34") return "";

    return `
    <InformacionReferencia>
        <NCFModificado>${escapeXml(reference.modifiedENCF)}</NCFModificado>
        <FechaNCFModificado>${escapeXml(reference.modifiedDate || "")}</FechaNCFModificado>
        <CodigoModificacion>${escapeXml(reference.modificationCode || "1")}</CodigoModificacion>
        <RazonModificacion>${escapeXml(reference.reason || "")}</RazonModificacion>
    </InformacionReferencia>`;
}

function buildEcfSecurityCode(hash = "") {
    return String(hash || "").replace(/[^a-fA-F0-9]/g, "").slice(0, 6).toUpperCase();
}

function buildEcfQrUrl({
                           rnc,
                           eNCF,
                           total,
                           fechaEmision,
                           fechaFirma,
                           securityCode,
                       }) {
    const base = String(
        process.env.DGII_ECF_QR_BASE_URL ||
        "https://dgii.gov.do/app/WebApps/ConsultasWeb2/ConsultasWeb/consultas/ncf.aspx"
    ).trim();

    const params = new URLSearchParams({
        rnc: String(rnc || ""),
        encf: String(eNCF || ""),
        monto: money(total || 0),
        fechaEmision: String(fechaEmision || ""),
        fechaFirma: String(fechaFirma || ""),
        codigoSeguridad: String(securityCode || ""),
    });

    return `${base}?${params.toString()}`;
}

function generateEcfXml({
                            profile,
                            order,
                            documentType = "32",
                            sequenceNumber,
                            eNCF,
                            reference = null,
                        }) {
    const type = normalizeEcfDocumentType(documentType);

    validateIssuer(profile);
    validateEcfBuyer({ type, order });
    validateReference({ type, reference });

    const totals = getTotals(order);
    const fechaEmision = formatDateDO(order?.invoicedAt || order?.paidAt || new Date());
    const fechaHoraFirma = formatDateTimeDO(new Date());

    const buyerXml = buildBuyerXml({ type, order });
    const referenceXml = buildReferenceXml({ type, reference });

    return `<?xml version="1.0" encoding="UTF-8"?>
<eCF>
    <Encabezado>
        <Version>1.0</Version>
        <IdDoc>
            <TipoeCF>${type}</TipoeCF>
            <eNCF>${escapeXml(eNCF)}</eNCF>
            <IndicadorMontoGravado>${getIsTaxIncludedIndicator(order)}</IndicadorMontoGravado>
            <TipoIngresos>${getIncomeType(order)}</TipoIngresos>
            <TipoPago>${getPaymentCode(order)}</TipoPago>
        </IdDoc>
        <Emisor>
            <RNCEmisor>${escapeXml(onlyDigits(profile?.issuer?.rnc || ""))}</RNCEmisor>
            <RazonSocialEmisor>${escapeXml(profile?.issuer?.legalName || "")}</RazonSocialEmisor>
            ${profile?.issuer?.commercialName ? `<NombreComercial>${escapeXml(profile.issuer.commercialName)}</NombreComercial>` : ""}
            <DireccionEmisor>${escapeXml(profile?.issuer?.taxAddress || "")}</DireccionEmisor>
            <FechaEmision>${fechaEmision}</FechaEmision>
        </Emisor>${buyerXml}
        <Totales>
            <MontoGravadoTotal>${money(totals.gravadoI1)}</MontoGravadoTotal>
            ${totals.gravadoI1 > 0 ? `<MontoGravadoI1>${money(totals.gravadoI1)}</MontoGravadoI1>` : ""}
            ${totals.exempt > 0 ? `<MontoExento>${money(totals.exempt)}</MontoExento>` : ""}
            ${totals.gravadoI1 > 0 ? `<ITBIS1>18</ITBIS1>` : ""}
            <TotalITBIS>${money(totals.tax)}</TotalITBIS>
            ${totals.tax > 0 ? `<TotalITBIS1>${money(totals.tax)}</TotalITBIS1>` : ""}
            <MontoTotal>${money(totals.total)}</MontoTotal>
            ${totals.tip > 0 ? `<MontoPropinaLegal>${money(totals.tip)}</MontoPropinaLegal>` : ""}
        </Totales>
    </Encabezado>
    <DetallesItems>${buildItemsXml(order)}
    </DetallesItems>${referenceXml}
    <FechaHoraFirma>${fechaHoraFirma}</FechaHoraFirma>
</eCF>`.trim();
}

function generateRfceXmlFromDocument({
                                         profile,
                                         document,
                                     }) {
    if (!document?.ecf?.eNCF) {
        throw new Error("RFCE_REQUIRES_ENCF");
    }

    if (String(document?.ecf?.documentType || "") !== "32") {
        throw new Error("RFCE_ONLY_ALLOWED_FOR_E32");
    }

    const total = Number(document?.totals?.total || 0);

    if (total >= 250000) {
        throw new Error("RFCE_ONLY_ALLOWED_FOR_E32_UNDER_250K");
    }

    const securityCode = buildEcfSecurityCode(document?.xml?.hash || "");

    if (!securityCode) {
        throw new Error("RFCE_REQUIRES_ORIGINAL_ECF_HASH");
    }

    const fechaEmision = formatDateDO(document?.timestampsFlow?.generatedAt || document?.createdAt || new Date());

    return `<?xml version="1.0" encoding="UTF-8"?>
<RFCE>
    <Encabezado>
        <Version>1.0</Version>
        <IdDoc>
            <TipoeCF>32</TipoeCF>
            <eNCF>${escapeXml(document.ecf.eNCF)}</eNCF>
            <TipoIngresos>01</TipoIngresos>
        </IdDoc>
        <Emisor>
            <RNCEmisor>${escapeXml(onlyDigits(profile?.issuer?.rnc || document?.issuer?.rnc || ""))}</RNCEmisor>
            <RazonSocialEmisor>${escapeXml(profile?.issuer?.legalName || document?.issuer?.legalName || "")}</RazonSocialEmisor>
            <FechaEmision>${fechaEmision}</FechaEmision>
        </Emisor>
        <Totales>
            <MontoGravadoTotal>${money(Number(document?.totals?.subtotal || 0) - Number(document?.totals?.discount || 0))}</MontoGravadoTotal>
            <TotalITBIS>${money(document?.totals?.tax || 0)}</TotalITBIS>
            <MontoTotal>${money(total)}</MontoTotal>
            <CodigoSeguridadeCF>${securityCode}</CodigoSeguridadeCF>
        </Totales>
    </Encabezado>
</RFCE>`.trim();
}

module.exports = {
    generateEcfXml,
    generateRfceXmlFromDocument,
    buildEcfSecurityCode,
    buildEcfQrUrl,
    formatDateDO,
    formatDateTimeDO,
};