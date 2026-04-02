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
                             showItemPrices = false,
                             paperSize = "80mm",
                         }) {
    const width = getPaperWidth(paperSize);
    const lines = [];

    const normalizedTitle = String(title || "").trim().toUpperCase();
    const isProductionCommand =
        normalizedTitle === "BAR" ||
        normalizedTitle === "COCINA" ||
        normalizedTitle === "PRODUCCION";

    const effectiveShowItemPrices =
        isProductionCommand ? false : showItemPrices === true;

    const effectiveShowTotals =
        isProductionCommand ? false : showTotals === true;

    if (businessName) lines.push(centerText(businessName, width));
    if (rnc) lines.push(centerText(`RNC: ${safe(rnc)}`, width));
    if (address) wrapText(address, width).forEach((line) => lines.push(centerText(line, width)));
    if (phone) lines.push(centerText(`Tel: ${safe(phone)}`, width));

    lines.push(hr(width, "="));

    if (title && safe(title).trim()) {
        lines.push(centerText(safe(title).toUpperCase(), width));
        lines.push(hr(width, "-"));
    }

    if (orderId) lines.push(twoCols("Orden:", safe(orderId), width));
    if (mesa !== undefined) lines.push(twoCols("Mesa:", safe(mesa || "N/A"), width));
    if (fecha) lines.push(twoCols("Fecha:", safe(fecha), width));
    if (mesero !== undefined) lines.push(twoCols("Mesero:", safe(mesero || "N/A"), width));
    if (salaArea !== undefined) lines.push(twoCols("Sala/Area:", safe(salaArea || "N/A"), width));

    lines.push(hr(width, "-"));

    for (const item of items) {
        const qty = item?.qty ?? item?.quantity ?? item?.amount ?? item?.cant ?? 1;
        const name = item?.name ?? item?.title ?? item?.description ?? "ITEM";

        if (isProductionCommand) {
            wrapText(`${safe(qty)} x ${String(name).toUpperCase()}`, width).forEach((line) =>
                lines.push(line)
            );
        } else {
            const rawAmount =
                item?.total ??
                item?.price ??
                item?.unitPrice ??
                null;

            const amount =
                effectiveShowItemPrices && rawAmount !== null && rawAmount !== undefined
                    ? `RD$${toMoney(rawAmount)}`
                    : "";

            wrapItemLine(String(name).toUpperCase(), `x${safe(qty)}`, amount, width).forEach((line) =>
                lines.push(line)
            );
        }

        if (Array.isArray(item?.modifiers) && item.modifiers.length) {
            for (const mod of item.modifiers) {
                const modName = mod?.name ?? mod?.title ?? mod?.description ?? "Modificador";
                wrapText(`+ ${modName}`, width - 2).forEach((line) => lines.push(` ${line}`));
            }
        }

        lines.push("");
    }

    if (!isProductionCommand && effectiveShowTotals) {
        lines.push(hr(width, "-"));

        if (subtotal !== undefined && subtotal !== null) {
            lines.push(moneyLine("Subtotal", subtotal, width));
        }
        if (tax !== undefined && tax !== null) {
            lines.push(moneyLine("ITBIS", tax, width));
        }
        if (total !== undefined && total !== null) {
            lines.push(moneyLine("TOTAL", total, width));
        }
        if (paymentMethod) {
            lines.push(twoCols("Pago", safe(paymentMethod), width));
        }
    }

    lines.push(hr(width, "="));
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
                              paperSize = "80mm",
                          }) {
    const width = getPaperWidth(paperSize);
    const lines = [];


    if (businessName) lines.push(centerText(businessName, width));
    if (rnc) lines.push(centerText(`RNC: ${safe(rnc)}`, width));
    if (address) wrapText(address, width).forEach((line) => lines.push(centerText(line, width)));
    if (phone) lines.push(centerText(`Tel: ${safe(phone)}`, width));

    lines.push("");

    if (headerTitle) {
        wrapText(headerTitle, width).forEach((line) => lines.push(centerText(line, width)));
    } else if (isPreInvoice) {
        lines.push(centerText("PREFACTURA", width));
    } else if (isFiscal) {
        lines.push(centerText("FACTURA CON COMPROBANTE FISCAL", width));
    } else {
        lines.push(centerText("FACTURA CONSUMIDOR FINAL", width));
    }



    if (isFiscal) {
        if (ncfType) lines.push(centerText(`Tipo NCF: ${safe(ncfType)}`, width));
        if (ncfNumber) lines.push(centerText(`NCF: ${safe(ncfNumber)}`, width));
        if (expirationDate) lines.push(centerText(`Vence: ${safe(expirationDate)}`, width));
    }

    lines.push(hr(width, "="));

    if (facturaNo) lines.push(twoCols("Factura:", safe(facturaNo), width));
    if (orderId) lines.push(twoCols("Orden:", safe(orderId), width));
    if (mesa && mesa !== "N/A") lines.push(twoCols("Mesa:", safe(mesa), width));
    if (mesero && mesero !== "N/A") lines.push(twoCols("Mesero:", safe(mesero), width));
    if (salaArea && salaArea !== "N/A") lines.push(twoCols("Sala/Area:", safe(salaArea), width));
    if (fechaHora) lines.push(twoCols("Fecha:", safe(fechaHora), width));

    if (branchName || emissionPoint) {
        lines.push(twoCols("Sucursal:", safe(branchName || "Principal"), width));
        lines.push(twoCols("Pto.Emision:", safe(emissionPoint || "001"), width));
    }

    if (isFiscal && expirationDate) {
        lines.push(twoCols("Vence:", safe(expirationDate), width));
    }

    lines.push(hr(width, "-"));
    lines.push(`Cliente: ${safe(clientName || "Consumidor Final")}`);
    if (clientPhone) lines.push(`Tel: ${safe(clientPhone)}`);
    if (clientRnc) lines.push(`RNC/Cedula: ${safe(clientRnc)}`);
    if (clientAddress) {
        wrapText(`Dir: ${clientAddress}`, width).forEach((line) => lines.push(line));
    }

    lines.push(hr(width, "-"));
    lines.push(twoCols("Descripcion", "Cant   Valor", width));
    lines.push(hr(width, "-"));

    for (const item of items) {
        const name = safe(item?.name || "Producto");
        const qty = Number(item?.qty || item?.quantity || 1);
        const amount =
            Number(item?.total ?? item?.price ?? item?.unitPrice ?? 0);

        wrapItemLine(name, `${qty}`, `RD$${toMoney(amount)}`, width).forEach((line) =>
            lines.push(line)
        );

        if (taxEnabled && Number(item?.tax || 0) > 0) {
            lines.push(twoCols("  ITBIS", `RD$${toMoney(item.tax)}`, width));
        }

        lines.push("");
    }

    lines.push(hr(width, "-"));
    lines.push(moneyLine("Subtotal", subtotal, width));

    if (Number(discount) > 0) {
        lines.push(moneyLine("Descuento", -Math.abs(Number(discount)), width));
    }
    if (Number(tip) > 0) {
        lines.push(moneyLine("Propina", tip, width));
    }
    if (taxEnabled && Number(tax) > 0) {
        lines.push(moneyLine("ITBIS", tax, width));
    }
    if (isAppDelivery && Number(commissionAmount) > 0) {
        lines.push(moneyLine(`Comision ${safe(commissionPct)}%`, commissionAmount, width));
    }
    if (showShipping && Number(shippingFee) > 0) {
        lines.push(moneyLine("Envio", shippingFee, width));
    }

    lines.push(hr(width, "="));
    lines.push(moneyLine("TOTAL A PAGAR", totalToPay, width));
    if (paymentMethod) {
        lines.push(twoCols("Metodo:", safe(paymentMethod), width));
    }

    lines.push(hr(width, "="));
    lines.push(centerText("Gracias por su compra", width));

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