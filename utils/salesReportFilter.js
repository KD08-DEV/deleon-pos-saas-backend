// Shared recognition criteria for Sales and Finance reports.
function buildLegacyReportFilter({ tenantId, clientId, registerId, startDate, endDate }) {
    const rawClientId = String(clientId || "default").trim() || "default";

    const rawRegister = registerId ? String(registerId).trim().toUpperCase() : "";

    const normalizeReg =
        !rawRegister || rawRegister === "__ALL_REGISTERS__" || rawRegister === "ALL"
            ? ""
            : rawRegister;

    const clientScope = rawClientId === "default"
        ? { $or: [{ clientId: "default" }, { clientId: { $exists: false } }, { clientId: null }, { clientId: "" }] }
        : { clientId: rawClientId };

    let registerScope = {};

    if (normalizeReg) {
        if (normalizeReg === "MAIN" || normalizeReg === "DEFAULT") {
            registerScope = {
                $or: [
                    { registerId: "MAIN" },
                    { registerId: "default" },
                    { registerId: { $exists: false } },
                    { registerId: null },
                    { registerId: "" },
                ],
            };
        } else {
            registerScope = { registerId: normalizeReg };
        }
    }

    const paidDateRange =
        startDate && endDate
            ? { paidAt: { $gte: startDate, $lte: endDate } }
            : {};

    const createdDateRange =
        startDate && endDate
            ? { createdAt: { $gte: startDate, $lte: endDate } }
            : {};

    const invoiceDateRange =
        startDate && endDate
            ? {
                $or: [
                    { invoicedAt: { $gte: startDate, $lte: endDate } },
                    { createdAt: { $gte: startDate, $lte: endDate } },
                ],
            }
            : {};

    const paidAtMissing = {
        $or: [
            { paidAt: { $exists: false } },
            { paidAt: null },
            { paidAt: "" },
        ],
    };

    const legacyPaymentStatusFilter = {
        $or: [
            { paymentStatus: { $exists: false } },
            { paymentStatus: null },
            { paymentStatus: "" },
            { paymentStatus: "Pendiente" },
        ],
    };

    return {
        tenantId,

        ...registerScope,

        $and: [
            { settledFromCredit: { $ne: true } },
            clientScope,

            {
                isDraft: { $ne: true },
            },

            {
                "items.0": { $exists: true },
            },

            {
                $or: [
                    { orderStatus: { $exists: false } },
                    { orderStatus: { $nin: ["Cancelado", "Canceled", "Cancelled"] } },
                ],
            },

            {
                $or: [
                    { paymentStatus: { $exists: false } },
                    { paymentStatus: { $ne: "Anulado" } },
                ],
            },

            {
                $or: [
                    // Venta moderna pagada: usa paidAt
                    {
                        paymentStatus: "Pagado",
                        ...paidDateRange,
                    },

                    // Venta pagada vieja sin paidAt: usa invoicedAt o createdAt
                    {
                        paymentStatus: "Pagado",
                        ...paidAtMissing,
                        ...invoiceDateRange,
                    },

                    // Legacy: completada pero sin paymentStatus moderno
                    {
                        ...legacyPaymentStatusFilter,
                        orderStatus: "Completado",
                        ...createdDateRange,
                    },

                    // Legacy: fiscal solicitada pero sin paymentStatus moderno
                    {
                        ...legacyPaymentStatusFilter,
                        "fiscal.requested": true,
                        ...createdDateRange,
                    },

                    // Legacy: factura interna pero sin paymentStatus moderno
                    {
                        ...legacyPaymentStatusFilter,
                        invoiceNumber: { $exists: true, $nin: [null, ""] },
                        ...createdDateRange,
                    },

                    {
                        ...legacyPaymentStatusFilter,
                        facturaNo: { $exists: true, $nin: [null, ""] },
                        ...createdDateRange,
                    },

                    {
                        ...legacyPaymentStatusFilter,
                        internalInvoiceNumber: { $exists: true, $nin: [null, ""] },
                        ...createdDateRange,
                    },
                ],
            },
        ],
    };
}
function buildCreditReportFilter({
                                     tenantId,
                                     clientId,
                                     registerId,
                                     startDate,
                                     endDate,
                                 }) {
    const rawClientId =
        String(clientId || "default").trim() ||
        "default";

    const rawRegister =
        registerId
            ? String(registerId)
                .trim()
                .toUpperCase()
            : "";

    const normalizedRegister =
        !rawRegister ||
        rawRegister ===
        "__ALL_REGISTERS__" ||
        rawRegister === "ALL"
            ? ""
            : rawRegister;

    const clientScope = rawClientId === "default"
        ? { $or: [{ clientId: "default" }, { clientId: { $exists: false } }, { clientId: null }, { clientId: "" }] }
        : { clientId: rawClientId };

    let registerScope = {};

    if (normalizedRegister) {
        if (
            normalizedRegister === "MAIN" ||
            normalizedRegister === "DEFAULT"
        ) {
            registerScope = {
                $or: [
                    { registerId: "MAIN" },
                    { registerId: "default" },
                    {
                        registerId: {
                            $exists: false,
                        },
                    },
                    { registerId: null },
                    { registerId: "" },
                ],
            };
        } else {
            registerScope = {
                registerId:
                normalizedRegister,
            };
        }
    }

    const andConditions = [
        clientScope,

        {
            isDraft: {
                $ne: true,
            },
        },

        {
            "items.0": {
                $exists: true,
            },
        },

        {
            orderStatus: {
                $nin: [
                    "Cancelado",
                    "Canceled",
                    "Cancelled",
                ],
            },
        },

        {
            paymentStatus: {
                $ne: "Anulado",
            },
        },

        {
            $or: [
                { settledFromCredit: true },
                { paymentMethod: { $regex: "^(Credito|Crédito|Credit)$", $options: "i" } },
            ],
        },
    ];

    if (startDate && endDate) {
        andConditions.push({
            $or: [
                {
                    invoicedAt: {
                        $gte: startDate,
                        $lte: endDate,
                    },
                },

                {
                    $and: [
                        {
                            $or: [
                                {
                                    invoicedAt: {
                                        $exists:
                                            false,
                                    },
                                },
                                {
                                    invoicedAt:
                                        null,
                                },
                                {
                                    invoicedAt:
                                        "",
                                },
                            ],
                        },
                        {
                            createdAt: {
                                $gte:
                                startDate,
                                $lte:
                                endDate,
                            },
                        },
                    ],
                },
            ],
        });
    }

    return {
        tenantId,

        ...registerScope,

        $and: andConditions,
    };
}
module.exports = { buildLegacyReportFilter, buildCreditReportFilter };
