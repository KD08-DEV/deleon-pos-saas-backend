function escapeXml(value = "") {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function generateEcfXml({ profile, order, documentType, sequenceNumber, eNCF }) {
    const customerName = order?.customerDetails?.name || "Consumidor Final";
    const customerDoc =
        order?.customerDetails?.rncCedula ||
        order?.customerDetails?.rnc ||
        "";

    const itemsXml = (order.items || [])
        .map((item, index) => {
            return `
            <Item>
                <Linea>${index + 1}</Linea>
                <Nombre>${escapeXml(item.name)}</Nombre>
                <Cantidad>${Number(item.quantity || 0)}</Cantidad>
                <PrecioUnitario>${Number(item.unitPrice || 0).toFixed(2)}</PrecioUnitario>
                <MontoItem>${Number(item.price || 0).toFixed(2)}</MontoItem>
            </Item>`;
        })
        .join("");

    return `
<ECF>
    <Encabezado>
        <TipoeCF>${documentType}</TipoeCF>
        <eNCF>${escapeXml(eNCF)}</eNCF>
        <Secuencia>${sequenceNumber}</Secuencia>
        <RNCEmisor>${escapeXml(profile.issuer.rnc || "")}</RNCEmisor>
        <RazonSocialEmisor>${escapeXml(profile.issuer.legalName || "")}</RazonSocialEmisor>
        <NombreComercial>${escapeXml(profile.issuer.commercialName || "")}</NombreComercial>
    </Encabezado>

    <Comprador>
        <NombreComprador>${escapeXml(customerName)}</NombreComprador>
        <DocumentoComprador>${escapeXml(customerDoc)}</DocumentoComprador>
    </Comprador>

    <DetalleItems>
        ${itemsXml}
    </DetalleItems>

    <Totales>
        <Subtotal>${Number(order.bills?.subtotal || 0).toFixed(2)}</Subtotal>
        <ITBIS>${Number(order.bills?.tax || 0).toFixed(2)}</ITBIS>
        <Propina>${Number(order.bills?.tipAmount || order.bills?.tip || 0).toFixed(2)}</Propina>
        <Descuento>${Number(order.bills?.discount || 0).toFixed(2)}</Descuento>
        <Total>${Number(order.bills?.totalWithTax || 0).toFixed(2)}</Total>
    </Totales>
</ECF>`.trim();
}

module.exports = {
    generateEcfXml,
};