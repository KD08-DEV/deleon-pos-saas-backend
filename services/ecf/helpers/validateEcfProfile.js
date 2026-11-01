const { assessProductionAuthorization } = require("./ecfProductionAuthorization");
const ALLOWED_TYPE_KEYS = [
    "e31",
    "e32",
    "e33",
    "e34",
    "e41",
    "e43",
    "e44",
    "e45",
    "e46",
    "e47",
];

function positiveIntegerOrNull(value) {
    const number = Number(value);

    if (
        !Number.isInteger(number) ||
        number <= 0 ||
        number > 9999999999
    ) {
        return null;
    }

    return number;
}

function isRangeExpired(value) {
    if (!value) {
        return false;
    }

    const date = new Date(value);

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        return true;
    }

    date.setUTCHours(
        23,
        59,
        59,
        999
    );

    return (
        date.getTime() <
        Date.now()
    );
}

function isCertificateExpired(value) {
    if (!value) {
        return false;
    }

    const date = new Date(value);

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        return true;
    }

    return (
        date.getTime() <
        Date.now()
    );
}

function isCertificateNotYetValid(value) {
    if (!value) {
        return false;
    }

    const date = new Date(value);

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        return true;
    }

    return (
        date.getTime() >
        Date.now()
    );
}

function validateEcfProfile(profile) {
    const errors = [];
    const warnings = [];

    const documentTypes = {};

    if (!profile) {
        errors.push(
            "Perfil e-CF no encontrado"
        );

        return {
            ok: false,
            errors,
            warnings,
            issuerReady: false,
            certificateReady: false,
            certificateRequired: false,
            documentTypes,
        };
    }

    const environment =
        String(
            profile.environment ||
            ""
        ).trim();

    if (!profile.enabled) {
        errors.push(
            "El módulo e-CF está desactivado"
        );
    }

    if (!environment) {
        errors.push(
            "Falta ambiente e-CF"
        );
    }

    const issuerReady =
        Boolean(
            profile?.issuer?.rnc &&
            profile?.issuer?.legalName &&
            profile?.issuer?.taxAddress
        );

    if (!profile?.issuer?.rnc) {
        errors.push(
            "Falta RNC del emisor"
        );
    }

    if (!profile?.issuer?.legalName) {
        errors.push(
            "Falta razón social"
        );
    }

    if (!profile?.issuer?.taxAddress) {
        errors.push(
            "Falta dirección fiscal"
        );
    }

    const enabledTypeKeys =
        ALLOWED_TYPE_KEYS.filter(
            (typeKey) =>
                profile
                    ?.documentTypes
                    ?.[typeKey]
                    ?.enabled === true
        );

    if (
        enabledTypeKeys.length === 0
    ) {
        errors.push(
            "Debes habilitar al menos un tipo de e-CF"
        );
    }

    // ==========================================
    // CERTIFICADO
    // ==========================================

    const certificateRequired =
        environment ===
        "dgii_certification" ||
        environment ===
        "dgii_production";

    const certificateStored =
        Boolean(
            profile
                ?.certificate
                ?.bucket
        ) &&
        Boolean(
            profile
                ?.certificate
                ?.path
        ) &&
        Boolean(
            profile
                ?.certificate
                ?.passwordEncrypted
        );

    const certificateFlagsReady =
        profile
            ?.certificate
            ?.isActive === true &&
        profile
            ?.security
            ?.certificateUploaded === true &&
        profile
            ?.security
            ?.passwordConfigured === true &&
        profile
            ?.certificate
            ?.passwordValidated === true;

    const certificateExpired =
        isCertificateExpired(
            profile
                ?.certificate
                ?.validTo
        );

    const certificateNotYetValid =
        isCertificateNotYetValid(
            profile
                ?.certificate
                ?.validFrom
        );

    const certificateReady =
        certificateStored &&
        certificateFlagsReady &&
        !certificateExpired &&
        !certificateNotYetValid;

    if (certificateRequired) {
        if (!certificateStored) {
            errors.push(
                "Falta certificado digital o su configuración de almacenamiento"
            );
        }

        if (!certificateFlagsReady) {
            errors.push(
                "El certificado digital no está validado correctamente"
            );
        }

        if (certificateExpired) {
            errors.push(
                "El certificado digital está vencido"
            );
        }

        if (
            certificateNotYetValid
        ) {
            errors.push(
                "El certificado digital todavía no es válido"
            );
        }
    }

    // ==========================================
    // PRODUCCIÓN
    // ==========================================

    if (
        environment ===
        "dgii_production"
    ) {
        // El estado textual "certified" no basta: se exige verificación
        // documental registrada por SuperAdmin y vinculada al certificado actual.
        if (String(process.env.ECF_XSD_MODE || "").toLowerCase() !== "enforce") {
            errors.push("ECF_XSD_ENFORCE_REQUIRED_FOR_PRODUCTION");
        }
        const productionApproval = assessProductionAuthorization(profile);
        if (!productionApproval.ok) {
            errors.push(...productionApproval.errors);
        }

        if (
            String(
                profile
                    .certificationStatus ||
                ""
            ).trim() !==
            "certified"
        ) {
            errors.push(
                "La certificación DGII debe estar aprobada antes de usar Producción"
            );
        }

        for (
            const typeKey
            of enabledTypeKeys
            ) {
            const config =
                profile
                    ?.documentTypes
                    ?.[typeKey] ||
                {};

            const from =
                positiveIntegerOrNull(
                    config.authorizedFrom
                );

            const to =
                positiveIntegerOrNull(
                    config.authorizedTo
                );

            const next =
                positiveIntegerOrNull(
                    config.nextSequence
                );

            const rangeConfigured =
                from !== null &&
                to !== null &&
                from <= to;

            const expired =
                isRangeExpired(
                    config.validUntil
                );

            let ready =
                rangeConfigured &&
                next !== null &&
                next >= from &&
                next <= to &&
                !expired;

            if (!rangeConfigured) {
                errors.push(
                    `${typeKey.toUpperCase()}: falta rango autorizado`
                );

                ready = false;
            }

            if (
                rangeConfigured &&
                next === null
            ) {
                errors.push(
                    `${typeKey.toUpperCase()}: próxima secuencia inválida`
                );

                ready = false;
            }

            if (
                rangeConfigured &&
                next !== null &&
                next < from
            ) {
                errors.push(
                    `${typeKey.toUpperCase()}: próxima secuencia está antes del rango autorizado`
                );

                ready = false;
            }

            if (
                rangeConfigured &&
                next !== null &&
                next > to
            ) {
                errors.push(
                    `${typeKey.toUpperCase()}: rango autorizado agotado`
                );

                ready = false;
            }

            if (expired) {
                errors.push(
                    `${typeKey.toUpperCase()}: rango autorizado vencido`
                );

                ready = false;
            }

            if (
                rangeConfigured &&
                !config.validUntil
            ) {
                warnings.push(
                    `${typeKey.toUpperCase()}: no tiene fecha de vencimiento registrada`
                );
            }

            documentTypes[
                typeKey
                ] = {
                enabled: true,
                ready,

                authorizedFrom:
                from,

                authorizedTo:
                to,

                nextSequence:
                next,

                validUntil:
                    config.validUntil ||
                    null,

                rangeConfigured,

                expired,

                exhausted:
                    rangeConfigured &&
                    next !== null &&
                    next > to,

                remaining:
                    rangeConfigured &&
                    next !== null
                        ? Math.max(
                            0,
                            to -
                            next +
                            1
                        )
                        : 0,
            };
        }
    } else {
        for (
            const typeKey
            of enabledTypeKeys
            ) {
            const config =
                profile
                    ?.documentTypes
                    ?.[typeKey] ||
                {};

            const field =
                environment ===
                "dgii_certification"
                    ? "certificationNextSequence"
                    : "sandboxNextSequence";

            documentTypes[
                typeKey
                ] = {
                enabled: true,
                ready: true,

                nextSequence:
                    positiveIntegerOrNull(
                        config[field]
                    ) || 1,

                sequenceField:
                field,
            };
        }
    }

    return {
        ok:
            errors.length === 0,

        errors,
        warnings,

        environment,

        issuerReady,

        certificateRequired,
        certificateReady,

        enabledTypeKeys,

        documentTypes,
    };
}

module.exports = {
    validateEcfProfile,
};