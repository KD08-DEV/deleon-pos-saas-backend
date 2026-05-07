const Order = require("../models/orderModel");
const TenantEcfProfile = require("../models/tenantEcfProfileModel");
const ElectronicTaxDocument = require("../models/electronicTaxDocumentModel");

const { validateEcfProfile } = require("../services/ecf/helpers/validateEcfProfile");
const { getNextSequence } = require("../services/ecf/helpers/ecfSequenceService");
const { buildENcf } = require("../services/ecf/helpers/buildENcf");
const { generateEcfXml } = require("../services/ecf/xmlBuilder");
const { mockSignXml } = require("../services/ecf/signer/mockSigner");
const { getEcfGateway } = require("../services/ecf/gateways/gatewayFactory");

const ACTIVE_ECF_STATUSES = [
    "draft",
    "xml_generated",
    "signed",
    "submitted",
    "track_received",
    "accepted",
    "accepted_with_observation",
];

exports.issueOrderAsEcf = async (req, res) => {
    try {
        const tenantId = req.tenantId || req.user?.tenantId;
        const clientId = req.clientId || "default";
        const { id } = req.params;
        const { documentType = "32" } = req.body || {};

        const order = await Order.findOne({
            _id: id,
            tenantId,
            $or: [{ clientId }, { clientId: { $exists: false } }, { clientId: "default" }],
        });

        if (!order) {
            return res.status(404).json({
                success: false,
                message: "ORDER_NOT_FOUND",
            });
        }

        const profile = await TenantEcfProfile.findOne({ tenantId });

        const validation = validateEcfProfile(profile);
        if (!validation.ok) {
            return res.status(400).json({
                success: false,
                message: "ECF_PROFILE_INVALID",
                errors: validation.errors,
            });
        }

        // =========================================
        // ANTI-DUPLICADO:
        // si ya existe un e-CF activo para esta orden
        // y este mismo tipo de documento, no reemitimos
        // =========================================
        const existingDoc = await ElectronicTaxDocument.findOne({
            tenantId,
            clientId,
            orderId: order._id,
            sourceDocumentType: "ORDER",
            "ecf.documentType": documentType,
            "ecf.status": { $in: ACTIVE_ECF_STATUSES },
        }).sort({ createdAt: -1 });

        if (existingDoc) {
            return res.status(200).json({
                success: true,
                message: "ECF_ALREADY_EXISTS",
                duplicated: true,
                data: {
                    documentId: existingDoc._id,
                    eNCF: existingDoc.ecf?.eNCF || null,
                    status: existingDoc.ecf?.status || null,
                    trackId: existingDoc.ecf?.trackId || null,
                },
            });
        }

        const sequenceNumber = await getNextSequence({ tenantId, documentType });
        const eNCF = buildENcf({ documentType, sequenceNumber });

        const xml = generateEcfXml({
            profile,
            order,
            documentType,
            sequenceNumber,
            eNCF,
        });

        const doc = await ElectronicTaxDocument.create({
            tenantId,
            clientId,
            orderId: order._id,
            sourceDocumentType: "ORDER",
            ecf: {
                documentType,
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

        const signResult = await mockSignXml(xml);

        doc.xml.signed = signResult.signedXml;
        doc.xml.hash = signResult.hash;
        doc.ecf.status = "signed";
        doc.timestampsFlow.signedAt = new Date();

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
        } else {
            doc.ecf.status = "rejected";
            doc.timestampsFlow.rejectedAt = new Date();
        }

        await doc.save();

        return res.json({
            success: true,
            message: "ECF_ISSUED",
            duplicated: false,
            data: {
                documentId: doc._id,
                eNCF: doc.ecf.eNCF,
                status: doc.ecf.status,
                trackId: doc.ecf.trackId,
            },
        });
    } catch (error) {
        console.error("issueOrderAsEcf error:", error);
        return res.status(500).json({
            success: false,
            message: "ERROR_ISSUING_ECF",
            error: error.message,
        });
    }
};