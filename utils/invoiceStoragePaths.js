/** Paths dentro del bucket 'invoices', nunca se incluye el nombre del bucket. */
function invoiceStoragePaths(tenantId, orderId) {
    const tenant = String(tenantId || "");
    const order = String(orderId || "");
    if (!tenant || !order || !/^[A-Za-z0-9_-]+$/.test(tenant) ||
        !/^[A-Za-z0-9_-]+$/.test(order)) {
        throw new Error("INVALID_INVOICE_STORAGE_SCOPE");
    }
    const canonical = `tenant_${tenant}/orders/invoice_${order}.pdf`;
    // Los PDF históricos se subieron con un prefijo de bucket duplicado.
    return [canonical, `invoices/${canonical}`];
}

module.exports = { invoiceStoragePaths };
