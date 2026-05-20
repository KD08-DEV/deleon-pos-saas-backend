const Order = require("../models/orderModel");
const TenantEcfProfile = require("../models/tenantEcfProfileModel");
const ElectronicTaxDocument = require("../models/electronicTaxDocumentModel");

const { validateEcfProfile } = require("../services/ecf/helpers/validateEcfProfile");
const { validateP12CertificateBuffer } = require("../services/ecf/signer/realSigner");
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
        canIssueEcfDocumentTypeFromOrder,
} = require("../services/ecf/helpers/ecfDocumentTypes");

function onlyDigits(value = "") {
    return String(value || "").replace(/\D/g, "");
}
const ACTIVE_ECF_STATUSES = [
    "draft",
    "xml_generated",
    "signed",
    "submitted",
    "track_received",
    "accepted",
    "accepted_with_observation",
];
const ACCEPTED_ECF_STATUSES = ["accepted", "accepted_with_observation"];

function buildClientScopeOr(clientId = "default") {
    return [
        { clientId },
        { clientId: { $exists: false } },
        { clientId: "default" },
    ];
}

async function getAcceptedAdjustmentBalanceSummary({
                                                       tenantId,
                                                       clientId = "default",
                                                       originalOrder,
                                                       originalDoc,
                                                   }) {
    const referenceOr = [
        { orderId: originalOrder._id },
        { "reference.modifiedOrderId": originalOrder._id },
    ];

    if (originalDoc?._id) {
        referenceOr.push({ "reference.modifiedDocumentId": originalDoc._id });
    }

    if (originalDoc?.ecf?.eNCF) {
        referenceOr.push({ "reference.modifiedENCF": originalDoc.ecf.eNCF });
    }

    const adjustmentNotes = await ElectronicTaxDocument.find({
        tenantId,
        sourceDocumentType: "ECF_ADJUSTMENT",
        "ecf.documentType": { $in: ["33", "34"] },
        "ecf.status": { $in: ACCEPTED_ECF_STATUSES },
        $and: [
            { $or: buildClientScopeOr(clientId) },
            { $or: referenceOr },
        ],
    })
        .select("_id ecf.eNCF ecf.documentType ecf.status totals.total reference createdAt")
        .lean();

    const debitNotes = adjustmentNotes.filter((doc) => {
        return String(doc?.ecf?.documentType || "").trim() === "33";
    });

    const creditNotes = adjustmentNotes.filter((doc) => {
        return String(doc?.ecf?.documentType || "").trim() === "34";
    });

    const totalDebitIssued = round2(
        debitNotes.reduce((sum, doc) => {
            return sum + Number(doc?.totals?.total || 0);
        }, 0)
    );

    const totalCreditIssued = round2(
        creditNotes.reduce((sum, doc) => {
            return sum + Number(doc?.totals?.total || 0);
        }, 0)
    );

    return {
        totalDebitIssued,
        totalCreditIssued,
        debitNotes,
        creditNotes,
    };
}
async function issueOrderAsEcfCore({
                                       tenantId,
                                       clientId = "default",
                                       orderId,
                                       documentType = "32",
                                   })
{
    const normalizedDocumentType = normalizeEcfDocumentType(documentType);
    if (!canIssueEcfDocumentTypeFromOrder(normalizedDocumentType)) {
        const err = new Error(`ECF_DOCUMENT_TYPE_NOT_SUPPORTED_FOR_ORDER_E${normalizedDocumentType}`);
        err.statusCode = 400;
        throw err;
    }
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

    const signedAt = new Date();
    const fechaEmision = formatDateDO(order?.invoicedAt || order?.paidAt || signedAt);
    const fechaHoraFirma = formatDateTimeDO(signedAt);

    const xml = generateEcfXml({
        profile,
        order,
        documentType: normalizedDocumentType,
        sequenceNumber,
        eNCF,
        fechaHoraFirmaOverride: fechaHoraFirma,
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

    const isInternalSandbox =
        String(profile?.environment || "").trim() === "internal_sandbox";

    const useRealSigner =
        !isInternalSandbox &&
        profile?.certificate?.isActive === true &&
        profile?.security?.certificateUploaded === true &&
        profile?.security?.passwordConfigured === true &&
        profile?.certificate?.bucket &&
        profile?.certificate?.path &&
        profile?.certificate?.passwordEncrypted;

    if (isInternalSandbox) {
        signResult = await mockSignXml(xml);
    } else {
        if (!useRealSigner) {
            const err = new Error("REAL_DGII_CERTIFICATE_REQUIRED");
            err.statusCode = 400;
            err.details = {
                environment: profile?.environment,
                certificateIsActive: profile?.certificate?.isActive === true,
                certificateUploaded: profile?.security?.certificateUploaded === true,
                passwordConfigured: profile?.security?.passwordConfigured === true,
                hasBucket: Boolean(profile?.certificate?.bucket),
                hasPath: Boolean(profile?.certificate?.path),
                hasEncryptedPassword: Boolean(profile?.certificate?.passwordEncrypted),
            };
            throw err;
        }

        signResult = await realSignXml({
            xml,
            profile,
        });
    }

    const securityCode = buildEcfSecurityCode(signResult.hash);
    doc.xml.signed = signResult.signedXml;
    doc.xml.hash = signResult.hash;
    doc.ecf.status = "signed";
    doc.ecf.securityCode = securityCode;
    doc.ecf.fechaHoraFirma = fechaHoraFirma;
    const rncComprador = onlyDigits(
        order?.customerDetails?.rncCedula ||
        order?.customerDetails?.rnc ||
        ""
    );

    doc.ecf.qrUrl = buildEcfQrUrl({
        environment: profile?.environment,
        documentType: normalizedDocumentType,
        rncEmisor: profile?.issuer?.rnc,
        rncComprador,
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
    const trackId = String(submitResult?.trackId || "");

    if (!isInternalSandbox && trackId.toUpperCase().startsWith("SANDBOX-")) {
        doc.ecf.status = "rejected";
        doc.ecf.trackId = trackId;
        doc.dgiiResponse.raw = submitResult?.raw || submitResult || null;
        doc.dgiiResponse.message = "SANDBOX_TRACK_ID_RECEIVED_IN_REAL_DGII_ENVIRONMENT";
        doc.timestampsFlow.rejectedAt = new Date();

        await doc.save();

        const err = new Error("SANDBOX_TRACK_ID_RECEIVED_IN_REAL_DGII_ENVIRONMENT");
        err.statusCode = 500;
        err.details = {
            environment: profile?.environment,
            trackId,
        };
        throw err;
    }

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

function round2(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

function buildAdjustmentOrderFromBody({
                                          originalOrder,
                                          documentType,
                                          body = {},
                                          signedAt = new Date(),
                                      }) {
    const reason = String(body.reason || "").trim();
    const adjustmentMode = String(body.adjustmentMode || "partial").trim().toLowerCase();

    const originalItems = Array.isArray(originalOrder?.items) ? originalOrder.items : [];
    const incomingItems = Array.isArray(body.items) ? body.items : [];

    const originalSubtotal = Number(originalOrder?.bills?.subtotal || originalOrder?.bills?.total || 0);
    const originalTax = Number(originalOrder?.bills?.tax || 0);
    const originalTotal = Number(originalOrder?.bills?.totalWithTax || 0);

    const originalTaxRate =
        originalSubtotal > 0 && originalTax > 0
            ? originalTax / originalSubtotal
            : Number(process.env.TAX_RATE ?? 0.18);

    let items = [];

    if (adjustmentMode === "total" && incomingItems.length === 0) {
        items = originalItems.map((item, index) => {
            const quantity = Number(item.quantity || 1);
            const unitPrice = Number(item.unitPrice || 0);
            const price = Number(item.price || quantity * unitPrice || 0);

            return {
                lineId: item.lineId || `adj-${index + 1}`,
                dishId: item.dishId || null,
                name: item.name || "Producto",
                presentation: item.presentation || "Regular",
                category: item.category || "",
                qtyType: item.qtyType || "unit",
                weightUnit: item.weightUnit || "lb",
                quantity,
                unitPrice,
                price: round2(price),
                note: item.note || "",
                addons: Array.isArray(item.addons) ? item.addons : [],
                modifiers: Array.isArray(item.modifiers) ? item.modifiers : [],
                productionArea: item.productionArea || "kitchen",
                printedQty: 0,
            };
        });

        return {
            ...originalOrder.toObject?.() || originalOrder,
            _id: originalOrder._id,
            fiscal: {
                ...(originalOrder.fiscal || {}),
                ecfDocumentType: documentType,
                requested: documentType === "33",
                ncfType: documentType === "33" ? "E33" : "E34",
                issuedAt: signedAt,
            },
            items,
            bills: {
                subtotal: round2(originalSubtotal),
                total: round2(originalSubtotal),
                discount: 0,
                taxEnabled: originalTax > 0,
                tax: round2(originalTax),
                tipEnabled: false,
                tip: 0,
                tipAmount: 0,
                deliveryFee: 0,
                totalWithTax: round2(originalTotal),
            },
            invoicedAt: signedAt,
            paidAt: signedAt,
            paymentMethod: originalOrder.paymentMethod || "Efectivo",
            orderNote: reason || originalOrder.orderNote || "",
        };
    }

    if (incomingItems.length > 0) {
        items = incomingItems.map((item, index) => {
            const quantity = Number(item.quantity || item.qty || 1);
            const unitPrice = Number(item.unitPrice ?? item.pricePerQuantity ?? item.price ?? 0);
            const price = round2(Number(item.price ?? quantity * unitPrice ?? 0));

            return {
                lineId: item.lineId || `adj-${Date.now()}-${index + 1}`,
                dishId: item.dishId || null,
                name: String(item.name || item.description || "Ajuste").trim(),
                presentation: item.presentation || "Regular",
                category: item.category || "",
                qtyType: item.qtyType || "unit",
                weightUnit: item.weightUnit || "lb",
                quantity,
                unitPrice: round2(unitPrice),
                price,
                note: item.note || "",
                addons: Array.isArray(item.addons) ? item.addons : [],
                modifiers: Array.isArray(item.modifiers) ? item.modifiers : [],
                productionArea: item.productionArea || "other",
                printedQty: 0,
            };
        });
    } else {
        const amount = round2(
            Number(
                body.amount ??
                body.subtotal ??
                body.total ??
                body.totalWithTax ??
                0
            )
        );

        if (amount <= 0) {
            const err = new Error("ADJUSTMENT_AMOUNT_OR_ITEMS_REQUIRED");
            err.statusCode = 400;
            throw err;
        }

        items = [
            {
                lineId: `adj-${Date.now()}-1`,
                dishId: null,
                name:
                    documentType === "33"
                        ? `Nota de débito - ${reason || "Ajuste"}`
                        : `Nota de crédito - ${reason || "Ajuste"}`,
                presentation: "Regular",
                category: "Ajuste e-CF",
                qtyType: "unit",
                weightUnit: "lb",
                quantity: 1,
                unitPrice: amount,
                price: amount,
                note: reason,
                addons: [],
                modifiers: [],
                productionArea: "other",
                printedQty: 0,
            },
        ];
    }

    const subtotal = round2(items.reduce((sum, item) => sum + Number(item.price || 0), 0));

    const taxEnabled =
        typeof body.taxEnabled === "boolean"
            ? body.taxEnabled
            : Number(body.tax ?? 0) > 0;

    const tax = round2(
        body.tax !== undefined && body.tax !== null
            ? Number(body.tax)
            : taxEnabled
                ? subtotal * originalTaxRate
                : 0
    );

    const discount = round2(Number(body.discount || 0));
    const totalWithTax = round2(
        body.totalWithTax !== undefined && body.totalWithTax !== null
            ? Number(body.totalWithTax)
            : Math.max(subtotal - discount, 0) + tax
    );

    return {
        ...originalOrder.toObject?.() || originalOrder,
        _id: originalOrder._id,
        fiscal: {
            ...(originalOrder.fiscal || {}),
            ecfDocumentType: documentType,
            requested: documentType === "33",
            ncfType: documentType === "33" ? "E33" : "E34",
            issuedAt: signedAt,
        },
        items,
        bills: {
            subtotal,
            total: subtotal,
            discount,
            taxEnabled,
            tax,
            tipEnabled: false,
            tip: 0,
            tipAmount: 0,
            deliveryFee: 0,
            totalWithTax,
        },
        invoicedAt: signedAt,
        paidAt: signedAt,
        paymentMethod: originalOrder.paymentMethod || "Efectivo",
        orderNote: reason || originalOrder.orderNote || "",
    };
}

async function issueEcfAdjustmentCore({
                                          tenantId,
                                          clientId = "default",
                                          orderId,
                                          documentType,
                                          body = {},
                                      }) {
    const normalizedDocumentType = normalizeEcfDocumentType(documentType);

    if (!["33", "34"].includes(normalizedDocumentType)) {
        const err = new Error("ONLY_E33_E34_ALLOWED_FOR_ADJUSTMENTS");
        err.statusCode = 400;
        throw err;
    }

    const documentTypeKey = getEcfDocumentTypeKey(normalizedDocumentType);

    const originalOrder = await Order.findOne({
        _id: orderId,
        tenantId,
        $or: [
            { clientId },
            { clientId: { $exists: false } },
            { clientId: "default" },
        ],
    });

    if (!originalOrder) {
        const err = new Error("ORDER_NOT_FOUND");
        err.statusCode = 404;
        throw err;
    }

    const originalDoc = await ElectronicTaxDocument.findOne({
        tenantId,
        orderId: originalOrder._id,
        sourceDocumentType: "ORDER",
        "ecf.status": { $in: ["accepted", "accepted_with_observation"] },
        $or: [
            { clientId },
            { clientId: { $exists: false } },
            { clientId: "default" },
        ],
    }).sort({ createdAt: -1 });

    if (!originalDoc) {
        const err = new Error("ORIGINAL_ACCEPTED_ECF_NOT_FOUND");
        err.statusCode = 400;
        throw err;
    }

    if (!["31", "32"].includes(String(originalDoc?.ecf?.documentType || ""))) {
        const err = new Error("ONLY_E31_E32_CAN_BE_ADJUSTED_FOR_NOW");
        err.statusCode = 400;
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

    if (profile?.documentTypes?.[documentTypeKey]?.enabled !== true) {
        const err = new Error(`ECF_DOCUMENT_TYPE_NOT_ENABLED_${documentTypeKey.toUpperCase()}`);
        err.statusCode = 400;
        throw err;
    }


    const signedAt = new Date();
    const fechaEmision = formatDateDO(signedAt);
    const fechaHoraFirma = formatDateTimeDO(signedAt);

    const reason = String(body.reason || "").trim();

    if (!reason) {
        const err = new Error("ADJUSTMENT_REASON_REQUIRED");
        err.statusCode = 400;
        throw err;
    }

    const reference = {
        modifiedDocumentId: originalDoc._id,
        modifiedOrderId: originalOrder._id,
        modifiedENCF: originalDoc.ecf?.eNCF,
        modifiedDate: formatDateDO(
            originalOrder?.invoicedAt ||
            originalOrder?.paidAt ||
            originalDoc?.timestampsFlow?.generatedAt ||
            originalDoc?.createdAt ||
            signedAt
        ),
        modificationCode: String(body.modificationCode || "1").trim(),
        reason,
    };

    const adjustmentOrder = buildAdjustmentOrderFromBody({
        originalOrder,
        documentType: normalizedDocumentType,
        body,
        signedAt,
    });

// Validación fuerte para Nota de Crédito E34.
// Nueva regla:
// Balance disponible = Total original + E33 aceptadas - E34 aceptadas.
    if (normalizedDocumentType === "34") {
        const originalTotal = round2(
            Number(
                originalDoc?.totals?.total ??
                originalOrder?.bills?.totalWithTax ??
                0
            )
        );

        const requestedCreditTotal = round2(
            Number(
                adjustmentOrder?.bills?.totalWithTax ??
                adjustmentOrder?.bills?.total ??
                0
            )
        );

        const balanceSummary = await getAcceptedAdjustmentBalanceSummary({
            tenantId,
            clientId,
            originalOrder,
            originalDoc,
        });

        const availableCredit = round2(
            Math.max(
                originalTotal +
                balanceSummary.totalDebitIssued -
                balanceSummary.totalCreditIssued,
                0
            )
        );

        if (requestedCreditTotal > availableCredit + 0.01) {
            const err = new Error("E34_CREDIT_EXCEEDS_AVAILABLE_BALANCE");
            err.statusCode = 400;
            err.details = {
                originalENCF: originalDoc?.ecf?.eNCF || null,
                originalTotal,
                previousAcceptedDebitTotal: balanceSummary.totalDebitIssued,
                previousAcceptedCreditTotal: balanceSummary.totalCreditIssued,
                availableCredit,
                requestedCreditTotal,
                acceptedDebitNotes: balanceSummary.debitNotes.map((doc) => ({
                    documentId: String(doc._id),
                    eNCF: doc?.ecf?.eNCF || null,
                    total: doc?.totals?.total || 0,
                    status: doc?.ecf?.status || null,
                    createdAt: doc?.createdAt || null,
                })),
                acceptedCreditNotes: balanceSummary.creditNotes.map((doc) => ({
                    documentId: String(doc._id),
                    eNCF: doc?.ecf?.eNCF || null,
                    total: doc?.totals?.total || 0,
                    status: doc?.ecf?.status || null,
                    createdAt: doc?.createdAt || null,
                })),
            };
            throw err;
        }
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
        order: adjustmentOrder,
        documentType: normalizedDocumentType,
        sequenceNumber,
        eNCF,
        reference,
        fechaHoraFirmaOverride: fechaHoraFirma,
    });

    const doc = await ElectronicTaxDocument.create({
        tenantId,
        clientId,
        orderId: originalOrder._id,
        sourceDocumentType: "ECF_ADJUSTMENT",
        ecf: {
            documentType: normalizedDocumentType,
            sequenceNumber,
            eNCF,
            status: "xml_generated",
        },
        reference: {
            modifiedDocumentId: reference.modifiedDocumentId,
            modifiedOrderId: reference.modifiedOrderId,
            modifiedENCF: reference.modifiedENCF,
            modifiedDate: reference.modifiedDate,
            modificationCode: reference.modificationCode,
            reason: reference.reason,
        },
        issuer: {
            rnc: profile.issuer.rnc,
            legalName: profile.issuer.legalName,
            commercialName: profile.issuer.commercialName,
        },
        customer: {
            name: adjustmentOrder.customerDetails?.name || "Consumidor Final",
            document:
                adjustmentOrder.customerDetails?.rncCedula ||
                adjustmentOrder.customerDetails?.rnc ||
                null,
            documentType:
                adjustmentOrder.customerDetails?.rncCedula
                    ? "CEDULA"
                    : adjustmentOrder.customerDetails?.rnc
                        ? "RNC"
                        : "NONE",
        },
        totals: {
            subtotal: adjustmentOrder.bills?.subtotal || 0,
            tax: adjustmentOrder.bills?.tax || 0,
            tip: adjustmentOrder.bills?.tipAmount || adjustmentOrder.bills?.tip || 0,
            discount: adjustmentOrder.bills?.discount || 0,
            total: adjustmentOrder.bills?.totalWithTax || 0,
        },
        xml: {
            raw: xml,
        },
        timestampsFlow: {
            generatedAt: new Date(),
        },
    });

    let signResult;

    const isInternalSandbox =
        String(profile?.environment || "").trim() === "internal_sandbox";

    const useRealSigner =
        !isInternalSandbox &&
        profile?.certificate?.isActive === true &&
        profile?.security?.certificateUploaded === true &&
        profile?.security?.passwordConfigured === true &&
        profile?.certificate?.bucket &&
        profile?.certificate?.path &&
        profile?.certificate?.passwordEncrypted;

    if (isInternalSandbox) {
        signResult = await mockSignXml(xml);
    } else {
        if (!useRealSigner) {
            const err = new Error("REAL_DGII_CERTIFICATE_REQUIRED");
            err.statusCode = 400;
            err.details = {
                environment: profile?.environment,
                certificateIsActive: profile?.certificate?.isActive === true,
                certificateUploaded: profile?.security?.certificateUploaded === true,
                passwordConfigured: profile?.security?.passwordConfigured === true,
                hasBucket: Boolean(profile?.certificate?.bucket),
                hasPath: Boolean(profile?.certificate?.path),
                hasEncryptedPassword: Boolean(profile?.certificate?.passwordEncrypted),
            };
            throw err;
        }

        signResult = await realSignXml({
            xml,
            profile,
        });
    }

    const securityCode = buildEcfSecurityCode(signResult.hash);

    doc.xml.signed = signResult.signedXml;
    doc.xml.hash = signResult.hash;
    doc.ecf.status = "signed";
    doc.ecf.securityCode = securityCode;
    doc.ecf.fechaHoraFirma = fechaHoraFirma;

    const rncComprador = onlyDigits(
        adjustmentOrder?.customerDetails?.rncCedula ||
        adjustmentOrder?.customerDetails?.rnc ||
        ""
    );

    doc.ecf.qrUrl = buildEcfQrUrl({
        environment: profile?.environment,
        documentType: normalizedDocumentType,
        rncEmisor: profile?.issuer?.rnc,
        rncComprador,
        eNCF,
        total: adjustmentOrder?.bills?.totalWithTax || 0,
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
    const trackId = String(submitResult?.trackId || "");

    if (!isInternalSandbox && trackId.toUpperCase().startsWith("SANDBOX-")) {
        doc.ecf.status = "rejected";
        doc.ecf.trackId = trackId;
        doc.dgiiResponse.raw = submitResult?.raw || submitResult || null;
        doc.dgiiResponse.message = "SANDBOX_TRACK_ID_RECEIVED_IN_REAL_DGII_ENVIRONMENT";
        doc.timestampsFlow.rejectedAt = new Date();

        await doc.save();

        const err = new Error("SANDBOX_TRACK_ID_RECEIVED_IN_REAL_DGII_ENVIRONMENT");
        err.statusCode = 500;
        err.details = {
            environment: profile?.environment,
            trackId,
        };
        throw err;
    }

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
            reference: doc.reference,
            totals: doc.totals,
        },
    };
}

exports.issueEcfAdjustment = async (req, res) => {
    try {
        const tenantId = req.tenantId || req.user?.tenantId;
        const clientId = req.clientId || "default";
        const { id } = req.params;

        const {
            documentType,
            type,
        } = req.body || {};

        const finalDocumentType = documentType || type;

        const result = await issueEcfAdjustmentCore({
            tenantId,
            clientId,
            orderId: id,
            documentType: finalDocumentType,
            body: req.body || {},
        });

        return res.json({
            success: true,
            message: "ECF_ADJUSTMENT_ISSUED",
            data: result.data,
        });
    } catch (error) {
        console.error("issueEcfAdjustment error:", error);

        return res.status(error.statusCode || 500).json({
            success: false,
            message: error.message || "ERROR_ISSUING_ECF_ADJUSTMENT",
            errors: error.errors || undefined,
            details: error.details || undefined,
        });
    }
};

exports.listOrderEcfAdjustments = async (req, res) => {
    try {
        const tenantId = req.tenantId || req.user?.tenantId;
        const clientId = req.clientId || "default";
        const { id } = req.params;

        const docs = await ElectronicTaxDocument.find({
            tenantId,
            sourceDocumentType: "ECF_ADJUSTMENT",
            $or: [
                { orderId: id },
                { "reference.modifiedOrderId": id },
            ],
            $and: [
                {
                    $or: [
                        { clientId },
                        { clientId: { $exists: false } },
                        { clientId: "default" },
                    ],
                },
            ],
        })
            .sort({ createdAt: -1 })
            .lean();

        return res.json({
            success: true,
            data: docs.map((doc) => ({
                documentId: String(doc._id),
                documentType: doc.ecf?.documentType || null,
                eNCF: doc.ecf?.eNCF || null,
                status: doc.ecf?.status || null,
                trackId: doc.ecf?.trackId || null,
                securityCode: doc.ecf?.securityCode || null,
                qrUrl: doc.ecf?.qrUrl || null,
                fechaHoraFirma: doc.ecf?.fechaHoraFirma || null,
                reference: doc.reference || null,
                totals: doc.totals || null,
                createdAt: doc.createdAt || null,
            })),
        });
    } catch (error) {
        console.error("listOrderEcfAdjustments error:", error);

        return res.status(error.statusCode || 500).json({
            success: false,
            message: error.message || "ERROR_LISTING_ECF_ADJUSTMENTS",
        });
    }
};

exports.issueEcfAdjustmentCore = issueEcfAdjustmentCore;

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