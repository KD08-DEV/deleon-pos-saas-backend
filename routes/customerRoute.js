const router =
    require("express")
        .Router();

const createHttpError =
    require("http-errors");

const verifyToken =
    require(
        "../middlewares/tokenVerification"
    );

const {
    tenantMiddleware,
} =
    require(
        "../middlewares/tenantMiddleware"
    );

const Customer =
    require(
        "../models/customerModel"
    );


// ======================================================
// HELPERS
// ======================================================

const escapeRegex = (value) => {
    return String(value || "")
        .replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&"
        );
};


// ======================================================
// IDENTIDAD FISCAL DESDE BODY
// ======================================================
//
// También permite compatibilidad temporal con:
//
// rnc
// rncCedula
//
// Así un frontend viejo todavía puede enviar un RNC
// mientras migramos todo a taxIdentity.
// ======================================================

const getTaxIdentityFromBody = (
    body = {}
) => {
    if (
        Object.prototype
            .hasOwnProperty
            .call(
                body,
                "taxIdentity"
            )
    ) {
        return Customer
            .normalizeTaxIdentity(
                body.taxIdentity
            );
    }


    // ==============================================
    // COMPATIBILIDAD LEGACY RD
    // ==============================================

    const legacyRnc =
        String(
            body?.rncCedula ||
            body?.rnc ||
            ""
        ).trim();

    if (!legacyRnc) {
        return null;
    }

    return Customer
        .normalizeTaxIdentity({
            countryCode:
                "DO",

            type:
                "RNC",

            label:
                "RNC",

            value:
            legacyRnc,
        });
};


// ======================================================
// GET /api/customer?q=...
// ======================================================

router.get(
    "/",

    verifyToken,
    tenantMiddleware,

    async (
        req,
        res,
        next
    ) => {
        try {
            const tenantId =
                req.tenantId ||
                req.user?.tenantId;

            const clientId =
                req.clientId ||
                "default";

            const q =
                String(
                    req.query.q ||
                    ""
                ).trim();

            const limit =
                Math.min(
                    Math.max(
                        Number(
                            req.query.limit ||
                            20
                        ),
                        1
                    ),

                    50
                );


            const filter = {
                tenantId,
                clientId,
                isActive:
                    true,
            };


            // ======================================
            // BÚSQUEDA
            // ======================================

            if (q) {
                const rx =
                    new RegExp(
                        escapeRegex(q),
                        "i"
                    );

                const normalizedTax =
                    Customer
                        .normalizeTaxValue(
                            q
                        );

                const or = [
                    {
                        name:
                        rx,
                    },

                    {
                        phone:
                        rx,
                    },

                    {
                        address:
                        rx,
                    },

                    {
                        "taxIdentity.value":
                        rx,
                    },

                    {
                        "taxIdentity.type":
                        rx,
                    },

                    {
                        "taxIdentity.label":
                        rx,
                    },
                ];


                /*
                 * Permite encontrar:
                 *
                 * 12-3456789
                 *
                 * buscando:
                 *
                 * 123456789
                 */
                if (
                    normalizedTax
                ) {
                    or.push({
                        "taxIdentity.valueNormalized":
                            new RegExp(
                                escapeRegex(
                                    normalizedTax
                                ),

                                "i"
                            ),
                    });
                }


                filter.$or =
                    or;
            }


            const list =
                await Customer
                    .find(
                        filter
                    )
                    .sort({
                        createdAt:
                            -1,
                    })
                    .limit(
                        limit
                    );


            return res.json({
                success:
                    true,

                data:
                list,
            });

        } catch (e) {
            console.error(
                "[CUSTOMER] GET error:",
                e
            );

            return next(
                createHttpError(
                    500,

                    "GET_CUSTOMERS_FAILED"
                )
            );
        }
    }
);


// ======================================================
// POST /api/customer
// ======================================================

router.post(
    "/",

    verifyToken,
    tenantMiddleware,

    async (
        req,
        res,
        next
    ) => {
        try {
            const tenantId =
                req.tenantId ||
                req.user?.tenantId;

            const clientId =
                req.clientId ||
                "default";


            const name =
                String(
                    req.body?.name ||
                    ""
                ).trim();


            const phone =
                String(
                    req.body?.phone ||
                    ""
                ).trim();


            const address =
                String(
                    req.body?.address ||
                    ""
                ).trim();


            if (!name) {
                return next(
                    createHttpError(
                        400,

                        "NAME_REQUIRED"
                    )
                );
            }


            // ======================================
            // TELÉFONO NORMALIZADO
            // ======================================

            const phoneNormalized =
                Customer
                    .normalizePhone(
                        phone
                    );


            // ======================================
            // EVITAR TELÉFONO DUPLICADO
            // ======================================

            if (
                phoneNormalized
            ) {
                const existing =
                    await Customer
                        .findOne({
                            tenantId,
                            clientId,
                            phoneNormalized,
                            isActive:
                                true,
                        });


                if (existing) {
                    return res
                        .status(409)
                        .json({
                            success:
                                false,

                            code:
                                "PHONE_ALREADY_EXISTS",

                            data:
                            existing,
                        });
                }
            }


            // ======================================
            // IDENTIFICACIÓN FISCAL
            // ======================================

            const taxIdentity =
                getTaxIdentityFromBody(
                    req.body
                );


            // ======================================
            // CREAR
            // ======================================

            const doc =
                await Customer
                    .create({
                        tenantId,
                        clientId,

                        name,
                        phone,
                        phoneNormalized,
                        address,

                        taxIdentity,

                        isActive:
                            true,
                    });


            return res
                .status(201)
                .json({
                    success:
                        true,

                    data:
                    doc,
                });

        } catch (e) {
            console.error(
                "[CUSTOMER] CREATE error:",
                e
            );


            if (
                e?.code ===
                11000
            ) {
                return res
                    .status(409)
                    .json({
                        success:
                            false,

                        code:
                            "PHONE_ALREADY_EXISTS",
                    });
            }


            return next(
                createHttpError(
                    500,

                    "CREATE_CUSTOMER_FAILED"
                )
            );
        }
    }
);


// ======================================================
// PATCH /api/customer/:id
// ======================================================
//
// Necesario para que la identificación fiscal quede
// guardada en el Customer real y no solamente dentro
// del snapshot de una orden.
// ======================================================

router.patch(
    "/:id",

    verifyToken,
    tenantMiddleware,

    async (
        req,
        res,
        next
    ) => {
        try {
            const tenantId =
                req.tenantId ||
                req.user?.tenantId;

            const clientId =
                req.clientId ||
                "default";


            const customer =
                await Customer
                    .findOne({
                        _id:
                        req.params.id,

                        tenantId,
                        clientId,

                        isActive:
                            true,
                    });


            if (!customer) {
                return next(
                    createHttpError(
                        404,

                        "CUSTOMER_NOT_FOUND"
                    )
                );
            }


            // ======================================
            // NOMBRE
            // ======================================

            if (
                Object.prototype
                    .hasOwnProperty
                    .call(
                        req.body,
                        "name"
                    )
            ) {
                const name =
                    String(
                        req.body
                            ?.name ||
                        ""
                    ).trim();

                if (!name) {
                    return next(
                        createHttpError(
                            400,

                            "NAME_REQUIRED"
                        )
                    );
                }

                customer.name =
                    name;
            }


            // ======================================
            // TELÉFONO
            // ======================================

            if (
                Object.prototype
                    .hasOwnProperty
                    .call(
                        req.body,
                        "phone"
                    )
            ) {
                const phone =
                    String(
                        req.body
                            ?.phone ||
                        ""
                    ).trim();

                const normalized =
                    Customer
                        .normalizePhone(
                            phone
                        );


                if (normalized) {
                    const existing =
                        await Customer
                            .findOne({
                                _id: {
                                    $ne:
                                    customer._id,
                                },

                                tenantId,
                                clientId,

                                phoneNormalized:
                                normalized,

                                isActive:
                                    true,
                            });


                    if (existing) {
                        return res
                            .status(409)
                            .json({
                                success:
                                    false,

                                code:
                                    "PHONE_ALREADY_EXISTS",

                                data:
                                existing,
                            });
                    }
                }


                customer.phone =
                    phone;

                customer.phoneNormalized =
                    normalized;
            }


            // ======================================
            // DIRECCIÓN
            // ======================================

            if (
                Object.prototype
                    .hasOwnProperty
                    .call(
                        req.body,
                        "address"
                    )
            ) {
                customer.address =
                    String(
                        req.body
                            ?.address ||
                        ""
                    ).trim();
            }


            // ======================================
            // IDENTIDAD FISCAL
            // ======================================

            if (
                Object.prototype
                    .hasOwnProperty
                    .call(
                        req.body,
                        "taxIdentity"
                    ) ||

                Object.prototype
                    .hasOwnProperty
                    .call(
                        req.body,
                        "rnc"
                    ) ||

                Object.prototype
                    .hasOwnProperty
                    .call(
                        req.body,
                        "rncCedula"
                    )
            ) {
                customer.taxIdentity =
                    getTaxIdentityFromBody(
                        req.body
                    );
            }


            await customer.save();


            return res.json({
                success:
                    true,

                data:
                customer,
            });

        } catch (e) {
            console.error(
                "[CUSTOMER] UPDATE error:",
                e
            );


            if (
                e?.code ===
                11000
            ) {
                return res
                    .status(409)
                    .json({
                        success:
                            false,

                        code:
                            "PHONE_ALREADY_EXISTS",
                    });
            }


            return next(
                createHttpError(
                    500,

                    "UPDATE_CUSTOMER_FAILED"
                )
            );
        }
    }
);


// ======================================================
// EXPORT
// ======================================================

module.exports =
    router;