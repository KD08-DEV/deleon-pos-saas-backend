const TenantEcfProfile = require(
    "../../../models/tenantEcfProfileModel"
);

const {
    normalizeEcfDocumentType,
    getEcfDocumentTypeKey,
} = require("./ecfDocumentTypes");

const MAX_ECF_SEQUENCE = 9999999999;

function makeError(
    message,
    statusCode = 400,
    details = null
) {
    const err = new Error(message);

    err.statusCode = statusCode;

    if (details) {
        err.details = details;
    }

    return err;
}

function normalizeSequenceNumber(value) {
    const number = Number(value);

    if (
        !Number.isInteger(number) ||
        number <= 0 ||
        number > MAX_ECF_SEQUENCE
    ) {
        return null;
    }

    return number;
}

function isExpired(dateValue) {
    if (!dateValue) {
        return false;
    }

    const date = new Date(dateValue);

    if (Number.isNaN(date.getTime())) {
        return true;
    }

    // El rango puede utilizarse durante todo
    // el día indicado como fecha límite.
    date.setUTCHours(
        23,
        59,
        59,
        999
    );

    return date.getTime() < Date.now();
}

async function ensureEnvironmentCounter({
                                            tenantId,
                                            environment,
                                            typeKey,
                                            fieldName,
                                        }) {
    const path =
        `documentTypes.${typeKey}.${fieldName}`;

    // Compatibilidad con perfiles creados
    // antes de agregar sandboxNextSequence /
    // certificationNextSequence.
    await TenantEcfProfile.updateOne(
        {
            tenantId,
            environment,

            $or: [
                {
                    [path]: {
                        $exists: false,
                    },
                },
                {
                    [path]: null,
                },
            ],
        },

        {
            $set: {
                [path]: 1,
            },
        }
    );
}

async function incrementEnvironmentSequence({
                                                tenantId,
                                                environment,
                                                type,
                                                typeKey,
                                                fieldName,
                                            }) {
    const path =
        `documentTypes.${typeKey}.${fieldName}`;

    const enabledPath =
        `documentTypes.${typeKey}.enabled`;

    await ensureEnvironmentCounter({
        tenantId,
        environment,
        typeKey,
        fieldName,
    });

    const profileBeforeIncrement =
        await TenantEcfProfile.findOneAndUpdate(
            {
                tenantId,
                environment,
                enabled: true,

                [enabledPath]: true,

                [path]: {
                    $gte: 1,
                    $lte: MAX_ECF_SEQUENCE,
                },
            },

            {
                $inc: {
                    [path]: 1,
                },
            },

            {
                new: false,
            }
        );

    if (!profileBeforeIncrement) {
        const latestProfile =
            await TenantEcfProfile
                .findOne({
                    tenantId,
                })
                .lean();

        if (!latestProfile?.enabled) {
            throw makeError(
                "ECF_PROFILE_NOT_ENABLED",
                400
            );
        }

        if (
            latestProfile
                ?.documentTypes
                ?.[typeKey]
                ?.enabled !== true
        ) {
            throw makeError(
                `ECF_DOCUMENT_TYPE_NOT_ENABLED_${typeKey.toUpperCase()}`,
                400
            );
        }

        throw makeError(
            "ECF_ENVIRONMENT_SEQUENCE_NOT_AVAILABLE",
            409,
            {
                environment,
                documentType: type,
                typeKey,
                fieldName,
            }
        );
    }

    const reservedSequence =
        normalizeSequenceNumber(
            profileBeforeIncrement
                ?.documentTypes
                ?.[typeKey]
                ?.[fieldName]
        );

    if (reservedSequence === null) {
        throw makeError(
            "ECF_RESERVED_SEQUENCE_INVALID",
            500,
            {
                environment,
                documentType: type,
                typeKey,
                fieldName,
            }
        );
    }

    return reservedSequence;
}

async function getNextProductionSequence({
                                             tenantId,
                                             type,
                                             typeKey,
                                             profile,
                                         }) {
    const typeConfig =
        profile
            ?.documentTypes
            ?.[typeKey];

    const authorizedFrom =
        normalizeSequenceNumber(
            typeConfig?.authorizedFrom
        );

    const authorizedTo =
        normalizeSequenceNumber(
            typeConfig?.authorizedTo
        );

    const nextSequence =
        normalizeSequenceNumber(
            typeConfig?.nextSequence
        );

    const hasConfiguredRange =
        authorizedFrom !== null &&
        authorizedTo !== null &&
        authorizedFrom <= authorizedTo;

    if (!hasConfiguredRange) {
        throw makeError(
            "ECF_AUTHORIZED_RANGE_REQUIRED",
            400,
            {
                documentType: type,
                typeKey,
                authorizedFrom:
                    typeConfig
                        ?.authorizedFrom ??
                    null,
                authorizedTo:
                    typeConfig
                        ?.authorizedTo ??
                    null,
            }
        );
    }

    if (
        isExpired(
            typeConfig?.validUntil
        )
    ) {
        throw makeError(
            "ECF_AUTHORIZED_RANGE_EXPIRED",
            400,
            {
                documentType: type,
                typeKey,
                validUntil:
                typeConfig?.validUntil,
            }
        );
    }

    if (nextSequence === null) {
        throw makeError(
            "ECF_NEXT_SEQUENCE_INVALID",
            400,
            {
                documentType: type,
                typeKey,
                nextSequence:
                    typeConfig
                        ?.nextSequence ??
                    null,
            }
        );
    }

    if (
        nextSequence <
        authorizedFrom
    ) {
        throw makeError(
            "ECF_NEXT_SEQUENCE_BEFORE_AUTHORIZED_RANGE",
            400,
            {
                documentType: type,
                typeKey,
                nextSequence,
                authorizedFrom,
            }
        );
    }

    if (
        nextSequence >
        authorizedTo
    ) {
        throw makeError(
            "ECF_AUTHORIZED_RANGE_EXHAUSTED",
            409,
            {
                documentType: type,
                typeKey,
                nextSequence,
                authorizedTo,
            }
        );
    }

    const path =
        `documentTypes.${typeKey}.nextSequence`;

    const enabledPath =
        `documentTypes.${typeKey}.enabled`;

    const fromPath =
        `documentTypes.${typeKey}.authorizedFrom`;

    const toPath =
        `documentTypes.${typeKey}.authorizedTo`;

    const profileBeforeIncrement =
        await TenantEcfProfile.findOneAndUpdate(
            {
                tenantId,

                environment:
                    "dgii_production",

                enabled: true,

                [enabledPath]:
                    true,

                [fromPath]:
                authorizedFrom,

                [toPath]:
                authorizedTo,

                [path]: {
                    $gte:
                    authorizedFrom,

                    $lte:
                    authorizedTo,
                },
            },

            {
                $inc: {
                    [path]: 1,
                },
            },

            {
                new: false,
            }
        );

    if (!profileBeforeIncrement) {
        const latestProfile =
            await TenantEcfProfile
                .findOne({
                    tenantId,
                })
                .lean();

        const latestNext =
            normalizeSequenceNumber(
                latestProfile
                    ?.documentTypes
                    ?.[typeKey]
                    ?.nextSequence
            );

        if (
            latestNext !== null &&
            latestNext >
            authorizedTo
        ) {
            throw makeError(
                "ECF_AUTHORIZED_RANGE_EXHAUSTED",
                409,
                {
                    documentType:
                    type,

                    typeKey,

                    nextSequence:
                    latestNext,

                    authorizedTo,
                }
            );
        }

        throw makeError(
            "ECF_SEQUENCE_COULD_NOT_BE_RESERVED",
            409,
            {
                documentType:
                type,

                typeKey,
            }
        );
    }

    const reservedSequence =
        normalizeSequenceNumber(
            profileBeforeIncrement
                ?.documentTypes
                ?.[typeKey]
                ?.nextSequence
        );

    if (reservedSequence === null) {
        throw makeError(
            "ECF_RESERVED_SEQUENCE_INVALID",
            500,
            {
                documentType:
                type,

                typeKey,
            }
        );
    }

    return reservedSequence;
}

async function getNextSequence({
                                   tenantId,
                                   documentType = "32",
                               }) {
    const type =
        normalizeEcfDocumentType(
            documentType
        );

    const typeKey =
        getEcfDocumentTypeKey(type);

    const profile =
        await TenantEcfProfile
            .findOne({
                tenantId,
            })
            .lean();

    if (
        !profile ||
        profile.enabled !== true
    ) {
        throw makeError(
            "ECF_PROFILE_NOT_ENABLED",
            400
        );
    }

    if (
        profile
            ?.documentTypes
            ?.[typeKey]
            ?.enabled !== true
    ) {
        throw makeError(
            `ECF_DOCUMENT_TYPE_NOT_ENABLED_${typeKey.toUpperCase()}`,
            400
        );
    }

    const environment =
        String(
            profile.environment ||
            "internal_sandbox"
        ).trim();

    // ==========================================
    // SANDBOX
    // ==========================================

    if (
        environment ===
        "internal_sandbox"
    ) {
        return incrementEnvironmentSequence({
            tenantId,
            environment,
            type,
            typeKey,
            fieldName:
                "sandboxNextSequence",
        });
    }

    // ==========================================
    // CERTIFICACIÓN DGII
    // ==========================================

    if (
        environment ===
        "dgii_certification"
    ) {
        return incrementEnvironmentSequence({
            tenantId,
            environment,
            type,
            typeKey,
            fieldName:
                "certificationNextSequence",
        });
    }

    // ==========================================
    // PRODUCCIÓN DGII
    // ==========================================

    if (
        environment ===
        "dgii_production"
    ) {
        return getNextProductionSequence({
            tenantId,
            type,
            typeKey,
            profile,
        });
    }

    throw makeError(
        "ECF_ENVIRONMENT_INVALID",
        400,
        {
            environment,
        }
    );
}

module.exports = {
    getNextSequence,
};