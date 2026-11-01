const Tenant = require("../models/tenantModel");
const path = require("path");
const TenantEcfProfile = require("../models/tenantEcfProfileModel");
const { supabase } = require("../config/supabaseClient");


const { encryptField } = require("../services/ecf/helpers/encryptField");
const { validateEcfProfile } = require("../services/ecf/helpers/validateEcfProfile");
const { assessProductionAuthorization } = require("../services/ecf/helpers/ecfProductionAuthorization");
const { validateP12CertificateBuffer } = require("../services/ecf/signer/realSigner");
function createEcfConfigError(
    message,
    details = null
) {
    const error =
        new Error(message);

    error.statusCode = 400;

    if (details) {
        error.details = details;
    }

    return error;
}

function normalizeOptionalSequence(
    value,
    fieldName
) {
    if (
        value === "" ||
        value === null ||
        value === undefined
    ) {
        return null;
    }

    const number =
        Number(value);

    if (
        !Number.isInteger(number) ||
        number <= 0 ||
        number > 9999999999
    ) {
        throw createEcfConfigError(
            "ECF_INVALID_SEQUENCE_RANGE_VALUE",
            {
                field:
                fieldName,

                value,
            }
        );
    }

    return number;
}

function normalizeOptionalDate(
    value,
    fieldName
) {
    if (
        value === "" ||
        value === null ||
        value === undefined
    ) {
        return null;
    }

    const raw =
        String(value).trim();

    if (
        !/^\d{4}-\d{2}-\d{2}$/.test(
            raw
        )
    ) {
        throw createEcfConfigError(
            "ECF_INVALID_RANGE_DATE",
            {
                field:
                fieldName,

                value,
            }
        );
    }

    const date =
        new Date(
            `${raw}T00:00:00.000Z`
        );

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        throw createEcfConfigError(
            "ECF_INVALID_RANGE_DATE",
            {
                field:
                fieldName,

                value,
            }
        );
    }

    return date;
}
// La identificación del negocio puede haberse guardado primero en Identificación Fiscal.
// Solo rellenar RNC emisor cuando está vacío; jamás sustituir uno utilizado para emitir e-CF.
function getConfiguredIssuerRnc(tenant = {}) {
    const country = String(tenant?.localization?.countryCode || "DO").toUpperCase();
    if (country !== "DO") return "";
    const primary = tenant?.taxIdentity?.primaryTaxId || {};
    const primaryRnc = (String(primary.type || "").toUpperCase() === "RNC" && primary.active !== false && tenant?.taxIdentity?.enabled !== false)
        ? primary.value : "";
    for (const input of [primaryRnc, tenant?.business?.rnc, tenant?.fiscal?.rnc]) {
        const digits = String(input || "").replace(/\D/g, "");
        if (/^[0-9]{9}$/.test(digits) || /^[0-9]{11}$/.test(digits)) return digits;
    }
    return "";
}

exports.getEcfProfile = async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const clientId = req.scope?.clientId || req.headers["x-client-id"] || "default";

        let profile = await TenantEcfProfile.findOne({ tenantId });
        const tenant = await Tenant.findOne({ tenantId }).select("business fiscal taxIdentity localization name").lean();
        const configuredRnc = getConfiguredIssuerRnc(tenant);

        // Secondary branches see metadata ONLY: no certificate internals,
        // encryption metadata, sequence counters, approvals or audit data.
        // Never create/synchronize/update the global profile during branch GET.
        if (String(clientId) !== "default") {
            const {getSecondaryBranchStatus} = require("../services/ecf/ecfBranchAccess");
            const branch = await getSecondaryBranchStatus({tenantId,clientId});
            return res.json({success:true,data:{
                sharedReadOnly:true,branch,
                enabled:profile?.enabled === true,
                environment:profile?.environment || "internal_sandbox",
                certificationStatus:profile?.certificationStatus || "not_started",
                issuer:{rnc:profile?.issuer?.rnc || configuredRnc || "",
                        legalName:profile?.issuer?.legalName || ""},
                certificate:{configured:profile?.security?.certificateUploaded === true,
                             isActive:profile?.certificate?.isActive === true,
                             validUntil:profile?.certificate?.validUntil || null},
                documentTypes:Object.fromEntries(Object.entries(profile?.documentTypes?.toObject?.() || profile?.documentTypes || {})
                    .map(([key,value])=>[key,{enabled:value?.enabled === true}])),
            }});
        }

        if (!profile) {

            profile = await TenantEcfProfile.create({
                tenantId,
                clientId,
                issuer: {
                    rnc: configuredRnc || null,
                    legalName: tenant?.business?.name || tenant?.name || null,
                    commercialName: tenant?.business?.name || tenant?.name || null,
                    taxAddress: tenant?.business?.address || null,
                    phone: tenant?.business?.phone || null,
                    email: null,
                },
                enabled: false,
                environment: "internal_sandbox",
                certificationStatus: "not_started",
            });
        }

        // Perfil creado previamente sin RNC: sincronización segura de solo campo vacío.
        if (!profile.issuer?.rnc && configuredRnc) {
            profile.issuer = {...(profile.issuer?.toObject?.() || profile.issuer || {}), rnc: configuredRnc};
            await profile.save();
        }
        const safeProfile = profile.toObject();
        safeProfile.issuerRncMismatch = Boolean(configuredRnc && profile.issuer?.rnc && configuredRnc !== String(profile.issuer.rnc).replace(/\D/g, ""));
        safeProfile.configuredBusinessRnc = configuredRnc;
        if (safeProfile.certificate) {
            delete safeProfile.certificate.passwordEncrypted;
        }
        if (safeProfile.productionApproval?.evidenceFile) {
            // Enlace a evidencia DGII exclusivo de SuperAdmin.
            delete safeProfile.productionApproval.evidenceFile.bucket;
            delete safeProfile.productionApproval.evidenceFile.path;
        }
        if (safeProfile.productionApproval) {
            delete safeProfile.productionApproval.verificationNotes;
        }
        if (safeProfile.certificationVerification) {
            delete safeProfile.certificationVerification.notes;
        }
        delete safeProfile.approvalHistory;


        return res.json({
            success: true,
            data: safeProfile,
        });
    } catch (error) {
        console.error("getEcfProfile error:", error);
        return res.status(500).json({
            success: false,
            message: "ERROR_GETTING_ECF_PROFILE",
        });
    }
};

exports.updateEcfProfile = async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const clientId = req.scope?.clientId || req.headers["x-client-id"] || "default";
        const payload = req.body || {};

        let profile = await TenantEcfProfile.findOne({ tenantId });
        const tenant = await Tenant.findOne({ tenantId }).lean();

        if (!profile) {
            profile = new TenantEcfProfile({
                tenantId,
                clientId,
            });
        }

        const tenantIssuer = {
            rnc: getConfiguredIssuerRnc(tenant) || null,
            legalName: tenant?.business?.name || tenant?.name || null,
            commercialName: tenant?.business?.name || tenant?.name || null,
            taxAddress: tenant?.business?.address || null,
            phone: tenant?.business?.phone || null,
            email: tenant?.business?.email || null,
        };

        if (typeof payload.enabled === "boolean") {
            profile.enabled = payload.enabled;
        }

        const allowedEnvironments = [
            "internal_sandbox",
            "dgii_certification",
            "dgii_production",
        ];

        const allowedCertificationStatuses = [
            "not_started",
            "pending_config",
            "ready_for_testing",
            "in_testing",
            "certified",
            "rejected",
            "disabled",
        ];

        const requestedEnvironment =
            payload.environment && allowedEnvironments.includes(payload.environment)
                ? payload.environment
                : null;

        const requestedCertificationStatus =
            payload.certificationStatus &&
            allowedCertificationStatuses.includes(payload.certificationStatus)
                ? payload.certificationStatus
                : null;

        // El negocio nunca se certifica a sí mismo desde PATCH /ecf/profile.
        if (Object.prototype.hasOwnProperty.call(payload, "productionApproval") ||
            Object.prototype.hasOwnProperty.call(payload, "certificationVerification")) {
            return res.status(403).json({ success: false, message: "ECF_APPROVAL_SUPERADMIN_ONLY" });
        }
        if (requestedCertificationStatus === "certified") {
            return res.status(403).json({ success: false, message: "ECF_APPROVAL_SUPERADMIN_ONLY" });
        }
        if (payload.certificationStatus === "certified" && !profile.productionApproval?.verifiedAt) {
            return res.status(403).json({ success: false, message: "ECF_APPROVAL_SUPERADMIN_ONLY" });
        }

        const currentCertificationStatus = String(profile.certificationStatus || "").trim();

        if (requestedEnvironment === "dgii_production") {
            const hasRealCertificate =
                profile?.certificate?.isActive === true &&
                profile?.security?.certificateUploaded === true &&
                profile?.security?.passwordConfigured === true &&
                Boolean(profile?.certificate?.bucket) &&
                Boolean(profile?.certificate?.path) &&
                Boolean(profile?.certificate?.passwordEncrypted);

            if (currentCertificationStatus !== "certified") {
                return res.status(400).json({
                    success: false,
                    message: "ECF_CERTIFICATION_REQUIRED_BEFORE_PRODUCTION",
                });
            }
            const productionGuard = assessProductionAuthorization(profile);
            if (!productionGuard.ok) {
                return res.status(403).json({
                    success: false,
                    message: "ECF_PRODUCTION_APPROVAL_REQUIRED",
                    errors: productionGuard.errors,
                });
            }

            if (!hasRealCertificate) {
                return res.status(400).json({
                    success: false,
                    message: "REAL_DGII_CERTIFICATE_REQUIRED_BEFORE_PRODUCTION",
                });
            }
        }

        if (requestedCertificationStatus) {
            profile.certificationStatus = requestedCertificationStatus;
        }

        if (requestedEnvironment) {
            profile.environment = requestedEnvironment;
        }

        if (!profile.issuer?.rnc && tenantIssuer.rnc && !payload.issuer?.rnc) {
            profile.issuer = {...(profile.issuer?.toObject?.() || profile.issuer || {}), rnc: tenantIssuer.rnc};
        }
        if (payload.syncIssuerFromTenant === true) {
            profile.issuer = {
                ...profile.issuer,
                ...tenantIssuer,
            };
        } else if (payload.issuer && typeof payload.issuer === "object") {
            profile.issuer = {
                ...profile.issuer,
                ...payload.issuer,
            };
        }

        if (
            payload.documentTypes &&
            typeof payload.documentTypes === "object"
        ) {
            const currentDocTypes =
                profile.documentTypes?.toObject
                    ? profile.documentTypes.toObject()
                    : profile.documentTypes || {};

            const allowedTypes = [
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

            for (
                const typeKey
                of allowedTypes
                ) {
                const incoming =
                    payload.documentTypes[
                        typeKey
                        ];

                if (
                    !incoming ||
                    typeof incoming !==
                    "object"
                ) {
                    continue;
                }

                // ====================================
                // nextSequence ES SOLO DEL BACKEND
                // ====================================

                if (
                    Object.prototype
                        .hasOwnProperty.call(
                        incoming,
                        "nextSequence"
                    )
                ) {
                    throw createEcfConfigError(
                        "ECF_NEXT_SEQUENCE_READ_ONLY",
                        {
                            typeKey,
                        }
                    );
                }

                const current =
                    currentDocTypes[
                        typeKey
                        ] || {};

                const nextConfig = {
                    ...current,
                };

                if (
                    typeof incoming.enabled ===
                    "boolean"
                ) {
                    nextConfig.enabled =
                        incoming.enabled;
                }

                const hasRangeField =
                    [
                        "authorizedFrom",
                        "authorizedTo",
                        "authorizedAt",
                        "validUntil",
                    ].some(
                        (field) =>
                            Object.prototype
                                .hasOwnProperty
                                .call(
                                    incoming,
                                    field
                                )
                    );

                if (hasRangeField) {
                    const authorizedFrom =
                        normalizeOptionalSequence(
                            Object.prototype
                                .hasOwnProperty
                                .call(
                                    incoming,
                                    "authorizedFrom"
                                )
                                ? incoming
                                    .authorizedFrom
                                : current
                                    .authorizedFrom,

                            `${typeKey}.authorizedFrom`
                        );

                    const authorizedTo =
                        normalizeOptionalSequence(
                            Object.prototype
                                .hasOwnProperty
                                .call(
                                    incoming,
                                    "authorizedTo"
                                )
                                ? incoming
                                    .authorizedTo
                                : current
                                    .authorizedTo,

                            `${typeKey}.authorizedTo`
                        );

                    if (
                        (
                            authorizedFrom ===
                            null
                        ) !==
                        (
                            authorizedTo ===
                            null
                        )
                    ) {
                        throw createEcfConfigError(
                            "ECF_AUTHORIZED_RANGE_INCOMPLETE",
                            {
                                typeKey,
                                authorizedFrom,
                                authorizedTo,
                            }
                        );
                    }

                    if (
                        authorizedFrom !==
                        null &&
                        authorizedTo !==
                        null &&
                        authorizedFrom >
                        authorizedTo
                    ) {
                        throw createEcfConfigError(
                            "ECF_AUTHORIZED_RANGE_INVALID",
                            {
                                typeKey,
                                authorizedFrom,
                                authorizedTo,
                            }
                        );
                    }

                    const currentFrom =
                        normalizeOptionalSequence(
                            current.authorizedFrom,
                            `${typeKey}.currentAuthorizedFrom`
                        );

                    const currentTo =
                        normalizeOptionalSequence(
                            current.authorizedTo,
                            `${typeKey}.currentAuthorizedTo`
                        );

                    const currentNext =
                        normalizeOptionalSequence(
                            current.nextSequence,
                            `${typeKey}.currentNextSequence`
                        ) || 1;

                    const hasCurrentRange =
                        currentFrom !== null &&
                        currentTo !== null &&
                        currentFrom <=
                        currentTo;

                    const rangeChanged =
                        authorizedFrom !==
                        currentFrom ||
                        authorizedTo !==
                        currentTo;

                    const currentRangeUsed =
                        hasCurrentRange &&
                        currentNext >
                        currentFrom;

                    const currentRangeExhausted =
                        hasCurrentRange &&
                        currentNext >
                        currentTo;

                    // ====================================
                    // No permitir cambiar un rango
                    // que ya comenzó a utilizarse.
                    // ====================================

                    if (
                        rangeChanged &&
                        hasCurrentRange &&
                        currentRangeUsed &&
                        !currentRangeExhausted
                    ) {
                        throw createEcfConfigError(
                            "ECF_ACTIVE_RANGE_CANNOT_BE_REPLACED",
                            {
                                typeKey,
                                currentFrom,
                                currentTo,
                                currentNext,
                            }
                        );
                    }

                    // ====================================
                    // Un nuevo rango no puede reutilizar
                    // números del anterior.
                    // ====================================

                    if (
                        rangeChanged &&
                        currentRangeExhausted &&
                        authorizedFrom !==
                        null &&
                        authorizedFrom <=
                        currentTo
                    ) {
                        throw createEcfConfigError(
                            "ECF_NEW_RANGE_MUST_NOT_OVERLAP_PREVIOUS_RANGE",
                            {
                                typeKey,

                                previousTo:
                                currentTo,

                                requestedFrom:
                                authorizedFrom,
                            }
                        );
                    }

                    nextConfig
                        .authorizedFrom =
                        authorizedFrom;

                    nextConfig
                        .authorizedTo =
                        authorizedTo;

                    if (
                        Object.prototype
                            .hasOwnProperty
                            .call(
                                incoming,
                                "authorizedAt"
                            )
                    ) {
                        nextConfig
                            .authorizedAt =
                            normalizeOptionalDate(
                                incoming
                                    .authorizedAt,

                                `${typeKey}.authorizedAt`
                            );
                    }

                    if (
                        Object.prototype
                            .hasOwnProperty
                            .call(
                                incoming,
                                "validUntil"
                            )
                    ) {
                        nextConfig
                            .validUntil =
                            normalizeOptionalDate(
                                incoming
                                    .validUntil,

                                `${typeKey}.validUntil`
                            );
                    }

                    // ====================================
                    // PRIMER RANGO / NUEVO RANGO
                    //
                    // Aquí sí inicializamos la próxima
                    // secuencia automáticamente.
                    // ====================================

                    if (
                        authorizedFrom !==
                        null &&
                        authorizedTo !==
                        null
                    ) {
                        if (
                            !hasCurrentRange ||
                            rangeChanged ||
                            currentNext <
                            authorizedFrom
                        ) {
                            nextConfig
                                .nextSequence =
                                authorizedFrom;
                        }
                    }
                }

                profile.documentTypes[
                    typeKey
                    ] = nextConfig;
            }
        }
        if (typeof payload.certificatePassword === "string" && payload.certificatePassword.trim() &&
            profile.environment === "dgii_production") {
            return res.status(409).json({ success: false, message: "ECF_SWITCH_TO_CERTIFICATION_BEFORE_CERTIFICATE_CHANGE" });
        }
        if (typeof payload.certificatePassword === "string" && payload.certificatePassword.trim()) {
            profile.certificate.passwordEncrypted = encryptField(payload.certificatePassword.trim());
            profile.security.passwordConfigured = true;
        }

        const validation = validateEcfProfile(profile);

// ==========================================
// BLOQUEAR CONFIGURACIÓN INVÁLIDA
// EN PRODUCCIÓN DGII
// ==========================================

        if (
            profile.environment ===
            "dgii_production" &&
            !validation.ok
        ) {
            return res
                .status(400)
                .json({
                    success: false,

                    message:
                        "ECF_PRODUCTION_CONFIGURATION_INVALID",

                    errors:
                        validation.errors || [],

                    warnings:
                        validation.warnings || [],
                });
        }

// ==========================================
// GUARDAR RESULTADO DE VALIDACIÓN
// ==========================================

        profile.lastValidationResult = {
            ok: validation.ok,
            errors: validation.errors,
            checkedAt: new Date(),
        };

        profile.security.configCompleted =
            validation.ok;

        await profile.save();

        const safeProfile = profile.toObject();
        if (safeProfile.certificate) {
            delete safeProfile.certificate.passwordEncrypted;
        }
        if (safeProfile.productionApproval?.evidenceFile) {
            // Enlace a evidencia DGII exclusivo de SuperAdmin.
            delete safeProfile.productionApproval.evidenceFile.bucket;
            delete safeProfile.productionApproval.evidenceFile.path;
        }
        if (safeProfile.productionApproval) {
            delete safeProfile.productionApproval.verificationNotes;
        }
        if (safeProfile.certificationVerification) {
            delete safeProfile.certificationVerification.notes;
        }
        delete safeProfile.approvalHistory;


        return res.json({
            success: true,
            message: "ECF_PROFILE_UPDATED",
            data: safeProfile,
        });
    } catch (error) {
        console.error(
            "updateEcfProfile error:",
            error
        );

        return res
            .status(
                error.statusCode ||
                500
            )
            .json({
                success: false,

                message:
                    error.statusCode
                        ? error.message
                        : "ERROR_UPDATING_ECF_PROFILE",

                error:
                error.message,

                details:
                    error.details ||
                    null,
            });
    }
};
exports.uploadEcfCertificate = async (req, res) => {
    let uploadedNewCertificate = null;

    try {
        const tenantId =
            req.user?.tenantId;

        const clientId =
            req.scope?.clientId ||
            req.headers["x-client-id"] ||
            "default";

        if (!tenantId) {
            return res
                .status(401)
                .json({
                    success: false,
                    message:
                        "TENANT_NOT_FOUND",
                });
        }

        if (!req.file) {
            return res
                .status(400)
                .json({
                    success: false,
                    message:
                        "CERTIFICATE_FILE_REQUIRED",
                });
        }

        const password =
            String(
                req.body?.password || ""
            ).trim();

        if (!password) {
            return res
                .status(400)
                .json({
                    success: false,
                    message:
                        "CERTIFICATE_PASSWORD_REQUIRED",
                });
        }

        const originalName =
            String(
                req.file.originalname ||
                ""
            ).trim();

        const ext =
            path
                .extname(originalName)
                .toLowerCase();

        const allowedExt = [
            ".p12",
            ".pfx",
        ];

        if (
            !allowedExt.includes(ext)
        ) {
            return res
                .status(400)
                .json({
                    success: false,

                    message:
                        "INVALID_CERTIFICATE_EXTENSION",

                    allowed:
                    allowedExt,
                });
        }

        // ==========================================
        // 1. VALIDAR CERTIFICADO ANTES DE SUBIRLO
        // ==========================================

        let certificateValidation;

        try {
            certificateValidation =
                validateP12CertificateBuffer({
                    p12Buffer:
                    req.file.buffer,

                    password,
                });
        } catch (error) {
            console.error(
                "[uploadEcfCertificate] Certificate validation error:",
                error.message
            );

            return res
                .status(400)
                .json({
                    success: false,

                    message:
                        error.message ===
                        "INVALID_CERTIFICATE_PASSWORD_OR_FILE"
                            ? "CERTIFICATE_PASSWORD_INVALID"
                            : "CERTIFICATE_FILE_INVALID",

                    error:
                    error.message,
                });
        }

        // ==========================================
        // 2. CARGAR PERFIL ACTUAL
        // ==========================================

        let profile =
            await TenantEcfProfile.findOne({
                tenantId,
            });

        if (!profile) {
            const tenant =
                await Tenant.findOne({
                    tenantId,
                }).lean();

            profile =
                new TenantEcfProfile({
                    tenantId,
                    clientId,

                    issuer: {
                        rnc:
                            tenant
                                ?.business
                                ?.rnc ||
                            tenant
                                ?.fiscal
                                ?.rnc ||
                            null,

                        legalName:
                            tenant
                                ?.business
                                ?.name ||
                            tenant?.name ||
                            null,

                        commercialName:
                            tenant
                                ?.business
                                ?.name ||
                            tenant?.name ||
                            null,

                        taxAddress:
                            tenant
                                ?.business
                                ?.address ||
                            null,

                        phone:
                            tenant
                                ?.business
                                ?.phone ||
                            null,

                        email:
                            tenant
                                ?.business
                                ?.email ||
                            null,
                    },
                });
        }

        // Guardamos referencia al certificado anterior.
        // NO lo eliminamos todavía.
        const previousCertificate = {
            bucket:
                profile
                    ?.certificate
                    ?.bucket ||
                null,

            path:
                profile
                    ?.certificate
                    ?.path ||
                null,
        };

        if (profile.environment === "dgii_production") {
            return res.status(409).json({
                success: false,
                message: "ECF_SWITCH_TO_CERTIFICATION_BEFORE_CERTIFICATE_CHANGE",
            });
        }

        // ==========================================
        // 3. SUBIR CERTIFICADO NUEVO
        // ==========================================

        const bucket =
            process.env
                .SUPABASE_ECF_CERT_BUCKET ||
            "ecf-certificates";

        const safeClientId =
            String(
                clientId ||
                "default"
            ).replace(
                /[^a-zA-Z0-9_-]/g,
                "_"
            );

        const timestamp =
            Date.now();

        const filePath =
            `tenant_${tenantId}/` +
            `client_${safeClientId}/` +
            `certificate_${timestamp}${ext}`;

        const {
            error: uploadError,
        } =
            await supabase.storage
                .from(bucket)
                .upload(
                    filePath,
                    req.file.buffer,
                    {
                        contentType:
                            req.file
                                .mimetype ||
                            "application/octet-stream",

                        upsert:
                            false,
                    }
                );

        if (uploadError) {
            console.error(
                "[uploadEcfCertificate] Supabase upload error:",
                uploadError
            );

            return res
                .status(500)
                .json({
                    success: false,

                    message:
                        "CERTIFICATE_UPLOAD_FAILED",

                    error:
                    uploadError.message,
                });
        }

        uploadedNewCertificate = {
            bucket,
            path:
            filePath,
        };

        // ==========================================
        // 4. ACTUALIZAR PERFIL
        // ==========================================

        profile.certificate = {
            ...(profile.certificate ||
                {}),

            provider:
                "supabase",

            bucket,

            path:
            filePath,

            fileName:
            originalName,

            mimeType:
                req.file.mimetype ||
                "application/octet-stream",

            uploadedAt:
                new Date(),

            uploadedBy:
                req.user?._id ||
                null,

            passwordEncrypted:
                encryptField(
                    password
                ),

            passwordValidated:
                true,

            passwordValidatedAt:
                new Date(),

            isActive:
                true,

            serialNumber:
                certificateValidation
                    ?.certificateInfo
                    ?.serialNumber ||
                null,

            subjectName:
                certificateValidation?.certificateInfo?.subject?.commonName ||
                certificateValidation?.certificateInfo?.subject?.organizationName ||
                null,

            validFrom:
                certificateValidation
                    ?.certificateInfo
                    ?.validFrom ||
                null,

            validTo:
                certificateValidation
                    ?.certificateInfo
                    ?.validTo ||
                null,

            thumbprint:
                certificateValidation
                    ?.certificateInfo
                    ?.thumbprint ||
                null,

            validationError:
                null,
        };

        profile.security = {
            ...(profile.security ||
                {}),

            certificateUploaded:
                true,

            passwordConfigured:
                true,
        };

        // El reemplazo de certificado invalida la verificación vinculada a su huella.
        if (profile.productionApproval?.verifiedAt && !profile.productionApproval?.revokedAt) {
            const revokedAt = new Date();
            profile.productionApproval.revokedAt = revokedAt;
            profile.productionApproval.revokedBy = String(req.user?._id || req.user?.role || "system");
            profile.productionApproval.revocationReason = "Certificado digital reemplazado por el negocio";
            // El certificado cambiado no elimina el estatus DGII del negocio, pero revoca nuestra habilitación.
            profile.approvalHistory.push({
                action: "CERTIFICATE_REPLACED", at: revokedAt,
                actor: String(req.user?._id || req.user?.role || "system"),
                reason: "Certificado digital reemplazado; aprobación anterior inválida",
                issuerRnc: String(profile.issuer?.rnc || ""),
                certificateThumbprint: String(profile.certificate?.thumbprint || ""),
                evidenceReference: String(profile.productionApproval?.evidenceReference || ""),
                evidenceFileSha256: String(profile.productionApproval?.evidenceFile?.sha256 || ""),
                evidenceBucket: String(profile.productionApproval?.evidenceFile?.bucket || ""),
                evidencePath: String(profile.productionApproval?.evidenceFile?.path || ""),
            });
        }

        // ==========================================
        // 5. VALIDAR PERFIL
        // ==========================================

        const validation =
            validateEcfProfile(
                profile
            );

        profile.lastValidationResult = {
            ok:
            validation.ok,

            errors:
            validation.errors,

            checkedAt:
                new Date(),
        };

        profile.security
            .configCompleted =
            validation.ok;

        // ==========================================
        // 6. GUARDAR PERFIL
        // ==========================================

        try {
            await profile.save();
        } catch (saveError) {
            // Si MongoDB falla, eliminamos el
            // certificado NUEVO para no dejarlo
            // huérfano en Storage.

            try {
                await supabase.storage
                    .from(bucket)
                    .remove([
                        filePath,
                    ]);
            } catch (
                cleanupError
                ) {
                console.error(
                    "[uploadEcfCertificate] Could not rollback new certificate:",
                    cleanupError
                );
            }

            uploadedNewCertificate =
                null;

            throw saveError;
        }

        // ==========================================
        // 7. ELIMINAR CERTIFICADO ANTERIOR
        // ==========================================

        let oldCertificateCleanupWarning =
            null;

        if (
            previousCertificate.bucket &&
            previousCertificate.path &&
            !(
                previousCertificate.bucket ===
                bucket &&
                previousCertificate.path ===
                filePath
            )
        ) {
            try {
                const {
                    error:
                        deleteOldError,
                } =
                    await supabase.storage
                        .from(
                            previousCertificate
                                .bucket
                        )
                        .remove([
                            previousCertificate
                                .path,
                        ]);

                if (deleteOldError) {
                    throw deleteOldError;
                }
            } catch (
                cleanupError
                ) {
                console.error(
                    "[uploadEcfCertificate] Old certificate cleanup failed:",
                    cleanupError
                );

                // No revertimos el certificado
                // nuevo: ya está guardado y activo.
                oldCertificateCleanupWarning =
                    "OLD_CERTIFICATE_CLEANUP_FAILED";
            }
        }

        // ==========================================
        // 8. RESPUESTA SEGURA
        // ==========================================

        const safeProfile =
            profile.toObject();

        if (
            safeProfile.certificate
        ) {
            delete safeProfile
                .certificate
                .passwordEncrypted;
        }

        if (safeProfile.productionApproval?.evidenceFile) {
            delete safeProfile.productionApproval.evidenceFile.bucket;
            delete safeProfile.productionApproval.evidenceFile.path;
        }
        if (safeProfile.productionApproval) {
            delete safeProfile.productionApproval.verificationNotes;
        }
        if (safeProfile.certificationVerification) {
            delete safeProfile.certificationVerification.notes;
        }
        delete safeProfile.approvalHistory;

        return res
            .status(200)
            .json({
                success: true,

                message:
                    "ECF_CERTIFICATE_UPLOADED",

                warning:
                oldCertificateCleanupWarning,

                data:
                safeProfile,
            });

    } catch (error) {
        console.error(
            "uploadEcfCertificate error:",
            error
        );

        // Protección adicional:
        // si hubo un error inesperado después de
        // subir el nuevo archivo y todavía no fue
        // limpiado, intentamos eliminarlo.

        if (
            uploadedNewCertificate
                ?.bucket &&
            uploadedNewCertificate
                ?.path
        ) {
            try {
                await supabase.storage
                    .from(
                        uploadedNewCertificate
                            .bucket
                    )
                    .remove([
                        uploadedNewCertificate
                            .path,
                    ]);
            } catch (
                cleanupError
                ) {
                console.error(
                    "[uploadEcfCertificate] Emergency cleanup failed:",
                    cleanupError
                );
            }
        }

        return res
            .status(
                error.statusCode ||
                500
            )
            .json({
                success: false,

                message:
                    error.statusCode
                        ? error.message
                        : "ERROR_UPLOADING_ECF_CERTIFICATE",

                error:
                error.message,
            });
    }
};;