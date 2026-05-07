const Tenant = require("../models/tenantModel");
const TenantEcfProfile = require("../models/tenantEcfProfileModel");
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

        if (!profile) {
            profile = new TenantEcfProfile({
                tenantId,
                clientId,
            });
        }

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

        if (payload.issuer && typeof payload.issuer === "object") {
            profile.issuer = {
                ...profile.issuer,
                ...payload.issuer,
            };
        }

        if (payload.documentTypes && typeof payload.documentTypes === "object") {
            profile.documentTypes = {
                ...profile.documentTypes,
                ...payload.documentTypes,
            };
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