const mongoose = require("mongoose");

const electronicTaxDocumentSchema = new mongoose.Schema(
    {
        tenantId: { type: String, required: true, index: true },
        clientId: { type: String, required: true, default: "default", index: true },

        orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null, index: true },
        invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", default: null, index: true },

        sourceDocumentType: {
            type: String,
            enum: ["ORDER", "INVOICE"],
            default: "ORDER",
        },

        ecf: {
            documentType: {
                type: String,
                enum: ["31", "32", "33", "34"],
                required: true,
            },
            sequenceNumber: { type: Number, default: null },
            eNCF: { type: String, default: null },
            status: {
                type: String,
                enum: [
                    "draft",
                    "xml_generated",
                    "signed",
                    "submitted",
                    "track_received",
                    "accepted",
                    "accepted_with_observation",
                    "rejected",
                    "cancelled",
                ],
                default: "draft",
            },
            trackId: { type: String, default: null },
            securityCode: { type: String, default: null },
            qrUrl: { type: String, default: null },
            fechaHoraFirma: { type: String, default: null },
        },

        issuer: {
            rnc: { type: String, default: null },
            legalName: { type: String, default: null },
            commercialName: { type: String, default: null },
        },

        customer: {
            name: { type: String, default: null },
            document: { type: String, default: null },
            documentType: {
                type: String,
                enum: ["RNC", "CEDULA", "NONE", null],
                default: null,
            },
        },

        totals: {
            subtotal: { type: Number, default: 0 },
            tax: { type: Number, default: 0 },
            tip: { type: Number, default: 0 },
            discount: { type: Number, default: 0 },
            total: { type: Number, default: 0 },
        },

        xml: {
            raw: { type: String, default: null },
            signed: { type: String, default: null },
            hash: { type: String, default: null },
        },

        dgiiResponse: {
            raw: { type: mongoose.Schema.Types.Mixed, default: null },
            code: { type: String, default: null },
            message: { type: String, default: null },
            receivedAt: { type: Date, default: null },
        },

        timestampsFlow: {
            generatedAt: { type: Date, default: null },
            signedAt: { type: Date, default: null },
            submittedAt: { type: Date, default: null },
            acceptedAt: { type: Date, default: null },
            rejectedAt: { type: Date, default: null },
        },

        errorLog: {
            type: [String],
            default: [],
        },
    },
    { timestamps: true }
);

electronicTaxDocumentSchema.index({ tenantId: 1, clientId: 1, "ecf.eNCF": 1 });
electronicTaxDocumentSchema.index({ tenantId: 1, clientId: 1, "ecf.trackId": 1 });
electronicTaxDocumentSchema.index({ tenantId: 1, clientId: 1, createdAt: -1 });

electronicTaxDocumentSchema.index({
    tenantId: 1,
    clientId: 1,
    orderId: 1,
    sourceDocumentType: 1,
    "ecf.documentType": 1,
    createdAt: -1,
});
module.exports = mongoose.model("ElectronicTaxDocument", electronicTaxDocumentSchema);