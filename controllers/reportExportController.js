const XLSX =
    require("xlsx");

const Order =
    require(
        "../models/orderModel"
    );

const Tenant =
    require(
        "../models/tenantModel"
    );


// ======================================================
// PROPINA
// ======================================================

function resolveTip(
    bills = {},
    order = {}
) {
    if (
        bills.tipAmount !==
        undefined
    ) {
        return Number(
            bills.tipAmount ||
            0
        );
    }


    if (
        bills.tip !==
        undefined
    ) {
        return Number(
            bills.tip ||
            0
        );
    }


    if (
        order.tip !==
        undefined
    ) {
        return Number(
            order.tip ||
            0
        );
    }


    return 0;
}


// ======================================================
// IDENTIFICACIÓN FISCAL CLIENTE
// ======================================================

function resolveCustomerTaxIdentity(
    order = {}
) {
    const identity =
        order
            ?.customerDetails
            ?.taxIdentity;


    if (
        identity &&
        typeof identity ===
        "object" &&
        String(
            identity.value ||
            ""
        ).trim()
    ) {
        const type =
            String(
                identity.type ||
                "TAX_ID"
            )
                .trim()
                .toUpperCase();


        return {
            countryCode:
                String(
                    identity
                        .countryCode ||
                    ""
                )
                    .trim()
                    .toUpperCase(),

            type,

            label:
                String(
                    identity.label ||
                    type
                ).trim(),

            value:
                String(
                    identity.value ||
                    ""
                ).trim(),
        };
    }


    // ==============================================
    // LEGACY RD
    // ==============================================

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
        digits.length ===
        9
    ) {
        type =
            "RNC";

        label =
            "RNC";
    }


    if (
        digits.length ===
        11
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
}


// ======================================================
// TAX BREAKDOWN
// ======================================================

function resolveTaxBreakdown(
    bills = {}
) {
    const list =
        Array.isArray(
            bills
                ?.taxBreakdown
        )
            ? bills.taxBreakdown
            : [];


    return list
        .map(
            (tax) => {
                const name =
                    String(
                        tax?.name ||
                        tax?.label ||
                        tax?.code ||
                        "Impuesto"
                    ).trim();


                const rate =
                    Number(
                        tax?.ratePercent ||
                        0
                    );


                const amount =
                    Number(
                        tax?.amount ||
                        0
                    );


                return `${
                    name
                }${
                    rate > 0
                        ? ` ${rate}%`
                        : ""
                }: ${amount}`;
            }
        )
        .join(" | ");
}


// ======================================================
// LOCALIZACIÓN
// ======================================================

function resolveLocalization(
    tenant = {}
) {
    const raw =
        tenant
            ?.localization ||
        {};


    return {
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
    };
}


// ======================================================
// FECHA
// ======================================================

function formatExportDate(
    value,
    localization
) {
    if (!value) {
        return "";
    }


    const date =
        new Date(
            value
        );


    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        return "";
    }


    try {
        return new Intl
            .DateTimeFormat(
                localization
                    .locale,
                {
                    timeZone:
                    localization
                        .timezone,

                    year:
                        "numeric",

                    month:
                        "2-digit",

                    day:
                        "2-digit",
                }
            )
            .format(
                date
            );

    } catch {
        return date
            .toISOString()
            .slice(
                0,
                10
            );
    }
}


// ======================================================
// EXCEL PRINCIPAL
// ======================================================

async function exportExcel(
    req,
    res
) {
    try {
        const tenantId =
            req.user
                .tenantId;


        const tenant =
            await Tenant
                .findOne({
                    tenantId,
                })
                .lean();


        const localization =
            resolveLocalization(
                tenant
            );


        const orders =
            await Order
                .find({
                    tenantId,
                })
                .populate(
                    "user"
                )
                .sort({
                    createdAt:
                        -1,
                })
                .lean();


        if (
            !orders ||
            orders.length ===
            0
        ) {
            return res
                .status(200)
                .send(
                    Buffer.from([])
                );
        }


        const rows =
            [];

        let totalGeneral =
            0;


        for (
            const order of
            orders
            ) {
            const bills =
                order.bills ||
                {};


            const taxIdentity =
                resolveCustomerTaxIdentity(
                    order
                );


            const itemsNames =
                (
                    order.items ||
                    []
                )
                    .map(
                        (item) => {
                            const quantity =
                                Number(
                                    item
                                        ?.quantity ??
                                    item
                                        ?.qty ??
                                    1
                                );


                            return `${
                                item
                                    ?.name ||
                                "Item"
                            } x${quantity}`;
                        }
                    )
                    .join(", ");


            const subtotal =
                Number(
                    bills
                        ?.subtotal ??
                    bills
                        ?.total ??
                    0
                );


            const discount =
                Number(
                    bills
                        ?.discount ||
                    0
                );


            const taxTotal =
                Number(
                    bills
                        ?.tax ||
                    0
                );


            const tip =
                resolveTip(
                    bills,
                    order
                );


            const serviceCharge =
                Number(
                    bills
                        ?.serviceChargeTotal ||
                    0
                );


            const shipping =
                Number(
                    order
                        ?.shippingFee ??
                    order
                        ?.deliveryFee ??
                    bills
                        ?.shippingFee ??
                    bills
                        ?.deliveryFee ??
                    0
                );


            const grandTotal =
                Number(
                    bills
                        ?.totalWithTax ||
                    0
                );


            totalGeneral +=
                grandTotal;


            rows.push({
                "Order ID":
                    order
                        ._id
                        .toString(),

                Fecha:
                    formatExportDate(
                        order
                            .createdAt,
                        localization
                    ),

                Items:
                itemsNames,

                Cliente:
                    order
                        ?.customerDetails
                        ?.name ||
                    "Consumidor",

                "País fiscal cliente":
                    taxIdentity
                        ?.countryCode ||
                    "",

                "Tipo identificación fiscal":
                    taxIdentity
                        ?.type ||
                    "",

                "Etiqueta identificación fiscal":
                    taxIdentity
                        ?.label ||
                    "",

                "Número identificación fiscal":
                    taxIdentity
                        ?.value ||
                    "",

                Subtotal:
                subtotal,

                Descuento:
                discount,

                "Total impuestos":
                taxTotal,

                "Detalle impuestos":
                    resolveTaxBreakdown(
                        bills
                    ),

                Propina:
                tip,

                "Cargo por servicio":
                serviceCharge,

                Envío:
                shipping,

                "Método de pago":
                    order
                        .paymentMethod ||
                    "Efectivo",

                Canal:
                    order
                        ?.orderSource ||
                    "",

                Usuario:
                    order
                        ?.user
                        ?.name ||
                    "—",

                Moneda:
                localization
                    .currency,

                "NCF RD":
                    order
                        ?.fiscal
                        ?.ncfNumber ||
                    order
                        ?.ncfNumber ||
                    "",

                "eNCF RD":
                    order
                        ?.ecf
                        ?.eNCF ||
                    "",

                Total:
                grandTotal,
            });
        }


        // ==============================================
        // TOTAL FINAL
        // ==============================================

        rows.push({
            "Order ID":
                "",

            Fecha:
                "",

            Items:
                "",

            Cliente:
                "TOTAL",

            Total:
            totalGeneral,
        });


        const worksheet =
            XLSX.utils
                .json_to_sheet(
                    rows
                );


        worksheet["!cols"] = [
            { wch: 28 },
            { wch: 14 },
            { wch: 45 },
            { wch: 28 },
            { wch: 12 },
            { wch: 22 },
            { wch: 26 },
            { wch: 28 },
            { wch: 14 },
            { wch: 14 },
            { wch: 16 },
            { wch: 45 },
            { wch: 14 },
            { wch: 20 },
            { wch: 14 },
            { wch: 20 },
            { wch: 18 },
            { wch: 20 },
            { wch: 12 },
            { wch: 20 },
            { wch: 20 },
            { wch: 16 },
        ];


        const workbook =
            XLSX.utils
                .book_new();


        XLSX.utils
            .book_append_sheet(
                workbook,
                worksheet,
                "Reportes"
            );


        const buffer =
            XLSX.write(
                workbook,
                {
                    type:
                        "buffer",

                    bookType:
                        "xlsx",
                }
            );


        res.setHeader(
            "Content-Disposition",
            "attachment; filename=reporte_ordenes.xlsx"
        );


        res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );


        return res.send(
            buffer
        );

    } catch (error) {
        console.error(
            "Excel export error:",
            error
        );


        return res
            .status(500)
            .json({
                success:
                    false,

                message:
                    "Export failed",
            });
    }
}


// ======================================================
// EXPORT FACTURAS
// ======================================================
//
// Actualmente esta ruta existe pero el frontend principal
// no la utiliza. La mantenemos explícitamente sin fingir
// que exporta PDFs o ZIPs.
//
// Cuando implementemos un export masivo real de facturas,
// esta función será su punto de entrada.
// ======================================================

function exportAllInvoices(
    req,
    res
) {
    return res
        .status(501)
        .json({
            success:
                false,

            code:
                "INVOICE_BULK_EXPORT_NOT_IMPLEMENTED",

            message:
                "La exportación masiva de facturas todavía no está implementada.",
        });
}


module.exports = {
    exportExcel,
    exportAllInvoices,
};