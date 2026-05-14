const Tenant = require("../models/tenantModel");
const path = require("path");
const TenantEcfProfile = require("../models/tenantEcfProfileModel");
const { supabase } = require("../config/supabaseClient");

const { encryptField } = require("../services/ecf/helpers/encryptField");
const { validateEcfProfile } = require("../services/ecf/helpers/validateEcfProfile");

exports.getEcfProfile = async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const clientId = req.scope?.clientId || req.headers["x-client-id"] || "default";

        let profile = await TenantEcfProfile.findOne({ tenantId });

        if (!profile) {
            const tenant = await Tenant.findOne({ tenantId });

            profile = await TenantEcfProfile.create({
                tenantId,
                clientId,
                issuer: {
                    rnc: tenant?.business?.rnc || null,
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

        const safeProfile = profile.toObject();
        if (safeProfile.certificate) {
            delete safeProfile.certificate.passwordEncrypted;
        }

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
            rnc: tenant?.business?.rnc || tenant?.fiscal?.rnc || null,
            legalName: tenant?.business?.name || tenant?.name || null,
            commercialName: tenant?.business?.name || tenant?.name || null,
            taxAddress: tenant?.business?.address || null,
            phone: tenant?.business?.phone || null,
            email: tenant?.business?.email || null,
        };

        if (typeof payload.enabled === "boolean") {
            profile.enabled = payload.enabled;
        }

        if (
            payload.environment &&
            ["internal_sandbox", "dgii_certification", "dgii_production"].includes(payload.environment)
        ) {
            profile.environment = payload.environment;
        }

        if (
            payload.certificationStatus &&
            [
                "not_started",
                "pending_config",
                "ready_for_testing",
                "in_testing",
                "certified",
                "rejected",
                "disabled",
            ].includes(payload.certificationStatus)
        ) {
            profile.certificationStatus = payload.certificationStatus;
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

        if (payload.documentTypes && typeof payload.documentTypes === "object") {
            const currentDocTypes = profile.documentTypes?.toObject
                ? profile.documentTypes.toObject()
                : profile.documentTypes || {};

            const allowedTypes = ["e31", "e32", "e33", "e34"];

            for (const typeKey of allowedTypes) {
                if (!payload.documentTypes[typeKey]) continue;

                profile.documentTypes[typeKey] = {
                    ...(currentDocTypes[typeKey] || {}),
                    ...payload.documentTypes[typeKey],
                };
            }
        }

        if (typeof payload.certificatePassword === "string" && payload.certificatePassword.trim()) {
            profile.certificate.passwordEncrypted = encryptField(payload.certificatePassword.trim());
            profile.security.passwordConfigured = true;
        }

        const validation = validateEcfProfile(profile);

        profile.lastValidationResult = {
            ok: validation.ok,
            errors: validation.errors,
            checkedAt: new Date(),
        };

        profile.security.configCompleted = validation.ok;

        await profile.save();

        const safeProfile = profile.toObject();
        if (safeProfile.certificate) {
            delete safeProfile.certificate.passwordEncrypted;
        }

        return res.json({
            success: true,
            message: "ECF_PROFILE_UPDATED",
            data: safeProfile,
        });
    } catch (error) {
        console.error("updateEcfProfile error:", error);
        return res.status(500).json({
            success: false,
            message: "ERROR_UPDATING_ECF_PROFILE",
            error: error.message,
        });
    }
};
exports.uploadEcfCertificate = async (req, res) => {
    try {
        const tenantId = req.user?.tenantId;
        const clientId = req.scope?.clientId || req.headers["x-client-id"] || "default";

        if (!tenantId) {
            return res.status(401).json({
                success: false,
                message: "TENANT_NOT_FOUND",
            });
        }

        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "CERTIFICATE_FILE_REQUIRED",
            });
        }

        const password = String(req.body?.password || "").trim();

        if (!password) {
            return res.status(400).json({
                success: false,
                message: "CERTIFICATE_PASSWORD_REQUIRED",
            });
        }

        const originalName = String(req.file.originalname || "").trim();
        const ext = path.extname(originalName).toLowerCase();

        const allowedExt = [".p12", ".pfx"];

        if (!allowedExt.includes(ext)) {
            return res.status(400).json({
                success: false,
                message: "INVALID_CERTIFICATE_EXTENSION",
                allowed: allowedExt,
            });
        }

        const bucket = process.env.SUPABASE_ECF_CERT_BUCKET || "ecf-certificates";

        const safeClientId = String(clientId || "default")
            .replace(/[^a-zA-Z0-9_-]/g, "_");

        const timestamp = Date.now();

        const filePath = `tenant_${tenantId}/client_${safeClientId}/certificate_${timestamp}${ext}`;

        const { error: uploadError } = await supabase.storage
            .from(bucket)
            .upload(filePath, req.file.buffer, {
                contentType: req.file.mimetype || "application/octet-stream",
                upsert: false,
            });

        if (uploadError) {
            console.error("[uploadEcfCertificate] Supabase upload error:", uploadError);

            return res.status(500).json({
                success: false,
                message: "CERTIFICATE_UPLOAD_FAILED",
                error: uploadError.message,
            });
        }

        let profile = await TenantEcfProfile.findOne({ tenantId });

        if (!profile) {
            const tenant = await Tenant.findOne({ tenantId }).lean();

            profile = new TenantEcfProfile({
                tenantId,
                clientId,
                issuer: {
                    rnc: tenant?.business?.rnc || tenant?.fiscal?.rnc || null,
                    legalName: tenant?.business?.name || tenant?.name || null,
                    commercialName: tenant?.business?.name || tenant?.name || null,
                    taxAddress: tenant?.business?.address || null,
                    phone: tenant?.business?.phone || null,
                    email: tenant?.business?.email || null,
                },
            });
        }

        profile.certificate = {
            ...(profile.certificate || {}),
            provider: "supabase",
            bucket,
            path: filePath,
            fileName: originalName,
            mimeType: req.file.mimetype || "application/octet-stream",
            uploadedAt: new Date(),
            uploadedBy: req.user?._id || null,
            passwordEncrypted: encryptField(password),
            isActive: true,
        };

        profile.security = {
            ...(profile.security || {}),
            certificateUploaded: true,
            passwordConfigured: true,
        };

        const validation = validateEcfProfile(profile);

        profile.lastValidationResult = {
            ok: validation.ok,
            errors: validation.errors,
            checkedAt: new Date(),
        };

        profile.security.configCompleted = validation.ok;

        await profile.save();

        const safeProfile = profile.toObject();

        if (safeProfile.certificate) {
            delete safeProfile.certificate.passwordEncrypted;
        }

        return res.status(200).json({
            success: true,
            message: "ECF_CERTIFICATE_UPLOADED",
            data: safeProfile,
        });
    } catch (error) {
        console.error("uploadEcfCertificate error:", error);

        return res.status(500).json({
            success: false,
            message: "ERROR_UPLOADING_ECF_CERTIFICATE",
            error: error.message,
        });
    }
};