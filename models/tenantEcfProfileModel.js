const mongoose = require("mongoose");

const buildDocumentTypeDefinition = (defaultEnabled = false) => ({
    enabled: {
        type: Boolean,
        default: defaultEnabled,
    },

    // ==========================================
    // SANDBOX INTERNO
    // ==========================================
    sandboxNextSequence: {
        type: Number,
        default: 1,
        min: 1,
    },

    // ==========================================
    // CERTIFICACIÓN DGII
    // ==========================================
    certificationNextSequence: {
        type: Number,
        default: 1,
        min: 1,
    },

    // ==========================================
    // PRODUCCIÓN DGII
    // ==========================================
    //
    // nextSequence queda reservado exclusivamente
    // para el rango productivo autorizado.
    // ==========================================
    nextSequence: {
        type: Number,
        default: 1,
        min: 1,
    },

    authorizedFrom: {
        type: Number,
        default: null,
        min: 1,
    },

    authorizedTo: {
        type: Number,
        default: null,
        min: 1,
    },

    authorizedAt: {
        type: Date,
        default: null,
    },

    validUntil: {
        type: Date,
        default: null,
    },
});
const tenantEcfProfileSchema = new mongoose.Schema(
    {
        tenantId: {
            type: String,
            required: true,
            unique: true,
            index: true,
        },

        clientId: {
            type: String,
            default: "default",
            index: true,
        },

        enabled: {
            type: Boolean,
            default: false,
        },
        // Activación por sede: la principal es virtual, mantiene ON para tenants legacy.
        // Esta bandera NO concede certificación, firma ni habilitación DGII.
        branchActivation: {
            primaryEnabled: { type: Boolean, default: true },
            updatedAt: { type: Date, default: null },
            updatedBy: { type: String, default: null },
        },

        environment: {
            type: String,
            enum: [
                "internal_sandbox",
                "dgii_certification",
                "dgii_production",
            ],
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
            rnc: {
                type: String,
                default: null,
            },

            legalName: {
                type: String,
                default: null,
            },

            commercialName: {
                type: String,
                default: null,
            },

            taxAddress: {
                type: String,
                default: null,
            },

            phone: {
                type: String,
                default: null,
            },

            email: {
                type: String,
                default: null,
            },
        },

        certificate: {
            provider: {
                type: String,
                default: "supabase",
            },

            bucket: {
                type: String,
                default: null,
            },

            path: {
                type: String,
                default: null,
            },

            fileName: {
                type: String,
                default: null,
            },

            mimeType: {
                type: String,
                default: null,
            },

            uploadedAt: {
                type: Date,
                default: null,
            },

            uploadedBy: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User",
                default: null,
            },

            passwordEncrypted: {
                type: String,
                default: null,
            },

            passwordValidated: {
                type: Boolean,
                default: false,
            },

            passwordValidatedAt: {
                type: Date,
                default: null,
            },

            isActive: {
                type: Boolean,
                default: false,
            },

            validFrom: {
                type: Date,
                default: null,
            },

            validTo: {
                type: Date,
                default: null,
            },

            serialNumber: {
                type: String,
                default: null,
            },

            // Nombre común contenido en el sujeto del certificado X.509.
            subjectName: { type: String, default: null },

            thumbprint: {
                type: String,
                default: null,
            },

            validationError: {
                type: String,
                default: null,
            },
        },

        documentTypes: {
            // Ventas normales
            e31: buildDocumentTypeDefinition(true),
            e32: buildDocumentTypeDefinition(true),

            // Ajustes
            e33: buildDocumentTypeDefinition(true),
            e34: buildDocumentTypeDefinition(true),

            // Comprobantes especiales
            e41: buildDocumentTypeDefinition(false),
            e43: buildDocumentTypeDefinition(false),
            e44: buildDocumentTypeDefinition(false),
            e45: buildDocumentTypeDefinition(false),
            e46: buildDocumentTypeDefinition(false),
            e47: buildDocumentTypeDefinition(false),
        },

        // La DGII autoriza al CONTRIBUYENTE, no a DeLeonSoft.
        // Este objeto registra una constatación interna del estado público, no un permiso DGII.
        productionApproval: {
            approvalVersion: { type: Number, default: null },
            verificationMethod: { type: String, enum: ["DGII_PUBLIC_QUERY", "DGII_OFFICIAL_DOCUMENT", null], default: null },
            dgiiTaxStatus: { type: String, enum: ["ACTIVE", "INACTIVE", null], default: null },
            dgiiEcfStatus: { type: String, enum: ["YES", "NO", null], default: null },
            queriedRnc: { type: String, default: null },
            queriedLegalName: { type: String, default: null },
            evidenceSource: { type: String, default: null },
            evidenceReference: { type: String, default: null },
            evidenceDocumentType: { type: String, default: null },
            evidenceDocumentDate: { type: Date, default: null },
            evidenceFile: {
                bucket: { type: String, default: null },
                path: { type: String, default: null },
                name: { type: String, default: null },
                sha256: { type: String, default: null },
                uploadedAt: { type: Date, default: null },
                size: { type: Number, default: null },
            },
            verificationNotes: { type: String, default: null },
            revocationReason: { type: String, default: null },
            issuerRnc: { type: String, default: null },
            certificateThumbprint: { type: String, default: null },
            verifiedAt: { type: Date, default: null },
            verifiedBy: { type: String, default: null },
            revokedAt: { type: Date, default: null },
            revokedBy: { type: String, default: null },
        },

        // Confirmación APARTE de que el cliente culminó ante DGII la incorporación
        // o cambio al software DeLeonSoft. Una simple consulta RNC NO confirma esto.
        certificationVerification: {
            verifiedAt: { type: Date, default: null },
            verifiedBy: { type: String, default: null },
            method: { type: String, enum: ["NEW_SOFTWARE_CERTIFICATION", "SOFTWARE_CHANGE", null], default: null },
            reference: { type: String, default: null },
            notes: { type: String, default: null },
            softwareName: { type: String, default: null },
        },

        // Registro apendicular de decisiones sobre autorización, en la misma
        // escritura MongoDB que la aprobación o revocación.
        approvalHistory: [{
            action: { type: String, enum: ["EVIDENCE_UPLOADED", "APPROVED", "REVOKED", "CERTIFICATE_REPLACED", "CERTIFICATION_CONFIRMED"], required: true },
            at: { type: Date, required: true },
            actor: { type: String, required: true },
            reason: { type: String, default: null },
            issuerRnc: { type: String, default: null },
            certificateThumbprint: { type: String, default: null },
            evidenceReference: { type: String, default: null },
            evidenceFileSha256: { type: String, default: null },
            // Solo backend: ubicación para conservar archivos anteriores.
            evidenceBucket: { type: String, default: null },
            evidencePath: { type: String, default: null },
        }],

        security: {
            configCompleted: {
                type: Boolean,
                default: false,
            },

            certificateUploaded: {
                type: Boolean,
                default: false,
            },

            passwordConfigured: {
                type: Boolean,
                default: false,
            },
        },

        lastValidationResult: {
            ok: {
                type: Boolean,
                default: false,
            },

            errors: {
                type: [String],
                default: [],
            },

            checkedAt: {
                type: Date,
                default: null,
            },
        },
    },
    {
        timestamps: true,
    }
);

module.exports = mongoose.model(
    "TenantEcfProfile",
    tenantEcfProfileSchema
);