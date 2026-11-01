// services/tax/taxEngine.js

function round2(value) {
    return (
        Math.round(
            (Number(value) || 0) * 100
        ) / 100
    );
}

function makeTaxError(
    code,
    meta = {}
) {
    const error =
        new Error(code);

    error.code = code;
    error.statusCode = 400;
    error.meta = meta;

    return error;
}


// ======================================================
// LEGACY
// ======================================================

function normalizeLegacyTaxPercent(
    value
) {
    const number =
        Number(value);

    if (
        !Number.isFinite(
            number
        )
    ) {
        return 18;
    }

    // Legacy:
    // 0.18 = 18%
    if (
        number >= 0 &&
        number <= 1
    ) {
        return round2(
            number * 100
        );
    }

    return number;
}


// ======================================================
// NORMALIZAR UN IMPUESTO
// ======================================================

function normalizeTax(
    tax
) {
    const ratePercent =
        Number(
            tax?.ratePercent ??
            0
        );

    return {
        id:
            String(
                tax?.id || ""
            ).trim(),

        name:
            String(
                tax?.name ||
                "Tax"
            ).trim(),

        code:
            String(
                tax?.code ||
                "TAX"
            )
                .trim()
                .toUpperCase(),

        ratePercent:
            Number.isFinite(
                ratePercent
            )
                ? ratePercent
                : 0,

        active:
            tax?.active !==
            false,

        includedInPrice:
            tax
                ?.includedInPrice ===
            true,

        appliesToDeliveryFee:
            tax
                ?.appliesToDeliveryFee ===
            true,
    };
}


// ======================================================
// OBTENER CONFIGURACIÓN DEL TENANT
// ======================================================

function getNormalizedTaxConfig(
    tenant = {}
) {
    const storedTaxes =
        Array.isArray(
            tenant
                ?.taxConfig
                ?.taxes
        )
            ? tenant.taxConfig.taxes
            : [];

    const enabled =
        typeof tenant
            ?.taxConfig
            ?.enabled ===
        "boolean"
            ? tenant
                .taxConfig
                .enabled
            : tenant
            ?.features
            ?.tax
            ?.enabled !== false;

    // ==========================================
    // NUEVO MOTOR
    // ==========================================

    if (
        storedTaxes.length >
        0
    ) {
        const taxes =
            storedTaxes
                .map(
                    normalizeTax
                )
                .filter(
                    (tax) =>
                        tax.id
                );

        const activeTaxes =
            taxes.filter(
                (tax) =>
                    tax.active
            );

        const requestedDefault =
            String(
                tenant
                    ?.taxConfig
                    ?.defaultTaxId ||
                ""
            ).trim();

        const defaultTaxId =
            activeTaxes.some(
                (tax) =>
                    tax.id ===
                    requestedDefault
            )
                ? requestedDefault
                : (
                    activeTaxes[0]
                        ?.id ||
                    null
                );

        return {
            enabled,
            defaultTaxId,
            taxes,
        };
    }


    // ==========================================
    // COMPATIBILIDAD LEGACY
    // ==========================================

    const countryCode =
        String(
            tenant
                ?.localization
                ?.countryCode ||
            "DO"
        )
            .trim()
            .toUpperCase();

    const ratePercent =
        normalizeLegacyTaxPercent(
            tenant
                ?.features
                ?.tax
                ?.rate ??
            0.18
        );

    const legacyTax = {
        id:
            "legacy_default_tax",

        name:
            countryCode === "DO"
                ? "ITBIS"
                : "Tax",

        code:
            countryCode === "DO"
                ? "ITBIS"
                : "TAX",

        ratePercent,

        active:
            true,

        includedInPrice:
            false,

        appliesToDeliveryFee:
            true,
    };

    return {
        enabled,

        defaultTaxId:
        legacyTax.id,

        taxes: [
            legacyTax,
        ],
    };
}
function applyItemIncludedOverride(
    tax,
    item
) {
    if (!tax) {
        return null;
    }

    // Si el producto no tiene override,
    // respetar configuración del impuesto.
    if (
        typeof item
            ?.taxIncludedOverride !==
        "boolean"
    ) {
        return tax;
    }

    return {
        ...tax,

        includedInPrice:
        item
            .taxIncludedOverride,
    };
}

// ======================================================
// RESOLVER IMPUESTO PARA PRODUCTO
// ======================================================

function resolveItemTax({
                            item,
                            taxConfig,
                        }) {
    if (
        taxConfig.enabled !==
        true
    ) {
        return null;
    }

    const requestedTaxId =
        String(
            item?.taxId ||
            ""
        ).trim();

    // Producto tiene impuesto explícito.
    if (requestedTaxId) {
        const tax =
            taxConfig.taxes.find(
                (candidate) =>
                    candidate.id ===
                    requestedTaxId
            );

        if (!tax) {
            throw makeTaxError(
                "ITEM_TAX_NOT_FOUND",
                {
                    taxId:
                    requestedTaxId,

                    dishId:
                        item?.dishId ||
                        null,
                }
            );
        }

        if (
            tax.active !== true
        ) {
            throw makeTaxError(
                "ITEM_TAX_INACTIVE",
                {
                    taxId:
                    requestedTaxId,

                    dishId:
                        item?.dishId ||
                        null,
                }
            );
        }

        return applyItemIncludedOverride(
            tax,
            item
        );
    }

    // Sin impuesto propio:
    // usar predeterminado.
    const defaultTax =
        taxConfig.taxes.find(
            (tax) =>
                tax.id ===
                taxConfig.defaultTaxId &&
                tax.active ===
                true
        );

    if (defaultTax) {
        return applyItemIncludedOverride(
            defaultTax,
            item
        );
    }

    // Último fallback:
    const fallbackTax =
        taxConfig.taxes.find(
            (tax) =>
                tax.active === true
        ) ||
        null;

    return applyItemIncludedOverride(
        fallbackTax,
        item
    );
}


// ======================================================
// CÁLCULO DE UNA BASE
// ======================================================

function calculateTaxForAmount({
                                   amount,
                                   tax,
                               }) {
    const inputAmount =
        round2(
            Math.max(
                Number(amount) || 0,
                0
            )
        );

    if (!tax) {
        return {
            taxableBase:
            inputAmount,

            taxAmount:
                0,

            grossAmount:
            inputAmount,
        };
    }

    const rate =
        Math.max(
            Number(
                tax.ratePercent ||
                0
            ),
            0
        ) / 100;


    // ==========================================
    // IMPUESTO INCLUIDO EN PRECIO
    // ==========================================

    if (
        tax.includedInPrice ===
        true
    ) {
        if (rate <= 0) {
            return {
                taxableBase:
                inputAmount,

                taxAmount:
                    0,

                grossAmount:
                inputAmount,
            };
        }

        const taxableBase =
            round2(
                inputAmount /
                (1 + rate)
            );

        const taxAmount =
            round2(
                inputAmount -
                taxableBase
            );

        return {
            taxableBase,

            taxAmount,

            grossAmount:
            inputAmount,
        };
    }


    // ==========================================
    // IMPUESTO AGREGADO AL PRECIO
    // ==========================================

    const taxableBase =
        inputAmount;

    const taxAmount =
        round2(
            taxableBase *
            rate
        );

    return {
        taxableBase,

        taxAmount,

        grossAmount:
            round2(
                taxableBase +
                taxAmount
            ),
    };
}


// ======================================================
// ACUMULAR DESGLOSE
// ======================================================

function addBreakdown({
                          breakdownMap,
                          tax,
                          taxableBase,
                          taxAmount,
                          grossAmount,
                      }) {
    if (!tax) return;

    const key =
        [
            tax.id,
            tax.includedInPrice
                ? "included"
                : "exclusive",
        ].join(":");

    const current =
        breakdownMap.get(
            key
        ) || {
            taxId:
            tax.id,

            name:
            tax.name,

            code:
            tax.code,

            ratePercent:
            tax.ratePercent,

            includedInPrice:
            tax.includedInPrice,

            taxableBase:
                0,

            amount:
                0,

            grossAmount:
                0,
        };

    current.taxableBase =
        round2(
            current.taxableBase +
            taxableBase
        );

    current.amount =
        round2(
            current.amount +
            taxAmount
        );

    current.grossAmount =
        round2(
            current.grossAmount +
            grossAmount
        );

    breakdownMap.set(
        key,
        current
    );
}


// ======================================================
// MOTOR PRINCIPAL
// ======================================================

function calculateOrderTaxes({
                                 tenant,
                                 items = [],
                                 discountAmount = 0,
                                 deliveryFee = 0,
                                 taxesEnabled = true,
                             }) {
    const taxConfig =
        getNormalizedTaxConfig(
            tenant
        );

    const engineEnabled =
        taxConfig.enabled ===
        true &&
        taxesEnabled === true;

    const normalizedItems =
        Array.isArray(items)
            ? items
            : [];

    const subtotal =
        round2(
            normalizedItems.reduce(
                (
                    sum,
                    item
                ) =>
                    sum +
                    Math.max(
                        Number(
                            item?.price ||
                            0
                        ),
                        0
                    ),
                0
            )
        );

    const discount =
        round2(
            Math.min(
                Math.max(
                    Number(
                        discountAmount
                    ) || 0,
                    0
                ),
                subtotal
            )
        );

    const subtotalAfterDiscount =
        round2(
            subtotal -
            discount
        );

    let remainingDiscount =
        discount;

    const breakdownMap =
        new Map();


    // ==================================================
    // PRODUCTOS
    // ==================================================

    const calculatedItems =
        normalizedItems.map(
            (
                item,
                index
            ) => {
                const lineAmount =
                    round2(
                        Math.max(
                            Number(
                                item?.price ||
                                0
                            ),
                            0
                        )
                    );

                let lineDiscount =
                    0;

                if (
                    discount > 0 &&
                    subtotal > 0
                ) {
                    const isLast =
                        index ===
                        normalizedItems.length -
                        1;

                    if (isLast) {
                        lineDiscount =
                            round2(
                                Math.min(
                                    lineAmount,
                                    remainingDiscount
                                )
                            );
                    } else {
                        lineDiscount =
                            round2(
                                Math.min(
                                    lineAmount,
                                    discount *
                                    (
                                        lineAmount /
                                        subtotal
                                    )
                                )
                            );
                    }

                    remainingDiscount =
                        round2(
                            Math.max(
                                0,
                                remainingDiscount -
                                lineDiscount
                            )
                        );
                }

                const discountedAmount =
                    round2(
                        Math.max(
                            lineAmount -
                            lineDiscount,
                            0
                        )
                    );

                const tax =
                    engineEnabled
                        ? resolveItemTax({
                            item,
                            taxConfig,
                        })
                        : null;

                const calculation =
                    calculateTaxForAmount({
                        amount:
                        discountedAmount,

                        tax,
                    });

                if (tax) {
                    addBreakdown({
                        breakdownMap,

                        tax,

                        taxableBase:
                        calculation
                            .taxableBase,

                        taxAmount:
                        calculation
                            .taxAmount,

                        grossAmount:
                        calculation
                            .grossAmount,
                    });
                }

                return {
                    ...item,

                    discountAmount:
                    lineDiscount,

                    taxId:
                        tax?.id ||
                        null,

                    taxAmount:
                    calculation
                        .taxAmount,

                    lineTotalWithTax:
                    calculation
                        .grossAmount,

                    taxSnapshot:
                        tax
                            ? {
                                taxId:
                                tax.id,

                                name:
                                tax.name,

                                code:
                                tax.code,

                                ratePercent:
                                tax
                                    .ratePercent,

                                includedInPrice:
                                tax
                                    .includedInPrice,

                                taxableBase:
                                calculation
                                    .taxableBase,

                                amount:
                                calculation
                                    .taxAmount,
                            }
                            : null,
                };
            }
        );


    // ==================================================
    // DELIVERY
    // ==================================================

    const safeDeliveryFee =
        round2(
            Math.max(
                Number(
                    deliveryFee
                ) || 0,
                0
            )
        );

    let deliveryTaxAmount =
        0;

    let deliveryGrossAmount =
        safeDeliveryFee;

    let deliveryNetAmount =
        safeDeliveryFee;

    if (
        engineEnabled &&
        safeDeliveryFee > 0
    ) {
        const defaultTax =
            resolveItemTax({
                item: {
                    taxId: null,
                },

                taxConfig,
            });

        if (
            defaultTax
                ?.appliesToDeliveryFee ===
            true
        ) {
            const deliveryCalculation =
                calculateTaxForAmount({
                    amount:
                    safeDeliveryFee,

                    tax:
                    defaultTax,
                });

            deliveryTaxAmount =
                deliveryCalculation
                    .taxAmount;

            deliveryGrossAmount =
                deliveryCalculation
                    .grossAmount;

            deliveryNetAmount =
                deliveryCalculation
                    .taxableBase;

            addBreakdown({
                breakdownMap,

                tax:
                defaultTax,

                taxableBase:
                deliveryCalculation
                    .taxableBase,

                taxAmount:
                deliveryCalculation
                    .taxAmount,

                grossAmount:
                deliveryCalculation
                    .grossAmount,
            });
        }
    }


    // ==================================================
    // TOTALES
    // ==================================================

    const itemTaxTotal =
        round2(
            calculatedItems.reduce(
                (
                    sum,
                    item
                ) =>
                    sum +
                    Number(
                        item.taxAmount ||
                        0
                    ),
                0
            )
        );

    const taxTotal =
        round2(
            itemTaxTotal +
            deliveryTaxAmount
        );

    const itemsTotalWithTax =
        round2(
            calculatedItems.reduce(
                (
                    sum,
                    item
                ) =>
                    sum +
                    Number(
                        item
                            .lineTotalWithTax ||
                        0
                    ),
                0
            )
        );

    const itemsNetAmount =
        round2(
            calculatedItems.reduce(
                (
                    sum,
                    item
                ) =>
                    sum +
                    Number(
                        item
                            ?.taxSnapshot
                            ?.taxableBase ??
                        (
                            Number(
                                item?.price ||
                                0
                            ) -
                            Number(
                                item
                                    ?.discountAmount ||
                                0
                            )
                        )
                    ),
                0
            )
        );

    const netAmount =
        round2(
            itemsNetAmount +
            deliveryNetAmount
        );

    const totalBeforeTip =
        round2(
            itemsTotalWithTax +
            deliveryGrossAmount
        );

    return {
        engineVersion:
            1,

        taxEnabled:
        engineEnabled,

        items:
        calculatedItems,

        subtotal,

        discount,

        subtotalAfterDiscount,

        netAmount,

        tax:
        taxTotal,

        taxTotal,

        taxBreakdown:
            Array.from(
                breakdownMap.values()
            ),

        deliveryFee:
        safeDeliveryFee,

        deliveryTaxAmount,

        deliveryGrossAmount,

        itemsTotalWithTax,

        totalBeforeTip,
    };
}


module.exports = {
    calculateOrderTaxes,
    getNormalizedTaxConfig,
};