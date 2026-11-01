const Order = require("../models/orderModel");
const TenantEcfProfile = require("../models/tenantEcfProfileModel");
const ElectronicTaxDocument = require("../models/electronicTaxDocumentModel");

const { validateEcfProfile } = require("../services/ecf/helpers/validateEcfProfile");
const { validateP12CertificateBuffer } = require("../services/ecf/signer/realSigner");
const { getNextSequence } = require("../services/ecf/helpers/ecfSequenceService");
const { buildENcf } = require("../services/ecf/helpers/buildENcf");
const {
    generateEcfXml,
    buildEcfQrUrl,
    formatDateDO,
    formatDateTimeDO,
    getFiscalSnapshot,
} = require("../services/ecf/xmlBuilder");
const { buildPartialAdjustmentTax, validateAdjustmentMode } = require("../services/ecf/ecfAdjustmentFiscal");
const { buildFullAmountAdjustment, buildRemainingBalanceCancellation, creditAvailability } = require("../services/ecf/ecfAdjustmentTotals");
const { mockSignXml } = require("../services/ecf/signer/mockSigner");
const { signEcfXml: realSignXml, resolveMode } = require("../services/ecf/signer/signerRouter");
const { getEcfGateway } = require("../services/ecf/gateways/gatewayFactory");
const { checkEcfXsd } = require("../services/ecf/ecfXsdValidator");
const EcfEmissionAttempt = require("../models/ecfEmissionAttemptModel");
const issueAttempt = require("../services/ecf/ecfIssueAttempt");
const { ensureEcfDocumentIndex } = require("../services/ecf/ecfDocumentIndex");

const {
    normalizeEcfDocumentType,
        getEcfDocumentTypeKey,
        canIssueEcfDocumentTypeFromOrder,
} = require("../services/ecf/helpers/ecfDocumentTypes");


// Validación previa con e-NCF provisional: NO reserva una secuencia.
// El XSD de preflight permite ausencia de firma; el firmado se valida
// posteriormente contra el esquema completo. En modo report no bloquea.
async function checkXsdBeforeSequence({ profile, order, documentType, reference = null }) {
    const previewENcf = buildENcf({ documentType, sequenceNumber: 1 });
    const previewXml = generateEcfXml({
        profile, order, documentType, sequenceNumber: 1,
        eNCF: previewENcf, reference,
    });
    return checkEcfXsd({ xml: previewXml, format: documentType, stage: "preflight" });
}

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
    "rejected",
];
const ACCEPTED_ECF_STATUSES = ["accepted", "accepted_with_observation"];

function buildClientScopeOr(clientId = "default") {
    return clientId === "default"
        ? [{ clientId: "default" }, { clientId: { $exists: false } }]
        : [{ clientId }];
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
        .select("_id ecf.eNCF ecf.documentType ecf.status totals reference createdAt")
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
    // Defense in depth: this core function is also called from addOrder,
    // which does not pass through the /issue-ecf route middleware.
    const Tenant = require("../models/tenantModel");
    const { getPlanFeatures } = require("../middlewares/requirePlan");
    const tenantForFiscal = await Tenant.findOne({ tenantId }).select("plan localization.countryCode fiscal.enabled features.fiscal.enabled status").lean();
    if (!tenantForFiscal || tenantForFiscal.status !== "active" ||
        String(tenantForFiscal.localization?.countryCode || "DO").toUpperCase() !== "DO" ||
        getPlanFeatures(tenantForFiscal.plan).fiscal !== true ||
        tenantForFiscal.fiscal?.enabled !== true ||
        tenantForFiscal.features?.fiscal?.enabled === false) {
        const error = new Error("DOMINICAN_FISCAL_NOT_ALLOWED");
        error.statusCode = 403;
        throw error;
    }
    // Defense in depth: core can run from automatic orders without route middleware.
    const {assertSecondarySandboxIssue} = require("../services/ecf/ecfBranchAccess");
    await assertSecondarySandboxIssue({tenantId,clientId});
    const normalizedDocumentType = normalizeEcfDocumentType(documentType);
    if (!canIssueEcfDocumentTypeFromOrder(normalizedDocumentType)) {
        const err = new Error(`ECF_DOCUMENT_TYPE_NOT_SUPPORTED_FOR_ORDER_E${normalizedDocumentType}`);
        err.statusCode = 400;
        throw err;
    }
    const documentTypeKey = getEcfDocumentTypeKey(normalizedDocumentType);
    const order = await Order.findOne({
        _id: orderId, tenantId,
        ...(clientId === "default"
            ? { $or: [{ clientId: "default" }, { clientId: { $exists: false } }] }
            : { clientId }),
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
        $or: buildClientScopeOr(clientId),
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

    // Si falla el snapshot fiscal, NO consumir secuencia.
    const fiscalSnapshot = getFiscalSnapshot(order);
    await checkXsdBeforeSequence({ profile, order, documentType: normalizedDocumentType });

    // Nunca consumir secuencia si el índice único compartido no está listo.
    await ensureEcfDocumentIndex(ElectronicTaxDocument);
    const attempt = await issueAttempt.claimIssue(EcfEmissionAttempt, {
        tenantId, clientId, orderId: order._id, kind: "ORDER",
        documentType: normalizedDocumentType, environment: profile.environment,
    });
    try {
    // 'reserving' se persiste primero: si Mongo pierde respuesta del contador,
    // el intento queda bloqueado para revisión, aunque aún no conozcamos el número.
    await issueAttempt.advance(EcfEmissionAttempt, attempt, { stage: "reserving" });
    const sequenceNumber = await getNextSequence({
        tenantId,
        documentType: normalizedDocumentType,
    });

    const eNCF = buildENcf({
        documentType: normalizedDocumentType,
        sequenceNumber,
    });
    await issueAttempt.advance(EcfEmissionAttempt, attempt, {
        stage: "reserved", sequenceNumber, eNCF,
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
            environment: profile.environment,
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
            total: fiscalSnapshot.total,
            fiscalSummaryVersion: 1,
            taxable18: fiscalSnapshot.taxable18,
            taxable16: fiscalSnapshot.taxable16,
            exempt: fiscalSnapshot.exempt,
            itbis18: fiscalSnapshot.itbis18,
            itbis16: fiscalSnapshot.itbis16,
            deliveryFee: fiscalSnapshot.deliveryFee,
        },
        xml: {
            raw: xml,
        },
        timestampsFlow: {
            generatedAt: new Date(),
        },
    });

    await issueAttempt.advance(EcfEmissionAttempt, attempt, {
        stage: "xml_generated", documentId: doc._id,
    });
    let signResult;

    const isInternalSandbox =
        String(profile?.environment || "").trim() === "internal_sandbox";

    const usesExternalSigning = !isInternalSandbox && resolveMode() === "external_provider";
    const useRealSigner =
        !isInternalSandbox &&
        (usesExternalSigning || (
        profile?.certificate?.isActive === true &&
        profile?.security?.certificateUploaded === true &&
        profile?.security?.passwordConfigured === true &&
        profile?.certificate?.bucket &&
        profile?.certificate?.path &&
        profile?.certificate?.passwordEncrypted));

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

    const securityCode = isInternalSandbox
        ? String(signResult?.hash || "")
            .slice(0, 6)
            .toUpperCase()
        : String(signResult?.securityCode || "").trim();

    if (!securityCode) {
        const err = new Error("ECF_SECURITY_CODE_NOT_GENERATED");
        err.statusCode = 500;
        throw err;
    }
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

    // El mockSigner del sandbox no produce XMLDSig: validar contra XSD preflight.
    // En certificacion y produccion exigir SIEMPRE el XSD signed; no desactivar enforce.
    if (isInternalSandbox) {
        await checkEcfXsd({
            xml: signResult.signedXml, format: normalizedDocumentType, stage: "preflight",
        });
    } else {
        await checkEcfXsd({
            xml: signResult.signedXml, format: normalizedDocumentType, stage: "signed",
        });
    }

    // Durable before network: a crash cannot erase the signed document.
    await doc.save();
    await issueAttempt.advance(EcfEmissionAttempt, attempt, { stage: "dispatching" });
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

    const isRfceFlow =
        submitResult?.raw?.usedConsumerSummary === true;

    doc.ecf.status = isRfceFlow || !submitResult?.trackId
        ? "submitted"
        : "track_received";

    doc.ecf.trackId =
        submitResult?.trackId || null;

    doc.dgiiResponse.raw =
        submitResult?.raw || submitResult || null;

    doc.timestampsFlow.submittedAt = new Date();
    await doc.save();
    await issueAttempt.advance(EcfEmissionAttempt, attempt, {
        stage: "submitted", trackId: doc.ecf.trackId || null,
    });

// ==============================================
// RFCE E32 < RD$250,000
// ==============================================
//
// Recepción RFCE no utiliza el flujo normal
// basado en TrackId.
//
// El gateway ya devuelve el resultado de DGII
// correspondiente al RFCE.
//
// Para los demás e-CF utilizamos TrackId +
// queryStatus().
// ==============================================

    let statusResult;

    if (isRfceFlow) {
        statusResult = submitResult;
    } else {
        if (!submitResult?.trackId) {
            const err = new Error(
                "DGII_TRACK_ID_REQUIRED_AFTER_SUBMIT"
            );

            err.statusCode = 502;

            err.details = {
                documentType: normalizedDocumentType,
                eNCF,
                submitResult:
                    submitResult?.raw ||
                    submitResult ||
                    null,
            };

            throw err;
        }

        statusResult = await gateway.queryStatus({
            trackId: submitResult.trackId,
            profile,
        });
    }

    doc.dgiiResponse.code =
        statusResult?.code || null;

    doc.dgiiResponse.message =
        statusResult?.message || null;

    doc.dgiiResponse.receivedAt =
        new Date();

    if (statusResult?.status === "accepted") {
        doc.ecf.status = "accepted";
        doc.timestampsFlow.acceptedAt = new Date();

    } else if (
        statusResult?.status ===
        "accepted_with_observation"
    ) {
        doc.ecf.status =
            "accepted_with_observation";

        doc.timestampsFlow.acceptedAt =
            new Date();

    } else if (
        statusResult?.status === "track_received" ||
        statusResult?.status === "submitted" ||
        statusResult?.status === "pending"
    ) {
        doc.ecf.status = isRfceFlow
            ? "submitted"
            : "track_received";

    } else {
        doc.ecf.status = "rejected";
        doc.timestampsFlow.rejectedAt =
            new Date();
    }

    await doc.save();
    await issueAttempt.complete(EcfEmissionAttempt, attempt, doc.ecf.status, {
        documentId: doc._id, trackId: doc.ecf.trackId || null,
    });

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
    } catch (error) {
        await issueAttempt.failed(EcfEmissionAttempt, attempt, error);
        throw error;
    }
}

function round2(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

function buildAdjustmentOrderFromBody({
                                          originalOrder,
                                          documentType,
                                          body = {},
                                          signedAt = new Date(),
                                          acceptedCreditDocs = [],
                                      }) {
    const reason = String(body.reason || "").trim();
    const adjustmentMode = String(body.adjustmentMode || "partial").trim().toLowerCase();

    const originalItems = Array.isArray(originalOrder?.items) ? originalOrder.items : [];
    const incomingItems = Array.isArray(body.items) ? body.items : [];

    const originalSubtotal = Number(originalOrder?.bills?.subtotal || originalOrder?.bills?.total || 0);
    const originalTax = Number(originalOrder?.bills?.tax || 0);
    const originalTotal = Number(originalOrder?.bills?.totalWithTax || 0);

    let items = [];

    if (adjustmentMode === "total" && incomingItems.length === 0) {
        if (documentType === "34") {
            return buildRemainingBalanceCancellation({
                originalOrder, reason, signedAt,
                acceptedCreditDocs: acceptedCreditDocs || [],
            });
        }
        return buildFullAmountAdjustment({
            originalOrder, documentType, reason, signedAt,
        });
    }

    if (incomingItems.length > 0) {
        const err = new Error("ECF_ITEMIZED_ADJUSTMENT_REQUIRES_SOURCE_MAPPING");
        err.code = err.message;
        err.statusCode = 422;
        throw err;
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

        const mappedTax = buildPartialAdjustmentTax({
            originalOrder,
            baseAmount: amount,
            userTax: body.tax,
        });
        items = [
            {
                ...mappedTax,
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

    const tax = round2(items.reduce((sum, item) => sum + Number(item.taxAmount || 0), 0));
    const taxEnabled = tax > 0;

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
    const {assertSecondarySandboxIssue} = require("../services/ecf/ecfBranchAccess");
    await assertSecondarySandboxIssue({tenantId,clientId});
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
        $or: buildClientScopeOr(clientId),
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
        $or: buildClientScopeOr(clientId),
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

    // Una orden alterada luego de la emisión no puede usarse como fuente para
    // generar notas fiscales con base en importes distintos al e-CF aceptado.
    const verifiedOriginal = getFiscalSnapshot(originalOrder);
    if (!Number.isFinite(Number(originalDoc?.totals?.total)) ||
        Math.abs(verifiedOriginal.total - Number(originalDoc.totals.total)) > 0.01) {
        const err = new Error("ECF_ORIGINAL_STORED_TOTAL_MISMATCH");
        err.statusCode = 422;
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

    validateAdjustmentMode({
        documentType: normalizedDocumentType,
        adjustmentMode: String(body.adjustmentMode || "partial").trim().toLowerCase(),
        modificationCode: reference.modificationCode,
    });
    // Confirmación expresa de la anulación de un comprobante emitido.
    if (normalizedDocumentType === "34" &&
        String(body.adjustmentMode || "partial").trim().toLowerCase() === "total" &&
        body.confirmFullCancellation !== true) {
        const err = new Error("E34_TOTAL_CONFIRMATION_REQUIRED");
        err.statusCode = 422;
        throw err;
    }
    // Consultar los créditos aceptados ANTES de construir una anulación total:
    // el importe con código 1 es el saldo ORIGINAL pendiente, no el monto bruto
    // de la factura ni un saldo ampliado artificialmente por las notas E33.
    // No emitir una nota nueva mientras otra nota del mismo comprobante
    // tenga estado incierto. Hay que conciliarla antes de continuar.
    const pendingAdjustment = await ElectronicTaxDocument.exists({
        tenantId,
        sourceDocumentType: "ECF_ADJUSTMENT",
        "ecf.status": { $in: ["draft", "xml_generated", "signed", "submitted", "track_received"] },
        $and: [
            { $or: buildClientScopeOr(clientId) },
            { $or: [
                { orderId: originalOrder._id },
                { "reference.modifiedOrderId": originalOrder._id },
                { "reference.modifiedDocumentId": originalDoc._id },
                { "reference.modifiedENCF": originalDoc.ecf?.eNCF },
            ] },
        ],
    });
    if (pendingAdjustment) {
        const err = new Error("ECF_ADJUSTMENT_PENDING_RECONCILIATION");
        err.statusCode = 409;
        throw err;
    }

    // Nunca consumir secuencia si el índice único compartido no está listo.
    await ensureEcfDocumentIndex(ElectronicTaxDocument);
    const attempt = await issueAttempt.claimIssue(EcfEmissionAttempt, {
        tenantId, clientId, orderId: originalOrder._id, kind: "ECF_ADJUSTMENT",
        documentType: normalizedDocumentType, body, environment: profile.environment,
    });
    try {
    const balanceSummary = normalizedDocumentType === "34"
        ? await getAcceptedAdjustmentBalanceSummary({ tenantId, clientId, originalOrder, originalDoc })
        : null;

    const adjustmentOrder = buildAdjustmentOrderFromBody({
        originalOrder,
        documentType: normalizedDocumentType,
        body,
        signedAt,
        acceptedCreditDocs: balanceSummary?.creditNotes || [],
    });

// Validación fuerte para Nota de Crédito E34.
// Límite conservador: Total original - E34 aceptadas.
// Las notas E33 no aumentan la cuota de crédito contra el original.
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

        // Límite DGII: la suma de E34 referidas al original no supera su total.
        // Las E33 se informan por separado pero NO aumentan el crédito permitido.
        const availableCredit = creditAvailability(
            originalTotal,
            balanceSummary.totalCreditIssued
        );

        if (reference.modificationCode === "1" && Math.abs(requestedCreditTotal - availableCredit) > 0.01) {
            const err = new Error("E34_TOTAL_CANCELLATION_REQUIRES_REMAINING_BALANCE");
            err.statusCode = 422;
            err.details = { requestedCreditTotal, availableCredit };
            throw err;
        }

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

    // En notas, validar antes de reservar el e-NCF.
    const fiscalSnapshot = getFiscalSnapshot(adjustmentOrder);
    await checkXsdBeforeSequence({
        profile, order: adjustmentOrder, documentType: normalizedDocumentType, reference,
    });

    // 'reserving' se persiste primero: si Mongo pierde respuesta del contador,
    // el intento queda bloqueado para revisión, aunque aún no conozcamos el número.
    await issueAttempt.advance(EcfEmissionAttempt, attempt, { stage: "reserving" });
    const sequenceNumber = await getNextSequence({
        tenantId,
        documentType: normalizedDocumentType,
    });

    const eNCF = buildENcf({
        documentType: normalizedDocumentType,
        sequenceNumber,
    });
    await issueAttempt.advance(EcfEmissionAttempt, attempt, {
        stage: "reserved", sequenceNumber, eNCF,
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
            environment: profile.environment,
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
            total: fiscalSnapshot.total,
            fiscalSummaryVersion: 1,
            taxable18: fiscalSnapshot.taxable18,
            taxable16: fiscalSnapshot.taxable16,
            exempt: fiscalSnapshot.exempt,
            itbis18: fiscalSnapshot.itbis18,
            itbis16: fiscalSnapshot.itbis16,
            deliveryFee: fiscalSnapshot.deliveryFee,
        },
        xml: {
            raw: xml,
        },
        timestampsFlow: {
            generatedAt: new Date(),
        },
    });

    await issueAttempt.advance(EcfEmissionAttempt, attempt, {
        stage: "xml_generated", documentId: doc._id,
    });
    let signResult;

    const isInternalSandbox =
        String(profile?.environment || "").trim() === "internal_sandbox";

    const usesExternalSigning = !isInternalSandbox && resolveMode() === "external_provider";
    const useRealSigner =
        !isInternalSandbox &&
        (usesExternalSigning || (
        profile?.certificate?.isActive === true &&
        profile?.security?.certificateUploaded === true &&
        profile?.security?.passwordConfigured === true &&
        profile?.certificate?.bucket &&
        profile?.certificate?.path &&
        profile?.certificate?.passwordEncrypted));

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

    const securityCode = isInternalSandbox
        ? String(signResult?.hash || "")
            .slice(0, 6)
            .toUpperCase()
        : String(signResult?.securityCode || "").trim();

    if (!securityCode) {
        const err = new Error("ECF_SECURITY_CODE_NOT_GENERATED");
        err.statusCode = 500;
        throw err;
    }

    doc.xml.signed = signResult.signedXml;
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

    // El mockSigner del sandbox no produce XMLDSig: validar contra XSD preflight.
    // En certificacion y produccion exigir SIEMPRE el XSD signed; no desactivar enforce.
    if (isInternalSandbox) {
        await checkEcfXsd({
            xml: signResult.signedXml, format: normalizedDocumentType, stage: "preflight",
        });
    } else {
        await checkEcfXsd({
            xml: signResult.signedXml, format: normalizedDocumentType, stage: "signed",
        });
    }

    // Durable before network: a crash cannot erase the signed document.
    await doc.save();
    await issueAttempt.advance(EcfEmissionAttempt, attempt, { stage: "dispatching" });
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
    await doc.save();
    await issueAttempt.advance(EcfEmissionAttempt, attempt, {
        stage: "submitted", trackId: doc.ecf.trackId || null,
    });

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
    await issueAttempt.complete(EcfEmissionAttempt, attempt, doc.ecf.status, {
        documentId: doc._id, trackId: doc.ecf.trackId || null,
    });

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
    } catch (error) {
        await issueAttempt.failed(EcfEmissionAttempt, attempt, error);
        throw error;
    }
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
        const { getCapabilities } = require("../middlewares/requireEcfPermission");
        const permissions = getCapabilities(req);
        if (!permissions.issue && !permissions.credit && !permissions.debit) {
            return res.status(403).json({ success: false, code: "ECF_PERMISSION_DENIED" });
        }

        const docs = await ElectronicTaxDocument.find({
            tenantId,
            sourceDocumentType: "ECF_ADJUSTMENT",
            $or: [
                { orderId: id },
                { "reference.modifiedOrderId": id },
            ],
            // No principal/legacy documents leak into a secondary branch.
            $and: [{ $or: buildClientScopeOr(clientId) }],
        })
            .sort({ createdAt: -1 })
            .lean();

        return res.json({
            success: true,
            data: docs.filter(doc => {
                const type = String(doc.ecf?.documentType || "");
                return type === "34" ? permissions.credit : type === "33" ? permissions.debit : false;
            }).map((doc) => ({
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

// Recuperación segura: consulta el e-NCF EXISTENTE; jamás reenvía ni reserva otro.
exports.reconcileExistingEcf = async (req, res) => {
    try {
        const mongoose = require("mongoose");
        const { getCapabilities } = require("../middlewares/requireEcfPermission");
        const tenantId = req.scope?.tenantId || req.tenantId;
        const clientId = req.scope?.clientId || req.clientId || "default";
        const orderId = req.params.id;
        const documentId = req.body?.documentId;
        if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(documentId)) {
            return res.status(400).json({ success: false, code: "INVALID_ECF_DOCUMENT_ID" });
        }
        const doc = await ElectronicTaxDocument.findOne({
            _id: documentId, tenantId, orderId, $or: buildClientScopeOr(clientId),
        });
        if (!doc) return res.status(404).json({ success: false, code: "ECF_DOCUMENT_NOT_FOUND" });
        const permissions = getCapabilities(req);
        const type = String(doc.ecf?.documentType || "");
        const permitted = type === "34" ? permissions.credit : type === "33" ? permissions.debit : permissions.issue;
        if (!permitted) return res.status(403).json({ success: false, code: "ECF_PERMISSION_DENIED" });
        const state = String(doc.ecf?.status || "");
        if (["accepted", "accepted_with_observation", "rejected", "cancelled"].includes(state)) {
            return res.json({ success: true, unchanged: true, data: { documentId, eNCF: doc.ecf.eNCF, status: state } });
        }
        const profile = await TenantEcfProfile.findOne({ tenantId });
        if (!profile) return res.status(409).json({ success: false, code: "ECF_PROFILE_MISSING" });
        // CRÍTICO: no consultar una emisión antigua con las credenciales de
        // otro entorno después de cambiar el ambiente del contribuyente.
        // Los documentos previos a este parche carecen de snapshot fiable.
        if (!doc.ecf?.environment) {
            return res.status(409).json({ success: false,
                code: "ECF_DOCUMENT_ENVIRONMENT_UNRECORDED",
                data: { documentId, eNCF: doc.ecf?.eNCF || null, status: state },
            });
        }
        if (doc.ecf.environment !== profile.environment) {
            return res.status(409).json({ success: false,
                code: "ECF_RECONCILIATION_ENVIRONMENT_MISMATCH",
                data: { documentId, eNCF: doc.ecf?.eNCF || null, status: state },
            });
        }
        const gateway = getEcfGateway(doc.ecf.environment);
        let result;
        if (doc.ecf.trackId && typeof gateway.queryStatus === "function") {
            result = await gateway.queryStatus({ trackId: doc.ecf.trackId, profile });
        } else if (type === "32" && typeof gateway.queryRfceStatus === "function" && doc.ecf.securityCode) {
            result = await gateway.queryRfceStatus({ profile, rncEmisor: doc.issuer?.rnc, eNCF: doc.ecf.eNCF, securityCode: doc.ecf.securityCode });
        } else {
            return res.status(409).json({ success: false, code: "ECF_NO_TRACK_REQUIRES_MANUAL_DGII_VERIFICATION",
                data: { documentId, eNCF: doc.ecf.eNCF, status: state } });
        }
        const allowed = new Set(["accepted", "accepted_with_observation", "rejected", "track_received", "submitted", "pending"]);
        if (!allowed.has(result?.status)) {
            return res.status(409).json({ success: false, code: "ECF_UNRECOGNIZED_DGII_STATUS", data: { documentId, eNCF: doc.ecf.eNCF } });
        }
        const nextStatus = result.status === "pending" ? "track_received" : result.status;
        doc.ecf.status = nextStatus;
        doc.dgiiResponse.code = result.code || null;
        doc.dgiiResponse.message = result.message || null;
        doc.dgiiResponse.raw = result.raw || null;
        doc.dgiiResponse.receivedAt = new Date();
        if (["accepted", "accepted_with_observation"].includes(nextStatus)) doc.timestampsFlow.acceptedAt = new Date();
        if (nextStatus === "rejected") doc.timestampsFlow.rejectedAt = new Date();
        await doc.save();
        const attempt = await EcfEmissionAttempt.findOne({ tenantId, documentId: doc._id });
        if (attempt) await issueAttempt.complete(EcfEmissionAttempt, attempt, nextStatus,
            { documentId: doc._id, trackId: doc.ecf.trackId || null });
        return res.json({ success: true, data: { documentId, eNCF: doc.ecf.eNCF, status: nextStatus, trackId: doc.ecf.trackId || null } });
    } catch (error) {
        // Nunca se reenvía automáticamente por un error en consulta.
        return res.status(error.statusCode || 502).json({ success: false, code: "ECF_RECONCILIATION_QUERY_FAILED" });
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