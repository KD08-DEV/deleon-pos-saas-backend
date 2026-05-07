const mongoose = require("mongoose");

const tenantEcfProfileSchema = new mongoose.Schema(
    {
        tenantId: { type: String, required: true, unique: true, index: true },
        clientId: { type: String, default: "default", index: true },

        enabled: { type: Boolean, default: false },

        environment: {
            type: String,
            enum: ["internal_sandbox", "dgii_certification", "dgii_production"],
            default: "internal_sandbox",
        },

        certificationStatus: {
            type: String,
            enum: [
                "not_started",
                "pending_config",
                "ready_for_testing",
                "in_testing",
                "certified",
                "rejected",
                "disabled",
            ],
            default: "not_started",
        },

        issuerMode: {
            type: String,
            enum: ["tenant_direct"],
            default: "tenant_direct",
        },

        issuer: {
            rnc: { type: String, default: null },
            legalName: { type: String, default: null },
            commercialName: { type: String, default: null },
            taxAddress: { type: String, default: null },
            phone: { type: String, default: null },
            email: { type: String, default: null },
        },

        certificate: {
            provider: { type: String, default: "supabase" },
            bucket: { type: String, default: null },
            path: { type: String, default: null },
            fileName: { type: String, default: null },
            mimeType: { type: String, default: null },
            uploadedAt: { type: Date, default: null },
            uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
            passwordEncrypted: { type: String, default: null },
            isActive: { type: Boolean, default: false },
            validFrom: { type: Date, default: null },
            validTo: { type: Date, default: null },
            serialNumber: { type: String, default: null },
            thumbprint: { type: String, default: null },
        },

        documentTypes: {
            e31: {
                enabled: { type: Boolean, default: false },
                nextSequence: { type: Number, default: 1 },
            },
            e32: {
                enabled: { type: Boolean, default: true },
                nextSequence: { type: Number, default: 1 },
            },
            e33: {
                enabled: { type: Boolean, default: false },
                nextSequence: { type: Number, default: 1 },
            },
            e34: {
                enabled: { type: Boolean, default: false },
                nextSequence: { type: Number, default: 1 },
            },
        },

        security: {
            configCompleted: { type: Boolean, default: false },
            certificateUploaded: { type: Boolean, default: false },
            passwordConfigured: { type: Boolean, default: false },
        },

        lastValidationResult: {
            ok: { type: Boolean, default: false },
            errors: { type: [String], default: [] },
            checkedAt: { type: Date, default: null },
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model("TenantEcfProfile", tenantEcfProfileSchema);