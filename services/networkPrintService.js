const net = require("net");

function safe(value = "") {
    if (value === null || value === undefined) return "";
    return String(value);
}

function toMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "0.00";
    return n.toFixed(2);
}

function padRight(text = "", width = 0) {
    const str = safe(text);
    if (str.length >= width) return str.slice(0, width);
    return str + " ".repeat(width - str.length);
}

function padLeft(text = "", width = 0) {
    const str = safe(text);
    if (str.length >= width) return str.slice(0, width);
    return " ".repeat(width - str.length) + str;
}

function centerText(text = "", width = 42) {
    const str = safe(text).trim();
    if (!str) return "";
    if (str.length >= width) return str.slice(0, width);

    const totalSpaces = width - str.length;
    const left = Math.floor(totalSpaces / 2);
    const right = totalSpaces - left;

    return " ".repeat(left) + str + " ".repeat(right);
}

function divider(width = 42, char = "=") {
    return char.repeat(width);
}

function wrapText(text = "", width = 42) {
    const raw = safe(text).replace(/\r/g, "");
    if (!raw) return [""];

    const paragraphs = raw.split("\n");
    const lines = [];

    for (const paragraph of paragraphs) {
        const clean = paragraph.trim();

        if (!clean) {
            lines.push("");
            continue;
        }

        const words = clean.split(/\s+/);
        let current = "";

        for (const word of words) {
            if (!current) {
                if (word.length <= width) {
                    current = word;
                } else {
                    for (let i = 0; i < word.length; i += width) {
                        lines.push(word.slice(i, i + width));
                    }
                    current = "";
                }
                continue;
            }

            const test = `${current} ${word}`;
            if (test.length <= width) {
                current = test;
            } else {
                lines.push(current);
                if (word.length <= width) {
                    current = word;
                } else {
                    for (let i = 0; i < word.length; i += width) {
                        lines.push(word.slice(i, i + width));
                    }
                    current = "";
                }
            }
        }

        if (current) lines.push(current);
    }

    return lines.length ? lines : [""];
}

function buildTicketText({
                             businessName,
                             rnc,
                             address,
                             phone,
                             title = "",
                             orderId,
                             mesa,
                             mesero,
                             fecha,
                             salaArea,
                             orderNote,
                             items = [],
                             subtotal,
                             tax,
                             total,
                             paymentMethod,
                             showTotals = false,
                         }) {
    const width = 42;
    const lines = [];

    if (businessName) lines.push(centerText(businessName, width));
    if (rnc) lines.push(centerText(`RNC: ${safe(rnc)}`, width));
    if (address) wrapText(address, width).forEach((line) => lines.push(centerText(line, width)));
    if (phone) lines.push(centerText(`Tel: ${safe(phone)}`, width));

    lines.push(divider(width, "-"));

    if (orderId) lines.push(`${padRight("Operación:", 12)} ${safe(orderId)}`);
    if (mesa !== undefined) lines.push(`${padRight("Mesa:", 12)} ${safe(mesa || "N/A")}`);
    if (fecha) lines.push(`${padRight("Fecha:", 12)} ${safe(fecha)}`);
    if (mesero !== undefined) lines.push(`${padRight("Mesero:", 12)} ${safe(mesero || "N/A")}`);
    if (salaArea !== undefined) lines.push(`${padRight("Sala/Área:", 12)} ${safe(salaArea || "N/A")}`);

    lines.push(divider(width, "-"));

    if (title && safe(title).trim()) {
        lines.push(centerText(safe(title).toUpperCase(), width));
        lines.push(divider(width, "-"));
    }

    for (const item of items) {
        const qty = item?.qty ?? item?.quantity ?? item?.amount ?? item?.cant ?? 1;
        const name = item?.name ?? item?.title ?? item?.description ?? "ITEM";

        lines.push(`x${safe(qty)} ${safe(name).toUpperCase()}`);

        if (Array.isArray(item?.modifiers) && item.modifiers.length) {
            for (const mod of item.modifiers) {
                const modName = mod?.name ?? mod?.title ?? mod?.description ?? "Modificador";
                wrapText(`• ${modName}`, width - 2).forEach((line) => lines.push(`  ${line}`));
            }
        }

        lines.push("");
    }

    lines.push(divider(width, "-"));

    if (orderNote && safe(orderNote).trim()) {
        lines.push("NOTA DEL PEDIDO");
        wrapText(orderNote, width).forEach((line) => lines.push(line));
        lines.push(divider(width, "-"));
    }

    if (showTotals) {
        if (subtotal !== undefined && subtotal !== null) {
            lines.push(`${padRight("Subtotal", 24)}${padLeft(toMoney(subtotal), 18)}`);
        }
        if (tax !== undefined && tax !== null) {
            lines.push(`${padRight("ITBIS", 24)}${padLeft(toMoney(tax), 18)}`);
        }
        if (total !== undefined && total !== null) {
            lines.push(`${padRight("Total", 24)}${padLeft(toMoney(total), 18)}`);
        }
        if (paymentMethod) {
            lines.push(`${padRight("Pago", 24)}${padLeft(safe(paymentMethod), 18)}`);
        }
        lines.push(divider(width, "-"));
    }

    lines.push(centerText("FIN PEDIDO", width));
    lines.push(centerText("Gracias por su compra", width));

    return lines.join("\n");
}

function buildInvoiceText({
                              businessName,
                              rnc,
                              address,
                              phone,
                              headerTitle,
                              isFiscal = false,
                              isPreInvoice = false,
                              ncfType,
                              ncfNumber,
                              facturaNo,
                              branchName,
                              emissionPoint,
                              expirationDate,
                              orderId,
                              fechaHora,
                              mesa,
                              mesero,
                              salaArea,
                              clientName,
                              clientPhone,
                              clientAddress,
                              clientRnc,
                              taxEnabled = true,
                              paymentMethod,
                              items = [],
                              subtotal = 0,
                              discount = 0,
                              tip = 0,
                              tax = 0,
                              isAppDelivery = false,
                              commissionPct = 0,
                              commissionAmount = 0,
                              showShipping = false,
                              shippingFee = 0,
                              totalToPay = 0,
                          }) {
    const width = 42;
    const lines = [];

    if (businessName) lines.push(centerText(businessName, width));
    if (rnc) lines.push(centerText(`RNC: ${safe(rnc)}`, width));
    if (address) wrapText(address, width).forEach((line) => lines.push(centerText(line, width)));
    if (phone) lines.push(centerText(`Tel: ${safe(phone)}`, width));

    lines.push("");

    if (headerTitle) {
        wrapText(headerTitle, width).forEach((line) => lines.push(centerText(line, width)));
    } else if (isFiscal) {
        lines.push(centerText("FACTURA CON COMPROBANTE FISCAL", width));
    } else if (isPreInvoice) {
        lines.push(centerText("PREFACTURA", width));
    } else {
        lines.push(centerText("FACTURA PARA CONSUMIDOR FINAL", width));
    }

    if (isFiscal) {
        if (ncfType) lines.push(centerText(`Tipo NCF: ${safe(ncfType)}`, width));
        if (ncfNumber) lines.push(centerText(`NCF: ${safe(ncfNumber)}`, width));
    }

    lines.push(centerText("Gracias por su compra", width));
    lines.push(divider(width, "-"));

    if (facturaNo) lines.push(`Factura No.: ${safe(facturaNo)}`);
    if (mesa && mesa !== "N/A") lines.push(`Mesa: ${safe(mesa)}`);
    if (mesero && mesero !== "N/A") lines.push(`Mesero: ${safe(mesero)}`);
    if (salaArea && salaArea !== "N/A") lines.push(`Sala/Área: ${safe(salaArea)}`);

    if (branchName || emissionPoint) {
        lines.push(`Sucursal: ${safe(branchName || "Principal")}`);
        lines.push(`Punto emision: ${safe(emissionPoint || "001")}`);
    }

    if (orderId) lines.push(`Order ID: ${safe(orderId)}`);
    if (fechaHora) lines.push(`Fecha/Hora: ${safe(fechaHora)}`);

    if (isFiscal) {
        lines.push(`Fecha de Vencimiento: ${safe(expirationDate || "N/A")}`);
    }

    lines.push(`Cliente: ${safe(clientName || "Consumidor Final")}`);
    if (clientPhone) lines.push(`Teléfono: ${safe(clientPhone)}`);
    if (clientAddress) {
        lines.push("Dirección:");
        wrapText(clientAddress, width).forEach((line) => lines.push(line));
    }
    if (clientRnc) lines.push(`RNC/Cédula: ${safe(clientRnc)}`);

    lines.push(divider(width, "-"));
    lines.push("DETALLE DE CONSUMO");
    lines.push(divider(width, "-"));

    for (const item of items) {
        const name = safe(item?.name || "Producto");
        const qty = Number(item?.qty || 1);
        const unitPrice = Number(item?.unitPrice || 0);
        const itemTax = Number(item?.tax || 0);

        wrapText(name, width).forEach((line) => lines.push(line));
        lines.push(`Cant: ${qty}`);

        if (taxEnabled) {
            lines.push(`${padRight("ITBIS:", 10)}${padLeft(`RD$${toMoney(itemTax)}`, width - 10)}`);
        }

        lines.push(`${padRight("Valor:", 10)}${padLeft(`RD$${toMoney(unitPrice)}`, width - 10)}`);
        lines.push("");
    }

    lines.push(divider(width, "-"));
    lines.push(`${padRight("Subtotal:", 18)}${padLeft(`RD$${toMoney(subtotal)}`, width - 18)}`);

    if (Number(discount) > 0) {
        lines.push(`${padRight("Descuento:", 18)}${padLeft(`-RD$${toMoney(discount)}`, width - 18)}`);
    }
    if (Number(tip) > 0) {
        lines.push(`${padRight("Propina Legal:", 18)}${padLeft(`RD$${toMoney(tip)}`, width - 18)}`);
    }
    if (taxEnabled && Number(tax) > 0) {
        lines.push(`${padRight("ITBIS:", 18)}${padLeft(`RD$${toMoney(tax)}`, width - 18)}`);
    }
    if (isAppDelivery && Number(commissionAmount) > 0) {
        lines.push(
            `${padRight(`Comisión (${safe(commissionPct)}%):`, 18)}${padLeft(`RD$${toMoney(commissionAmount)}`, width - 18)}`
        );
    }
    if (showShipping && Number(shippingFee) > 0) {
        lines.push(`${padRight("Envío:", 18)}${padLeft(`RD$${toMoney(shippingFee)}`, width - 18)}`);
    }

    lines.push(divider(width, "-"));
    lines.push(`${padRight("TOTAL A PAGAR:", 18)}${padLeft(`RD$${toMoney(totalToPay)}`, width - 18)}`);

    if (paymentMethod) {
        lines.push(`${padRight("Método pago:", 18)}${padLeft(safe(paymentMethod), width - 18)}`);
    }

    return lines.join("\n");
}

function buildEscPosText(text = "") {
    const safeText = safe(text).replace(/\r\n/g, "\n");

    const ESC = "\x1B";
    const GS = "\x1D";

    const payload =
        ESC + "@" +
        ESC + "a" + "\x00" +
        safeText +
        "\n\n\n\n" +
        GS + "V" + "\x01";

    return Buffer.from(payload, "binary");
}

function sendToNetworkPrinter({ ip, port = 9100, payload, timeoutMs = 12000 }) {
    return new Promise((resolve, reject) => {
        if (!ip) {
            return reject(new Error("PRINTER_IP_REQUIRED"));
        }

        const socket = new net.Socket();
        let settled = false;
        let connected = false;
        let writeDone = false;

        const cleanup = () => {
            socket.removeAllListeners("connect");
            socket.removeAllListeners("timeout");
            socket.removeAllListeners("error");
            socket.removeAllListeners("close");
        };

        const succeed = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({
                ok: true,
                message: "Impresión exitosa",
                ip,
                port: Number(port || 9100),
            });
        };

        const fail = (err) => {
            if (settled) return;
            settled = true;
            cleanup();
            try {
                socket.destroy();
            } catch {}
            reject(err);
        };

        socket.setTimeout(Number(timeoutMs || 12000));
        socket.setNoDelay(true);
        socket.setKeepAlive(false);

        socket.on("connect", () => {
            connected = true;

            const bufferPayload = Buffer.isBuffer(payload)
                ? payload
                : Buffer.from(safe(payload), "binary");

            socket.write(bufferPayload, (err) => {
                if (err) return fail(err);

                writeDone = true;

                setTimeout(() => {
                    try {
                        socket.end();
                    } catch (e) {
                        return fail(e);
                    }
                }, 250);
            });
        });

        socket.on("timeout", () => {
            fail(new Error(connected ? "NETWORK_PRINT_TIMEOUT_AFTER_CONNECT" : "NETWORK_CONNECT_TIMEOUT"));
        });

        socket.on("error", (err) => {
            fail(err);
        });

        socket.on("close", (hadError) => {
            if (settled) return;

            if (hadError) {
                return fail(new Error("NETWORK_SOCKET_CLOSED_WITH_ERROR"));
            }

            if (connected && writeDone) {
                return succeed();
            }

            return fail(new Error("NETWORK_SOCKET_CLOSED_BEFORE_PRINT_COMPLETED"));
        });

        socket.connect(Number(port || 9100), ip);
    });
}

module.exports = {
    buildEscPosText,
    buildTicketText,
    buildInvoiceText,
    sendToNetworkPrinter,
};