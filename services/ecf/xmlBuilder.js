const { normalizeEcfDocumentType } = require("./helpers/ecfDocumentTypes");
const { getFiscalSnapshot } = require("./ecfFiscalSnapshot");
const { sequenceExpiryForXml, creditNoteIndicator, buyerForRfce } = require("./ecfXsdDocumentFields");

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
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) throw new Error("ECF_INVALID_ISSUE_DATE");
    const parts = new Intl.DateTimeFormat("es-DO", {
        timeZone: "America/Santo_Domingo", day: "2-digit", month: "2-digit", year: "numeric"
    }).formatToParts(d);
    const f = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return `${f.day}-${f.month}-${f.year}`;
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
    return String(
        order?.customerDetails?.name || ""
    ).trim();
}
function getTipoPago(order) {
    const method = String(order?.paymentMethod || "")
        .trim()
        .toLowerCase();

    if (
        method.includes("credito") ||
        method.includes("crédito")
    ) {
        return "2";
    }

    return "1";
}
function getFormaPago(order) {
    const method = String(order?.paymentMethod || "")
        .trim()
        .toLowerCase();

    if (method.includes("efectivo")) return "1";

    if (
        method.includes("cheque") ||
        method.includes("transferencia") ||
        method.includes("deposito") ||
        method.includes("depósito")
    ) {
        return "2";
    }

    if (method.includes("tarjeta")) return "3";

    if (
        method.includes("credito") ||
        method.includes("crédito")
    ) {
        return "4";
    }

    return null;
}
function buildPaymentTableXml(order, total) {
    const paymentCode = getFormaPago(order);

    if (!paymentCode) {
        return "";
    }

    return `
            <TablaFormasPago>
                <FormaDePago>
                    <FormaPago>${paymentCode}</FormaPago>
                    <MontoPago>${money(total)}</MontoPago>
                </FormaDePago>
            </TablaFormasPago>`;
}

function getIncomeType() {
    // 01 = Ingresos por operaciones no financieros.
    return "01";
}

function getIsTaxIncludedIndicator() {
    return "0";
}

// El snapshot fiscal viene de la venta persistida, nunca de la tasa global.
function buildDiscountsXml(fiscal) {
    if (!fiscal.discount) return "";
    const discounts = new Map();
    for (const line of fiscal.lines) {
        if (!line.discount) continue;
        discounts.set(line.indicator, Number(((discounts.get(line.indicator) || 0) + line.discount).toFixed(2)));
    }
    return `
    <DescuentosORecargos>${[...discounts].map(([indicator, amount], idx) => `
        <DescuentoORecargo>
            <NumeroLinea>${idx + 1}</NumeroLinea>
            <TipoAjuste>D</TipoAjuste>
            <DescripcionDescuentooRecargo>Descuento</DescripcionDescuentooRecargo>
            <TipoValor>$</TipoValor>
            <MontoDescuentooRecargo>${money(amount)}</MontoDescuentooRecargo>
            <IndicadorFacturacionDescuentooRecargo>${indicator}</IndicadorFacturacionDescuentooRecargo>
        </DescuentoORecargo>`).join("")}
    </DescuentosORecargos>`;
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

    // E32: Comprador es obligatorio por XSD aun si el RNC es opcional.
    // Nunca inventar un RNC/cedula para un consumidor final.
    if (!buyerDoc && type === "32") {
        return `
        <Comprador>
            ${buyerName ? `<RazonSocialComprador>${escapeXml(buyerName)}</RazonSocialComprador>` : ""}
        </Comprador>`;
    }

    return `
        <Comprador>
            ${buyerDoc ? `<RNCComprador>${escapeXml(buyerDoc)}</RNCComprador>` : ""}
            ${buyerName ? `<RazonSocialComprador>${escapeXml(buyerName)}</RazonSocialComprador>` : ""}
        </Comprador>`;
}

function buildItemsXml(fiscal) {
    return fiscal.lines.map((item, index) => {
        const hasLegalTip = fiscal.tip > 0;
        const legalTipXml = hasLegalTip ? `
            <TablaImpuestoAdicional>
                <ImpuestoAdicional><TipoImpuesto>001</TipoImpuesto></ImpuestoAdicional>
            </TablaImpuestoAdicional>` : "";
        return `
        <Item>
            <NumeroLinea>${index + 1}</NumeroLinea>
            <IndicadorFacturacion>${item.indicator}</IndicadorFacturacion>
            <NombreItem>${escapeXml(item.name)}</NombreItem>
            <IndicadorBienoServicio>${item.goodsOrService}</IndicadorBienoServicio>
            <CantidadItem>${qty(item.quantity)}</CantidadItem>
            <PrecioUnitarioItem>${money(item.unitPrice)}</PrecioUnitarioItem>
            ${legalTipXml}
            <MontoItem>${money(item.amount)}</MontoItem>
        </Item>`;
    }).join("");
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



function formatAmountForDgii(value) {
    const n = Number(value || 0);
    return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

function getEcfQrBaseUrl({
                             environment,
                             documentType,
                             total,
                         }) {
    const env = String(
        environment || "internal_sandbox"
    ).trim();

    const type = String(
        documentType || ""
    ).trim();

    const amount = Number(total || 0);

    const ecfHost = String(
        process.env.DGII_ECF_BASE_URL ||
        "https://ecf.dgii.gov.do"
    ).replace(/\/+$/, "");

    const fcHost = String(
        process.env.DGII_FC_BASE_URL ||
        "https://fc.dgii.gov.do"
    ).replace(/\/+$/, "");

    const isConsumerSummary =
        type === "32" &&
        amount > 0 &&
        amount < 250000;

    let slug = "testecf";

    if (env === "dgii_certification") {
        slug = "certecf";
    }

    if (env === "dgii_production") {
        slug = "ecf";
    }

    // =========================================
    // RFCE / Factura consumo < RD$250k
    // =========================================
    if (isConsumerSummary) {
        if (env === "dgii_production") {
            return (
                process.env.DGII_FC_QR_BASE_URL_PROD ||
                `${fcHost}/ecf/consultatimbrefc`
            );
        }

        if (env === "dgii_certification") {
            return (
                process.env.DGII_FC_QR_BASE_URL_CERT ||
                `${fcHost}/certecf/consultatimbrefc`
            );
        }

        return (
            process.env.DGII_FC_QR_BASE_URL_TEST ||
            `${fcHost}/testecf/consultatimbrefc`
        );
    }

    // =========================================
    // e-CF normal
    // =========================================
    if (env === "dgii_production") {
        return (
            process.env.DGII_ECF_QR_BASE_URL_PROD ||
            `${ecfHost}/ecf/consultatimbre`
        );
    }

    if (env === "dgii_certification") {
        return (
            process.env.DGII_ECF_QR_BASE_URL_CERT ||
            `${ecfHost}/certecf/consultatimbre`
        );
    }

    return (
        process.env.DGII_ECF_QR_BASE_URL_TEST ||
        `${ecfHost}/testecf/consultatimbre`
    );
}
function buildEcfQrUrl({
                           environment = "internal_sandbox",
                           documentType = "32",
                           rncEmisor,
                           rnc,
                           rncComprador,
                           eNCF,
                           total,
                           fechaEmision,
                           fechaFirma,
                           securityCode,
                       }) {
    const type = String(documentType || "32")
        .trim()
        .toLowerCase()
        .replace(/^e/, "");

    const amount = Number(total || 0);

    const finalRncEmisor = onlyDigits(rncEmisor || rnc || "");
    const finalRncComprador = onlyDigits(rncComprador || "");
    const finalENCF = String(eNCF || "").trim().toUpperCase();
    const finalCodigoSeguridad = String(securityCode || "").trim();
    const finalMontoTotal = formatAmountForDgii(amount);

    const baseUrl = getEcfQrBaseUrl({
        environment,
        documentType: type,
        total: amount,
    });

    const params = new URLSearchParams();

    const isFacturaConsumoMenor250k =
        type === "32" && amount < 250000;

    // Factura de Consumo Electrónica menor a RD$250,000
    // Usa ConsultaTimbreFC y solo requiere:
    // RncEmisor, ENCF, MontoTotal y CodigoSeguridad.
    if (isFacturaConsumoMenor250k) {
        params.set("RncEmisor", finalRncEmisor);
        params.set("ENCF", finalENCF);
        params.set("MontoTotal", finalMontoTotal);
        params.set("CodigoSeguridad", finalCodigoSeguridad);

        return `${baseUrl}?${params.toString()}`;
    }

    // e-CF normal:
    // e31, e33, e34 y e32 mayor o igual a RD$250,000.
    params.set("RncEmisor", finalRncEmisor);

    if (finalRncComprador) {
        params.set("RncComprador", finalRncComprador);
    }

    params.set("ENCF", finalENCF);
    params.set("FechaEmision", String(fechaEmision || "").trim());
    params.set("MontoTotal", finalMontoTotal);
    params.set("FechaFirma", String(fechaFirma || "").trim());
    params.set("CodigoSeguridad", finalCodigoSeguridad);

    return `${baseUrl}?${params.toString()}`;
}
function buildLegalTipTotalsXml(tip = 0) {
    const amount = Number(tip || 0);

    if (amount <= 0) {
        return "";
    }

    return `
            <MontoImpuestoAdicional>${money(amount)}</MontoImpuestoAdicional>
            <ImpuestosAdicionales>
                <ImpuestoAdicional>
                    <TipoImpuesto>001</TipoImpuesto>
                    <OtrosImpuestosAdicionales>${money(amount)}</OtrosImpuestosAdicionales>
                </ImpuestoAdicional>
            </ImpuestosAdicionales>`;
}
function generateEcfXml({
                            profile,
                            order,
                            documentType = "32",
                            sequenceNumber,
                            eNCF,
                            reference = null,
                            fechaHoraFirmaOverride = null,
                        }) {
    const type = normalizeEcfDocumentType(documentType);
    const fiscal = getFiscalSnapshot(order);
    const discountXml = buildDiscountsXml(fiscal);
    validateIssuer(profile);
    validateEcfBuyer({ type, order });
    validateReference({ type, reference });

    const totals = fiscal;
    const issuedAt = order?.invoicedAt || order?.paidAt || new Date();
    const fechaEmision = formatDateDO(issuedAt);
    const fechaVencimientoSecuencia = sequenceExpiryForXml({ profile, type });
    const indicadorNotaCredito = type === "34" ? creditNoteIndicator({ reference, issuedAt }) : null;
    const fechaHoraFirma = fechaHoraFirmaOverride || formatDateTimeDO(new Date());

    const buyerXml = buildBuyerXml({ type, order });
    const referenceXml = buildReferenceXml({ type, reference });

    return `<?xml version="1.0" encoding="UTF-8"?>
<ECF>
    <Encabezado>
        <Version>1.0</Version>
        <IdDoc>
            <TipoeCF>${type}</TipoeCF>
            <eNCF>${escapeXml(eNCF)}</eNCF>
            ${fechaVencimientoSecuencia ? `<FechaVencimientoSecuencia>${fechaVencimientoSecuencia}</FechaVencimientoSecuencia>` : ""}
            ${indicadorNotaCredito !== null ? `<IndicadorNotaCredito>${indicadorNotaCredito}</IndicadorNotaCredito>` : ""}
             ${totals.taxable18 + totals.taxable16 > 0
                ? `<IndicadorMontoGravado>0</IndicadorMontoGravado>`
                : ""}
            <TipoIngresos>${getIncomeType(order)}</TipoIngresos>
            <TipoPago>${getTipoPago(order)}</TipoPago>
            ${type === "34" ? "" : buildPaymentTableXml(order, totals.total)}
        </IdDoc>
        <Emisor>
            <RNCEmisor>${escapeXml(onlyDigits(profile?.issuer?.rnc || ""))}</RNCEmisor>
            <RazonSocialEmisor>${escapeXml(profile?.issuer?.legalName || "")}</RazonSocialEmisor>
            ${profile?.issuer?.commercialName ? `<NombreComercial>${escapeXml(profile.issuer.commercialName)}</NombreComercial>` : ""}
            <DireccionEmisor>${escapeXml(profile?.issuer?.taxAddress || "")}</DireccionEmisor>
            <FechaEmision>${fechaEmision}</FechaEmision>
        </Emisor>${buyerXml}
        <Totales>
            ${totals.taxable18 + totals.taxable16 > 0
                ? `<MontoGravadoTotal>${money(totals.taxable18 + totals.taxable16)}</MontoGravadoTotal>` : ""}
            ${totals.taxable18 > 0 ? `<MontoGravadoI1>${money(totals.taxable18)}</MontoGravadoI1>` : ""}
            ${totals.taxable16 > 0 ? `<MontoGravadoI2>${money(totals.taxable16)}</MontoGravadoI2>` : ""}
            ${totals.exempt > 0 ? `<MontoExento>${money(totals.exempt)}</MontoExento>` : ""}
            ${totals.taxable18 > 0 ? `<ITBIS1>18</ITBIS1>` : ""}
            ${totals.taxable16 > 0 ? `<ITBIS2>16</ITBIS2>` : ""}
            ${totals.tax > 0 ? `<TotalITBIS>${money(totals.tax)}</TotalITBIS>` : ""}
            ${totals.itbis18 > 0 ? `<TotalITBIS1>${money(totals.itbis18)}</TotalITBIS1>` : ""}
            ${totals.itbis16 > 0 ? `<TotalITBIS2>${money(totals.itbis16)}</TotalITBIS2>` : ""}
            ${buildLegalTipTotalsXml(totals.tip)}
            <MontoTotal>${money(totals.total)}</MontoTotal>
        </Totales>
    </Encabezado>
    <DetallesItems>${buildItemsXml(fiscal)}
</DetallesItems>
${discountXml}
${referenceXml}
    <FechaHoraFirma>${fechaHoraFirma}</FechaHoraFirma>
</ECF>`.trim();
}

function generateRfceXmlFromDocument({
                                         profile,
                                         document,
                                         securityCode,
                                     }) {
    if (!document?.ecf?.eNCF) {
        throw new Error("RFCE_REQUIRES_ENCF");
    }

    if (
        String(
            document?.ecf?.documentType || ""
        ) !== "32"
    ) {
        throw new Error(
            "RFCE_ONLY_ALLOWED_FOR_E32"
        );
    }

    const total = Number(
        document?.totals?.total || 0
    );

    if (total <= 0) {
        throw new Error(
            "RFCE_TOTAL_MUST_BE_POSITIVE"
        );
    }

    if (total >= 250000) {
        throw new Error(
            "RFCE_ONLY_ALLOWED_FOR_E32_UNDER_250K"
        );
    }

    const finalSecurityCode =
        String(securityCode || "").trim();

    if (finalSecurityCode.length !== 6) {
        throw new Error(
            "RFCE_REQUIRES_VALID_SECURITY_CODE"
        );
    }

    const subtotal = Number(
        document?.totals?.subtotal || 0
    );

    const discount = Number(
        document?.totals?.discount || 0
    );

    const tax = Number(
        document?.totals?.tax || 0
    );

    const tip = Number(
        document?.totals?.tip ||
        document?.totals?.tipAmount ||
        0
    );

    const netAmount =
        Math.max(subtotal - discount, 0);

    const hasFiscalSnapshot = Number(document?.totals?.fiscalSummaryVersion) === 1;
    const gravado18 = hasFiscalSnapshot
        ? Number(document.totals.taxable18 || 0) : (tax > 0 ? netAmount : 0);
    const gravado16 = hasFiscalSnapshot
        ? Number(document.totals.taxable16 || 0) : 0;
    const gravado = gravado18 + gravado16;
    const exempt = hasFiscalSnapshot
        ? Number(document.totals.exempt || 0) : (tax > 0 ? 0 : netAmount);
    const itbis18 = hasFiscalSnapshot
        ? Number(document.totals.itbis18 || 0) : tax;
    const itbis16 = hasFiscalSnapshot
        ? Number(document.totals.itbis16 || 0) : 0;
    if (hasFiscalSnapshot && Math.abs(gravado + exempt + tax + tip - total) > 0.011) {
        throw new Error("RFCE_FISCAL_SUMMARY_MISMATCH");
    }

    const tipoPago = String(
        document?.ecf?.tipoPago || "1"
    );

    const fechaEmision = formatDateDO(
        document?.timestampsFlow?.generatedAt ||
        document?.createdAt ||
        new Date()
    );

    const buyer = buyerForRfce(document);
    const buyerXml = `<Comprador>${buyer.id ? `<RNCComprador>${escapeXml(buyer.id)}</RNCComprador>` : ""}${buyer.name ? `<RazonSocialComprador>${escapeXml(buyer.name)}</RazonSocialComprador>` : ""}</Comprador>`;

    const additionalTaxesXml =
        tip > 0
            ? `
            <MontoImpuestoAdicional>${money(tip)}</MontoImpuestoAdicional>
            <ImpuestosAdicionales>
                <ImpuestoAdicional>
                    <TipoImpuesto>001</TipoImpuesto>
                    <OtrosImpuestosAdicionales>${money(tip)}</OtrosImpuestosAdicionales>
                </ImpuestoAdicional>
            </ImpuestosAdicionales>`
            : "";

    return `<?xml version="1.0" encoding="UTF-8"?>
<RFCE>
    <Encabezado>
        <Version>1.0</Version>

        <IdDoc>
            <TipoeCF>32</TipoeCF>
            <eNCF>${escapeXml(
        document.ecf.eNCF
    )}</eNCF>
            <TipoIngresos>01</TipoIngresos>
            <TipoPago>${tipoPago}</TipoPago>
        </IdDoc>

        <Emisor>
            <RNCEmisor>${escapeXml(
        onlyDigits(
            profile?.issuer?.rnc ||
            document?.issuer?.rnc ||
            ""
        )
    )}</RNCEmisor>

            <RazonSocialEmisor>${escapeXml(
        profile?.issuer?.legalName ||
        document?.issuer?.legalName ||
        ""
    )}</RazonSocialEmisor>

            <FechaEmision>${fechaEmision}</FechaEmision>
        </Emisor>
        ${buyerXml}

        <Totales>
            ${
        gravado > 0
            ? `<MontoGravadoTotal>${money(
                gravado
            )}</MontoGravadoTotal>`
            : ""
    }

            ${
        gravado18 > 0
            ? `<MontoGravadoI1>${money(gravado18)}</MontoGravadoI1>`
            : ""
    }

            ${gravado16 > 0 ? `<MontoGravadoI2>${money(gravado16)}</MontoGravadoI2>` : ""}
    ${
        exempt > 0
            ? `<MontoExento>${money(
                exempt
            )}</MontoExento>`
            : ""
    }

            ${
        tax > 0
            ? `<TotalITBIS>${money(
                tax
            )}</TotalITBIS>`
            : ""
    }

            ${
        itbis18 > 0
            ? `<TotalITBIS1>${money(itbis18)}</TotalITBIS1>`
            : ""
    }

            ${itbis16 > 0 ? `<TotalITBIS2>${money(itbis16)}</TotalITBIS2>` : ""}
            ${additionalTaxesXml}

            <MontoTotal>${money(total)}</MontoTotal>
        </Totales>

        <CodigoSeguridadeCF>${escapeXml(
        finalSecurityCode
    )}</CodigoSeguridadeCF>
    </Encabezado>
</RFCE>`.trim();
}
module.exports = {
    generateEcfXml,
    generateRfceXmlFromDocument,
    buildEcfQrUrl,
    formatDateDO,
    formatDateTimeDO,
    getFiscalSnapshot,
};