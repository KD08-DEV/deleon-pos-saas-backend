const PDFDocument = require("pdfkit");
const { invoiceLineBreakdown } = require("./invoiceExtras");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const Order = require("../models/orderModel");
const Tenant = require("../models/tenantModel");
const QRCode = require("qrcode");

const { supabase } = require("../config/supabaseClient"); // ajusta si tu import es distinto
const ElectronicTaxDocument = require("../models/electronicTaxDocumentModel");

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

const getPdfLocalization = (
    tenant = {}
) => {
    const raw =
        tenant?.localization ||
        {};

    return {
        countryCode:
            String(
                raw.countryCode ||
                "DO"
            )
                .trim()
                .toUpperCase(),
        weightUnit:
            raw.weightUnit ||
            (
                raw.measurementSystem ===
                "metric"
                    ? "kg"
                    : "lb"
            ),

        locale:
            String(
                raw.locale ||
                "es-DO"
            ).trim(),

        currency:
            String(
                raw.currency ||
                "DOP"
            )
                .trim()
                .toUpperCase(),

        timezone:
            String(
                raw.timezone ||
                "America/Santo_Domingo"
            ).trim(),

        timeFormat:
            raw.timeFormat ===
            "24h"
                ? "24h"
                : "12h",
    };
};

// ======================================================
// TAX IDENTITY PARA PDF
// ======================================================

const normalizePdfTaxIdentity = (
    raw,
    fallbackCountryCode = ""
) => {
    if (
        !raw ||
        typeof raw !== "object"
    ) {
        return null;
    }


    const source =
        raw?.primaryTaxId &&
        typeof raw.primaryTaxId === "object"
            ? raw.primaryTaxId
            : raw;


    const value =
        String(
            source?.value ||
            ""
        ).trim();


    if (!value) {
        return null;
    }


    const type =
        String(
            source?.type ||
            "TAX_ID"
        )
            .trim()
            .toUpperCase();


    return {
        countryCode:
            String(
                source?.countryCode ||
                raw?.countryCode ||
                fallbackCountryCode ||
                ""
            )
                .trim()
                .toUpperCase(),

        type,

        label:
            String(
                source?.label ||
                type ||
                "Tax ID"
            ).trim(),

        value,
    };
};


// ======================================================
// NEGOCIO
// ======================================================

const getPdfBusinessTaxIdentity = (
    tenant = {}
) => {
    if (
        tenant
            ?.taxIdentity
            ?.enabled === true
    ) {
        const identity =
            normalizePdfTaxIdentity(
                tenant.taxIdentity,

                tenant
                    ?.taxIdentity
                    ?.countryCode ||
                tenant
                    ?.localization
                    ?.countryCode ||
                ""
            );


        if (identity) {
            return identity;
        }
    }


    const legacy =
        String(
            tenant
                ?.business
                ?.rnc ||
            tenant
                ?.fiscal
                ?.rnc ||
            ""
        ).trim();


    if (!legacy) {
        return null;
    }


    return {
        countryCode:
            "DO",

        type:
            "RNC",

        label:
            "RNC",

        value:
        legacy,
    };
};


// ======================================================
// CLIENTE
// ======================================================

const getPdfCustomerTaxIdentity = (
    order = {}
) => {
    const identity =
        normalizePdfTaxIdentity(
            order
                ?.customerDetails
                ?.taxIdentity
        );


    if (identity) {
        return identity;
    }


    const legacy =
        String(
            order
                ?.customerDetails
                ?.rncCedula ||
            order
                ?.customerDetails
                ?.rnc ||
            order
                ?.customerRNC ||
            ""
        ).trim();


    if (!legacy) {
        return null;
    }


    const digits =
        legacy.replace(
            /\D/g,
            ""
        );


    let type =
        "RNC_CEDULA";

    let label =
        "RNC / Cédula";


    if (
        digits.length === 9
    ) {
        type =
            "RNC";

        label =
            "RNC";
    }


    if (
        digits.length === 11
    ) {
        type =
            "CEDULA";

        label =
            "Cédula";
    }


    return {
        countryCode:
            "DO",

        type,

        label,

        value:
        legacy,
    };
};

const money = (
    value,
    localization = {}
) => {
    const amount =
        Number(value);

    const safeAmount =
        Number.isFinite(
            amount
        )
            ? amount
            : 0;

    const locale =
        localization?.locale ||
        "es-DO";

    const currency =
        localization?.currency ||
        "DOP";

    try {
        return new Intl.NumberFormat(
            locale,
            {
                style:
                    "currency",

                currency,
            }
        ).format(
            safeAmount
        );
    } catch {
        return `${currency} ${safeAmount.toFixed(
            2
        )}`;
    }
};const MAX_LOGO_BYTES = 2 * 1024 * 1024;

const downloadImageBuffer = (url) => {
    return new Promise((resolve, reject) => {
        try {
            if (!url) return resolve(null);

            const parsed = new URL(url);
            const client = parsed.protocol === "https:" ? https : http;

            if (!["http:", "https:"].includes(parsed.protocol)) {
                return reject(new Error("LOGO_URL_INVALID"));
            }

            const req = client.get(parsed, (res) => {
                const statusCode = Number(res.statusCode || 0);

                if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location) {
                    const redirectUrl = new URL(res.headers.location, parsed).toString();
                    res.resume();
                    return resolve(downloadImageBuffer(redirectUrl));
                }

                if (statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`LOGO_DOWNLOAD_FAILED_${statusCode}`));
                }

                const contentType = String(res.headers["content-type"] || "")
                    .split(";")[0]
                    .toLowerCase();

                if (!["image/png", "image/jpeg", "image/jpg"].includes(contentType)) {
                    res.resume();
                    return reject(new Error("LOGO_CONTENT_TYPE_NOT_SUPPORTED"));
                }

                const chunks = [];
                let total = 0;

                res.on("data", (chunk) => {
                    total += chunk.length;

                    if (total > MAX_LOGO_BYTES) {
                        req.destroy(new Error("LOGO_TOO_LARGE"));
                        return;
                    }

                    chunks.push(chunk);
                });

                res.on("end", () => {
                    resolve(Buffer.concat(chunks));
                });
            });

            req.setTimeout(8000, () => {
                req.destroy(new Error("LOGO_DOWNLOAD_TIMEOUT"));
            });

            req.on("error", reject);
        } catch (error) {
            reject(error);
        }
    });
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

const formatDateTime = (
    dateLike,
    localization
) => {
    const date =
        normalizeMongoDate(
            dateLike
        );

    if (!date) {
        return "N/A";
    }

    try {
        return new Intl.DateTimeFormat(
            localization.locale,
            {
                timeZone:
                localization.timezone,

                day:
                    "2-digit",

                month:
                    "2-digit",

                year:
                    "numeric",

                hour:
                    "2-digit",

                minute:
                    "2-digit",

                hour12:
                    localization
                        .timeFormat !==
                    "24h",
            }
        ).format(
            date
        );
    } catch {
        return date.toLocaleString();
    }
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
        const businessTaxIdentity =
            getPdfBusinessTaxIdentity(
                tenant
            );


        const businessTaxLabel =
            businessTaxIdentity
                ?.label ||
            businessTaxIdentity
                ?.type ||
            "Tax ID";


        const businessTaxValue =
            businessTaxIdentity
                ?.value ||
            "";
        const localization =
            getPdfLocalization(
                tenant
            );
        const moneyPdf =
            (value) =>
                money(
                    value,
                    localization
                );
        if (!tenant) throw new Error("Tenant no encontrado para generar PDF.");

        const ecfDoc = await ElectronicTaxDocument.findOne({
            tenantId,
            orderId: order._id,
            sourceDocumentType: "ORDER",
        }).sort({ createdAt: -1 }).lean();

        const hasEcf = Boolean(ecfDoc?.ecf?.eNCF);

        const ecfStatusLabelMap = {
            draft: "Borrador",
            xml_generated: "XML generado",
            signed: "Firmado",
            submitted: "Enviado",
            track_received: "Track recibido",
            accepted: "Aceptado",
            accepted_with_observation: "Aceptado con observación",
            rejected: "Rechazado",
            cancelled: "Cancelado",
        };

        const ecfENCF = ecfDoc?.ecf?.eNCF || "";
        const ecfStatus = ecfStatusLabelMap[ecfDoc?.ecf?.status] || ecfDoc?.ecf?.status || "";
        const ecfTrackId = ecfDoc?.ecf?.trackId || "";
        const ecfSecurityCode = ecfDoc?.ecf?.securityCode || "";
        const ecfQrUrl = ecfDoc?.ecf?.qrUrl || "";
        const ecfFechaHoraFirma = ecfDoc?.ecf?.fechaHoraFirma || "";

        // ----- fiscal fields -----
        const fiscal = order?.fiscal || {};
        const hasNCF = Boolean(fiscal?.ncfNumber || order?.ncfNumber);
        const ncfType = fiscal?.ncfType || order?.ncfType || "";
        const ncfNumber = fiscal?.ncfNumber || order?.ncfNumber || "";
        const pad8 = (val) => String(val).padStart(8, "0");

        const rawInvoiceNumber =
            order?.facturaNo ||
            order?.invoiceNumber ||
            order?.invoiceNo ||
            fiscal?.facturaNo ||
            fiscal?.invoiceNumber ||
            fiscal?.invoiceNo ||
            fiscal?.internalNumber ||
            fiscal?.internalSeq ||
            "";

        const internalNumber =
            rawInvoiceNumber && /^\d+$/.test(String(rawInvoiceNumber))
                ? pad8(rawInvoiceNumber)
                : String(rawInvoiceNumber || "");
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

        // ✅ PreFactura: se activa si viene en la orden o si el tenant lo tiene como default
        const isPreInvoice =
            Boolean(fiscal?.preInvoice) ||
            Boolean(tenant?.features?.preInvoice?.enabled);

        const invoiceTitle = hasEcf
            ? "Factura Electrónica e-CF"
            : hasNCF
                ? "Factura con Comprobante Fiscal"
                : isPreInvoice
                    ? "PreFactura"
                    : "Factura para Consumidor Final";

        const ncfLabel = NCF_TYPE_LABEL[ncfType] ? `${ncfType} - ${NCF_TYPE_LABEL[ncfType]}` : ncfType;


        // ----- customer -----
        const customerName =
            order?.customerDetails?.name ||
            order?.client?.name ||
            "Consumidor Final";

        const customerTaxIdentity =
            getPdfCustomerTaxIdentity(
                order
            );


        const customerTaxLabel =
            customerTaxIdentity
                ?.label ||
            customerTaxIdentity
                ?.type ||
            "Tax ID";


        const customerTaxValue =
            customerTaxIdentity
                ?.value ||
            "";

        const customerPhone =
            order?.customerDetails?.phone ||
            "";

        const customerAddress =
            order?.customerDetails?.address ||
            "";



        // ----- totals -----
        const items = Array.isArray(order?.items) ? order.items : [];
        const computedSubtotal = items.reduce((acc, it) => acc + getLineNet(it), 0);

        const subtotal = Number(order?.bills?.subtotal ?? computedSubtotal);
        const discount = Number(order?.bills?.discount ?? 0);
        const tip = Number(order?.bills?.tipAmount ?? order?.bills?.tip ?? 0);
        const totalTax = Number(order?.bills?.tax ?? 0);
        const taxBreakdown =
            Array.isArray(
                order?.bills
                    ?.taxBreakdown
            )
                ? order.bills
                    .taxBreakdown
                : [];

        const serviceChargeBreakdown =
            Array.isArray(
                order?.bills
                    ?.serviceChargeBreakdown
            )
                ? order.bills
                    .serviceChargeBreakdown
                : [];

        const serviceChargeTotal =
            Number(
                order?.bills
                    ?.serviceChargeTotal ??
                0
            );

        const resolvedTaxLabel =
            taxBreakdown.length === 1
                ? String(
                    taxBreakdown[0]
                        ?.name ||
                    taxBreakdown[0]
                        ?.code ||
                    "Impuestos"
                )
                : "Impuestos";
        const deliveryFee = Number(order?.bills?.deliveryFee ?? 0);


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
        const totalToPay =
            grandTotal;
        // ----- create pdf -----
        const doc = new PDFDocument({ size: "A4", margin: 50 });

        const tempDir = path.join(__dirname, "..", "temp");
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

        const fileName = `invoice_${orderId}.pdf`;
        const filePath = path.join(tempDir, fileName);

        const stream = fs.createWriteStream(filePath);
        doc.pipe(stream);

        // Header: business
// Header: logo + business
        const businessLogoUrl = tenant?.business?.logoUrl || "";

        if (businessLogoUrl) {
            try {
                const logoBuffer = await downloadImageBuffer(businessLogoUrl);

                if (logoBuffer) {
                    const logoWidth = 120;
                    const logoHeight = 60;
                    const logoX = (doc.page.width - logoWidth) / 2;
                    const logoY = doc.y;

                    doc.image(logoBuffer, logoX, logoY, {
                        fit: [logoWidth, logoHeight],
                        align: "center",
                        valign: "center",
                    });

                    doc.y = logoY + logoHeight + 8;
                }
            } catch (logoError) {
                console.warn("[PDF] No se pudo insertar logo:", logoError?.message);
            }
        }

        doc.fontSize(16).text(tenant?.business?.name || "Empresa", { align: "center" });
        if (
            businessTaxValue
        ) {
            doc
                .fontSize(10)
                .text(
                    `${businessTaxLabel}: ${businessTaxValue}`,
                    {
                        align:
                            "center",
                    }
                );
        }
        doc.text(tenant?.business?.address || "", { align: "center" });
        doc.text(tenant?.business?.phone || "", { align: "center" });

        doc.moveDown(1);
        doc.fontSize(18).text(invoiceTitle, { align: "center" });

        if (hasEcf) {
            doc.moveDown(0.5);
            doc.fontSize(11).text(`eNCF: ${ecfENCF}`, { align: "center" });
            if (ecfStatus) doc.fontSize(10).text(`Estado e-CF: ${ecfStatus}`, { align: "center" });
            if (ecfTrackId) doc.fontSize(9).text(`TrackId: ${ecfTrackId}`, { align: "center" });
        } else if (hasNCF) {
            doc.moveDown(0.5);
            doc.fontSize(11).text(`Tipo NCF: ${ncfLabel}`, { align: "center" });
            doc.fontSize(11).text(`NCF: ${ncfNumber}`, { align: "center" });
        }
        if (ecfSecurityCode) {
            doc.fontSize(9).text(`Código de seguridad: ${ecfSecurityCode}`, { align: "center" });
        }

        if (ecfFechaHoraFirma) {
            doc.fontSize(9).text(`Fecha firma: ${ecfFechaHoraFirma}`, { align: "center" });
        }

        doc.moveDown(1);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#e5e7eb").stroke();
        doc.moveDown(1);

        // Top details
        doc.fontSize(10).fillColor("#111827");

        doc.text(`Factura No.: ${internalNumber || "N/A"}`);

        doc.text(`Sucursal: ${branchName} · Punto de emision: ${emissionPoint}`);

        doc.text(`Fecha/Hora: ${formatDateTime(
            order?.invoicedAt ||
            order?.paidAt ||
            order?.createdAt,
            localization
        )}`);

        if (hasEcf) {
            doc.text(`eNCF: ${ecfENCF || "N/A"}`);
            doc.text(`Estado e-CF: ${ecfStatus || "N/A"}`);
            doc.text(`TrackId: ${ecfTrackId || "N/A"}`);
        } else if (hasNCF) {
            doc.text(`Fecha de Vencimiento: ${formatDateUTC(expirationDate)}`);
        }

        doc.moveDown(0.5);
        doc.text(`Cliente: ${customerName}`);
        if (
            customerTaxValue
        ) {
            doc.text(
                `${customerTaxLabel}: ${customerTaxValue}`
            );
        }
        if (customerPhone) doc.text(`Teléfono: ${customerPhone}`);
        if (customerAddress) doc.text(`Dirección: ${customerAddress}`);


        doc.moveDown(1);

        // Table header
        const tableTop = doc.y;
        doc.fontSize(10).fillColor("#374151");

        doc.text("Descripción", 50, tableTop, { width: 230 });
        doc.text("Cant.", 285, tableTop, { width: 50, align: "right" });
        doc.text("Precio", 355, tableTop, { width: 80, align: "right" });
        doc.text("Importe", 455, tableTop, { width: 90, align: "right" });

        doc.moveTo(50, tableTop + 15)
            .lineTo(545, tableTop + 15)
            .strokeColor("#e5e7eb")
            .stroke();

// Rows: separate paid extra lines, never recompute billed totals.
        let y = tableTop + 25;
        doc.fontSize(10).fillColor("#111827");
        const ensureRoom = (height = 18) => {
            if (y + height > doc.page.height - 105) {
                doc.addPage();
                y = 55;
            }
        };
        items.forEach((it) => {
            const detail = invoiceLineBreakdown(it);
            const qtyLabel = it?.qtyType === "weight"
                ? `${detail.qty} ${it?.weightUnit || localization?.weightUnit || ""}`.trim()
                : String(detail.qty);
            const mainName = String(it?.name || "Item");
            doc.fontSize(10).fillColor("#111827");
            const mainHeight = Math.max(18, doc.heightOfString(mainName, { width: 225 }) + 5);
            ensureRoom(mainHeight);
            doc.text(mainName, 50, y, { width: 225 });
            doc.text(qtyLabel, 285, y, { width: 50, align: "right" });
            doc.text(moneyPdf(detail.mainUnitPrice), 355, y, { width: 80, align: "right" });
            doc.text(moneyPdf(detail.mainLineTotal), 455, y, { width: 90, align: "right" });
            y += mainHeight;

            for (const extra of detail.extras) {
                const label = `${extra.note ? "•" : "+"} ${extra.label}${extra.included ? " (incluido)" : ""}`;
                doc.fontSize(8).fillColor("#4b5563");
                const height = Math.max(15, doc.heightOfString(label, { width: 205 }) + 5);
                ensureRoom(height);
                doc.text(label, 64, y, { width: 205 });
                if (!extra.note) {
                    doc.text(String(extra.totalQty), 285, y, { width: 50, align: "right" });
                    doc.text(extra.unitPrice === null ? "—" : moneyPdf(extra.unitPrice), 355, y, { width: 80, align: "right" });
                    doc.text(extra.included || extra.lineTotal === null ? "—" : moneyPdf(extra.lineTotal), 455, y, { width: 90, align: "right" });
                }
                y += height;
            }
        });
        doc.y = Math.max(doc.y, y + 4);
        doc.fontSize(10).fillColor("#111827");

        doc.moveDown(2);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#e5e7eb").stroke();
        doc.moveDown(0.8);

        // Totals
        doc.fontSize(10).fillColor("#111827");
        if (discount > 0) doc.text(`Descuento: -${moneyPdf(discount)}`);
        doc.text(`Subtotal: ${moneyPdf(subtotal)}`);
        doc.text(`Propina: ${moneyPdf(tip)}`);
        if (
            totalTax > 0
        ) {
            doc.text(
                `${resolvedTaxLabel}: ${moneyPdf(
                    totalTax
                )}`
            );
        }

        if (
            serviceChargeBreakdown.length >
            0
        ) {
            serviceChargeBreakdown.forEach(
                (charge) => {
                    const amount =
                        Number(
                            charge?.amount ??
                            charge?.total ??
                            0
                        );

                    if (amount <= 0) {
                        return;
                    }

                    const name =
                        charge?.name ||
                        charge?.code ||
                        "Cargo por servicio";

                    doc.text(
                        `${name}: ${moneyPdf(
                            amount
                        )}`
                    );
                }
            );
        } else if (
            serviceChargeTotal > 0
        ) {
            doc.text(
                `Cargo por servicio: ${moneyPdf(
                    serviceChargeTotal
                )}`
            );
        }

        if (deliveryFee > 0) {
            doc.text(`Envío: ${moneyPdf(deliveryFee)}`);
        }



        doc.font("Helvetica-Bold").text(`Total a pagar: ${moneyPdf(totalToPay)}`);
        doc.font("Helvetica").text(`Método de pago: ${order?.paymentMethod || "N/A"}`);

        if (hasEcf && ecfQrUrl) {
            doc.moveDown(1);

            try {
                const qrBuffer = await QRCode.toBuffer(ecfQrUrl, {
                    type: "png",
                    width: 140,
                    margin: 1,
                });

                const qrX = (doc.page.width - 120) / 2;

                doc.image(qrBuffer, qrX, doc.y, {
                    width: 120,
                    height: 120,
                });

                doc.moveDown(8);
                doc.fontSize(8).text("Consulta e-CF DGII", {
                    align: "center",
                });

                if (ecfSecurityCode) {
                    doc.fontSize(8).text(`Código de seguridad: ${ecfSecurityCode}`, {
                        align: "center",
                    });
                }
            } catch (qrError) {
                console.error("[PDF] Error generando QR e-CF:", qrError);
                doc.fontSize(8).text(`Consulta e-CF: ${ecfQrUrl}`);
            }
        }

        doc.end();

        // Wait file write
        await new Promise((resolve, reject) => {
            stream.on("finish", resolve);
            stream.on("error", reject);
        });

        // Upload to Supabase
        const { invoiceStoragePaths } = require("./invoiceStoragePaths");
        const storagePath = invoiceStoragePaths(tenantId, orderId)[0];
        const fileBuffer = fs.readFileSync(filePath);

        const { error: uploadError } = await supabase.storage
            .from("invoices")
            .upload(storagePath, fileBuffer, { contentType: "application/pdf", upsert: true });

        if (uploadError) throw uploadError;

        // Private bucket: do not create public URLs, and do not persist a
        // short-lived signed URL in the order. The API will sign on each read.
        try { fs.unlinkSync(filePath); } catch (_) {}

        return { path: storagePath };
    } catch (err) {
        console.error("[PDF] Error generando invoice PDF:", err);
        throw err;
    }
}

module.exports = generateInvoicePDF;
