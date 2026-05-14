const Order = require("../models/orderModel");
const TenantEcfProfile = require("../models/tenantEcfProfileModel");
const ElectronicTaxDocument = require("../models/electronicTaxDocumentModel");

const { validateEcfProfile } = require("../services/ecf/helpers/validateEcfProfile");
const { getNextSequence } = require("../services/ecf/helpers/ecfSequenceService");
const { buildENcf } = require("../services/ecf/helpers/buildENcf");
const {
    generateEcfXml,
    buildEcfSecurityCode,
    buildEcfQrUrl,
    formatDateDO,
    formatDateTimeDO,
} = require("../services/ecf/xmlBuilder");
const { mockSignXml } = require("../services/ecf/signer/mockSigner");
const { realSignXml } = require("../services/ecf/signer/realSigner");
const { getEcfGateway } = require("../services/ecf/gateways/gatewayFactory");

const {
    normalizeEcfDocumentType,
    getEcfDocumentTypeKey,
} = require("../services/ecf/helpers/ecfDocumentTypes");

const ACTIVE_ECF_STATUSES = [
    "draft",
    "xml_generated",
    "signed",
    "submitted",
    "track_received",
    "accepted",
    "accepted_with_observation",
];
async function issueOrderAsEcfCore({
                                       tenantId,
                                       clientId = "default",
                                       orderId,
                                       documentType = "32",
                                   })
{
    const normalizedDocumentType = normalizeEcfDocumentType(documentType);
    const documentTypeKey = getEcfDocumentTypeKey(normalizedDocumentType);
    const order = await Order.findOne({
        _id: orderId,
        tenantId,
        $or: [
            { clientId },
            { clientId: { $exists: false } },
            { clientId: "default" },
        ],
    });

    if (!order) {
        const err = new Error("ORDER_NOT_FOUND");
        err.statusCode = 404;
        throw err;
    }

    const profile = await TenantEcfProfile.findOne({ tenantId });

    const validation = validateEcfProfile(profile);
    if (!validation.ok) {
        const err = new Error("ECF_PROFILE_INVALID");
        err.statusCode = 400;
        err.errors = validation.errors;
        throw err;
    }

    const existingDoc = await ElectronicTaxDocument.findOne({
        tenantId,
        orderId: order._id,
        sourceDocumentType: "ORDER",
        "ecf.status": { $in: ACTIVE_ECF_STATUSES },
        $or: [
            { clientId },
            { clientId: { $exists: false } },
            { clientId: "default" },
        ],
    }).sort({ createdAt: -1 });

    if (existingDoc) {
        return {
            duplicated: true,
            document: existingDoc,
            data: {
                documentId: existingDoc._id,
                documentType: existingDoc.ecf?.documentType || null,
                eNCF: existingDoc.ecf?.eNCF || null,
                status: existingDoc.ecf?.status || null,
                trackId: existingDoc.ecf?.trackId || null,
                securityCode: existingDoc.ecf?.securityCode || null,
                qrUrl: existingDoc.ecf?.qrUrl || null,
                fechaHoraFirma: existingDoc.ecf?.fechaHoraFirma || null,
            },
        };
    }

    if (profile?.documentTypes?.[documentTypeKey]?.enabled !== true) {
        const err = new Error(`ECF_DOCUMENT_TYPE_NOT_ENABLED_${documentTypeKey.toUpperCase()}`);
        err.statusCode = 400;
        throw err;
    }

    const sequenceNumber = await getNextSequence({
        tenantId,
        documentType: normalizedDocumentType,
    });

    const eNCF = buildENcf({
        documentType: normalizedDocumentType,
        sequenceNumber,
    });

    const xml = generateEcfXml({
        profile,
        order,
        documentType: normalizedDocumentType,
        sequenceNumber,
        eNCF,
    });

    const doc = await ElectronicTaxDocument.create({
        tenantId,
        clientId,
        orderId: order._id,
        sourceDocumentType: "ORDER",
        ecf: {
            documentType: normalizedDocumentType,
            sequenceNumber,
            eNCF,
            status: "xml_generated",
        },
        issuer: {
            rnc: profile.issuer.rnc,
            legalName: profile.issuer.legalName,
            commercialName: profile.issuer.commercialName,
        },
        customer: {
            name: order.customerDetails?.name || "Consumidor Final",
            document:
                order.customerDetails?.rncCedula ||
                order.customerDetails?.rnc ||
                null,
            documentType:
                order.customerDetails?.rncCedula
                    ? "CEDULA"
                    : order.customerDetails?.rnc
                        ? "RNC"
                        : "NONE",
        },
        totals: {
            subtotal: order.bills?.subtotal || 0,
            tax: order.bills?.tax || 0,
            tip: order.bills?.tipAmount || order.bills?.tip || 0,
            discount: order.bills?.discount || 0,
            total: order.bills?.totalWithTax || 0,
        },
        xml: {
            raw: xml,
        },
        timestampsFlow: {
            generatedAt: new Date(),
        },
    });

    let signResult;

    const useRealSigner =
        profile?.certificate?.isActive === true &&
        profile?.security?.certificateUploaded === true &&
        profile?.security?.passwordConfigured === true &&
        profile?.certificate?.bucket &&
        profile?.certificate?.path &&
        profile?.certificate?.passwordEncrypted;

    if (useRealSigner) {
        signResult = await realSignXml({
            xml,
            profile,
        });
    } else {
        signResult = await mockSignXml(xml);
    }

    const signedAt = new Date();
    const securityCode = buildEcfSecurityCode(signResult.hash);
    const fechaEmision = formatDateDO(order?.invoicedAt || order?.paidAt || signedAt);
    const fechaHoraFirma = formatDateTimeDO(signedAt);

    doc.xml.signed = signResult.signedXml;
    doc.xml.hash = signResult.hash;
    doc.ecf.status = "signed";
    doc.ecf.securityCode = securityCode;
    doc.ecf.fechaHoraFirma = fechaHoraFirma;
    doc.ecf.qrUrl = buildEcfQrUrl({
        rnc: profile?.issuer?.rnc,
        eNCF,
        total: order?.bills?.totalWithTax || 0,
        fechaEmision,
        fechaFirma: fechaHoraFirma,
        securityCode,
    });
    doc.timestampsFlow.signedAt = signedAt;
    if (signResult?.certificateInfo && profile?.certificate) {
        const certInfo = signResult.certificateInfo;

        if (certInfo.validFrom) profile.certificate.validFrom = certInfo.validFrom;
        if (certInfo.validTo) profile.certificate.validTo = certInfo.validTo;
        if (certInfo.serialNumber) profile.certificate.serialNumber = certInfo.serialNumber;

        await profile.save();
    }

    const gateway = getEcfGateway(profile.environment);

    const submitResult = await gateway.submitDocument({
        signedXml: signResult.signedXml,
        profile,
        document: doc,
    });

    doc.ecf.status = "track_received";
    doc.ecf.trackId = submitResult.trackId;
    doc.dgiiResponse.raw = submitResult.raw;
    doc.timestampsFlow.submittedAt = new Date();

    const statusResult = await gateway.queryStatus({
        trackId: submitResult.trackId,
        profile,
    });

    doc.dgiiResponse.code = statusResult.code;
    doc.dgiiResponse.message = statusResult.message;
    doc.dgiiResponse.receivedAt = new Date();

    if (statusResult.status === "accepted") {
        doc.ecf.status = "accepted";
        doc.timestampsFlow.acceptedAt = new Date();
    } else if (statusResult.status === "accepted_with_observation") {
        doc.ecf.status = "accepted_with_observation";
        doc.timestampsFlow.acceptedAt = new Date();
    } else if (
        statusResult.status === "track_received" ||
        statusResult.status === "submitted" ||
        statusResult.status === "pending"
    ) {
        doc.ecf.status = "track_received";
    } else {
        doc.ecf.status = "rejected";
        doc.timestampsFlow.rejectedAt = new Date();
    }

    await doc.save();

    return {
        duplicated: false,
        document: doc,
        data: {
            documentId: doc._id,
            documentType: doc.ecf.documentType,
            eNCF: doc.ecf.eNCF,
            status: doc.ecf.status,
            trackId: doc.ecf.trackId,
            securityCode: doc.ecf.securityCode,
            qrUrl: doc.ecf.qrUrl,
            fechaHoraFirma: doc.ecf.fechaHoraFirma,
        },
    };
}

exports.issueOrderAsEcf = async (req, res) => {
    try {
        const tenantId = req.tenantId || req.user?.tenantId;
        const clientId = req.clientId || "default";
        const { id } = req.params;
        const { documentType = "32" } = req.body || {};

        const result = await issueOrderAsEcfCore({
            tenantId,
            clientId,
            orderId: id,
            documentType,
        });

        return res.json({
            success: true,
            message: result.duplicated ? "ECF_ALREADY_EXISTS" : "ECF_ISSUED",
            duplicated: result.duplicated,
            data: result.data,
        });
    } catch (error) {
        console.error("issueOrderAsEcf error:", error);

        return res.status(error.statusCode || 500).json({
            success: false,
            message: error.message || "ERROR_ISSUING_ECF",
            errors: error.errors || undefined,
        });
    }
};
exports.issueOrderAsEcfCore = issueOrderAsEcfCore;