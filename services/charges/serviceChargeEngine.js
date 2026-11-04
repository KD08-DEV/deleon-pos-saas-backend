function round2(value) {
    return (
        Math.round(
            (Number(value) || 0) *
            100
        ) / 100
    );
}

function getServiceChargeConfig(
    tenant = {}
) {
    const config =
        tenant
            ?.features
            ?.serviceCharges ||
        {};

    const charges =
        Array.isArray(
            config?.charges
        )
            ? config.charges
            : [];

    return {
        enabled:
            config?.enabled ===
            true,

        charges:
            charges
                .map((charge) => ({
                    id:
                        String(
                            charge?.id ||
                            ""
                        ).trim(),

                    name:
                        String(
                            charge?.name ||
                            "Cargo"
                        ).trim(),

                    code:
                        String(
                            charge?.code ||
                            "SERVICE"
                        )
                            .trim()
                            .toUpperCase(),

                    ratePercent:
                        Number(
                            charge
                                ?.ratePercent ||
                            0
                        ),

                    active:
                        charge?.active !==
                        false,

                    calculationBase:
                        charge
                            ?.calculationBase ===
                        "AFTER_TAX"
                            ? "AFTER_TAX"
                            : "NET",

                    appliesToDeliveryOrders:
                        charge
                            ?.appliesToDeliveryOrders !==
                        false,

                    appliesToDeliveryFee:
                        charge
                            ?.appliesToDeliveryFee ===
                        true,

                    addToTotal:
                        charge
                            ?.addToTotal !==
                        false,
                }))
                .filter(
                    (charge) =>
                        charge.id
                ),
    };
}

function calculateServiceCharges({
                                     tenant,
                                     taxResult,
                                     orderSource = "DINE_IN",
                                 }) {
    const config =
        getServiceChargeConfig(
            tenant
        );

    if (
        !config.enabled ||
        !taxResult
    ) {
        return {
            total: 0,
            addedTotal: 0,
            breakdown: [],
        };
    }

    const breakdown = [];
    const normalizedOrderSource =
        String(
            orderSource ||
            "DINE_IN"
        )
            .trim()
            .toUpperCase();

    const DELIVERY_CHANNELS = [
        "DELIVERY",
        "PEDIDOSYA",
        "UBEREATS",
    ];

    const isDeliveryOrder =
        DELIVERY_CHANNELS.includes(
            normalizedOrderSource
        );

    for (
        const charge of
        config.charges
        ) {
        if (
            charge.active !==
            true
        ) {
            continue;
        }
        if (
            isDeliveryOrder &&
            charge
                .appliesToDeliveryOrders ===
            false
        ) {
            continue;
        }

        let baseAmount =
            charge.calculationBase ===
            "AFTER_TAX"
                ? Number(
                    taxResult
                        .itemsTotalWithTax ||
                    0
                )
                : Number(
                    taxResult
                        .subtotalAfterDiscount ||
                    0
                );

        if (
            charge
                .appliesToDeliveryFee
        ) {
            baseAmount +=
                charge.calculationBase ===
                "AFTER_TAX"
                    ? Number(
                        taxResult
                            .deliveryGrossAmount ||
                        0
                    )
                    : Number(
                        taxResult
                            .deliveryFee ||
                        0
                    );
        }

        baseAmount =
            round2(
                Math.max(
                    baseAmount,
                    0
                )
            );

        const amount =
            round2(
                baseAmount *
                (
                    Math.max(
                        charge
                            .ratePercent,
                        0
                    ) /
                    100
                )
            );

        breakdown.push({
            chargeId:
            charge.id,

            name:
            charge.name,

            code:
            charge.code,

            ratePercent:
            charge
                .ratePercent,

            calculationBase:
            charge
                .calculationBase,

            baseAmount,

            amount,

            appliesToDeliveryOrders:
            charge
                .appliesToDeliveryOrders,

            appliesToDeliveryFee:
            charge
                .appliesToDeliveryFee,

            addToTotal:
            charge
                .addToTotal,
        });
    }

    const total =
        round2(
            breakdown.reduce(
                (
                    sum,
                    charge
                ) =>
                    sum +
                    Number(
                        charge.amount ||
                        0
                    ),
                0
            )
        );

    const addedTotal =
        round2(
            breakdown.reduce(
                (
                    sum,
                    charge
                ) =>
                    sum +
                    (
                        charge
                            .addToTotal
                            ? Number(
                                charge
                                    .amount ||
                                0
                            )
                            : 0
                    ),
                0
            )
        );

    return {
        total,
        addedTotal,
        breakdown,
    };
}

module.exports = {
    calculateServiceCharges,
    getServiceChargeConfig,
};