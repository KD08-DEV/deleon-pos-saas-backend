// pos-backend/utils/generateInvoicePDF.js
const path = require("path");
const fs = require("fs");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

const Order = require("../models/orderModel");
const Tenant = require("../models/tenantModel");
const  supabase  = require("../config/supabaseClient");

async function generateInvoicePDF(orderId, tenantId) {
    console.log("[PDF] >>> generateInvoicePDF llamado con orderId:", orderId,"tenant:", tenantId);

    orderId = orderId.toString();
    const order = await Order.findById(orderId).lean();
    if (!order) throw new Error("Orden no encontrada");

    // =======================
    // 1) DATOS DEL TENANT / NEGOCIO
    // =======================

// OJO: tenantId es un UUID (tenantid), NO el _id de Mongo
    const tenantDoc = await Tenant.findOne({ tenantId }).lean();


    const business = (tenantDoc && tenantDoc.business) || {};

    const restaurantName =
        (business.name && business.name.trim()) ||
        (tenantDoc && tenantDoc.name) ||
        "Restaurant";

    const restaurantRNC =
        (business.rnc && business.rnc.trim()) || "N/A";

    const restaurantAddress =
        (business.address && business.address.trim()) ||
        "Dirección no disponible";

    const restaurantPhone =
        (business.phone && business.phone.trim()) || "";


    // =======================
    // 2) CREAR PDF
    // =======================
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595.28, 841.89]); // A4

    const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const marginLeft = 70;
    let y = 780;

    // =======================
    // 3) ENCABEZADO DEL NEGOCIO
    // =======================
    page.drawText(restaurantName, {
        x: marginLeft,
        y,
        size: 14,
        font: boldFont
    });
    y -= 16;

    page.drawText(`RNC: ${restaurantRNC}`, {
        x: marginLeft,
        y,
        size: 10,
        font: regularFont
    });
    y -= 12;

    page.drawText(restaurantAddress, {
        x: marginLeft,
        y,
        size: 10,
        font: regularFont
    });
    y -= 12;

    if (restaurantPhone) {
        page.drawText(`Tel: ${restaurantPhone}`, {
            x: marginLeft,
            y,
            size: 10,
            font: regularFont
        });
        y -= 16;
    } else {
        y -= 8;
    }

    // =======================
    // 4) TÍTULO DE LA FACTURA
    // =======================
    page.drawText("Factura para Consumidor Final", {
        x: marginLeft,
        y,
        size: 14,
        font: boldFont
    });
    y -= 14;

    page.drawText("Gracias por su compra", {
        x: marginLeft,
        y,
        size: 10,
        font: regularFont
    });
    y -= 20;

    // =======================
    // 5) DATOS DE LA ORDEN
    // =======================
    const createdAt = order.createdAt
        ? new Date(order.createdAt)
        : new Date();

    // Formato simple de fecha/hora
    const fechaStr = createdAt.toLocaleDateString("es-DO", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    });
    const horaStr = createdAt.toLocaleTimeString("es-DO", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true
    });

    const clientName =
        (order.customerDetails &&
            order.customerDetails.name &&
            order.customerDetails.name.trim()) ||
        "Consumidor Final";

    page.drawText(`Order ID: ${order._id}`, {
        x: marginLeft,
        y,
        size: 10,
        font: regularFont
    });
    y -= 12;

    page.drawText(`Fecha/Hora: ${fechaStr} ${horaStr}`, {
        x: marginLeft,
        y,
        size: 10,
        font: regularFont
    });
    y -= 12;

    page.drawText(`Cliente: ${clientName}`, {
        x: marginLeft,
        y,
        size: 10,
        font: regularFont
    });
    y -= 20;

//---------------------------------------------
// 6) TABLA DETALLE DE CONSUMO (CORREGIDO)
//---------------------------------------------
    page.drawText("Detalle de consumo", {
        x: marginLeft,
        y,
        size: 11,
        font: boldFont
    });
    y -= 14;

// Columnas dinámicas según si hay ITBIS
    const showTaxColumn = order.bills?.taxEnabled === true;

    const colDesc = marginLeft;
    const colCant = marginLeft + 200;
    const colValor = marginLeft + 350;
    const colITBIS = showTaxColumn ? (marginLeft + 270) : null;

// Encabezados
    page.drawText("Descripción", { x: colDesc, y, size: 10, font: boldFont });
    page.drawText("Cant.", { x: colCant, y, size: 10, font: boldFont });

    if (showTaxColumn) page.drawText("ITBIS", { x: colITBIS, y, size: 10, font: boldFont });

    page.drawText("Valor", { x: colValor, y, size: 10, font: boldFont });
    y -= 10;

    page.drawLine({
        start: { x: marginLeft, y },
        end: { x: marginLeft + 430, y },
        thickness: 0.5
    });
    y -= 12;

// Items

// Sacamos subtotal y tasa efectiva de ITBIS
    const bills = order.bills || {};
    const subtotalLines = Number(bills.total || 0);  // lo que guardaste como total de líneas
    const totalTax = Number(bills.tax || 0);         // ITBIS total que calculó el backend
    const taxRate = subtotalLines > 0 ? totalTax / subtotalLines : 0;
    const items = order.items || [];

    items.forEach((item) => {
        const name = item.name || "Producto";
        const quantity = Number(item.quantity || 0);
        const unit = Number(item.unitPrice || 0);
        const lineTotal = unit * quantity;

        page.drawText(name, { x: colDesc, y, size: 10, font: regularFont });
        page.drawText(String(quantity), { x: colCant, y, size: 10, font: regularFont });

        if (showTaxColumn) {
            // ITBIS proporcional a lo que vale la línea
            const lineTax = lineTotal * taxRate;
            page.drawText(`RD$${lineTax.toFixed(2)}`, {
                x: colITBIS,
                y,
                size: 10,
                font: regularFont
            });
        }

        page.drawText(`RD$${unit.toFixed(2)}`, { x: colValor, y, size: 10, font: regularFont });
        y -= 14;
    });

    y -= 10;


//---------------------------------------------
// 7) RESUMEN (USAR SÓLO VALORES DEL BACKEND)
//---------------------------------------------
    const subtotal = Number(bills.total || 0);
    const discount = Number(bills.discount || 0);
    const tax = Number(bills.tax || 0);
    const tipAmount = Number(
        bills.tipAmount ??    // nuevo formato correcto
        bills.tip ??          // formato viejo que ya tienes en DB
        0
    );
    const totalToPay = Number(bills.totalWithTax || subtotal + tax + tipAmount);
    const paymentMethod = order.paymentMethod || "N/A";

    function drawSummary(label, value, bold = false) {
        page.drawText(label, {
            x: marginLeft,
            y,
            size: 10,
            font: bold ? boldFont : regularFont
        });
        page.drawText(`RD$${value.toFixed(2)}`, {
            x: marginLeft + 130,
            y,
            size: 10,
            font: bold ? boldFont : regularFont
        });
        y -= 12;
    }

// Mostrar SIEMPRE subtotal
    drawSummary("Subtotal:", subtotal);

// Descuento si existe
    if (discount > 0) drawSummary("Descuento:", discount);

// Mostrar ITBIS solo si realmente hay impuesto (> 0)
// (se activará/desactivará según el cálculo del backend)
    if (tax > 0) {
        drawSummary("ITBIS (18%):", tax);
    }

// Propina si existe
    if (tipAmount > 0) {
        drawSummary("Propina:", tipAmount);
    }


    drawSummary("Total a pagar:", totalToPay, true);

    page.drawText(`Método de pago: ${paymentMethod}`, {
        x: marginLeft,
        y,
        size: 10,
        font: regularFont
    });
    y -= 20;

    page.drawText("------------------------------", {
        x: marginLeft, y, size: 10
    });
    y -= 12;

    page.drawText("Gracias por su compra", {
        x: marginLeft, y, size: 10
    });

    // =======================
    // 8) GUARDAR PDF
    // =======================
    console.log("ORDER ID FINAL:", orderId, "tipo:", typeof orderId);
    const fileName = `invoice_${orderId}.pdf`;
    const filePath = `tenant_${tenantId}/orders/${fileName}`;
    const outputPath = path.join(
        __dirname,
        "../uploads/invoices",
        fileName
    );

    const pdfBytes = await pdfDoc.save();




    const { error } = await supabase.storage
        .from("invoices")
        .upload(filePath, pdfBytes, {
            contentType: "application/pdf",
            upsert: true,
        });

    if (error) {
        console.error("[PDF] Error subiendo PDF:", error);
        throw error;
    }

    // Obtener URL pública
    const { data: publicUrlData } = supabase.storage
        .from("invoices")
        .getPublicUrl(filePath);

    console.log("[PDF] URL pública generada:", publicUrlData.publicUrl);

// Retornar objeto compatible con updateOrder()
    return {
        path: filePath,
        url: publicUrlData.publicUrl
    };
}


module.exports = { generateInvoicePDF };
