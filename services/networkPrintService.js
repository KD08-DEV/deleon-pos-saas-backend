const net = require("net");

function safe(value = "") {
    if (value === null || value === undefined) return "";
    return String(value);
}
function resolveLocalization({
                                 localization = {},
                                 locale,
                                 currency,
                             } = {}) {
    return {
        ...localization,

        locale:
            locale ||
            localization?.locale ||
            "es-DO",

        currency:
            currency ||
            localization?.currency ||
            "DOP",

        weightUnit:
            localization?.weightUnit ||
            "lb",
    };
}

function formatMoneyForPrint(
    value,
    localization = {}
) {
    const amount =
        Number(value);

    const safeAmount =
        Number.isFinite(amount)
            ? amount
            : 0;

    const locale =
        localization.locale ||
        "es-DO";

    const currency =
        localization.currency ||
        "DOP";

    try {
        /*
         * currencyDisplay:"code" es
         * intencional en ESC/POS.
         *
         * Evita problemas de encoding
         * con £, €, ¥ en impresoras
         * térmicas antiguas.
         */
        return new Intl.NumberFormat(
            locale,
            {
                style:
                    "currency",

                currency,

                currencyDisplay:
                    "code",
            }
        )
            .format(
                safeAmount
            )
            .replace(
                /\u00a0/g,
                " "
            );
    } catch {
        return `${currency} ${safeAmount.toFixed(
            2
        )}`;
    }
}

function getPaperWidth(
    paperSize = "80mm"
) {
    if (
        paperSize === "58mm"
    ) {
        return 32;
    }

    if (
        paperSize === "A4"
    ) {
        return 80;
    }

    return 42;
}

function hr(
    width = 42,
    char = "-"
) {
    return String(
        char || "-"
    )
        .slice(0, 1)
        .repeat(width);
}

function twoCols(
    left = "",
    right = "",
    width = 42
) {
    const leftText =
        safe(left);

    const rightText =
        safe(right);

    if (
        rightText.length >=
        width
    ) {
        return rightText.slice(
            0,
            width
        );
    }

    const availableLeft =
        Math.max(
            0,
            width -
            rightText.length -
            1
        );

    const finalLeft =
        leftText.slice(
            0,
            availableLeft
        );

    const spaces =
        Math.max(
            1,
            width -
            finalLeft.length -
            rightText.length
        );

    return (
        finalLeft +
        " ".repeat(spaces) +
        rightText
    );
}

function wrapItemLine(
    name = "",
    qty = "",
    amount = "",
    width = 42
) {
    const quantity =
        safe(qty);

    const money =
        safe(amount);

    const rightSide =
        [quantity, money]
            .filter(Boolean)
            .join(" ");

    const reserved =
        rightSide
            ? rightSide.length + 1
            : 0;

    const nameWidth =
        Math.max(
            8,
            width -
            reserved
        );

    const nameLines =
        wrapText(
            name,
            nameWidth
        );

    if (
        nameLines.length ===
        0
    ) {
        return [
            twoCols(
                "",
                rightSide,
                width
            ),
        ];
    }

    const lines = [
        twoCols(
            nameLines[0],
            rightSide,
            width
        ),
    ];

    for (
        let i = 1;
        i < nameLines.length;
        i += 1
    ) {
        lines.push(
            nameLines[i]
        );
    }

    return lines;
}

function moneyLine(
    label,
    value,
    width,
    localization
) {
    return twoCols(
        label,
        formatMoneyForPrint(
            value,
            localization
        ),
        width
    );
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
                             localization = {},
                             locale,
                             currency,
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
    const printLocalization =
        resolveLocalization({
            localization,
            locale,
            currency,
        });
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
        const qtyLabel =
            item?.qtyType ===
            "weight"
                ? `${safe(qty)} ${
                    item?.weightUnit ||
                    printLocalization.weightUnit ||
                    ""
                }`.trim()
                : safe(qty);
        const name = item?.name ?? item?.title ?? item?.description ?? "ITEM";

        if (isProductionCommand) {
            wrapText(`${qtyLabel} x ${String(
                name
            ).toUpperCase()}`, width).forEach((line) =>
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
                    ? formatMoneyForPrint(
                        rawAmount,
                        printLocalization
                    )
                    : "";

            wrapItemLine(String(name).toUpperCase(), item?.qtyType === "weight"
                ? qtyLabel
                : `x${qtyLabel}`, amount, width).forEach((line) =>
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

    if (
        !isProductionCommand &&
        effectiveShowTotals
    ) {
        lines.push(
            hr(
                width,
                "-"
            )
        );

        if (
            subtotal !== undefined &&
            subtotal !== null
        ) {
            lines.push(
                moneyLine(
                    "Subtotal",
                    subtotal,
                    width,
                    printLocalization
                )
            );
        }

        if (
            tax !== undefined &&
            tax !== null &&
            Number(tax) > 0
        ) {
            lines.push(
                moneyLine(
                    "Impuestos",
                    tax,
                    width,
                    printLocalization
                )
            );
        }

        if (
            total !== undefined &&
            total !== null
        ) {
            lines.push(
                moneyLine(
                    "TOTAL",
                    total,
                    width,
                    printLocalization
                )
            );
        }

        if (paymentMethod) {
            lines.push(
                twoCols(
                    "Pago",
                    safe(
                        paymentMethod
                    ),
                    width
                )
            );
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
                              localization = {},
                              locale,
                              currency,

                              taxBreakdown = [],

                              serviceChargeTotal = 0,
                              serviceChargeBreakdown = [],
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
    const printLocalization =
        resolveLocalization({
            localization,
            locale,
            currency,
        });

    const resolvedTaxLabel =
        taxBreakdown.length === 1
            ? String(
                taxBreakdown[0]?.name ||
                taxBreakdown[0]?.label ||
                taxBreakdown[0]?.code ||
                "Impuestos"
            )
            : "Impuestos";
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
        const qtyLabel =
            item?.qtyType ===
            "weight"
                ? `${qty} ${
                    item?.weightUnit ||
                    printLocalization.weightUnit ||
                    ""
                }`.trim()
                : String(qty);
        const amount =
            Number(item?.total ?? item?.price ?? item?.unitPrice ?? 0);

        wrapItemLine(
            name,
            qtyLabel,

            formatMoneyForPrint(
                amount,
                printLocalization
            ),

            width
        ).forEach((line) =>
            lines.push(line)
        );

        if (taxEnabled && Number(item?.tax || 0) > 0) {
            lines.push(
                twoCols(
                    "  Impuesto",

                    formatMoneyForPrint(
                        item.tax,
                        printLocalization
                    ),

                    width
                )
            );
        }

        lines.push("");
    }

    lines.push(
        hr(
            width,
            "-"
        )
    );

    lines.push(
        moneyLine(
            "Subtotal",
            subtotal,
            width,
            printLocalization
        )
    );

    if (
        Number(discount) > 0
    ) {
        lines.push(
            moneyLine(
                "Descuento",
                -Math.abs(
                    Number(
                        discount
                    )
                ),
                width,
                printLocalization
            )
        );
    }

    if (
        Number(tip) > 0
    ) {
        lines.push(
            moneyLine(
                "Propina",
                tip,
                width,
                printLocalization
            )
        );
    }

    if (
        taxEnabled &&
        Number(tax) > 0
    ) {
        lines.push(
            moneyLine(
                resolvedTaxLabel,
                tax,
                width,
                printLocalization
            )
        );
    }

    /*
     * Service Charges
     *
     * Cada cargo se imprime por separado
     * cuando tenemos breakdown.
     */
    if (
        Array.isArray(
            serviceChargeBreakdown
        ) &&
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

                if (
                    !Number.isFinite(
                        amount
                    ) ||
                    amount <= 0
                ) {
                    return;
                }

                const name =
                    String(
                        charge?.name ||
                        charge?.label ||
                        charge?.code ||
                        "Cargo por servicio"
                    ).trim();

                lines.push(
                    moneyLine(
                        name,
                        amount,
                        width,
                        printLocalization
                    )
                );
            }
        );
    } else if (
        Number(
            serviceChargeTotal
        ) > 0
    ) {
        lines.push(
            moneyLine(
                "Cargo por servicio",
                serviceChargeTotal,
                width,
                printLocalization
            )
        );
    }

    if (
        showShipping &&
        Number(
            shippingFee
        ) > 0
    ) {
        lines.push(
            moneyLine(
                "Envío",
                shippingFee,
                width,
                printLocalization
            )
        );
    }

    /*
     * IMPORTANTE:
     *
     * commissionAmount NO se imprime.
     * Es un costo del negocio,
     * no un cargo al cliente.
     */

    lines.push(
        hr(
            width,
            "="
        )
    );

    lines.push(
        moneyLine(
            "TOTAL A PAGAR",
            totalToPay,
            width,
            printLocalization
        )
    );
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

// F8-14: permitir conexiones TCP desde el backend solo a impresoras LAN
// explicitamente configuradas. DeLeonBridge local es independiente.
function isPrivatePrinterIPv4(address) {
    if (net.isIP(address) !== 4) return false;
    const octets = address.split(".").map(Number);
    const [first, second] = octets;
    return first === 10 ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168);
}

function validatedPrintTarget(ip, port) {
    const address = typeof ip === "string" ? ip.trim() : "";
    if (!address) throw new Error("PRINTER_IP_REQUIRED");

    const parsedPort = Number(port);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        throw new Error("NETWORK_PRINT_INVALID_PORT");
    }

    // No DNS, loopback, link-local, cloud metadata, IPv6 ni IP publica.
    if (!isPrivatePrinterIPv4(address)) {
        throw new Error("NETWORK_PRINT_PRIVATE_IPV4_REQUIRED");
    }

    const allowedTargets = String(process.env.BACKEND_PRINT_ALLOWED_TARGETS || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    if (!allowedTargets.includes(`${address}:${parsedPort}`)) {
        throw new Error("NETWORK_PRINT_TARGET_NOT_ALLOWED");
    }

    return { ip: address, port: parsedPort };
}

function sendToNetworkPrinter({ ip, port = 9100, payload, timeoutMs = 12000 }) {
    return new Promise((resolve, reject) => {
        let target;
        try {
            // El rechazo sucede antes de construir o conectar el socket.
            target = validatedPrintTarget(ip, port);
        } catch (error) {
            return reject(error);
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

        socket.connect(target.port, target.ip);
    });
}

module.exports = {
    buildEscPosText,
    buildTicketText,
    buildInvoiceText,
    sendToNetworkPrinter,
};