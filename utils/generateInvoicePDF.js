const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

const Order = require("../models/orderModel");
const Tenant = require("../models/tenantModel");

const { supabase } = require("../config/supabaseClient"); // ajusta si tu import es distinto


// ---------- helpers ----------
const normalizeMongoDate = (val) => {
    if (!val) return null;
    if (val instanceof Date) return val;

    if (typeof val === "string") {
        const d = new Date(val);
        return isNaN(d.getTime()) ? null : d;
    }

    if (typeof val === "object") {
        // Soporta { $date: "..." } o { "$date": "..." }
        const raw = val.$date || val["$date"];
        if (raw) {
            const d = new Date(raw);
            return isNaN(d.getTime()) ? null : d;
        }
    }

    return null;
};

const moneyRD = (n) => {
    const x = Number(n || 0);
    return `RD$${x.toFixed(2)}`;
};

const getTaxRate = (order) => {
    const r = Number(order?.taxRate);
    if (!r) return 0.18;
    if (r > 1) return r / 100;
    return r;
};

const getLineNet = (item) => {
    const qty = Number(item?.quantity || item?.qty || 1);

    const unit =
        Number(item?.unitPrice ?? item?.pricePerQuantity ?? item?.price ?? 0);

    const line = qty * unit;
    return isNaN(line) ? 0 : line;
};


const fmtDateDO = new Intl.DateTimeFormat("es-DO", {
    timeZone: "America/Santo_Domingo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
});

const fmtTimeDO = new Intl.DateTimeFormat("es-DO", {
    timeZone: "America/Santo_Domingo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
});

const fmtDateUTC = new Intl.DateTimeFormat("es-DO", {
    timeZone: "UTC",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
});

const formatDateTimeDO = (dateLike) => {
    const d = normalizeMongoDate(dateLike);
    if (!d) return "N/A";
    return `${fmtDateDO.format(d)}, ${fmtTimeDO.format(d)}`;
};

const formatDateUTC = (dateLike) => {
    const d = normalizeMongoDate(dateLike);
    if (!d) return "N/A";
    return fmtDateUTC.format(d);
};

const NCF_TYPE_LABEL = {
    B01: "Crédito Fiscal",
    B02: "Consumidor Final",
};

// ---------- main ----------
async function generateInvoicePDF(orderId, tenantId) {
    try {
        console.log("[PDF] >>> generateInvoicePDF llamado con orderId:", orderId, "tenant:", tenantId);

        const order = await Order.findOne({ _id: orderId, tenantId });
        if (!order) throw new Error("Orden no encontrada para generar PDF.");

        const tenant = await Tenant.findOne({ tenantId });
        if (!tenant) throw new Error("Tenant no encontrado para generar PDF.");

        // ----- fiscal fields -----
        const fiscal = order?.fiscal || {};
        const hasNCF = Boolean(fiscal?.ncfNumber || order?.ncfNumber);
        const ncfType = fiscal?.ncfType || order?.ncfType || "";
        const ncfNumber = fiscal?.ncfNumber || order?.ncfNumber || "";
        const pad8 = (val) => String(val).padStart(8, "0");
        const internalNumber =
            fiscal?.internalNumber ||
            (fiscal?.internalSeq ? pad8(fiscal.internalSeq) : "");
        const branchName =
            fiscal?.branchName ||
            tenant?.fiscal?.defaultBranchName ||
            "Principal";
        const emissionPoint =
            fiscal?.emissionPoint ||
            tenant?.fiscal?.defaultEmissionPoint ||
            "001";

        // Expiration: primero lo que quedó en la orden; si no existe, lo tomamos del tenant config
        const fallbackExpiresAt =
            tenant?.fiscal?.ncfConfig?.[ncfType]?.expiresAt ||
            tenant?.fiscal?.ncfConfig?.[ncfType]?.expirationDate ||
            null;

        const expirationDate =
            fiscal?.expirationDate ||
            fiscal?.expiresAt ||
            fallbackExpiresAt;

        const invoiceTitle = hasNCF ? "Factura con Comprobante Fiscal" : "Factura";
        const ncfLabel = NCF_TYPE_LABEL[ncfType] ? `${ncfType} - ${NCF_TYPE_LABEL[ncfType]}` : ncfType;


        // ----- customer -----
        const customerName =
            order?.customerDetails?.name ||
            order?.client?.name ||
            "Consumidor Final";

        const customerRnc =
            order?.customerDetails?.rncCedula ||
            order?.customerDetails?.rnc ||
            order?.client?.rnc ||
            order?.customerRNC ||
            "";



    // ----- totals -----
        const items = Array.isArray(order?.items) ? order.items : [];
        const computedSubtotal = items.reduce((acc, it) => acc + getLineNet(it), 0);

        const subtotal = Number(order?.bills?.subtotal ?? computedSubtotal);
        const discount = Number(order?.bills?.discount ?? 0);
        const tip = Number(order?.bills?.tipAmount ?? order?.bills?.tip ?? 0);
        const totalTax = Number(order?.bills?.tax ?? 0);

        // ADD:
        const taxRate = getTaxRate(order);
        const taxEnabled = Number(totalTax) > 0;
    // total real (con ITBIS + propina) viene como totalWithTax en tu backend
        const grandTotal = Number(
            order?.bills?.totalWithTax ??
            (Math.max(subtotal - discount, 0) + totalTax + tip)
        );

    // comisión delivery (si aplica)
        const source = String(order?.orderSource || "").toUpperCase();
        const isDelivery = source === "PEDIDOSYA" || source === "UBEREATS";
        const commissionAmount = Number(order?.commissionAmount ?? 0);

    // total a pagar: si es delivery, normalmente el cliente paga total + comisión
        const totalToPay = isDelivery ? (grandTotal + commissionAmount) : grandTotal;
        // ----- create pdf -----
        const doc = new PDFDocument({ size: "A4", margin: 50 });

        const tempDir = path.join(__dirname, "..", "temp");
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

        const fileName = `invoice_${orderId}.pdf`;
        const filePath = path.join(tempDir, fileName);

        const stream = fs.createWriteStream(filePath);
        doc.pipe(stream);

        // Header: business
        doc.fontSize(16).text(tenant?.business?.name || "Empresa", { align: "center" });
        doc.fontSize(10).text(`RNC: ${tenant?.business?.rnc || "N/A"}`, { align: "center" });
        doc.text(tenant?.business?.address || "", { align: "center" });
        doc.text(tenant?.business?.phone || "", { align: "center" });

        doc.moveDown(1);
        doc.fontSize(18).text(invoiceTitle, { align: "center" });

        if (hasNCF) {
            doc.moveDown(0.5);
            doc.fontSize(11).text(`Tipo NCF: ${ncfLabel}`, { align: "center" });
            doc.fontSize(11).text(`NCF: ${ncfNumber}`, { align: "center" });
        }

        doc.moveDown(1);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#e5e7eb").stroke();
        doc.moveDown(1);

        // Top details
        doc.fontSize(10).fillColor("#111827");

        if (hasNCF) {
            doc.text(`Factura No.: ${internalNumber || "N/A"}`);
            doc.text(`Sucursal: ${branchName} · Punto de emisión: ${emissionPoint}`);
        }

        doc.text(`Order ID: ${String(order?._id || "")}`);
        doc.text(`Fecha/Hora: ${formatDateTimeDO(order?.createdAt)}`);
        if (hasNCF) doc.text(`Vence (NCF): ${formatDateUTC(expirationDate)}`);

        doc.moveDown(0.5);
        doc.text(`Cliente: ${customerName}`);
        if (customerRnc) doc.text(`RNC/Cédula: ${customerRnc}`);

        doc.moveDown(1);

        // Table header
        const tableTop = doc.y;
        doc.fontSize(10).fillColor("#374151");
        doc.text("Descripción", 50, tableTop);
        doc.text("Cant.", 260, tableTop, { width: 60, align: "right" });
        doc.text("ITBIS", 340, tableTop, { width: 80, align: "right" });
        doc.text("Valor", 440, tableTop, { width: 100, align: "right" });
        doc.moveTo(50, tableTop + 15).lineTo(545, tableTop + 15).strokeColor("#e5e7eb").stroke();

        // Rows
        let y = tableTop + 25;
        doc.fontSize(10).fillColor("#111827");

        items.forEach((it) => {
            const qty = Number(it?.quantity || it?.qty || 0);

            const unitPrice =
                Number(it?.unitPrice ?? it?.pricePerQuantity ?? it?.price ?? 0);

            const lineTotal = qty * unitPrice;


            let lineTax = Number(it?.tax);
            if (isNaN(lineTax)) {
                if (taxEnabled) {
                    if (subtotal > 0 && totalTax > 0) lineTax = (lineTotal / subtotal) * totalTax;
                    else lineTax = lineTotal * taxRate;
                } else {
                    lineTax = 0;
                }
            }

            doc.text(it?.name || "Item", 50, y, { width: 200 });
            doc.text(String(qty), 260, y, { width: 60, align: "right" });
            doc.text(moneyRD(lineTax), 340, y, { width: 80, align: "right" });
            doc.text(moneyRD(unitPrice), 440, y, { width: 100, align: "right" });
            y += 18;
        });

        doc.moveDown(2);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#e5e7eb").stroke();
        doc.moveDown(0.8);

        // Totals
        doc.fontSize(10).fillColor("#111827");
        if (discount > 0) doc.text(`Descuento: -${moneyRD(discount)}`);
        doc.text(`Subtotal: ${moneyRD(subtotal)}`);
        doc.text(`Propina: ${moneyRD(tip)}`);
        doc.text(`ITBIS: ${moneyRD(totalTax)}`);

        if (isDelivery && commissionAmount > 0) {
            doc.text(`Comisión: ${moneyRD(commissionAmount)}`);
        }

        doc.font("Helvetica-Bold").text(`Total a pagar: ${moneyRD(totalToPay)}`);
        doc.font("Helvetica").text(`Método de pago: ${order?.paymentMethod || "N/A"}`);


        doc.end();

        // Wait file write
        await new Promise((resolve, reject) => {
            stream.on("finish", resolve);
            stream.on("error", reject);
        });

        // Upload to Supabase
        const storagePath = `invoices/tenant_${tenantId}/orders/${fileName}`;
        const fileBuffer = fs.readFileSync(filePath);

        const { error: uploadError } = await supabase.storage
            .from("invoices")
            .upload(storagePath, fileBuffer, { contentType: "application/pdf", upsert: true });

        if (uploadError) throw uploadError;

        const { data: publicData } = supabase.storage.from("invoices").getPublicUrl(storagePath);
        const publicUrl = publicData?.publicUrl || null;

        console.log("[PDF] URL pública generada:", publicUrl);

        // Cleanup temp
        try { fs.unlinkSync(filePath); } catch (_) {}

        return publicUrl;
    } catch (err) {
        console.error("[PDF] Error generando invoice PDF:", err);
        throw err;
    }
}

module.exports = generateInvoicePDF;
