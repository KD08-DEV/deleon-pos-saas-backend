const { wasPrepared, authorizeInventoryReturn } = require("../services/inventory/returnAuthorization");
const {serviceChargeAmount,manualTipAmount,allocateCents}=require("../services/reports/chargeAllocation");
const {canCreateCreditSale}=require("../services/orders/creditSaleAccess");
const { summarizeLegacyNcf } = require("../services/fiscal/legacyNcfAvailability");
const createHttpError = require("http-errors");
const mongoose = require("mongoose");
const Order = require("../models/orderModel");
const Table = require("../models/tableModel");
const Tenant = require("../models/tenantModel");
const Dish = require("../models/dish"); // ajusta si el nombre es dishModel.js
const InventoryCategory = require("../models/inventoryCategoryModel");
const ElectronicTaxDocument = require("../models/electronicTaxDocumentModel");
const { buildEcfDocumentScope, mapEcfForInvoice } = require("../services/ecf/orderInvoiceEcfView");
// const InventoryItem = require("../models/inventoryItemModel"); // DEPRECATED: Ya no se usa InventoryItem, solo Dish
// const InventoryMovement = require("../models/inventoryMovementModel"); // DEPRECATED
const Customer = require("../models/customerModel");
const { deductInventoryForOrder, restoreInventoryForOrder } = require("../services/inventory/deductInventoryForOrder");
const { persistOrderWithInventory } = require("../services/inventory/persistOrderWithInventory");
const Printer = require("../models/printerModel");
const networkPrintService = require("../services/networkPrintService");
const Membership = require("../models/membershipModel");
const TenantEcfProfile = require("../models/tenantEcfProfileModel");
const Client = require("../models/clientModel");
const {getBranchEcfStatus, assertSecondarySandboxIssue} = require("../services/ecf/ecfBranchAccess");
const { issueOrderAsEcfCore } = require("./ecfIssueController");
const { createReceivableForOrder } = require("./accountReceivableController");
const {
    getTenantTimezone,
    getUtcRangeForYMDRange,
    getTodayYMDInTimeZone,
} = require(
    "../utils/timezone"
);
const {
    validateEcfProfile,
} = require(
    "../services/ecf/helpers/validateEcfProfile"
);
const {
    calculateOrderTaxes,
} = require(
    "../services/tax/taxEngine"
);
const {
    calculateServiceCharges,
} = require(
    "../services/charges/serviceChargeEngine"
);

const {
    normalizePlan,
    getPlanFeatures,
} = require("../middlewares/requirePlan");


function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}
const ORDER_SOURCES = ["DINE_IN", "TAKEOUT", "PEDIDOSYA", "UBEREATS", "DELIVERY"];
function normalizeSource(v) {
    const s = String(v || "").trim().toUpperCase();
    if (!s) return "DINE_IN";
    return ORDER_SOURCES.includes(s) ? s : "DINE_IN";
}

function getCommissionRateFromTenant(tenant, source) {
    const os = tenant?.features?.orderSources || {};
    if (source === "PEDIDOSYA") {
        if (os?.pedidosYa?.enabled !== true) return { allowed: false, rate: 0 };
        return { allowed: true, rate: Number(os?.pedidosYa?.commissionRate ?? 0.26) };
    }
    if (source === "UBEREATS") {
        if (os?.uberEats?.enabled !== true) return { allowed: false, rate: 0 };
        return { allowed: true, rate: Number(os?.uberEats?.commissionRate ?? 0.22) };
    }
    // ADD:
    if (source === "DELIVERY") {
        if (os?.delivery?.enabled !== true) return { allowed: false, rate: 0 };
        return { allowed: true, rate: 0 }; // delivery interno no tiene comisión
    }
    // DINE_IN / TAKEOUT por defecto sin comisión
    return { allowed: true, rate: 0 };
}

function computeCommission(totalBeforeTip, totalWithTax, rate) {
    const r = Number(rate) || 0;

    const base = round2(totalBeforeTip);
    const total = round2(totalWithTax);

    if (r <= 0) return { commissionAmount: 0, netTotal: total };

    const commissionAmount = round2(base * r);     // comisión NO incluye tip
    const netTotal = round2(total - commissionAmount);

    return { commissionAmount, netTotal };
}


function escapeRegex(str = "") {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function normalizeMongoDate(value) {
    if (!value) return null;

    // Date real
    if (value instanceof Date) return value;

    // ISO string / timestamp
    if (typeof value === "string" || typeof value === "number") {
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? null : d;
    }

    // Extended JSON guardado como objeto: { $date: "..." }
    if (typeof value === "object") {
        if (value.$date) return normalizeMongoDate(value.$date);
        if (value.date) return normalizeMongoDate(value.date);
    }

    return null;
}
// ======================================================
// IDENTIFICACIÓN FISCAL DEL CLIENTE
// ======================================================

function normalizeCustomerTaxIdentity(
    raw,
    legacyValue = "",
    fallbackCountryCode = "DO"
) {
    // ==============================================
    // FORMATO INTERNACIONAL NUEVO
    // ==============================================

    if (
        raw &&
        typeof raw === "object"
    ) {
        const value =
            String(
                raw?.value ||
                ""
            ).trim();

        if (value) {
            const type =
                String(
                    raw?.type ||
                    "TAX_ID"
                )
                    .trim()
                    .toUpperCase();

            return {
                countryCode:
                    String(
                        raw?.countryCode ||
                        fallbackCountryCode ||
                        "DO"
                    )
                        .trim()
                        .toUpperCase()
                        .slice(0, 2),

                type:
                    type.slice(
                        0,
                        40
                    ),

                label:
                    String(
                        raw?.label ||
                        type ||
                        "Tax ID"
                    )
                        .trim()
                        .slice(
                            0,
                            80
                        ),

                value:
                    value.slice(
                        0,
                        120
                    ),
            };
        }
    }


    // ==============================================
    // COMPATIBILIDAD LEGACY RD
    // ==============================================

    const legacy =
        String(
            legacyValue ||
            ""
        ).trim();

    if (!legacy) {
        return null;
    }


    const digits =
        legacy.replace(
            /\D/g,
            ""
        );


    let type =
        "RNC_CEDULA";


    if (
        digits.length ===
        9
    ) {
        type =
            "RNC";
    }


    if (
        digits.length ===
        11
    ) {
        type =
            "CEDULA";
    }


    return {
        countryCode:
            "DO",

        type,

        label:
            type === "CEDULA"
                ? "Cédula"
                : type === "RNC"
                    ? "RNC"
                    : "RNC / Cédula",

        value:
        legacy,
    };
}


// ======================================================
// LEGACY PARA DGII
// ======================================================
//
// Solamente una identificación dominicana puede
// alimentar rnc / rncCedula.
//
// EIN, VAT, ABN, NIT, RFC, etc. SIEMPRE producen "".
// ======================================================

function getDominicanLegacyCustomerTaxValue(
    taxIdentity
) {
    if (!taxIdentity) {
        return "";
    }


    const countryCode =
        String(
            taxIdentity
                ?.countryCode ||
            ""
        )
            .trim()
            .toUpperCase();


    if (
        countryCode !==
        "DO"
    ) {
        return "";
    }


    const type =
        String(
            taxIdentity
                ?.type ||
            ""
        )
            .trim()
            .toUpperCase();


    if (
        ![
            "RNC",
            "CEDULA",
            "CÉDULA",
            "RNC_CEDULA",
        ].includes(type)
    ) {
        return "";
    }


    return String(
        taxIdentity
            ?.value ||
        ""
    ).trim();
}
function normalizeOrderStatus(s) {
    const v = String(s || "").trim();

    const map = {
        "In Progress": "En Progreso",
        "Ready": "Listo",
        "Completed": "Completado",
        "Cancelled": "Cancelado",
        "Canceled": "Cancelado",

        "En Progreso": "En Progreso",
        "Listo": "Listo",
        "Completado": "Completado",
        "Cancelado": "Cancelado",
    };

    return map[v] || "En Progreso";
}

async function getCurrentMembership(req, tenantId) {
    const userId = req.user?._id;

    if (!userId || !tenantId) return null;

    return Membership.findOne({
        user: userId,
        tenantId,
        status: "active",
    }).lean();
}

async function assertCanCancelOrder(req, tenantId) {
    const userRole = String(req.user?.role || "").trim();

    // Admin del UserModel siempre puede.
    if (userRole === "Admin" || userRole === "Owner" || userRole === "SuperAdmin") {
        return true;
    }

    const membership = await getCurrentMembership(req, tenantId);
    const membershipRole = String(membership?.role || "").trim();

    // Owner/Admin del Membership siempre puede.
    if (membershipRole === "Owner" || membershipRole === "Admin") {
        return true;
    }

    const canCancel = Boolean(membership?.permissions?.orders?.cancel);

    if (!canCancel) {
        throw createHttpError(403, "NO_PERMISSION_TO_CANCEL_ORDER");
    }

    return true;
}

const VALID_PRODUCTION_AREAS = ["kitchen", "bar", "other"];

function normalizeProductionArea(value = "kitchen") {
    const v = String(value || "kitchen").trim().toLowerCase();
    return VALID_PRODUCTION_AREAS.includes(v) ? v : "kitchen";
}

function makeLineId() {
    return new mongoose.Types.ObjectId().toString();
}

function cloneArray(value) {
    return Array.isArray(value) ? JSON.parse(JSON.stringify(value)) : [];
}

function normalizeToken(value = "") {
    return String(value || "").trim().toLowerCase();
}

function stableTokens(arr = []) {
    return cloneArray(arr)
        .map((x) => {
            if (typeof x === "string") return x.trim().toLowerCase();
            return (
                x?.name ||
                x?.label ||
                x?.title ||
                x?.value ||
                JSON.stringify(x)
            )
                .trim?.()
                ?.toLowerCase?.() ?? String(x).trim().toLowerCase();
        })
        .sort();
}

function buildOrderItemComparableKey(item = {}) {
    const productRef = item?.dishId
        ? String(item.dishId)
        : `name:${normalizeToken(item?.name)}`;

    const qtyType = String(item?.qtyType || "unit");
    const weightUnit = qtyType === "weight" ? String(item?.weightUnit || "lb") : "";

    return JSON.stringify({
        productRef,
        name: normalizeToken(item?.name),
        qtyType,
        weightUnit,
        note: normalizeToken(item?.note || item?.comment || item?.specialInstructions || ""),
        addons: stableTokens(
            item?.addons ||
            item?.addOns ||
            item?.extras ||
            item?.extraIngredients ||
            item?.selectedExtras ||
            []
        ),
        modifiers: stableTokens(
            item?.modifiers ||
            item?.selectedOptions ||
            item?.options ||
            []
        ),
    });
}

function buildProductionModifiers(item = {}) {
    const out = [];

    const note = String(item?.note || "").trim();
    if (note) out.push({ name: note });

    const addons = Array.isArray(item?.addons) ? item.addons : [];
    for (const a of addons) {
        const name = a?.name || a?.label || a?.title || String(a || "").trim();
        if (String(name).trim()) out.push({ name: String(name).trim() });
    }

    const modifiers = Array.isArray(item?.modifiers) ? item.modifiers : [];
    for (const m of modifiers) {
        const name = m?.name || m?.label || m?.title || String(m || "").trim();
        if (String(name).trim()) out.push({ name: String(name).trim() });
    }

    return out;
}

async function hydrateOrderItems({ items, tenantId, clientId, currentItems = [] }) {
    const normalized = normalizeAndPriceItems(items);

    const validDishIds = [
        ...new Set(
            normalized
                .map((it) => String(it.dishId || ""))
                .filter((id) => mongoose.Types.ObjectId.isValid(id))
        ),
    ];

    const dishes = validDishIds.length
        ? await Dish.find({
            _id: { $in: validDishIds },
            tenantId,
            ...(clientId === "default"
                ? { $or: [{ clientId: "default" }, { clientId: { $exists: false } }, { clientId: null }, { clientId: "" }] }
                : { clientId }),
        })
            .select(
                "_id productionArea taxId taxIncludedOverride"
            )
            .lean()
        : [];

    const dishMap =
        new Map(
            dishes.map(
                (dish) => [
                    String(
                        dish._id
                    ),
                    dish,
                ]
            )
        );

    const currentByLineId = new Map(
        (currentItems || [])
            .filter((it) => it?.lineId)
            .map((it) => [String(it.lineId), it])
    );

    const buckets = new Map();
    for (const existing of currentItems || []) {
        const key = buildOrderItemComparableKey(existing);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(existing);
    }

    return normalized.map((item) => {
        let matched = null;

        if (item.lineId && currentByLineId.has(String(item.lineId))) {
            matched = currentByLineId.get(String(item.lineId));
        }

        if (!matched) {
            const key = buildOrderItemComparableKey(item);
            const bucket = buckets.get(key) || [];
            matched = bucket.length ? bucket.shift() : null;

            if (bucket.length) buckets.set(key, bucket);
            else buckets.delete(key);
        }

        const quantity = Number(item.quantity || 0);
        const prevPrintedQty = Number(matched?.printedQty || 0);
        const authoritativeDish =
            dishMap.get(
                String(
                    item.dishId ||
                    ""
                )
            );
        return {
            ...item,

            lineId:
                matched?.lineId ||
                item.lineId ||
                makeLineId(),

            productionArea:
                normalizeProductionArea(
                    item.productionArea ||
                    matched?.productionArea ||
                    authoritativeDish
                        ?.productionArea ||
                    "kitchen"
                ),

            // IMPORTANTE:
            // nunca confiamos en el taxId enviado
            // por el navegador.
            //
            // Siempre viene del producto guardado.
            taxId:
                authoritativeDish
                    ? (
                        String(
                            authoritativeDish
                                ?.taxId ||
                            ""
                        ).trim() ||
                        null
                    )
                    : null,

            taxIncludedOverride:
                typeof authoritativeDish
                    ?.taxIncludedOverride ===
                "boolean"
                    ? authoritativeDish
                        .taxIncludedOverride
                    : null,
            printedQty:
                Math.max(
                    0,
                    Math.min(
                        prevPrintedQty,
                        quantity
                    )
                ),
        };
    });
}

async function findActiveProductionPrinter({ tenantId, clientId, category }) {
    return Printer.findOne({
        tenantId,
        clientId,
        category,
        isActive: true,
    }).sort({ isDefault: -1, createdAt: -1 });
}



// DEPRECATED: Esta función usa InventoryItem que ya no se usa.
// Ahora solo se usa el modelo Dish.
// async function deductInventoryForOrder(order, userId) {
//     ... (función deshabilitada porque usa InventoryItem)
// }

const getTenantEcfStatus =
    async (
        req,
        res,
        next
    ) => {
        try {

            const tenantId =
                req.tenantId ||
                req.user
                    ?.tenantId;


            if (!tenantId) {
                return next(
                    createHttpError(
                        401,
                        "TENANT_NOT_FOUND"
                    )
                );
            }


            const tenant =
                await Tenant
                    .findOne({
                        tenantId,
                    })
                    .select(
                        "localization.countryCode plan fiscal.enabled fiscal.ncfConfig features.fiscal.enabled"
                    )
                    .lean();


            if (!tenant) {
                return next(
                    createHttpError(
                        404,
                        "TENANT_NOT_FOUND"
                    )
                );
            }


            if (
                !tenantUsesDgii(
                    tenant
                )
            ) {
                return res
                    .status(200)
                    .json({
                        success:
                            true,

                        data: {
                            enabled:
                                false,

                            canIssue:
                                false,

                            countryCode:
                                tenant
                                    ?.localization
                                    ?.countryCode ||
                                null,

                            environment:
                                null,

                            certificationStatus:
                                null,

                            issuerReady:
                                false,

                            certificateRequired:
                                false,

                            certificateReady:
                                false,

                            documentTypes:
                                null,

                            documentTypeStatus:
                                {},

                            errors: [
                                "DGII_ONLY_AVAILABLE_FOR_DO",
                            ],

                            warnings:
                                [],
                        },
                    });
            }


            const clientId =
                req.clientId ||
                "default";

        if (!tenantId) {
            return next(
                createHttpError(
                    401,
                    "TENANT_NOT_FOUND"
                )
            );
        }

        const profile =
            await TenantEcfProfile
                .findOne({
                    tenantId,

                    $or: [
                        {
                            clientId,
                        },
                        {
                            clientId: {
                                $exists:
                                    false,
                            },
                        },
                        {
                            clientId:
                                "default",
                        },
                    ],
                })
                .select(
                    "enabled environment certificationStatus issuer certificate security documentTypes productionApproval certificationVerification"
                )
                .lean();

        const validation =
            validateEcfProfile(
                profile
            );

        const enabled =
            profile?.enabled ===
            true;

        const {getBranchEcfStatus} = require("../services/ecf/ecfBranchAccess");
        const branchEcf = await getBranchEcfStatus({tenantId,clientId});
        const eligibleBranch = branchEcf.prepared === true &&
            (!branchEcf.secondary || profile?.environment === "internal_sandbox");
        const canIssue = enabled && validation.ok === true && eligibleBranch;

        return res
            .status(200)
            .json({
                success: true,

                data: {
                    enabled: enabled && eligibleBranch,
                    sharedProfileEnabled: enabled,
                    // Datos NCF tradicionales comunes al contribuyente, no al almacén
                    // de certificados. El POS puede consultarlos como Cajera sin ver
                    // rangos, secuencias o datos privados del emisor.
                    legacyNcf: profile?.enabled === true && profile?.environment === "dgii_production"
                        ? { enabled: false, availableTypes: [], available: false }
                        : summarizeLegacyNcf(
                            tenant,
                            getPlanFeatures(normalizePlan(tenant.plan)).fiscal === true
                        ),
                    branch: branchEcf,
                    readOnly: branchEcf.secondary,
                    canIssue,

                    environment:
                        profile
                            ?.environment ||
                        null,

                    certificationStatus:
                        profile
                            ?.certificationStatus ||
                        null,

                    issuerReady:
                        validation
                            .issuerReady ===
                        true,

                    certificateRequired:
                        validation
                            .certificateRequired ===
                        true,

                    certificateReady:
                        validation
                            .certificateReady ===
                        true,

                    documentTypes:
                        profile
                            ?.documentTypes ||
                        null,

                    documentTypeStatus:
                        validation
                            .documentTypes ||
                        {},

                    errors:
                        validation
                            .errors ||
                        [],

                    warnings:
                        validation
                            .warnings ||
                        [],
                },
            });
    } catch (error) {
        console.error(
            "[getTenantEcfStatus] error:",
            error
        );

        return next(
            createHttpError(
                500,
                "GET_TENANT_ECF_STATUS_FAILED"
            )
        );
    }
};
const previewOrderTaxes = async (
    req,
    res,
    next
) => {
    try {
        const tenantId =
            req.tenantId ||
            req.user?.tenantId;

        const clientId =
            req.clientId ||
            req.scope?.clientId ||
            "default";

        if (!tenantId) {
            return next(
                createHttpError(
                    401,
                    "TENANT_NOT_FOUND"
                )
            );
        }

        const tenant =
            await Tenant.findOne({
                tenantId,
            })
                .select(
                    "taxConfig features localization"
                )
                .lean();

        if (!tenant) {
            return next(
                createHttpError(
                    404,
                    "TENANT_NOT_FOUND"
                )
            );
        }

        const incomingItems =
            Array.isArray(
                req.body?.items
            )
                ? req.body.items
                : [];

        if (
            incomingItems.length ===
            0
        ) {
            return res
                .status(200)
                .json({
                    success: true,

                    data: {
                        engineVersion: 1,

                        taxEnabled:
                            false,

                        items: [],

                        subtotal: 0,

                        discount: 0,

                        subtotalAfterDiscount:
                            0,

                        netAmount: 0,

                        tax: 0,

                        taxTotal: 0,

                        taxBreakdown: [],
                        serviceChargeTotal: 0,

                        serviceChargeBreakdown: [],

                        deliveryFee: 0,

                        deliveryTaxAmount:
                            0,

                        deliveryGrossAmount:
                            0,

                        itemsTotalWithTax:
                            0,

                        totalBeforeTip:
                            0,
                    },
                });
        }

        // ==================================================
        // IMPORTANTE
        // ==================================================
        // No confiamos en taxId ni taxIncludedOverride
        // enviados por el navegador.
        //
        // hydrateOrderItems vuelve a consultar Dish.
        // ==================================================

        const hydratedItems =
            await hydrateOrderItems({
                items:
                incomingItems,

                tenantId,

                clientId,

                currentItems:
                    [],
            });

        const result =
            calculateOrderTaxes({
                tenant,

                items:
                hydratedItems,

                discountAmount:
                    Number(
                        req.body
                            ?.discountAmount ||
                        0
                    ),

                deliveryFee:
                    Number(
                        req.body
                            ?.deliveryFee ||
                        0
                    ),

                taxesEnabled:
                    req.body
                        ?.taxEnabled !==
                    false,
            });
        const serviceChargeResult =
            calculateServiceCharges({
                tenant,
                legalTipEnabled: req.body?.legalTipEnabled !== false,

                taxResult:
                result,

                orderSource:
                    normalizeSource(
                        req.body
                            ?.orderSource
                    ),
            });

        const totalBeforeTip =
            round2(
                result.totalBeforeTip +
                serviceChargeResult
                    .addedTotal
            );
        return res
            .status(200)
            .json({
                success: true,

                data: {
                    ...result,

                    serviceChargeTotal:
                    serviceChargeResult
                        .addedTotal,

                    serviceChargeBreakdown:
                    serviceChargeResult
                        .breakdown,

                    totalBeforeTip,
                },
            });
    } catch (error) {
        console.error(
            "[previewOrderTaxes] error:",
            error
        );

        return next(error);
    }
};
const getOrderEcfStatus = async (req, res, next) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return next(createHttpError(400, "INVALID_ORDER_ID"));
        }

        const tenantId = req.tenantId || req.user?.tenantId;
        const clientId = req.clientId || "default";

        if (!tenantId) {
            return next(createHttpError(401, "TENANT_NOT_FOUND"));
        }

        const orderScope = {
            _id: id,
            tenantId,
            ...(clientId === "default"
                ? { $or: [{ clientId: "default" }, { clientId: { $exists: false } }, { clientId: null }, { clientId: "" }] }
                : { clientId }),
        };

        const order = await Order.findOne(orderScope)
            .select("_id tenantId clientId invoiceNumber facturaNo fiscal ncfNumber invoiceUrl invoicePath createdAt updatedAt")
            .lean();

        if (!order) {
            return next(createHttpError(404, "ORDER_NOT_FOUND"));
        }

        const ecfDocument = await ElectronicTaxDocument.findOne({
            tenantId,
            orderId: id,
            sourceDocumentType: "ORDER",
            ...(clientId === "default"
                ? { $or: [{ clientId: "default" }, { clientId: { $exists: false } }, { clientId: null }, { clientId: "" }] }
                : { clientId }),
        })
            .sort({ createdAt: -1 })
            .lean();

        if (!ecfDocument) {
            return res.status(200).json({
                success: true,
                exists: false,
                data: {
                    orderId: String(order._id),
                    invoiceNumber: order.invoiceNumber || order.facturaNo || null,
                    legacyNcfNumber: order?.fiscal?.ncfNumber || order?.ncfNumber || null,
                    // El historial es visible, pero la acción de emitir depende
                    // del permiso y la preparación de la sede.
                    canIssue: await (async () => {
                        const {getCapabilities} = require("../middlewares/requireEcfPermission");
                        if (!getCapabilities(req).issue) return false;
                        try {
                            const {assertSecondarySandboxIssue} = require("../services/ecf/ecfBranchAccess");
                            await assertSecondarySandboxIssue({tenantId,clientId});
                            return true;
                        } catch (_error) { return false; }
                    })(),
                    message: "NO_ECF_FOUND_FOR_ORDER",
                },
            });
        }

        return res.status(200).json({
            success: true,
            exists: true,
            data: {
                documentId: String(ecfDocument._id),
                orderId: String(order._id),

                eNCF: ecfDocument?.ecf?.eNCF || null,
                documentType: ecfDocument?.ecf?.documentType || null,
                sequenceNumber: ecfDocument?.ecf?.sequenceNumber || null,
                status: ecfDocument?.ecf?.status || "draft",
                trackId: ecfDocument?.ecf?.trackId || null,
                securityCode: ecfDocument?.ecf?.securityCode || null,
                qrUrl: ecfDocument?.ecf?.qrUrl || null,
                fechaHoraFirma: ecfDocument?.ecf?.fechaHoraFirma || null,

                issuer: ecfDocument?.issuer || null,
                customer: ecfDocument?.customer || null,
                totals: ecfDocument?.totals || null,

                dgiiResponse: {
                    code: ecfDocument?.dgiiResponse?.code || null,
                    message: ecfDocument?.dgiiResponse?.message || null,
                    receivedAt: ecfDocument?.dgiiResponse?.receivedAt || null,
                },

                timestampsFlow: ecfDocument?.timestampsFlow || null,

                xml: {
                    hasRaw: Boolean(ecfDocument?.xml?.raw),
                    hasSigned: Boolean(ecfDocument?.xml?.signed),
                    hash: ecfDocument?.xml?.hash || null,
                },

                issuedAt:
                    ecfDocument?.timestampsFlow?.generatedAt ||
                    ecfDocument?.createdAt ||
                    null,

                createdAt: ecfDocument?.createdAt || null,
                updatedAt: ecfDocument?.updatedAt || null,
            },
        });
    } catch (error) {
        console.error("[getOrderEcfStatus] error:", error);
        return next(createHttpError(500, "GET_ORDER_ECF_STATUS_FAILED"));
    }
};
// Normaliza items y calcula price por ítem
function normalizeAndPriceItems(items) {
    if (!Array.isArray(items)) return [];

    return items.map((it) => {
        const dishId = it.dishId || null;
        const name = (it.name || "").toString().trim();
        const qtyType = (it.qtyType || "unit").toString();
        const weightUnit = (it.weightUnit || "lb").toString();
        const quantity = Number(it.quantity ?? it.qty ?? 0);

        const unitPrice = Number(
            it.unitPrice ??
            it.pricePerQuantity ??
            it.price ??
            0
        );

        if (!name) throw new Error("Item sin name");
        if (!Number.isFinite(quantity) || quantity <= 0) {
            throw new Error(`Cantidad inválida para ${name}`);
        }
        if (!Number.isFinite(unitPrice) || unitPrice < 0) {
            throw new Error(`Precio inválido para ${name}`);
        }

        const price = Number((unitPrice * quantity).toFixed(2));
        const presentation = (it.presentation || "Regular").toString().trim();

        return {
            dishId,
            name,
            qtyType,
            presentation,
            weightUnit,
            quantity,
            unitPrice,
            price,

            taxId:
                it?.taxId ||
                null,

            taxIncludedOverride:
                typeof it
                    ?.taxIncludedOverride ===
                "boolean"
                    ? it
                        .taxIncludedOverride
                    : null,

            note: String(it?.note || it?.comment || it?.specialInstructions || "").trim(),
            addons: cloneArray(
                it?.addons ||
                it?.addOns ||
                it?.extras ||
                it?.extraIngredients ||
                it?.selectedExtras ||
                []
            ),
            modifiers: cloneArray(
                it?.modifiers ||
                it?.selectedOptions ||
                it?.options ||
                []
            ),

            lineId: it?.lineId || null,
            productionArea: normalizeProductionArea(it?.productionArea || "kitchen"),
            printedQty: Number(it?.printedQty || 0),
        };
    });
}


const addOrder = async (req, res, next) => {
    try {
        const tenantId = req.tenantId || req.user?.tenantId;
        if (!tenantId) {
            return next(createHttpError(401, "TENANT_NOT_FOUND"));
        }
        const clientId =
            req.clientId;


// ======================================================
// TENANT
// ======================================================

        const tenant =
            await Tenant
                .findOne({
                    tenantId,
                })
                .lean();


        if (!tenant) {
            return next(
                createHttpError(
                    404,
                    "TENANT_NOT_FOUND"
                )
            );
        }


// ======================================================
// DGII SOLO RD
// ======================================================

        const dgiiTenant =
            tenantUsesDgii(
                tenant
            );


// ======================================================
// PERFIL e-CF
// ======================================================

        const ecfProfileForTenant = await TenantEcfProfile.findOne({tenantId}).lean();
        const branchEcfState = await getBranchEcfStatus({tenantId,clientId});
        const ecfEnabledForTenant =
            branchEcfState.prepared &&
            (!branchEcfState.secondary || ecfProfileForTenant?.environment === "internal_sandbox") &&
            dgiiTenant &&
            getPlanFeatures(normalizePlan(tenant.plan))?.fiscal === true &&
            tenant.fiscal?.enabled === true && tenant.features?.fiscal?.enabled !== false &&
            ecfProfileForTenant?.enabled === true;
        const {
            customerId = null,
            customerDetails = {},
            orderStatus,
            items = [],
            table = null,
            paymentMethod = "Efectivo",
            discount = 0,
            orderSource,
            orderNote = "",
            fiscal: incomingFiscal = null,
            submitAction = "",
        } = req.body;
        const normalizedPaymentMethod = String(paymentMethod || "Efectivo").trim();
        const isCreditSale = normalizedPaymentMethod === "Credito";
        if (
            isCreditSale &&
            !(await canCreateCreditSale(req,tenant))
        ) {
            return next(
                createHttpError(
                    403,
                    "No tienes permiso para realizar nuevas ventas a crédito."
                )
            );
        }
        const normalizedStatus = normalizeOrderStatus(orderStatus);
        customerDetails.name = customerDetails.name || "";

        // Mesa opcional
        let tableRef = null;

        if (table) {
            if (!mongoose.Types.ObjectId.isValid(table)) {
                return next(createHttpError(400, "INVALID_TABLE_ID"));
            }

            tableRef = new mongoose.Types.ObjectId(String(table));

            const sameTenantTable = await Table.findOne({
                _id: tableRef,
                tenantId,
                ...(req.clientId === "default"
                    ? { $or: [{ clientId: "default" }, { clientId: { $exists: false } }, { clientId: null }] }
                    : { clientId: req.clientId }),
            }).select("_id isVirtual virtualType");

            if (!sameTenantTable) {
                return next(createHttpError(403, "TABLE_NOT_IN_SELECTED_BRANCH"));
            }
        }

        const features =
            tenant?.features ||
            {};

        const taxFeatureEnabled =
            typeof tenant
                ?.taxConfig
                ?.enabled ===
            "boolean"
                ? tenant
                    .taxConfig
                    .enabled
                : features
                ?.tax
                ?.enabled !== false;
        const tipFeatureEnabled = features?.tip?.enabled !== false;
        const discountFeatureEnabled = features?.discount?.enabled !== false;
        const fiscalFeatureEnabled =
            dgiiTenant &&
            tenant
                ?.fiscal
                ?.enabled === true;

        const {
            chargeMode,
            isInvoiceAction,
            shouldFinalize,
            finalOrderStatus,
        } = getOrderFinalizationDecision({
            tenant,
            submitAction,
            requestedStatus: normalizedStatus,
        });

        const isCompletionAction = finalOrderStatus === "Completado";


        const isFinalizingOrder =
            shouldFinalize ||
            incomingFiscal?.requested === true;

        if (
            String(req.body?.paymentStatus || "").trim() === "Pagado" &&
            !isFinalizingOrder
        ) {
            return next(
                createHttpError(
                    400,
                    "No se puede marcar una orden como pagada sin facturar o completar explícitamente."
                )
            );
        }
        const incomingExplicitEcfType = String(incomingFiscal?.ecfDocumentType || "")
            .trim()
            .toLowerCase()
            .replace(/^e/, "");

        const fiscalRequested =
            dgiiTenant &&
            (
                incomingFiscal
                    ?.requested === true ||

                incomingExplicitEcfType ===
                "31"
            );

        const selectedEcfType = requestedEcfType(incomingFiscal);
        if (incomingFiscal?.ecfDocumentType && !selectedEcfType)
            return next(createHttpError(400,"INVALID_ECF_DOCUMENT_TYPE"));
        if (submitAction === "invoice" && selectedEcfType &&
            ecfProfileForTenant?.documentTypes?.[`e${selectedEcfType}`]?.enabled !== true)
            return next(createHttpError(409,`ECF_DOCUMENT_TYPE_NOT_ENABLED_E${selectedEcfType}`));
        // e-CF ON en la sucursal: Facturar exige E31/E32 explícito.
        // Nunca confirmar una factura ordinaria silenciosamente sin e-NCF/QR.
        if (submitAction === "invoice" && ecfEnabledForTenant && !selectedEcfType)
            return next(createHttpError(400,"ECF_DOCUMENT_TYPE_REQUIRED"));
        if (selectedEcfType && !ecfEnabledForTenant)
            return next(createHttpError(403,"BRANCH_ECF_NOT_ENABLED"));
        // OFF en esta sucursal = NCF legacy (si el contribuyente mantiene rangos NCF
        // habilitados). No bloquear todas las sucursales secundarias por defecto.
        if (fiscalRequested && !selectedEcfType && ecfEnabledForTenant)
            return next(createHttpError(400,"ECF_DOCUMENT_TYPE_REQUIRED"));
        // No generar NCF legacy si el perfil compartido ya opera en producción e-CF.
        if (fiscalRequested && !selectedEcfType &&
            ecfProfileForTenant?.enabled === true &&
            ecfProfileForTenant?.environment === "dgii_production")
            return next(createHttpError(403,"LEGACY_NCF_NOT_ALLOWED_IN_ECF_PRODUCTION"));

        const incomingNcfType =
            String(
                incomingFiscal
                    ?.ncfType ||
                ""
            )
                .trim()
                .toUpperCase();


        const hasIncomingDgiiRequest =
            Boolean(
                incomingFiscal &&
                (
                    incomingFiscal
                        ?.requested ===
                    true ||

                    [
                        "B01",
                        "B02",
                    ].includes(
                        incomingNcfType
                    ) ||

                    [
                        "31",
                        "32",
                    ].includes(
                        incomingExplicitEcfType
                    )
                )
            );


        if (
            !dgiiTenant &&
            hasIncomingDgiiRequest
        ) {
            return next(
                createHttpError(
                    400,
                    "DGII_ONLY_AVAILABLE_FOR_DO"
                )
            );
        }

        const shouldIssueInternalInvoice = isInvoiceAction || shouldFinalize;
        let assignedInternalInvoice = null;


        const shouldMarkPaid = shouldFinalize;

        let fiscalPayload = {
            requested: false,
            ncfType: null,
        };

        let topLevelNcfNumber = null;

        if (!ecfEnabledForTenant && shouldIssueInternalInvoice && fiscalRequested) {
            if (!fiscalFeatureEnabled) {
                return next(createHttpError(400, "FISCAL_NOT_ENABLED_FOR_TENANT"));
            }

            const requestedType = incomingFiscal?.ncfType || "B02";

            const { type, ncfNumber } = await allocateNCF({
                tenantId,
                ncfType: requestedType,
            });

            assignedInternalInvoice = await allocateInternalSeq({ tenantId });
            const { internalSeq, internalNumber } = assignedInternalInvoice;

            const emissionPoint =
                String(tenant?.fiscal?.emissionPoint || "001").trim() || "001";

            const branchName = await getBranchInvoiceName({tenantId,clientId,tenant});

            const expiresAtRaw =
                tenant?.fiscal?.ncfConfig?.[type]?.expiresAt ??
                tenant?.fiscal?.ncfConfig?.[type]?.expirationDate ??
                tenant?.fiscal?.expiresAt ??
                null;

            const expirationDate = normalizeMongoDate(expiresAtRaw);
            const expirationDateISO = expirationDate ? expirationDate.toISOString() : null;

            fiscalPayload = {
                requested: true,
                ncfType: type,
                ncfNumber,
                issuedAt: new Date(),
                expirationDate: expirationDateISO,
                internalSeq,
                internalNumber,
                emissionPoint,
                branchName,
            };

            topLevelNcfNumber = ncfNumber;
        }
        if (ecfEnabledForTenant && selectedEcfType) {
            const requestedEcfType = String(incomingFiscal?.ecfDocumentType || "")
                .trim()
                .toLowerCase()
                .replace(/^e/, "");

            const finalEcfDocumentType =
                requestedEcfType ||
                (String(incomingFiscal?.ncfType || "").toUpperCase() === "B01" ? "31" : "32");

            fiscalPayload = {
                ...(fiscalPayload || {}),
                requested: finalEcfDocumentType === "31",
                ncfType: finalEcfDocumentType === "31" ? "B01" : "B02",
                ecfDocumentType: finalEcfDocumentType,
                issuedAt: shouldIssueInternalInvoice ? new Date() : null,
            };
        }


        // Canal / comisión
        const source = normalizeSource(orderSource);
        const { allowed, rate } = getCommissionRateFromTenant(tenant, source);

        if (!allowed) {
            return next(createHttpError(400, `SOURCE_DISABLED_${source}`));
        }

        // Normalizar items
        const normItems = Array.isArray(items) && items.length
            ? await hydrateOrderItems({
                items,
                tenantId,
                clientId,
                currentItems: [],
            })
            : [];

        const isDraft = normItems.length === 0;

        if (normItems.length === 0) {
            return next(createHttpError(400, "EMPTY_ORDER_NOT_ALLOWED"));
        }

        const incomingBills = req.body?.bills || {};

        // Delivery fee
        let deliveryFee = Number(incomingBills.deliveryFee ?? 0);
        deliveryFee = round2(deliveryFee);
        if (deliveryFee < 0) deliveryFee = 0;

        // Subtotal
        const subtotal = round2(normItems.reduce((s, i) => s + Number(i.price || 0), 0));

        // Discount
        let discountAmt = 0;
        if (discountFeatureEnabled) {
            discountAmt = round2(Number(incomingBills.discount ?? discount) || 0);
            if (discountAmt < 0) discountAmt = 0;
            if (discountAmt > subtotal) discountAmt = subtotal;
        }

        // Tax enabled
        let taxEnabled;
        if (incomingBills.taxEnabled !== undefined) {
            taxEnabled = Boolean(incomingBills.taxEnabled);
        } else if (incomingBills.tax !== undefined) {
            taxEnabled = Number(incomingBills.tax) > 0;
        } else {
            taxEnabled = true;
        }

        taxEnabled = taxFeatureEnabled ? taxEnabled : false;

        // Tip enabled
        let tipEnabled;
        if (incomingBills.tipEnabled !== undefined) {
            tipEnabled = Boolean(incomingBills.tipEnabled);
        } else if (incomingBills.tipAmount !== undefined) {
            tipEnabled = Number(incomingBills.tipAmount) > 0;
        } else if (incomingBills.tip !== undefined) {
            tipEnabled = Number(incomingBills.tip) > 0;
        } else {
            tipEnabled = tipFeatureEnabled;
        }

        tipEnabled = tipFeatureEnabled ? tipEnabled : false;

        // Tip
        let tip = 0;
        if (tipEnabled) {
            if (incomingBills.tipAmount !== undefined) {
                tip = Number(incomingBills.tipAmount);
            } else if (incomingBills.tip !== undefined) {
                tip = Number(incomingBills.tip);
            }
        }
        tip = round2(tip);
        if (tip < 0) tip = 0;

        // Tax
        // ======================================================
// MOTOR DE IMPUESTOS GENÉRICO
// ======================================================

        const taxResult =
            calculateOrderTaxes({
                tenant,

                items:
                normItems,

                discountAmount:
                discountAmt,

                deliveryFee,

                taxesEnabled:
                taxEnabled,
            });

        const serviceChargeResult =
            calculateServiceCharges({
                tenant,
                legalTipEnabled: incomingBills.legalTipEnabled !== false,
                taxResult,

                orderSource:
                source,
            });

// Los items que debemos guardar son estos,
// no los enviados por el navegador.
        const taxedItems =
            taxResult.items;

// Compatibilidad:
// bills.tax sigue siendo el total de impuestos.
        const tax =
            taxResult.taxTotal;

// Total sin propina.
        const totalBeforeTip =
            round2(
                taxResult
                    .totalBeforeTip +
                serviceChargeResult
                    .addedTotal
            );

        const totalWithTax =
            round2(
                totalBeforeTip +
                tip
            );

// La comisión de PedidosYa/UberEats continúa
// sin usar la propina.
//
// Tampoco cambiamos aquí la política existente
// respecto al delivery.
        const commissionBase =
            taxResult.itemsTotalWithTax;

        const {
            commissionAmount,
            netTotal,
        } =
            computeCommission(
                commissionBase,
                totalWithTax,
                rate
            );

        // Resolver customer
        // ======================================================
// RESOLVER CUSTOMER
// ======================================================

        let resolvedCustomerId =
            null;


// ======================================================
// TAX IDENTITY ENVIADO POR LA ORDEN
// ======================================================

        const incomingLegacyTaxValue =
            String(
                customerDetails
                    ?.rncCedula ??
                customerDetails
                    ?.rnc ??
                ""
            ).trim();


        const incomingTaxIdentity =
            normalizeCustomerTaxIdentity(
                customerDetails
                    ?.taxIdentity,

                incomingLegacyTaxValue,

                tenant
                    ?.localization
                    ?.countryCode ||
                "DO"
            );


        const incomingDominicanLegacy =
            getDominicanLegacyCustomerTaxValue(
                incomingTaxIdentity
            );


        let resolvedCustomerDetails = {
            name:
                String(
                    customerDetails
                        ?.name ??
                    ""
                ),

            phone:
                String(
                    customerDetails
                        ?.phone ??
                    ""
                ),

            address:
                String(
                    customerDetails
                        ?.address ??
                    ""
                ),

            guests:
                Number(
                    customerDetails
                        ?.guests ??
                    0
                ),

            taxIdentity:
            incomingTaxIdentity,

            /*
             * Compatibilidad DGII.
             *
             * Nunca copiamos directamente un EIN/VAT/etc.
             */
            rnc:
            incomingDominicanLegacy,

            rncCedula:
            incomingDominicanLegacy,
        };

        if (customerId) {
            if (!mongoose.Types.ObjectId.isValid(customerId)) {
                return next(createHttpError(400, "INVALID_CUSTOMER_ID"));
            }

            const found = await Customer.findOne({
                _id: customerId,
                tenantId,
                clientId,
                isActive: true,
            }).lean();

            if (!found) {
                return next(createHttpError(404, "CUSTOMER_NOT_FOUND"));
            }

            resolvedCustomerId = found._id;
            const foundTaxIdentity =
                normalizeCustomerTaxIdentity(
                    found
                        ?.taxIdentity,

                    "",

                    tenant
                        ?.localization
                        ?.countryCode ||
                    "DO"
                );


            /*
             * Si el Customer guardado ya tiene taxIdentity,
             * esa es nuestra fuente principal.
             *
             * Si es un cliente viejo sin taxIdentity,
             * usamos lo que vino de la orden.
             */
            const finalTaxIdentity =
                foundTaxIdentity ||
                incomingTaxIdentity;


            const finalLegacyTaxValue =
                getDominicanLegacyCustomerTaxValue(
                    finalTaxIdentity
                );


            resolvedCustomerDetails = {
                name:
                    found.name ||
                    "",

                phone:
                    found.phone ||
                    "",

                address:
                    found.address ||
                    "",

                guests:
                    Number(
                        customerDetails
                            ?.guests ??
                        0
                    ),

                taxIdentity:
                finalTaxIdentity,

                rnc:
                finalLegacyTaxValue,

                rncCedula:
                finalLegacyTaxValue,
            };
        }
        const registerId = String(req.body?.registerId || "MAIN")
            .trim()
            .toUpperCase();

        if (isCreditSale && !resolvedCustomerId) {
            return next(createHttpError(400, "CUSTOMER_REQUIRED_FOR_CREDIT_SALE"));
        }
        // ✅ Validar e-CF ANTES de crear la orden/factura.
// Esto evita que una E32 mayor o igual a 250,000 sin RNC/Cédula
// se guarde como Consumidor Final.
        try {
            if (String(submitAction || "").toLowerCase() === "invoice" && selectedEcfType) {
                await assertSecondarySandboxIssue({tenantId,clientId});
                const profileValidation = validateEcfProfile(ecfProfileForTenant);
                if (!profileValidation.ok) {
                    const err = createHttpError(409,"ECF_PROFILE_INVALID");
                    err.errors = profileValidation.errors;
                    throw err;
                }
            }
            assertEcfCanBeIssuedBeforePersist({
                tenant,

                ecfProfile:
                ecfProfileForTenant,

                submitAction,

                orderCandidate: {
                    tenantId,

                    clientId,

                    customerDetails:
                    resolvedCustomerDetails,

                    bills: {
                        // Compatibilidad
                        subtotal,

                        total:
                        subtotal,

                        discount:
                        discountAmt,

                        legalTipEnabled: incomingBills.legalTipEnabled !== false,

                        taxEnabled,

                        // Total de todos los impuestos.
                        tax,

                        // ==========================================
                        // NUEVO MOTOR DE IMPUESTOS
                        // ==========================================

                        taxEngineVersion:
                        taxResult
                            .engineVersion,

                        subtotalAfterDiscount:
                        taxResult
                            .subtotalAfterDiscount,

                        netAmount:
                        taxResult
                            .netAmount,

                        deliveryTaxAmount:
                        taxResult
                            .deliveryTaxAmount,

                        taxBreakdown:
                        taxResult
                            .taxBreakdown,

                        // ==========================================

                        tipEnabled,

                        tip,

                        tipAmount:
                        tip,

                        deliveryFee,

                        totalWithTax,
                    },

                    fiscal:
                    fiscalPayload,
                },
            });

        } catch (error) {
            return next(
                getEcfHttpError(
                    error
                )
            );
        }
// Snapshot de sede desde el alcance autenticado; no confundirla con el RNC común.
        if (shouldIssueInternalInvoice) {
            fiscalPayload.branchName = await getBranchInvoiceName({tenantId,clientId,tenant});
        }
// ✅ Solo asignar número interno si la validación e-CF pasó.
        if (shouldIssueInternalInvoice && !assignedInternalInvoice) {
            assignedInternalInvoice = await allocateInternalSeq({ tenantId });

            const { internalSeq, internalNumber } = assignedInternalInvoice;

            fiscalPayload = {
                ...(fiscalPayload || {}),
                internalSeq,
                internalNumber,
                issuedAt: fiscalPayload?.issuedAt || new Date(),
            };
        }

// ✅ Toda orden real debe tener número de operación.
// Esto NO es factura fiscal. Es para Ticket / Actualizar / Orden en progreso.
        const assignedOperation = await allocateOperationSeq({ tenantId });

        const payload = {
            tenantId,
            clientId,
            operationSeq: assignedOperation.operationSeq,
            operationNumber: assignedOperation.operationNumber,
            customerId: resolvedCustomerId,
            customerDetails: resolvedCustomerDetails,
            orderStatus: finalOrderStatus,
            isDraft,
            invoiceNumber: assignedInternalInvoice?.internalNumber || null,
            facturaNo: assignedInternalInvoice?.internalNumber || null,

            bills: {
                // Compatibilidad
                subtotal,

                total:
                subtotal,

                discount:
                discountAmt,

                legalTipEnabled: incomingBills.legalTipEnabled !== false,

                taxEnabled,

                serviceChargeTotal:
                serviceChargeResult
                    .addedTotal,

                serviceChargeBreakdown:
                serviceChargeResult
                    .breakdown,
                tax,

                // ==========================================
                // MOTOR FISCAL NUEVO
                // ==========================================

                taxEngineVersion:
                taxResult.engineVersion,

                subtotalAfterDiscount:
                taxResult
                    .subtotalAfterDiscount,

                netAmount:
                taxResult.netAmount,

                deliveryTaxAmount:
                taxResult
                    .deliveryTaxAmount,

                taxBreakdown:
                taxResult
                    .taxBreakdown,

                // ==========================================

                tipEnabled,

                tip,

                tipAmount:
                tip,

                deliveryFee,

                totalWithTax,
            },
            fiscal: fiscalPayload,
            ...(topLevelNcfNumber ? { ncfNumber: topLevelNcfNumber } : {}),

            orderNote: String(orderNote || "").trim(),
            orderSource: source,
            commissionRate: round2(rate),
            commissionAmount,
            netTotal,

            items:
            taxedItems,
            paymentMethod: normalizedPaymentMethod,
            registerId,

            creditStatus: isCreditSale ? "pending" : "none",

            paymentStatus: isCreditSale
                ? "Pendiente"
                : shouldMarkPaid
                    ? "Pagado"
                    : "Pendiente",

            paidAt: isCreditSale
                ? null
                : shouldMarkPaid
                    ? new Date()
                    : null,

            paidBy: isCreditSale
                ? null
                : shouldMarkPaid
                    ? (req.user?._id || null)
                    : null,
            invoicedAt: shouldIssueInternalInvoice ? new Date() : null,
            ...(tableRef ? { table: tableRef } : {}),
            ...(req.user?._id ? { user: req.user._id } : {}),
        };

        const order = await Order.create(payload);

// Si la orden se creó con mesa y ya tiene items, marcar mesa ocupada
        if (tableRef && Array.isArray(payload.items) && payload.items.length > 0) {
            const shouldFreeTable =
                finalOrderStatus === "Cancelado";

            await Table.updateOne(
                {
                    _id: tableRef,
                    tenantId,
                    ...(req.clientId === "default"
                        ? { $or: [{ clientId: "default" }, { clientId: { $exists: false } }, { clientId: null }] }
                        : { clientId: req.clientId }),
                },
                {
                    $set: shouldFreeTable
                        ? {
                            status: "Disponible",
                            currentOrder: null,
                        }
                        : {
                            status: "Ocupada",
                            currentOrder: order._id,
                        },
                }
            );
        }

        let responseOrder = order;

        try {
            const invResult = await syncInventoryForOrderTiming({
                orderId: order._id,
                tenant,
                orderStatus: finalOrderStatus,
                isInvoiceAction,
                userId: req.user?._id || null,
            });

            if (["deduct", "restore"].includes(invResult?.action)) {
                responseOrder = await Order.findById(order._id) || order;
            }
        } catch (e) {
            console.error("INVENTORY SYNC ON ADD ORDER ERROR =>", e);
            res.set("Cache-Control", "no-store");
            return res.status(409).json({
                success: false,
                code: "ORDER_CREATED_INVENTORY_SYNC_FAILED",
                orderId: String(order._id),
                requiresRecovery: true,
                message: "Orden guardada, inventario sin confirmar. Recuperar la orden antes de reintentar."
            });
        }
        const autoEcfResult = await autoIssueEcfForOrderIfNeeded({
            tenant,
            tenantId,
            clientId,
            order: responseOrder,
            submitAction,
            requestedFiscal: incomingFiscal,
            orderStatus: finalOrderStatus,
        });

        if (autoEcfResult && !autoEcfResult.error) {
            responseOrder = responseOrder.toObject ? responseOrder.toObject() : responseOrder;
            responseOrder.ecf = {
                exists: true,
                ...autoEcfResult,
            };
        } else if (autoEcfResult?.error) {
            const isInvoiceActionForEcf =
                String(submitAction || "").trim().toLowerCase() === "invoice";

            if (ecfEnabledForTenant && isInvoiceActionForEcf && requestedEcfType(responseOrder?.fiscal)) {
                return res.status(409).json({success:false,code:"ECF_ISSUE_REQUIRES_RECOVERY",
                    orderId:String(order._id),message:autoEcfResult.message || "AUTO_ECF_ISSUE_FAILED",
                    details:autoEcfResult.errors || []});
            }

            responseOrder = responseOrder.toObject ? responseOrder.toObject() : responseOrder;
            responseOrder.ecf = {
                exists: false,
                error: true,
                message: autoEcfResult.message,
                errors: autoEcfResult.errors || [],
            };
        }
        if (isCreditSale && shouldIssueInternalInvoice) {
            try {
                const receivable = await createReceivableForOrder({
                    order: responseOrder,
                    userId: req.user?._id || null,
                });

                responseOrder = await Order.findById(order._id) || responseOrder;
                responseOrder = responseOrder.toObject ? responseOrder.toObject() : responseOrder;

                responseOrder.accountReceivable = receivable.toObject
                    ? receivable.toObject()
                    : receivable;
            } catch (e) {
                console.error("[CREATE_RECEIVABLE_ON_ADD_ORDER_FAILED]", e);
                return next(e);
            }
        }

        return res.status(201).json({
            success: true,
            message: "Order created!",
            data: responseOrder,
        });
    } catch (error) {
        console.error("[addOrder] error:", error?.message);
        return next(createHttpError(500, "ADD_ORDER_FAILED"));
    }
};



const getOrderById = async (req, res, next) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return next(createHttpError(404, "Invalid id!"));
        }

        const order = await Order.findOne({ _id: id, tenantId: req.user.tenantId, clientId: req.clientId  })
            .populate("table")
            .populate("user", "name email role");


        if (!order) return next(createHttpError(404, "Order not found!"));

        // La emisión e-CF se conserva en ElectronicTaxDocument, no en Order.
        // Adjuntar SOLO el comprobante aceptado de esta orden, tenant y sucursal;
        // no modificar Order ni crear secuencias al consultar/imprimir.
        const tenantId = req.tenantId || req.user?.tenantId;
        const clientId = req.clientId || "default";
        const document = await ElectronicTaxDocument.findOne(
            buildEcfDocumentScope({ orderId: order._id, tenantId, clientId })
        )
            .select("ecf.documentType ecf.eNCF ecf.status ecf.trackId ecf.securityCode ecf.qrUrl ecf.fechaHoraFirma")
            .sort({ createdAt: -1 })
            .lean();

        const orderForInvoice = order.toObject();
        const ecf = mapEcfForInvoice(document);
        if (ecf) orderForInvoice.ecf = ecf;

        res.status(200).json({ success: true, data: orderForInvoice });
    } catch (error) {
        next(error);
    }
};

const getOrders = async (req, res, next) => {
    try {
        const tenantId =
            req.tenantId ||
            req.user?.tenantId;

        const clientId =
            req.clientId ||
            "default";

        if (!tenantId) {
            return next(
                createHttpError(401, "TENANT_NOT_FOUND")
            );
        }

        const includeDrafts =
            String(req.query.includeDrafts || "") === "1";

        const includeCancelled =
            String(req.query.includeCancelled || "1") === "1";

        const range = String(
            req.query.range || "24h"
        ).trim().toLowerCase();

        const requestedLimit = Number(
            req.query.limit || 120
        );

        const limit = Math.min(
            Math.max(
                Number.isFinite(requestedLimit)
                    ? Math.floor(requestedLimit)
                    : 120,
                1
            ),
            500
        );

        // No incluir ventas de la sucursal principal al consultar otra sede.
        // Los registros sin clientId solo son compatibles con la sede legacy default.
        const clientScope = clientId === "default"
            ? { $or: [
                { clientId: "default" },
                { clientId: { $exists: false } },
                { clientId: null },
                { clientId: "" },
            ] }
            : { clientId };

        const query = {
            tenantId,
            ...clientScope,
        };

        if (!includeDrafts) {
            query.isDraft = { $ne: true };
            query["items.0"] = { $exists: true };
        }

        if (!includeCancelled) {
            query.orderStatus = { $ne: "Cancelado" };
        }

        let startDate = null;

        if (range === "24h") {
            startDate = new Date(
                Date.now() - 24 * 60 * 60 * 1000
            );
        }

        if (range === "7d") {
            startDate = new Date(
                Date.now() - 7 * 24 * 60 * 60 * 1000
            );
        }

        if (startDate) {
            query.$and = [
                {
                    $or: [
                        {
                            createdAt: {
                                $gte: startDate,
                            },
                        },

                        // Nunca esconder una orden activa,
                        // aunque tenga más tiempo.
                        {
                            orderStatus: {
                                $in: [
                                    "En Progreso",
                                    "Listo",
                                ],
                            },
                        },
                    ],
                },
            ];
        }

        const orders = await Order.find(query)
            .sort({
                createdAt: -1,
                _id: -1,
            })
            .limit(limit)
            .populate({
                path: "table",
                select:
                    "tableNo tableNumber name type isVirtual virtualType",
            })
            .populate({
                path: "user",
                select: "name email role",
            })
            .lean();

        res.set({
            "Cache-Control":
                "no-store, no-cache, must-revalidate, proxy-revalidate",
            Pragma: "no-cache",
            Expires: "0",
        });

        return res.status(200).json({
            success: true,
            count: orders.length,
            data: orders,
        });
    } catch (error) {
        console.error(
            "[getOrders] error:",
            error?.message || error
        );

        return next(error);
    }
};
// DELETE /api/order/:id
const deleteOrder = async (req, res, next) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return next(createHttpError(404, "Invalid id!"));
        }

        // Traemos la orden para saber si hay mesa que liberar
        const order = await Order.findOne({ _id: id, tenantId: req.user.tenantId , clientId: req.clientId }).populate("table");

        if (!order) {
            // Si no existe, respondemos 200 idempotente para que el front no truene
            return res.status(200).json({
                success: true,
                message: "Order already removed or not found",
            });
        }
        const hasFinancialHistory =
            Boolean(
                order.invoiceNumber ||
                order.facturaNo ||
                order.invoicedAt ||
                order.accountReceivableId ||
                order.ncfNumber ||
                order?.fiscal?.ncfNumber ||
                order?.fiscal?.internalNumber ||
                order.paymentStatus === "Pagado" ||
                order.paymentMethod === "Credito"
            );

        if (order.inventoryDeducted || order.inventoryDeductedAt || order.inventoryRestoredAt) return next(createHttpError(409, "INVENTORY_ORDER_USE_AUDITED_CANCEL"));
        if (hasFinancialHistory) {
            return next(
                createHttpError(
                    409,
                    "FINANCIAL_ORDER_CANNOT_BE_DELETED_USE_CANCEL_OR_VOID"
                )
            );
        }
        await assertCanCancelOrder(req, req.user.tenantId);

        // Las ordenes con inventario o historial financiero se cancelan por la ruta auditada.
        // Solo liberar la mesa si esta orden sigue siendo su ocupante actual.
        if (order.table?._id) {
            await Table.findOneAndUpdate(
                { _id: order.table._id, tenantId: req.user.tenantId,
                  clientId: req.clientId, currentOrder: order._id },
                { $set: { status: "Disponible", currentOrder: null, tableSessionId: null } }
            );
        }
        await Order.deleteOne({ _id: id, tenantId: req.user.tenantId, clientId: req.clientId  });

        return res.status(200).json({
            success: true,
            message: "Order deleted successfully",
        });
    } catch (error) {
        next(error);
    }
};
function formatNCF(type, seq) {
    const t = String(type || "B02").toUpperCase().trim();

    const n = Number(seq);
    if (!Number.isFinite(n) || n <= 0) {
        const err = new Error(`Secuencia NCF inválida: ${seq}`);
        err.statusCode = 400;
        throw err;
    }

    // En tu caso estás usando B02 + 8 dígitos (total 11 caracteres).
    // Si el número crece (9 dígitos), aquí lo recortamos y además avisamos.
    if (n > 99999999) {
        const err = new Error(
            `NCF excede 8 dígitos (seq=${n}). Ajusta el rango en el panel admin.`
        );
        err.statusCode = 400;
        throw err;
    }

    const digits = String(Math.floor(n)).padStart(8, "0").slice(-8);
    return `${t}${digits}`;
}


async function allocateNCF({ tenantId, ncfType }) {
    const type = ncfType || "B02";

    const currentPath = `fiscal.ncfConfig.${type}.current`;
    const maxPath = `fiscal.ncfConfig.${type}.max`;
    const activePath = `fiscal.ncfConfig.${type}.active`;

    // Incremento atómico por tenant y por tipo
    const tenant = await Tenant.findOneAndUpdate(
        {
            tenantId,
            $or: [
                {
                    "localization.countryCode":
                        "DO",
                },

                /*
                 * Compatibilidad tenants antiguos
                 */
                {
                    "localization.countryCode": {
                        $exists:
                            false,
                    },
                },
            ],
            "fiscal.enabled": true,
            [activePath]: true,
            $expr: { $lte: [`$${currentPath}`, `$${maxPath}`] },
        },
        { $inc: { [currentPath]: 1 } },
        { new: true }
    ).lean();

    if (!tenant) {
        const err = new Error(`NCF no disponible para ${type} (inactivo o rango agotado).`);
        err.statusCode = 400;
        throw err;
    }

    // Como retorna después del $inc, el asignado es current-1
    const assignedSeq = tenant.fiscal.ncfConfig[type].current - 1;

    return { type, ncfNumber: formatNCF(type, assignedSeq) };
}
async function allocateInternalSeq({ tenantId }) {
    const tenant = await Tenant.findOneAndUpdate(
        { tenantId },
        { $inc: { "fiscal.nextInvoiceNumber": 1 } },
        { new: true }
    ).lean();

    if (!tenant) {
        const err = new Error("Tenant no encontrado para asignar secuencial interno.");
        err.statusCode = 404;
        throw err;
    }

    const next = Number(tenant?.fiscal?.nextInvoiceNumber ?? 0);

    let assigned = next - 1;
    if (!Number.isFinite(assigned) || assigned <= 0) assigned = next;

    if (!Number.isFinite(assigned) || assigned <= 0) {
        const err = new Error("No se pudo asignar secuencia interna.");
        err.statusCode = 500;
        throw err;
    }

    const internalNumber = String(assigned).padStart(8, "0");

    return {
        internalSeq: assigned,
        internalNumber,
    };
}

async function allocateOperationSeq({ tenantId }) {
    const tenant = await Tenant.findOneAndUpdate(
        { tenantId },
        [
            {
                $set: {
                    "counters.nextOrderNumber": {
                        $add: [
                            { $ifNull: ["$counters.nextOrderNumber", 1] },
                            1,
                        ],
                    },
                },
            },
        ],
        { new: true }
    ).lean();

    if (!tenant) {
        const err = new Error("Tenant no encontrado para asignar número de orden.");
        err.statusCode = 404;
        throw err;
    }

    const next = Number(tenant?.counters?.nextOrderNumber ?? 0);
    const assigned = next - 1;

    if (!Number.isFinite(assigned) || assigned <= 0) {
        const err = new Error("No se pudo asignar número de orden.");
        err.statusCode = 500;
        throw err;
    }

    return {
        operationSeq: assigned,
        operationNumber: String(assigned).padStart(8, "0"),
    };
}

function getExistingInternalInvoiceNumber(order = {}) {
    return (
        order?.facturaNo ||
        order?.invoiceNumber ||
        order?.invoiceNo ||
        order?.fiscal?.facturaNo ||
        order?.fiscal?.invoiceNumber ||
        order?.fiscal?.invoiceNo ||
        order?.fiscal?.internalNumber ||
        order?.fiscal?.internalSeq ||
        order?.fiscal?.internal ||
        null
    );
}


function getTenantChargeMode(tenant = {}) {
    const mode = String(
        tenant?.features?.checkout?.chargeMode || "AT_COMPLETE"
    )
        .trim()
        .toUpperCase();

    return ["AT_INVOICE", "AT_COMPLETE"].includes(mode)
        ? mode
        : "AT_COMPLETE";
}
function getOrderFinalizationDecision({
                                          tenant,
                                          submitAction,
                                          requestedStatus,
                                      }) {
    const chargeMode = getTenantChargeMode(tenant);
    const normalizedStatus = normalizeOrderStatus(requestedStatus);
    const isInvoiceAction =
        String(submitAction || "").trim().toLowerCase() === "invoice";

    const finalizesByInvoice =
        chargeMode === "AT_INVOICE" && isInvoiceAction;

    const finalizesByCompletion =
        chargeMode === "AT_COMPLETE" && normalizedStatus === "Completado";

    const shouldFinalize = finalizesByInvoice || finalizesByCompletion;

    return {
        chargeMode,
        isInvoiceAction,
        shouldFinalize,

        // IMPORTANTE:
        // Facturar puede marcar pago, generar factura, NCF/e-CF e inventario,
        // pero NO debe forzar el estado a Completado.
        finalOrderStatus: normalizedStatus,
    };
}

function shouldDeductInventoryNow({ tenant, orderStatus, isInvoiceAction }) {
    const chargeMode = getTenantChargeMode(tenant);
    const normalizedStatus = normalizeOrderStatus(orderStatus);

    if (normalizedStatus === "Cancelado") {
        return false;
    }

    // Modo cobrar al facturar:
    // descuenta inventario cuando la acción real es facturar.
    if (chargeMode === "AT_INVOICE" && isInvoiceAction) {
        return true;
    }

    // Modo cobrar al completar:
    // descuenta inventario cuando la orden pasa a Completado.
    if (chargeMode === "AT_COMPLETE" && normalizedStatus === "Completado") {
        return true;
    }

    return false;
}
function onlyDigits(value = "") {
    return String(value || "").replace(/\D/g, "");
}

// ======================================================
// DGII SOLO REPÚBLICA DOMINICANA
// ======================================================

function tenantUsesDgii(
    tenant = {}
) {
    const countryCode =
        String(
            tenant
                ?.localization
                ?.countryCode ||
            "DO"
        )
            .trim()
            .toUpperCase();


    /*
     * Default DO conserva compatibilidad
     * con tenants antiguos que todavía
     * no tienen localization.
     */
    return (
        countryCode ===
        "DO"
    );
}

function determineEcfDocumentTypeForOrder(order) {
    const rnc = onlyDigits(order?.customerDetails?.rnc);
    const rncCedula = onlyDigits(order?.customerDetails?.rncCedula);
    const buyerDoc = rnc || rncCedula;

    const hasValidBuyerDoc = [9, 11].includes(buyerDoc.length);

    const explicitEcfType = String(order?.fiscal?.ecfDocumentType || "")
        .trim()
        .toLowerCase()
        .replace(/^e/, "");

    const ncfType = String(order?.fiscal?.ncfType || "").toUpperCase();

    const wantsFiscalCredit =
        explicitEcfType === "31" ||
        order?.fiscal?.requested === true ||
        ncfType === "B01";

    const total = Number(order?.bills?.totalWithTax || 0);

    if (explicitEcfType === "32") {
        if (total >= 250000 && !hasValidBuyerDoc) {
            const err = new Error("E32_OVER_250K_REQUIRES_BUYER_DOCUMENT");
            err.statusCode = 400;
            throw err;
        }

        return "32";
    }

    if (wantsFiscalCredit) {
        if (!hasValidBuyerDoc) {
            const err = new Error("E31_REQUIRES_VALID_BUYER_DOCUMENT");
            err.statusCode = 400;
            throw err;
        }

        return "31";
    }

    if (total >= 250000 && !hasValidBuyerDoc) {
        const err = new Error("E32_OVER_250K_REQUIRES_BUYER_DOCUMENT");
        err.statusCode = 400;
        throw err;
    }

    return "32";
}
async function getBranchInvoiceName({tenantId,clientId,tenant}) {
    if (String(clientId || "default") === "default")
        return String(tenant?.fiscal?.branchName || "Principal").trim() || "Principal";
    const branch = await Client.findOne({tenantId,clientId}).select("name").lean();
    if (!branch) throw createHttpError(403,"BRANCH_NOT_FOUND");
    return String(branch.name || "Sucursal").trim();
}
function requestedEcfType(fiscal) {
    const type = String(fiscal?.ecfDocumentType || "").trim().toLowerCase().replace(/^e/, "");
    return ["31","32"].includes(type) ? type : null;
}
function shouldAutoIssueEcfNow({
                                   ecfProfile,
                                   submitAction,
                                   fiscal,
                               }) {
    return ecfProfile?.enabled === true &&
        String(submitAction || "").trim().toLowerCase() === "invoice" &&
        Boolean(requestedEcfType(fiscal));
}
function assertEcfCanBeIssuedBeforePersist({
                                               tenant,
                                               ecfProfile,
                                               submitAction,
                                               orderCandidate,
                                           }) {

    if (
        !tenantUsesDgii(
            tenant
        )
    ) {
        return;
    }
    // Fase 12.3: una configuración fiscal desactivada nunca dispara emisión automática.
    if (tenant?.fiscal?.enabled !== true ||
        tenant?.features?.fiscal?.enabled === false ||
        getPlanFeatures(normalizePlan(tenant?.plan)).fiscal !== true) return;
    const shouldIssue = shouldAutoIssueEcfNow({
        ecfProfile,
        submitAction,
        fiscal: orderCandidate?.fiscal,
    });

    if (!shouldIssue) return;

    // Usa la misma validación real que ya tienes para e31/e32.
    determineEcfDocumentTypeForOrder(orderCandidate);
}

function getEcfHttpError(error) {
    const code = error?.message || "ECF_VALIDATION_FAILED";

    return createHttpError(error?.statusCode || error?.status || 400, code);
}
async function autoIssueEcfForOrderIfNeeded({
                                                tenant,
                                                tenantId,
                                                clientId,
                                                order,
                                                submitAction,
                                                requestedFiscal,
                                                orderStatus,
                                            }) {
    try {
        if (!order?._id) return null;
        if (!tenantUsesDgii(tenant) || tenant?.fiscal?.enabled !== true ||
            tenant?.features?.fiscal?.enabled === false ||
            getPlanFeatures(normalizePlan(tenant?.plan)).fiscal !== true) return null;

        const ecfProfile = await TenantEcfProfile.findOne({tenantId});


        const shouldIssue = shouldAutoIssueEcfNow({
            ecfProfile,
            submitAction,
            fiscal: requestedFiscal,
        });
        if (!shouldIssue) return null;
        // This is checked again inside issueOrderAsEcfCore, not just at route level.
        await assertSecondarySandboxIssue({tenantId,clientId});
        const documentType = determineEcfDocumentTypeForOrder(order);

        const result = await issueOrderAsEcfCore({
            tenantId,
            clientId,
            orderId: order._id,
            documentType,
        });

        return result?.data || null;
    } catch (error) {
        console.error("[AUTO_ECF_ISSUE_FAILED]", {
            orderId: order?._id,
            tenantId,
            message: error?.message,
            errors: error?.errors,
        });

        return {
            error: true,
            message: error?.message || "AUTO_ECF_ISSUE_FAILED",
            errors: error?.errors || [],
        };
    }
}

async function syncInventoryForOrderTiming({
                                               orderId,
                                               tenant,
                                               orderStatus,
                                               isInvoiceAction,
                                               userId,
                                               session = null,
                                               returnAuthorization = {},
                                           }) {
    const normalizedStatus = normalizeOrderStatus(orderStatus);

    if (normalizedStatus === "Cancelado") {
        const restored = await restoreInventoryForOrder(orderId, {
            userId: userId || null, session, returnAuthorization,
        });

        return {
            action: "restore",
            result: restored,
        };
    }

    if (
        shouldDeductInventoryNow({
            tenant,
            orderStatus: normalizedStatus,
            isInvoiceAction,
        })
    ) {
        const deducted = await deductInventoryForOrder(orderId, {
            userId: userId || null, session,
        });

        return {
            action: "deduct",
            result: deducted,
        };
    }

    return {
        action: "skip",
        result: null,
    };
}

const updateOrder = async (req, res, next) => {
    console.log("[ORDER UPDATE] body =>", {
        orderId: req.params.id,
        orderStatus: req.body.orderStatus,
        paymentStatus: req.body.paymentStatus,
        paid: req.body.paid,
        isPaid: req.body.isPaid,
    });

    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return next(createHttpError(404, "Invalid id!"));
        }

        // ✅ Unificar tenantId UNA VEZ
        const tenantId = req.tenantId || req.user?.tenantId;
        if (!tenantId) {
            return next(createHttpError(401, "TENANT_NOT_FOUND"));
        }

        const clientId = req.clientId;

        // ✅ Traer settings del tenant al inicio
        const tenant = await Tenant.findOne({ tenantId }).lean();
        if (!tenant) return next(createHttpError(404, "TENANT_NOT_FOUND"));
        // ======================================================
// DGII SOLO REPÚBLICA DOMINICANA
// ======================================================

        const dgiiTenant =
            tenantUsesDgii(
                tenant
            );

        const features =
            tenant?.features ||
            {};

        const taxFeatureEnabled =
            typeof tenant
                ?.taxConfig
                ?.enabled ===
            "boolean"
                ? tenant
                    .taxConfig
                    .enabled
                : features
                    ?.tax
                    ?.enabled !==
                false;
        const discountFeatureEnabled = features?.discount?.enabled !== false; // default true
        const tipFeatureEnabled = features?.tip?.enabled !== false; // default true

        // ✅ fiscalFeatureEnabled viene del tenant.fiscal.enabled
        const fiscalFeatureEnabled =
            dgiiTenant &&
            tenant
                ?.fiscal
                ?.enabled === true;

        // Helper: compatibilidad con docs viejos (sin clientId)
        const orderScope = {
            _id: id,
            tenantId,
            ...(clientId === "default"
                ? { $or: [{ clientId: "default" }, { clientId: { $exists: false } }, { clientId: null }, { clientId: "" }] }
                : { clientId }),
        };

// ✅ Primero buscamos la orden actual.
// IMPORTANTE: current debe existir antes de leer current.items, current.paymentMethod, etc.
        const current = await Order.findOne(orderScope);
        if (!current) return next(createHttpError(404, "Order not found!"));
        await require("../services/orders/tableOrderAccess").assertActiveTableOrder({
            order: current, Table, tenantId, clientId, incoming: req.body || {},
        });
        // Reject a stale write if release/move committed after the initial read.
        const writeOrderScope = { ...orderScope, ...(current.updatedAt ? { updatedAt: current.updatedAt } : {}) };


        // Validar la mesa ANTES de modificar la orden o reservar NCF/e-NCF.
        if (Object.prototype.hasOwnProperty.call(req.body || {}, "table") &&
            req.body.table !== null && req.body.table !== "") {
            const requestedTableId = String(req.body.table?._id || req.body.table);
            if (!mongoose.Types.ObjectId.isValid(requestedTableId))
                return next(createHttpError(400, "INVALID_TABLE_ID"));
            const sameBranchTable = await Table.findOne({
                _id: requestedTableId, tenantId,
                ...(clientId === "default"
                    ? { $or: [{ clientId: "default" }, { clientId: { $exists: false } }, { clientId: null }] }
                    : { clientId }),
            }).select("_id");
            if (!sameBranchTable)
                return next(createHttpError(403, "TABLE_NOT_IN_SELECTED_BRANCH"));
        }

        const incomingItemsForOperation = Array.isArray(req.body?.items)
            ? req.body.items
            : [];

        const currentItemsForOperation = Array.isArray(current.items)
            ? current.items
            : [];

        const shouldHaveOperationNumber =
            incomingItemsForOperation.length > 0 ||
            currentItemsForOperation.length > 0;

        let assignedOperation = null;

        if (!current.operationNumber && shouldHaveOperationNumber) {
            assignedOperation = await allocateOperationSeq({ tenantId });
        }

        const normalizedIncomingPaymentMethod = String(
            req.body?.paymentMethod ?? current?.paymentMethod ?? "Efectivo"
        ).trim();

        const isCreditSale = normalizedIncomingPaymentMethod === "Credito";
        if (
            isCreditSale &&
            !(await canCreateCreditSale(req,tenant))
        ) {
            return next(
                createHttpError(
                    403,
                    "No tienes permiso para realizar nuevas ventas a crédito."
                )
            );
        }
        const ecfProfileForTenant = await TenantEcfProfile.findOne({tenantId}).lean();
        const branchEcfState = await getBranchEcfStatus({tenantId,clientId});
        const ecfEnabledForTenant = branchEcfState.prepared &&
            (!branchEcfState.secondary || ecfProfileForTenant?.environment === "internal_sandbox") &&
            dgiiTenant && tenant.fiscal?.enabled === true &&
            tenant.features?.fiscal?.enabled !== false &&
            getPlanFeatures(normalizePlan(tenant.plan)).fiscal === true &&
            ecfProfileForTenant?.enabled === true;
        const submitAction = String(req.body?.submitAction || "").trim().toLowerCase();

        const requestedStatusRaw = normalizeOrderStatus(
            req.body.orderStatus ?? current.orderStatus
        );

        const {
            chargeMode,
            isInvoiceAction,
            shouldFinalize,
            finalOrderStatus,
        } = getOrderFinalizationDecision({
            tenant,
            submitAction,
            requestedStatus: requestedStatusRaw,
        });

        const incomingExplicitEcfType = String(req.body?.fiscal?.ecfDocumentType || "")
            .trim()
            .toLowerCase()
            .replace(/^e/, "");

        const currentExplicitEcfType = String(current?.fiscal?.ecfDocumentType || "")
            .trim()
            .toLowerCase()
            .replace(/^e/, "");

        const incomingNcfType =
            String(
                req.body
                    ?.fiscal
                    ?.ncfType ||
                ""
            )
                .trim()
                .toUpperCase();


        const hasIncomingDgiiRequest =
            Boolean(
                req.body?.fiscal &&
                (
                    req.body
                        .fiscal
                        .requested ===
                    true ||

                    [
                        "B01",
                        "B02",
                    ].includes(
                        incomingNcfType
                    ) ||

                    [
                        "31",
                        "32",
                    ].includes(
                        incomingExplicitEcfType
                    )
                )
            );


        if (
            !dgiiTenant &&
            hasIncomingDgiiRequest
        ) {
            return next(
                createHttpError(
                    400,
                    "DGII_ONLY_AVAILABLE_FOR_DO"
                )
            );
        }


// Una orden vieja puede conservar datos fiscales,
// pero solamente RD puede generar/reprocesar DGII.
        const fiscalRequested = dgiiTenant && (
            req.body?.fiscal != null
                // Explicit choice for THIS checkout wins over previous draft.
                ? (req.body.fiscal.requested === true || incomingExplicitEcfType === "31")
                : (current?.fiscal?.requested === true || currentExplicitEcfType === "31")
        );

        const selectedEcfType = requestedEcfType(req.body?.fiscal);
        if (req.body?.fiscal?.ecfDocumentType && !selectedEcfType)
            return next(createHttpError(400,"INVALID_ECF_DOCUMENT_TYPE"));
        if (submitAction === "invoice" && selectedEcfType &&
            ecfProfileForTenant?.documentTypes?.[`e${selectedEcfType}`]?.enabled !== true)
            return next(createHttpError(409,`ECF_DOCUMENT_TYPE_NOT_ENABLED_E${selectedEcfType}`));
        if (submitAction === "invoice" && ecfEnabledForTenant && !selectedEcfType)
            return next(createHttpError(400,"ECF_DOCUMENT_TYPE_REQUIRED"));
        if (selectedEcfType && !ecfEnabledForTenant)
            return next(createHttpError(403,"BRANCH_ECF_NOT_ENABLED"));
        // OFF en esta sucursal = NCF legacy (si el contribuyente mantiene rangos NCF
        // habilitados). No bloquear todas las sucursales secundarias por defecto.
        if (fiscalRequested && !selectedEcfType && ecfEnabledForTenant)
            return next(createHttpError(400,"ECF_DOCUMENT_TYPE_REQUIRED"));
        // No generar NCF legacy si el perfil compartido ya opera en producción e-CF.
        if (fiscalRequested && !selectedEcfType &&
            ecfProfileForTenant?.enabled === true &&
            ecfProfileForTenant?.environment === "dgii_production")
            return next(createHttpError(403,"LEGACY_NCF_NOT_ALLOWED_IN_ECF_PRODUCTION"));

        const shouldIssueInternalInvoice = isInvoiceAction || shouldFinalize;
        const prevStatus = current.orderStatus;
        const existingBills = current.bills || {};

        const userRole = String(req.user?.role || "").trim().toLowerCase();
        const isAdminUser = userRole === "admin";

        const currentStatusNormalized = normalizeOrderStatus(current.orderStatus);
        const requestedStatusNormalized = finalOrderStatus;
        const isCancellingOrder =
            requestedStatusNormalized === "Cancelado" &&
            currentStatusNormalized !== "Cancelado";

        if (isCancellingOrder) {
            await assertCanCancelOrder(req, tenantId);
            if(current.inventoryDeducted)await authorizeInventoryReturn(current,{userId:req.user?._id,confirmed:req.body.inventoryReturnConfirmed});
        }

        const isReopeningCancelledOrder =
            currentStatusNormalized === "Cancelado" &&
            requestedStatusNormalized !== "Cancelado";

        if (isReopeningCancelledOrder && !isAdminUser) {
            return next(
                createHttpError(403, "ONLY_ADMIN_CAN_CHANGE_CANCELLED_ORDER_STATUS")
            );
        }

// ---- construir safeUpdate ----
        const fiscalFromClient = req.body.fiscal || null;

        const fiscalSafeFromClient = {};

        if (
            fiscalFromClient &&
            Object.prototype.hasOwnProperty.call(fiscalFromClient, "requested")
        ) {
            fiscalSafeFromClient.requested = fiscalFromClient.requested === true;
        }

        if (
            fiscalFromClient?.ncfType !== undefined &&
            fiscalFromClient?.ncfType !== null &&
            String(fiscalFromClient.ncfType).trim() !== ""
        ) {
            fiscalSafeFromClient.ncfType = String(fiscalFromClient.ncfType).trim().toUpperCase();
        }

        if (
            fiscalFromClient?.ecfDocumentType !== undefined &&
            fiscalFromClient?.ecfDocumentType !== null &&
            String(fiscalFromClient.ecfDocumentType).trim() !== ""
        ) {
            fiscalSafeFromClient.ecfDocumentType = String(fiscalFromClient.ecfDocumentType)
                .trim()
                .toLowerCase()
                .replace(/^e/, "");
        }
        const safeUpdate = {
            customerDetails: {
                ...(current.customerDetails || {}),
                ...(req.body.customerDetails || {}),
            },
            orderNote: req.body.orderNote ?? current.orderNote,
            items: req.body.items ?? current.items,
            table: req.body.table ?? current.table,
            paymentMethod: req.body.paymentMethod ?? current.paymentMethod,
            orderStatus: requestedStatusNormalized,
            bills: { ...existingBills },
            fiscal: {
                ...(current.fiscal || {}),
                ...(fiscalSafeFromClient || {}),
            },
        };
        if (submitAction === "invoice" && !selectedEcfType &&
            !current?.fiscal?.ncfNumber && !current?.ncfNumber) {
            // El cajero apagó el interruptor e-CF para esta factura. No reutilizar
            // la intención e31/e32 de un borrador previo.
            safeUpdate.fiscal.ecfDocumentType = null;
            safeUpdate.fiscal.requested = req.body?.fiscal?.requested === true;
            safeUpdate.fiscal.ncfType = safeUpdate.fiscal.requested
                ? (req.body?.fiscal?.ncfType || "B02") : null;
        }
        // ======================================================
// NORMALIZAR IDENTIDAD FISCAL DEL SNAPSHOT
// ======================================================

        const safeLegacyTaxValue =
            String(
                safeUpdate
                    ?.customerDetails
                    ?.rncCedula ??
                safeUpdate
                    ?.customerDetails
                    ?.rnc ??
                ""
            ).trim();


        const safeTaxIdentity =
            normalizeCustomerTaxIdentity(
                safeUpdate
                    ?.customerDetails
                    ?.taxIdentity,

                safeLegacyTaxValue,

                tenant
                    ?.localization
                    ?.countryCode ||
                "DO"
            );


        const safeDominicanLegacy =
            getDominicanLegacyCustomerTaxValue(
                safeTaxIdentity
            );


        safeUpdate.customerDetails = {
            ...(
                safeUpdate
                    .customerDetails ||
                {}
            ),

            taxIdentity:
            safeTaxIdentity,

            rnc:
            safeDominicanLegacy,

            rncCedula:
            safeDominicanLegacy,
        };
        if (assignedOperation) {
            safeUpdate.operationSeq = assignedOperation.operationSeq;
            safeUpdate.operationNumber = assignedOperation.operationNumber;
        }

        let nextCustomerId = current.customerId || null;

        if (req.body.customerId) {
            if (!mongoose.Types.ObjectId.isValid(req.body.customerId)) {
                return next(createHttpError(400, "INVALID_CUSTOMER_ID"));
            }

            const foundCustomer = await Customer.findOne({
                _id: req.body.customerId,
                tenantId,
                clientId,
                isActive: true,
            }).lean();

            if (!foundCustomer) {
                return next(createHttpError(404, "CUSTOMER_NOT_FOUND"));
            }

            nextCustomerId = foundCustomer._id;

            const storedCustomerTaxIdentity =
                normalizeCustomerTaxIdentity(
                    foundCustomer
                        ?.taxIdentity,

                    "",

                    tenant
                        ?.localization
                        ?.countryCode ||
                    "DO"
                );


            /*
             * Cliente persistente tiene prioridad.
             *
             * Si todavía es un Customer legacy,
             * conservamos el snapshot que ya teníamos.
             */
            const finalCustomerTaxIdentity =
                storedCustomerTaxIdentity ||
                safeUpdate
                    ?.customerDetails
                    ?.taxIdentity ||
                null;


            const finalCustomerLegacyTaxValue =
                getDominicanLegacyCustomerTaxValue(
                    finalCustomerTaxIdentity
                );


            safeUpdate.customerDetails = {
                ...(
                    safeUpdate
                        .customerDetails ||
                    {}
                ),

                name:
                    foundCustomer.name ||
                    safeUpdate
                        .customerDetails
                        ?.name ||
                    "",

                phone:
                    foundCustomer.phone ||
                    safeUpdate
                        .customerDetails
                        ?.phone ||
                    "",

                address:
                    foundCustomer.address ||
                    safeUpdate
                        .customerDetails
                        ?.address ||
                    "",

                taxIdentity:
                finalCustomerTaxIdentity,

                rnc:
                finalCustomerLegacyTaxValue,

                rncCedula:
                finalCustomerLegacyTaxValue,
            };
        }

        if (isCreditSale && !nextCustomerId) {
            return next(createHttpError(400, "CUSTOMER_REQUIRED_FOR_CREDIT_SALE"));
        }

        safeUpdate.customerId = nextCustomerId;
        safeUpdate.paymentMethod = normalizedIncomingPaymentMethod;
        // compat tip
        if (safeUpdate.bills.tipAmount === undefined && safeUpdate.bills.tip !== undefined) {
            safeUpdate.bills.tipAmount = Number(safeUpdate.bills.tip);
        }

        const incomingFiscal = req.body.fiscal;
        // ✅ NCF: si lo pidió y aún no tiene NCF, asignar
        console.log("[ORDER UPDATE][FISCAL DEBUG]", {
            tenantId,
            fiscalFeatureEnabled,
            incomingFiscal: req.body.fiscal,
            currentFiscal: current?.fiscal,
            tenantFiscal: tenant?.fiscal,
        });
        const alreadyHasNCF = current?.fiscal?.ncfNumber || current?.ncfNumber;

        if (!ecfEnabledForTenant && shouldIssueInternalInvoice && fiscalFeatureEnabled && fiscalRequested && !alreadyHasNCF) {
            const requestedType = incomingFiscal?.ncfType || current?.fiscal?.ncfType || "B02";

            const { type, ncfNumber } = await allocateNCF({
                tenantId,
                ncfType: requestedType,
            });

            const { internalSeq, internalNumber } = await allocateInternalSeq({ tenantId });

            const emissionPoint =
                String(tenant?.fiscal?.emissionPoint || "001").trim() || "001";

            const branchName = await getBranchInvoiceName({tenantId,clientId,tenant});

            const expiresAtRaw =
                tenant?.fiscal?.ncfConfig?.[type]?.expiresAt ??
                tenant?.fiscal?.ncfConfig?.[type]?.expirationDate ??
                tenant?.fiscal?.expiresAt ??
                null;

            const expirationDate = normalizeMongoDate(expiresAtRaw);
            const expirationDateISO = expirationDate ? expirationDate.toISOString() : null;

            safeUpdate.ncfNumber = ncfNumber;

            safeUpdate.fiscal = {
                ...(safeUpdate.fiscal || {}),
                requested: true,
                ncfType: type,
                ncfNumber,
                issuedAt: shouldIssueInternalInvoice
                    ? (safeUpdate?.fiscal?.issuedAt || new Date())
                    : safeUpdate?.fiscal?.issuedAt || null,
                expirationDate: expirationDateISO,
                internalSeq,
                internalNumber,
                emissionPoint,
                branchName,
            };

            safeUpdate.invoiceNumber = internalNumber;
            safeUpdate.facturaNo = internalNumber;
        }else if (!ecfEnabledForTenant && shouldIssueInternalInvoice && fiscalFeatureEnabled && fiscalRequested && alreadyHasNCF) {
            // Backfill por si la orden vieja tiene NCF pero le faltan campos
            const existingNcfNumber = String(
                current?.fiscal?.ncfNumber ||
                current?.ncfNumber ||
                safeUpdate?.fiscal?.ncfNumber ||
                ""
            ).trim().toUpperCase();

            const inferredTypeFromNumber =
                existingNcfNumber.startsWith("B01") ? "B01" :
                    existingNcfNumber.startsWith("B02") ? "B02" :
                        null;

            const currentType =
                inferredTypeFromNumber ||
                current?.fiscal?.ncfType ||
                incomingFiscal?.ncfType ||
                "B02";


        const expiresAtRaw =
            tenant?.fiscal?.ncfConfig?.[currentType]?.expiresAt ??
            tenant?.fiscal?.ncfConfig?.[currentType]?.expirationDate ??
            tenant?.fiscal?.expiresAt ??
            null;

        const expirationDate = normalizeMongoDate(expiresAtRaw);
        const expirationDateISO = expirationDate ? expirationDate.toISOString() : null;

            safeUpdate.ncfNumber =
                current?.fiscal?.ncfNumber ||
                current?.ncfNumber ||
                safeUpdate?.fiscal?.ncfNumber ||
                safeUpdate?.ncfNumber ||
                null;

            safeUpdate.fiscal = {
                ...(safeUpdate.fiscal || {}),
                requested: true,
                ncfType: currentType,
                ncfNumber:
                    current?.fiscal?.ncfNumber ||
                    current?.ncfNumber ||
                    safeUpdate?.fiscal?.ncfNumber ||
                    null,
                branchName:
                    safeUpdate.fiscal.branchName ||
                    await getBranchInvoiceName({tenantId,clientId,tenant}),
                emissionPoint:
                    safeUpdate.fiscal.emissionPoint ||
                    String(tenant?.fiscal?.emissionPoint || "001").trim() ||
                    "001",
                expirationDate:
                    safeUpdate.fiscal.expirationDate ||
                    expirationDateISO,
            };

    }
        const alreadyHasInternalInvoice =
            getExistingInternalInvoiceNumber(current) ||
            getExistingInternalInvoiceNumber(safeUpdate);

        if (ecfEnabledForTenant && selectedEcfType) {
            const preservedEcfDocumentType = String(
                incomingFiscal?.ecfDocumentType ||
                safeUpdate?.fiscal?.ecfDocumentType ||
                current?.fiscal?.ecfDocumentType ||
                ""
            )
                .trim()
                .toLowerCase()
                .replace(/^e/, "");

            const preservedNcfType = String(
                incomingFiscal?.ncfType ||
                safeUpdate?.fiscal?.ncfType ||
                current?.fiscal?.ncfType ||
                "B01"
            )
                .trim()
                .toUpperCase();

            const finalEcfDocumentType =
                preservedEcfDocumentType ||
                (preservedNcfType === "B01" ? "31" : "32");

            safeUpdate.fiscal = {
                ...(safeUpdate.fiscal || {}),
                requested: finalEcfDocumentType === "31",
                ncfType: finalEcfDocumentType === "31" ? "B01" : "B02",
                ecfDocumentType: finalEcfDocumentType,
                issuedAt: shouldFinalize
                    ? (safeUpdate?.fiscal?.issuedAt || new Date())
                    : safeUpdate?.fiscal?.issuedAt || null,
            };
        }

        if (!ecfEnabledForTenant && fiscalRequested && !fiscalFeatureEnabled) {
            return next(createHttpError(400, "FISCAL_NOT_ENABLED_FOR_TENANT"));
        }


        // ✅ Normalizar items si vienen del front
        if (req.body.items) {
            safeUpdate.items = await hydrateOrderItems({
                items: req.body.items,
                tenantId,
                clientId,
                currentItems: current.items || [],
            });
        }

        // Draft logic: si tiene al menos 1 item => ya no es borrador
        const finalItems = Array.isArray(safeUpdate.items) ? safeUpdate.items : [];
        safeUpdate.isDraft = finalItems.length === 0;

        // =========================
        // RECALCULO TOTALES
        // =========================
        let subtotal = 0;
        if (Array.isArray(safeUpdate.items)) {
            subtotal = safeUpdate.items.reduce((sum, item) => {
                const line = Number(item.unitPrice || 0) * Number(item.quantity || 1);
                return sum + line;
            }, 0);
        }

        const incomingBills = req.body.bills || {};

        let deliveryFee = Number(incomingBills.deliveryFee ?? safeUpdate.bills.deliveryFee ?? 0);
        deliveryFee = round2(deliveryFee);
        if (deliveryFee < 0) deliveryFee = 0;

        // Descuento
        let discount = 0;
        if (discountFeatureEnabled) {
            discount = Number(incomingBills.discount ?? safeUpdate.bills.discount ?? 0);
            if (discount < 0) discount = 0;
            if (discount > subtotal) discount = subtotal;
        } else {
            discount = 0;
        }

        // Tax enabled
        let taxEnabled;
        if (incomingBills.taxEnabled !== undefined) {
            taxEnabled = Boolean(incomingBills.taxEnabled);
        } else if (existingBills.taxEnabled !== undefined) {
            taxEnabled = Boolean(existingBills.taxEnabled);
        } else if (incomingBills.tax !== undefined) {
            taxEnabled = Number(incomingBills.tax) > 0;
        } else if (existingBills.tax !== undefined) {
            taxEnabled = Number(existingBills.tax) > 0;
        } else {
            taxEnabled = true;
        }

        subtotal = round2(subtotal);
        discount = round2(discount);

        taxEnabled =
            taxFeatureEnabled
                ? taxEnabled
                : false;


// ======================================================
// PROPINA
// ======================================================

        let tipEnabled;

        if (
            incomingBills.tipEnabled !==
            undefined
        ) {
            tipEnabled =
                Boolean(
                    incomingBills.tipEnabled
                );
        } else if (
            safeUpdate.bills.tipEnabled !==
            undefined
        ) {
            tipEnabled =
                Boolean(
                    safeUpdate
                        .bills
                        .tipEnabled
                );
        } else if (
            incomingBills.tipAmount !==
            undefined
        ) {
            tipEnabled =
                Number(
                    incomingBills.tipAmount
                ) > 0;
        } else if (
            incomingBills.tip !==
            undefined
        ) {
            tipEnabled =
                Number(
                    incomingBills.tip
                ) > 0;
        } else if (
            safeUpdate.bills.tipAmount !==
            undefined
        ) {
            tipEnabled =
                Number(
                    safeUpdate
                        .bills
                        .tipAmount
                ) > 0;
        } else if (
            safeUpdate.bills.tip !==
            undefined
        ) {
            tipEnabled =
                Number(
                    safeUpdate
                        .bills
                        .tip
                ) > 0;
        } else {
            tipEnabled =
                tipFeatureEnabled;
        }

        tipEnabled =
            tipFeatureEnabled
                ? tipEnabled
                : false;


// ======================================================
// MONTO DE PROPINA
// ======================================================

        let tip = 0;

        if (tipEnabled) {
            if (
                incomingBills.tipAmount !==
                undefined
            ) {
                tip =
                    Number(
                        incomingBills.tipAmount
                    );
            } else if (
                incomingBills.tip !==
                undefined
            ) {
                tip =
                    Number(
                        incomingBills.tip
                    );
            } else if (
                safeUpdate.bills.tipAmount !==
                undefined
            ) {
                tip =
                    Number(
                        safeUpdate
                            .bills
                            .tipAmount
                    );
            } else if (
                safeUpdate.bills.tip !==
                undefined
            ) {
                tip =
                    Number(
                        safeUpdate
                            .bills
                            .tip
                    );
            }
        }

        tip = round2(tip);

        if (tip < 0) {
            tip = 0;
        }


// ======================================================
// MOTOR DE IMPUESTOS GENÉRICO
// ======================================================
//
// Aquí reemplazamos completamente:
// - taxable
// - effectiveTaxRate
// - TAX_RATE
//
// El servidor calcula ahora cada producto utilizando
// taxId + taxIncludedOverride.
// ======================================================

        const itemsForTaxCalculation =
            Array.isArray(
                safeUpdate.items
            )
                ? safeUpdate.items.map(
                    (item) =>
                        item?.toObject
                            ? item.toObject()
                            : item
                )
                : [];

        const taxResult =
            calculateOrderTaxes({
                tenant,

                items:
                itemsForTaxCalculation,

                discountAmount:
                discount,

                deliveryFee,

                taxesEnabled:
                taxEnabled,
            });
        const serviceChargeResult =
            calculateServiceCharges({
                tenant,
                legalTipEnabled: (incomingBills.legalTipEnabled ?? current.bills?.legalTipEnabled) !== false,
                taxResult,

                orderSource:
                    normalizeSource(
                        req.body
                            ?.orderSource ??
                        current
                            ?.orderSource ??
                        "DINE_IN"
                    ),
            });


// Los items guardados deben ser los que devolvió
// el motor, porque contienen taxSnapshot.
        safeUpdate.items =
            taxResult.items;


// Reutilizamos exactamente los valores
// calculados por el motor.
        subtotal =
            taxResult.subtotal;

        discount =
            taxResult.discount;


// Total de todos los impuestos.
        const tax =
            taxResult.taxTotal;


        const totalBeforeTip =
            round2(
                taxResult
                    .totalBeforeTip +
                serviceChargeResult
                    .addedTotal
            );

        const totalWithTax =
            round2(
                totalBeforeTip +
                tip
            );


// Base utilizada actualmente para
// comisión PedidoYa / UberEats.
//
// No incluye propina.
        const baseBeforeTip =
            taxResult.itemsTotalWithTax;

// =========================
// CANAL / COMISION
// =========================
        const incomingSource =
            req.body.orderSource !== undefined ? normalizeSource(req.body.orderSource) : null;

        const currentSource = normalizeSource(current.orderSource || "DINE_IN");

        let finalSource = currentSource;
        let finalRate = Number(current.commissionRate || 0);

// Si cambió el source, valida contra config del tenant
        if (incomingSource && incomingSource !== currentSource) {
            const { allowed, rate } = getCommissionRateFromTenant(tenant, incomingSource);
            if (!allowed) return next(createHttpError(400, `SOURCE_DISABLED_${incomingSource}`));

            finalSource = incomingSource;
            finalRate = Number(rate || 0);
        }

// Si NO cambió source pero la orden era vieja y no tenía rate, puedes backfill opcional:
        if (!incomingSource && (currentSource === "PEDIDOSYA" || currentSource === "UBEREATS") && !current.commissionRate) {
            const { allowed, rate } = getCommissionRateFromTenant(tenant, currentSource);
            if (allowed) finalRate = Number(rate || 0);
        }

        const { commissionAmount, netTotal } = computeCommission(baseBeforeTip, totalWithTax, finalRate);

        safeUpdate.orderSource = finalSource;
        safeUpdate.commissionRate = round2(finalRate);
        safeUpdate.commissionAmount = commissionAmount;
        safeUpdate.netTotal = netTotal;



        safeUpdate.bills = {
            ...safeUpdate.bills,

            // Compatibilidad
            subtotal,
            serviceChargeTotal:
            serviceChargeResult
                .addedTotal,

            serviceChargeBreakdown:
            serviceChargeResult
                .breakdown,

            total:
            subtotal,

            discount,

            legalTipEnabled: (incomingBills.legalTipEnabled ?? current.bills?.legalTipEnabled) !== false,

            taxEnabled,

            tax,

            // ==========================================
            // MOTOR FISCAL NUEVO
            // ==========================================

            taxEngineVersion:
            taxResult.engineVersion,

            subtotalAfterDiscount:
            taxResult
                .subtotalAfterDiscount,

            netAmount:
            taxResult.netAmount,

            deliveryTaxAmount:
            taxResult
                .deliveryTaxAmount,

            taxBreakdown:
            taxResult
                .taxBreakdown,

            // ==========================================

            tipEnabled,

            tipAmount:
            tip,

            tip,

            deliveryFee,

            totalWithTax,
        };
        // ✅ AUTO-DELETE SOLO SI items: [] fue enviado explícitamente
        const incomingItems = req.body.items;
        const isClearingItems = Array.isArray(incomingItems) && incomingItems.length === 0;
        const deletableStatuses = [
            "En Progreso",
            "Cancelado",
        ];

        const hasFinancialHistory =
            Boolean(
                current.invoiceNumber ||
                current.facturaNo ||
                current.invoicedAt ||
                current.accountReceivableId ||
                current.ncfNumber ||
                current?.fiscal?.ncfNumber ||
                current?.fiscal?.internalNumber ||
                current.paymentStatus === "Pagado" ||
                current.paymentMethod === "Credito"
            );

        if (
            isClearingItems &&
            deletableStatuses.includes(
                current.orderStatus
            ) &&
            !hasFinancialHistory
        ) {
            if (current.inventoryDeducted === true) {
                return next(createHttpError(409, "AUTO_DELETE_REQUIRES_INVENTORY_RESTORE"));
            }
            if (current.table) {
                const tableId = current.table?._id ? current.table._id : current.table;
                await Table.findOneAndUpdate(
                    {
                        _id: tableId,
                        currentOrder: current._id,
                        tenantId,
                        ...(clientId === "default"
                ? { $or: [{ clientId: "default" }, { clientId: { $exists: false } }, { clientId: null }, { clientId: "" }] }
                : { clientId }),
                    },
                    { status: "Disponible", currentOrder: null }
                );
            }

            await Order.deleteOne(writeOrderScope);

            return res.status(200).json({
                success: true,
                autoDeleted: true,
                message: "Order deleted because items were explicitly cleared.",
            });
        }
        const incomingStatus = requestedStatusNormalized;
        const incomingRegisterId = String(
            req.body?.registerId || current.registerId || "MAIN"
        )
            .trim()
            .toUpperCase();

        const shouldMarkPaid = shouldFinalize && !isCreditSale;

        safeUpdate.registerId = incomingRegisterId;

// guardar fecha de facturación si emitió fiscal
        if (shouldIssueInternalInvoice) {
            safeUpdate.invoicedAt = current.invoicedAt || new Date();
        }

// pago automático según el modo del tenant
        if (incomingStatus === "Cancelado") {
            safeUpdate.paymentStatus = "Anulado";
        } else if (isCreditSale) {
            safeUpdate.paymentStatus = "Pendiente";
            safeUpdate.creditStatus =
                current.creditStatus && current.creditStatus !== "none"
                    ? current.creditStatus
                    : "pending";
            safeUpdate.paidAt = null;
            safeUpdate.paidBy = null;
        } else {
            safeUpdate.paymentStatus = shouldMarkPaid
                ? "Pagado"
                : current.paymentStatus || "Pendiente";

            if (!current.accountReceivableId) {
                safeUpdate.creditStatus = "none";
            }
        }

        if (shouldMarkPaid && incomingStatus !== "Cancelado") {
            safeUpdate.paidAt = current.paidAt || new Date();
            safeUpdate.paidBy = req.user?._id || current.paidBy || null;
        }

// ✅ Validar e-CF ANTES de actualizar/cerrar la orden.
// Si falla, no se marca como pagada, no se completa y no se muestra factura.
        try {
            if (submitAction === "invoice" && selectedEcfType) {
                await assertSecondarySandboxIssue({tenantId,clientId});
                const profileValidation = validateEcfProfile(ecfProfileForTenant);
                if (!profileValidation.ok) {
                    const err = createHttpError(409,"ECF_PROFILE_INVALID");
                    err.errors = profileValidation.errors;
                    throw err;
                }
            }
            const currentPlain = current?.toObject ? current.toObject() : current;

            assertEcfCanBeIssuedBeforePersist({
                ecfProfile: ecfProfileForTenant,
                submitAction,
                tenant,
                orderCandidate: {
                    ...currentPlain,
                    ...safeUpdate,
                    customerDetails: safeUpdate.customerDetails || currentPlain.customerDetails,
                    bills: safeUpdate.bills || currentPlain.bills,
                    fiscal: safeUpdate.fiscal || currentPlain.fiscal,
                },
            });
        } catch (error) {
            return next(getEcfHttpError(error));
        }

// ✅ Solo asignar número interno si la validación e-CF pasó.
        if (shouldIssueInternalInvoice && !alreadyHasInternalInvoice) {
            const { internalSeq, internalNumber } = await allocateInternalSeq({ tenantId });

            safeUpdate.fiscal = {
                ...(safeUpdate.fiscal || {}),
                internalSeq,
                internalNumber,
                issuedAt: safeUpdate?.fiscal?.issuedAt || new Date(),
            };

            safeUpdate.invoiceNumber = internalNumber;
            safeUpdate.facturaNo = internalNumber;
        }

// Conservar sucursal de la orden (no la etiqueta global Principal).
        if (shouldIssueInternalInvoice) {
            safeUpdate.fiscal = {...(safeUpdate.fiscal || {}),
                branchName: await getBranchInvoiceName({tenantId,clientId,tenant})};
        }
// CONTROL 4: estado/pago e inventario se confirman en una misma transacción.
        // Sin soporte transaccional o con falta de stock, todo revierte y se envía error.
        // No se recalculan pagos, partidas ni impuestos en cambios de estado pagados.
        const paidStatusOnly = current.paymentStatus === "Pagado" && !isInvoiceAction &&
            Object.keys(req.body || {}).every(key => [
                "orderStatus", "statusHistory", "lastStatusChangeAt", "registerId", "inventoryReturnConfirmed"
            ].includes(key));
        if (paidStatusOnly &&
            Object.prototype.hasOwnProperty.call(req.body || {}, "registerId") &&
            incomingRegisterId !== String(current.registerId || "MAIN").trim().toUpperCase()) {
            return next(createHttpError(409, "PAID_ORDER_REGISTER_CHANGE_REQUIRES_AUDIT"));
        }
        if (paidStatusOnly) {
            const statePatch = { orderStatus: incomingStatus };
            if (incomingStatus === "Cancelado") statePatch.paymentStatus = "Anulado";
            for (const field of Object.keys(safeUpdate)) delete safeUpdate[field];
            Object.assign(safeUpdate, statePatch);
        }
        const mustSyncInventory = incomingStatus === "Cancelado" ||
            shouldDeductInventoryNow({ tenant, orderStatus: incomingStatus, isInvoiceAction });
        if(wasPrepared(current))safeUpdate.inventoryPreparedAt=current.inventoryPreparedAt||new Date();
        await persistOrderWithInventory({
            mongoose, Order, orderScope: writeOrderScope, safeUpdate, mustSyncInventory,
            syncInventory: ({ session, orderId }) => syncInventoryForOrderTiming({
                orderId, tenant, orderStatus: incomingStatus, isInvoiceAction,
                userId: req.user?._id || null, session,
                returnAuthorization: {userId:req.user?._id,confirmed:req.body.inventoryReturnConfirmed},
            }),
        });
        let order = await Order.findOne(orderScope)
            .populate("table", "tableNo status")
            .populate("user", "name email role");
        if (!order) throw createHttpError(500, "ORDER_NOT_FOUND_AFTER_COMMIT");


        // Si antes no tenía items y ahora sí tiene, ocupar la mesa
        const prevCount = Array.isArray(current.items) ? current.items.length : 0;
        const newCount = Array.isArray(order.items) ? order.items.length : 0;

        if (order.table && prevCount === 0 && newCount > 0) {
            const tableId = order.table?._id ? String(order.table._id) : String(order.table);

            await Table.findOneAndUpdate(
                {
                    _id: tableId,
                    currentOrder: current._id,
                    tenantId,
                    ...(clientId === "default"
                ? { $or: [{ clientId: "default" }, { clientId: { $exists: false } }, { clientId: null }, { clientId: "" }] }
                : { clientId }),
                },
                { status: "Ocupada", currentOrder: order._id }
            );
        }

        // ✅ Si se completó => generar PDF (no rompe la respuesta)
        // ✅ Si se completó => descontar inventario (idempotente) + generar PDF
        // ✅ Congelar snapshot de items para reportes (category, unitCost, taxAmount)
        // Orden pagada + cambio de estado no debe alterar importes ni snapshots fiscales.
        if (!paidStatusOnly) try {
            const Dish = require("../models/dish"); // ya lo tienes
            const InventoryCategory = require("../models/inventoryCategoryModel"); // 👈 este es tu model

            const items = Array.isArray(order.items) ? order.items : [];
            const dishIds = items.map((it) => it.dishId).filter(Boolean);

            // 1) Buscar dishes (incluye inventoryCategoryId + recipe)
            const dishes = await Dish.find({ _id: { $in: dishIds } })
                .select("_id category inventoryCategoryId inventoryType isInventoryItem avgCost lastCost recipe productionArea")
                .lean();

            const dishMap = new Map(dishes.map((d) => [String(d._id), d]));

            // 2) Map de inventoryCategoryId -> name (para categoría “oficial”)
            const invCatIds = dishes.map((d) => d.inventoryCategoryId).filter(Boolean);
            const invCats = invCatIds.length
                ? await InventoryCategory.find({
                    _id: { $in: invCatIds },
                    tenantId,
                    ...(clientId === "default"
                ? { $or: [{ clientId: "default" }, { clientId: { $exists: false } }, { clientId: null }, { clientId: "" }] }
                : { clientId }),
                })
                    .select("_id name")
                    .lean()
                : [];

            const invCatMap = new Map(invCats.map((c) => [String(c._id), String(c.name || "").trim()]));

            // 3) Para costear recetas: recolectar ingredientDishIds y buscar sus costos
            const ingredientIds = [];
            for (const d of dishes) {
                if (Array.isArray(d.recipe) && d.recipe.length) {
                    for (const r of d.recipe) {
                        if (r?.ingredientDishId) ingredientIds.push(r.ingredientDishId);
                    }
                }
            }

            const ingredientDishes = ingredientIds.length
                ? await Dish.find({ _id: { $in: ingredientIds } })
                    .select("_id avgCost lastCost unit")
                    .lean()
                : [];

            const ingredientCostMap = new Map(
                ingredientDishes.map((ing) => [
                    String(ing._id),
                    Number(ing.avgCost ?? ing.lastCost ?? 0) || 0,
                ])
            );

            // 4) Impuestos: prorratear con base real = sum(items.price)


            for (const it of items) {
                const d = it.dishId ? dishMap.get(String(it.dishId)) : null;

                it.productionArea = normalizeProductionArea(it.productionArea || d?.productionArea || "kitchen");

                if (!it.lineId) it.lineId = makeLineId();
                if (!Number.isFinite(Number(it.printedQty))) it.printedQty = 0;
                if (!it.note) it.note = "";
                if (!Array.isArray(it.addons)) it.addons = [];
                if (!Array.isArray(it.modifiers)) it.modifiers = [];
                // ✅ Categoría oficial: InventoryCategory.name si existe
                const invCatName = d?.inventoryCategoryId
                    ? invCatMap.get(String(d.inventoryCategoryId))
                    : "";

                it.category =
                    (invCatName && invCatName.trim()) ||
                    (d?.category && String(d.category).trim()) ||
                    it.category ||
                    "Sin categoría";

                // ✅ Costo unitario (unitCost)
                // Regla:
                // - Si es inventario directo => avgCost/lastCost
                // - Si tiene receta => suma( qty * costoIngrediente )
                // - Si no tiene nada => 0
                let unitCost = 0;

                const inventoryType = String(d?.inventoryType || "").trim();
                const hasRecipe =
                    inventoryType === "recipe" ||
                    (Array.isArray(d?.recipe) && d.recipe.length > 0);

                if (inventoryType === "direct" && !hasRecipe) {
                    unitCost = Number(d.avgCost ?? d.lastCost ?? 0) || 0;
                } else if (hasRecipe) {
                    let recipeCost = 0;
                    for (const r of d.recipe) {
                        const ingId = r?.ingredientDishId ? String(r.ingredientDishId) : null;
                        const ingCost = ingId ? (ingredientCostMap.get(ingId) || 0) : 0;
                        const qty = Number(r?.qty || 0);
                        recipeCost += ingCost * qty;
                    }
                    unitCost = Number(recipeCost) || 0;
                } else {
                    // fallback: si el plato tiene avgCost/lastCost, lo usa (aunque sea menú)
                    unitCost = Number(d?.avgCost ?? d?.lastCost ?? 0) || 0;
                }

                it.unitCost = Number(unitCost.toFixed(6)); // precisión por si hay pesos/recetas


// ==========================================
// IMPUESTO
// ==========================================
//
// Ya fue calculado por taxEngine.js.
// NO recalcular ni prorratear aquí.
//
// Solo normalizamos por seguridad.
// ==========================================

                it.taxAmount =
                    round2(
                        Number(
                            it?.taxAmount ??
                            it
                                ?.taxSnapshot
                                ?.amount ??
                            0
                        )
                    );

                // ✅ Presentación fallback
                if (!it.presentation) it.presentation = "Regular";
            }

            await order.save();
        } catch (e) {
            console.error("SNAPSHOT ITEMS ERROR =>", e);
        }


// Inventario ejecutado atómicamente ANTES de los efectos secundarios.
// NO repetir aquí: evita doble descuento y no oculta un fallo con un catch.
// ✅ Solo liberar mesa si la orden fue cancelada.
// Completado NO debe desocupar la mesa automáticamente.
        if (
            incomingStatus === "Cancelado" &&
            current.table
        ) {
            const tableId = current.table?._id ? current.table._id : current.table;

            await Table.findOneAndUpdate(
                {
                    _id: tableId,
                    currentOrder: current._id,
                    tenantId,
                    ...(clientId === "default"
                ? { $or: [{ clientId: "default" }, { clientId: { $exists: false } }, { clientId: null }, { clientId: "" }] }
                : { clientId }),
                },
                { status: "Disponible", currentOrder: null }
            );
        }

        const autoEcfResult = await autoIssueEcfForOrderIfNeeded({
            tenant,
            tenantId,
            clientId,
            order,
            submitAction,
            requestedFiscal: req.body?.fiscal,
            orderStatus: incomingStatus,
        });

        if (autoEcfResult && !autoEcfResult.error) {
            order = order.toObject ? order.toObject() : order;
            order.ecf = {
                exists: true,
                ...autoEcfResult,
            };
        } else if (autoEcfResult?.error) {
            const isInvoiceActionForEcf =
                String(submitAction || "").trim().toLowerCase() === "invoice";

            if (ecfEnabledForTenant && isInvoiceActionForEcf && requestedEcfType(order?.fiscal)) {
                return res.status(409).json({success:false,code:"ECF_ISSUE_REQUIRES_RECOVERY",
                    orderId:String(order._id),message:autoEcfResult.message || "AUTO_ECF_ISSUE_FAILED",
                    details:autoEcfResult.errors || []});
            }

            order = order.toObject ? order.toObject() : order;
            order.ecf = {
                exists: false,
                error: true,
                message: autoEcfResult.message,
                errors: autoEcfResult.errors || [],
            };
        }

        const io = req.app?.get?.("io");
        if (io) {
            const eventClientId = String(order?.clientId || req.clientId || "default");
            const room = `tenant:${tenantId}:branch:${eventClientId}`;

            const tableId =
                order?.table?._id
                    ? String(order.table._id)
                    : order?.table
                        ? String(order.table)
                        : null;

            io.to(room).emit("tenant:orderUpdated", {
                tenantId,
                orderId: String(order._id),
                orderStatus: incomingStatus,
            });

            // clave para que /tables se actualice al marcar Completed/Cancelado (libera mesa)
            io.to(room).emit("tenant:tablesUpdated", {
                tenantId,
                orderId: String(order._id),
                tableId,
                orderStatus: incomingStatus,
            });
        }

        if (isCreditSale && shouldIssueInternalInvoice) {
            try {
                const receivable = await createReceivableForOrder({
                    order,
                    userId: req.user?._id || null,
                });

                const refreshedOrder = await Order.findOne(orderScope)
                    .populate("table", "tableNo status")
                    .populate("user", "name email role");

                order = refreshedOrder || order;
                order = order.toObject ? order.toObject() : order;

                order.accountReceivable = receivable.toObject
                    ? receivable.toObject()
                    : receivable;
            } catch (e) {
                console.error("[CREATE_RECEIVABLE_ON_UPDATE_ORDER_FAILED]", e);
                return next(e);
            }
        }
        return res.status(200).json({
            success: true,
            message: "Order updated successfully",
            data: order,
        });
    } catch (error) {
        console.error("[updateOrder] error:", error);
        const status = Number(error?.statusCode || error?.status);
        if (Number.isInteger(status) && status >= 400 && status < 500) {
            return next(error);
        }
        return next(createHttpError(500, "UPDATE_ORDER_FAILED"));
    }
};
const updatePaymentMethod = async (req, res) => {
    try {
        const { id } = req.params;
        const { paymentMethod } = req.body;

        const allowedPaymentMethods = [
            "Efectivo",
            "Tarjeta",
            "Transferencia",
            "Pedido Ya",
            "Uber Eats",
            "Otros",
            "Credito",
        ];

        if (!allowedPaymentMethods.includes(paymentMethod)) {
            return res.status(400).json({
                success: false,
                message: "INVALID_PAYMENT_METHOD",
            });
        }

        const current = await Order.findOne({
            _id: id,
            tenantId: req.tenantId || req.user?.tenantId,
            ...(req.clientId === "default"
                ? { $or: [{ clientId: "default" }, { clientId: { $exists: false } }, { clientId: null }, { clientId: "" }] }
                : { clientId: req.clientId }),
        });

        if (!current) {
            return res.status(404).json({
                success: false,
                message: "Orden no encontrada",
            });
        }
        const currentMethod =
            String(
                current.paymentMethod || ""
            ).trim();

        if (
            paymentMethod === "Credito" ||
            currentMethod === "Credito" ||
            current.accountReceivableId
        ) {
            return res.status(409).json({
                success: false,
                message:
                    "CREDIT_PAYMENT_METHOD_MUST_USE_ORDER_FINALIZATION_FLOW",
            });
        }

        if (paymentMethod === "Credito" && !current.customerId) {
            return res.status(400).json({
                success: false,
                message: "CUSTOMER_REQUIRED_FOR_CREDIT_SALE",
            });
        }

        current.paymentMethod = paymentMethod;

        if (paymentMethod === "Credito") {
            current.paymentStatus = "Pendiente";
            current.paidAt = null;
            current.paidBy = null;
            current.creditStatus =
                current.creditStatus && current.creditStatus !== "none"
                    ? current.creditStatus
                    : "pending";
        }

        await current.save();

        return res.json({
            success: true,
            data: current,
        });
    } catch (err) {
        console.error("updatePaymentMethod error:", err);
        return res.status(500).json({
            success: false,
            message: "Error interno",
        });
    }
};
// ✅ Reporte tipo “Químicos” pero para restaurante (por categoría/presentación/producto/método)
// ✅ Reporte tipo “Químicos” pero para restaurante (por categoría/presentación/producto/método)

const getSalesByProductReport = async (req, res) => {
    try {
        const tenantId = req.tenantId || req.user?.tenantId;
        const clientId = req.clientId;

        if (!tenantId) {
            return res.status(401).json({
                success: false,
                message: "TENANT_NOT_FOUND",
            });
        }

        const { from, to, paymentMethod, category, presentation, orderSource } = req.query;

        const tenant =
            await Tenant
                .findOne({
                    tenantId,
                })
                .select(
                    "localization.timezone"
                )
                .lean();

        const timezone =
            getTenantTimezone(
                tenant
            );

        const todayYMD =
            getTodayYMDInTimeZone(
                timezone
            );

        const range =
            getUtcRangeForYMDRange(
                from ||
                to ||
                todayYMD,

                to ||
                from ||
                todayYMD,

                timezone
            );

        if (!range) {
            return res
                .status(400)
                .json({
                    success: false,
                    message:
                        "INVALID_DATE_RANGE",
                });
        }

        const {
            start,
            end,
        } = range;



        const rawClientId = String(clientId || "default").trim() || "default";

        const clientScope = rawClientId === "default"
            ? [{ clientId: "default" }, { clientId: { $exists: false } }, { clientId: null }, { clientId: "" }]
            : [{ clientId: rawClientId }];

        const baseOrderFilter = {
            tenantId,
            $and: [{ $or: clientScope }],
            isDraft: { $ne: true },
            orderStatus: { $ne: "Cancelado" },
            "items.0": { $exists: true },
        };

        const legacyPaymentStatusFilter = {
            $or: [
                { paymentStatus: { $exists: false } },
                { paymentStatus: null },
                { paymentStatus: "" },
                { paymentStatus: "Pendiente" },
            ],
        };

        const modernPaid = {
            ...baseOrderFilter,
            paymentStatus: "Pagado",
            paidAt: { $gte: start, $lte: end },
        };
        const modernPaidWithoutPaidAt = {
            ...baseOrderFilter,
            paymentStatus: "Pagado",
            $and: [
                ...(baseOrderFilter.$and || []),
                {
                    $or: [
                        { paidAt: { $exists: false } },
                        { paidAt: null },
                    ],
                },
                {
                    $or: [
                        { invoicedAt: { $gte: start, $lte: end } },
                        { createdAt: { $gte: start, $lte: end } },
                    ],
                },
            ],
        };

        const legacyCompleted = {
            ...baseOrderFilter,
            ...legacyPaymentStatusFilter,
            orderStatus: "Completado",
            createdAt: { $gte: start, $lte: end },
        };

        const legacyFiscal = {
            ...baseOrderFilter,
            ...legacyPaymentStatusFilter,
            "fiscal.requested": true,
            createdAt: { $gte: start, $lte: end },
        };


        const match = {
            $or: [
                modernPaid,
                modernPaidWithoutPaidAt,
                legacyCompleted,
                legacyFiscal,
            ],
        };

        if (paymentMethod) {
            match.$or = match.$or.map((q) => ({
                ...q,
                paymentMethod,
            }));
        }

        if (orderSource) {
            match.$or = match.$or.map((q) => ({
                ...q,
                orderSource,
            }));
        }

        const dishCollection = Dish.collection.name;
        const inventoryCategoryCollection = InventoryCategory.collection.name;
        const categoryFilterValue = String(category || "").trim();

        const itemMatch = {};
        if (presentation) itemMatch["items.presentation"] = presentation;

        const rows = await Order.aggregate([
            { $match: match },

            // IMPORTANTE:
            // Esto debe ir ANTES del $unwind porque $map necesita que items sea un array.
            {
                $addFields: {
                    _itemPrices: {$map:{input:{$ifNull:["$items",[]]},as:"it",in:{$ifNull:["$$it.price",0]}}},
                    _orderItemsSubtotal: {
                        $sum: {
                            $map: {
                                input: {
                                    $cond: [
                                        { $isArray: "$items" },
                                        "$items",
                                        []
                                    ],
                                },
                                as: "it",
                                in: { $ifNull: ["$$it.price", 0] },
                            },
                        },
                    },
                },
            },

            { $unwind: {path:"$items",includeArrayIndex:"_itemIndex"} },

            ...(Object.keys(itemMatch).length ? [{ $match: itemMatch }] : []),
            {
                $addFields: {
                    _dishObjectId: {
                        $cond: [
                            { $eq: [{ $type: "$items.dishId" }, "objectId"] },
                            "$items.dishId",
                            {
                                $convert: {
                                    input: "$items.dishId",
                                    to: "objectId",
                                    onError: null,
                                    onNull: null,
                                },
                            },
                        ],
                    },
                },
            },

            {
                $lookup: {
                    from: dishCollection,
                    let: {
                        did: "$_dishObjectId",
                        itemName: "$items.name",
                        tenant: "$tenantId",
                        cid: "$clientId",
                    },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $eq: ["$tenantId", "$$tenant"] },
                                        {
                                            $or: [
                                                { $eq: ["$clientId", "$$cid"] },
                                                { $eq: ["$clientId", "default"] },
                                                { $eq: [{ $type: "$clientId" }, "missing"] },
                                            ],
                                        },
                                        {
                                            $or: [
                                                {
                                                    $and: [
                                                        { $ne: ["$$did", null] },
                                                        { $eq: ["$_id", "$$did"] },
                                                    ],
                                                },
                                                {
                                                    $and: [
                                                        { $eq: ["$$did", null] },
                                                        { $eq: ["$name", "$$itemName"] },
                                                    ],
                                                },
                                            ],
                                        },
                                    ],
                                },
                            },
                        },
                        { $sort: { isInventoryItem: 1, updatedAt: -1, createdAt: -1 } },
                        { $limit: 1 },
                        { $project: { name: 1, category: 1, inventoryCategoryId: 1 } },
                    ],
                    as: "_dish",
                },
            },

            { $unwind: { path: "$_dish", preserveNullAndEmptyArrays: true } },

            {
                $lookup: {
                    from: inventoryCategoryCollection,
                    localField: "_dish.inventoryCategoryId",
                    foreignField: "_id",
                    as: "_invCat",
                },
            },

            { $unwind: { path: "$_invCat", preserveNullAndEmptyArrays: true } },

            {
                $addFields: {
                    _snapshotCat: { $trim: { input: { $ifNull: ["$items.category", ""] } } },
                    _inventoryCat: { $trim: { input: { $ifNull: ["$_invCat.name", ""] } } },
                    _dishCat: { $trim: { input: { $ifNull: ["$_dish.category", ""] } } },
                },
            },

            {
                $addFields: {
                    _cat: {
                        $switch: {
                            branches: [
                                {
                                    case: {
                                        $and: [
                                            { $ne: ["$_snapshotCat", ""] },
                                            {
                                                $not: [
                                                    {
                                                        $in: [
                                                            "$_snapshotCat",
                                                            [
                                                                "Sin categoría",
                                                                "Sin Categoría",
                                                                "Sin category",
                                                                "Sin Category",
                                                            ],
                                                        ],
                                                    },
                                                ],
                                            },
                                        ],
                                    },
                                    then: "$_snapshotCat",
                                },
                                {
                                    case: { $ne: ["$_inventoryCat", ""] },
                                    then: "$_inventoryCat",
                                },
                                {
                                    case: { $ne: ["$_dishCat", ""] },
                                    then: "$_dishCat",
                                },
                            ],
                            default: "Sin categoría",
                        },
                    },
                    _pres: { $ifNull: ["$items.presentation", "Regular"] },
                    _prod: {
                        $cond: [
                            { $ne: [{ $ifNull: ["$items.name", ""] }, ""] },
                            "$items.name",
                            { $ifNull: ["$_dish.name", "Producto"] },
                        ],
                    },
                    _pay: { $ifNull: ["$paymentMethod", "Desconocido"] },
                    _qty: { $ifNull: ["$items.quantity", 0] },
                    _revenue: { $ifNull: ["$items.price", 0] },
                    _unitCost: { $ifNull: ["$items.unitCost", 0] },
                    _lineRatio: {
                        $cond: [
                            { $gt: ["$_orderItemsSubtotal", 0] },
                            {
                                $divide: [
                                    { $ifNull: ["$items.price", 0] },
                                    "$_orderItemsSubtotal",
                                ],
                            },
                            0,
                        ],
                    },

                },

            },
            {
                $addFields: {

                    // ==========================================
                    // IMPUESTO DEL ITEM
                    // ==========================================
                    //
                    // Orden nueva:
                    // usamos taxAmount aunque sea 0.
                    //
                    // Orden legacy:
                    // mantenemos el prorrateo antiguo.
                    // ==========================================

                    _tax: {
                        $cond: [
                            {
                                $gte: [
                                    {
                                        $ifNull: [
                                            "$bills.taxEngineVersion",
                                            0
                                        ]
                                    },

                                    1
                                ]
                            },

                            {
                                $ifNull: [
                                    "$items.taxAmount",

                                    {
                                        $ifNull: [
                                            "$items.taxSnapshot.amount",
                                            0
                                        ]
                                    }
                                ]
                            },

                            {
                                $multiply: [
                                    {
                                        $ifNull: [
                                            "$bills.tax",
                                            0
                                        ]
                                    },

                                    "$_lineRatio"
                                ]
                            }
                        ]
                    },

                    _tip: allocateCents(serviceChargeAmount),
                    _manualTip: allocateCents(manualTipAmount),

                    _deliveryFeeShare: {
                        $multiply: [
                            {
                                $ifNull: [
                                    "$bills.deliveryFee",
                                    0
                                ]
                            },

                            "$_lineRatio"
                        ]
                    },
                },
            },

            {
                $addFields: {

                    // ==========================================
                    // TOTAL REAL DE LA LÍNEA CON IMPUESTO
                    // ==========================================
                    //
                    // Motor nuevo:
                    // lineTotalWithTax ya sabe si el impuesto
                    // estaba incluido o se agregó encima.
                    //
                    // Orden legacy:
                    // mantenemos price + tax.
                    // ==========================================

                    _lineGrossRevenue: {
                        $cond: [
                            {
                                $gte: [
                                    {
                                        $ifNull: [
                                            "$bills.taxEngineVersion",
                                            0
                                        ]
                                    },
                                    1
                                ]
                            },

                            {
                                $ifNull: [
                                    "$items.lineTotalWithTax",

                                    {
                                        $add: [
                                            "$_revenue",
                                            "$_tax"
                                        ]
                                    }
                                ]
                            },

                            {
                                $add: [
                                    "$_revenue",
                                    "$_tax"
                                ]
                            }
                        ]
                    },
                },
            },
            ...(categoryFilterValue ? [{ $match: { _cat: categoryFilterValue } }] : []),

            {
                $addFields: {
                    _costTotal: { $multiply: ["$_qty", "$_unitCost"] },
                    _grossRevenue: {
                        $add: [
                            "$_lineGrossRevenue",
                            "$_tip",
                            "$_manualTip",
                            "$_deliveryFeeShare",
                        ],
                    },
                },
            },

            {
                $group: {
                    orders: { $addToSet: "$_id" },
                    _id: {
                        category: "$_cat",
                        presentation: "$_pres",
                        product: "$_prod",
                        paymentMethod: "$_pay",
                    },

                    qty: { $sum: "$_qty" },

                    categories: {
                        $addToSet: {
                            $cond: [
                                {
                                    $and: [
                                        { $ne: ["$_cat", null] },
                                        { $ne: ["$_cat", ""] },
                                        { $ne: ["$_cat", "Sin categoría"] },
                                        { $ne: ["$_cat", "Sin Categoría"] },
                                    ],
                                },
                                "$_cat",
                                "$$REMOVE",
                            ],
                        },
                    },
                    revenue: { $sum: "$_revenue" },
                    grossRevenue: { $sum: "$_grossRevenue" },
                    costTotal: { $sum: "$_costTotal" },
                    taxTotal: { $sum: "$_tax" },
                    tipTotal: { $sum: "$_tip" },
                    manualTipTotal: { $sum: "$_manualTip" },
                    deliveryFeeTotal: { $sum: "$_deliveryFeeShare" },
                },
            },

            {
                $addFields: {
                    orderCount: { $size: "$orders" },
                    category: {
                        $ifNull: [
                            { $arrayElemAt: ["$categories", 0] },
                            "Sin categoría",
                        ],
                    },
                },
            },

            {
                $addFields: {
                    unitCost: {
                        $cond: [
                            { $gt: ["$qty", 0] },
                            { $divide: ["$costTotal", "$qty"] },
                            0,
                        ],
                    },
                    unitPrice: {
                        $cond: [
                            { $gt: ["$qty", 0] },
                            { $divide: ["$revenue", "$qty"] },
                            0,
                        ],
                    },
                    profit: { $subtract: ["$revenue", "$costTotal"] },
                },
            },

            {
                $addFields: {
                    costPct: {
                        $cond: [
                            { $gt: ["$revenue", 0] },
                            { $multiply: [{ $divide: ["$costTotal", "$revenue"] }, 100] },
                            0,
                        ],
                    },
                    profitPct: {
                        $cond: [
                            { $gt: ["$revenue", 0] },
                            { $multiply: [{ $divide: ["$profit", "$revenue"] }, 100] },
                            0,
                        ],
                    },
                },
            },

            {
                $project: {
                    _id: 0,
                    category: "$category",
                    presentation: "$_id.presentation",
                    product: "$_id.product",
                    paymentMethod: "$_id.paymentMethod",

                    qty: 1,
                    orderCount: 1,
                    unitCost: { $round: ["$unitCost", 2] },
                    unitPrice: { $round: ["$unitPrice", 2] },
                    revenue: { $round: ["$revenue", 2] },
                    grossRevenue: { $round: ["$grossRevenue", 2] },
                    costTotal: { $round: ["$costTotal", 2] },
                    profit: { $round: ["$profit", 2] },
                    costPct: { $round: ["$costPct", 2] },
                    profitPct: { $round: ["$profitPct", 2] },
                    taxTotal: { $round: ["$taxTotal", 2] },
                    tipTotal: { $round: ["$tipTotal", 2] },
                    manualTipTotal: { $round: ["$manualTipTotal", 2] },
                    deliveryFeeTotal: { $round: ["$deliveryFeeTotal", 2] },
                },
            },

            { $sort: { category: 1, presentation: 1, product: 1, paymentMethod: 1 } },
        ]);

        const [chargeReconciliation={serviceChargeTotal:0,manualTipTotal:0,unallocatedServiceCharge:0,unallocatedManualTip:0}]=await Order.aggregate([
            {$match:match},{$project:{charges:serviceChargeAmount,manual:manualTipAmount,subtotal:{$sum:{$map:{input:{$ifNull:['$items',[]]},as:'it',in:{$ifNull:['$$it.price',0]}}}}}},
            {$group:{_id:null,serviceChargeTotal:{$sum:'$charges'},manualTipTotal:{$sum:'$manual'},unallocatedServiceCharge:{$sum:{$cond:[{$lte:['$subtotal',0]},'$charges',0]}},unallocatedManualTip:{$sum:{$cond:[{$lte:['$subtotal',0]},'$manual',0]}}}}
        ]);
        return res.json({
            success: true,
            data: rows,
            meta: {
                from: start.toISOString(),
                to: end.toISOString(),
                totalRows: rows.length,
                chargeAllocation:"ORIGINAL_ITEM_SUBTOTAL_CUMULATIVE_CENTS",
                chargeReconciliation,
            },
        });
    } catch (err) {
        console.error("getSalesByProductReport error:", {
            message: err?.message,
            stack: err?.stack,
        });
        return res.status(500).json({
            success: false,
            message: "Error interno",
        });
    }
};
const sendOrderToProduction = async (req, res, next) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return next(createHttpError(404, "Invalid id!"));
        }

        const tenantId = req.tenantId || req.user?.tenantId;
        if (!tenantId) {
            return next(createHttpError(401, "TENANT_NOT_FOUND"));
        }

        const clientId = req.clientId;

        const order = await Order.findOne({
            _id: id,
            tenantId,
            ...(clientId === "default"
                ? { $or: [{ clientId: "default" }, { clientId: { $exists: false } }, { clientId: null }, { clientId: "" }] }
                : { clientId }),
        })
            .populate("table", "tableNo name area")
            .populate("user", "name");

        if (!order) {
            return next(createHttpError(404, "Order not found!"));
        }

        const tenant = await Tenant.findOne({ tenantId }).lean();

        const pendingByArea = {};

        for (const item of order.items || []) {
            const quantity = Number(item?.quantity || 0);
            const printedQty = Number(item?.printedQty || 0);
            const pendingQty = Number((quantity - printedQty).toFixed(3));

            if (pendingQty <= 0) continue;

            const area = normalizeProductionArea(item?.productionArea || "kitchen");

            if (!pendingByArea[area]) pendingByArea[area] = [];
            pendingByArea[area].push({
                lineId: item.lineId,
                item,
                pendingQty,
            });
        }

        const areas = Object.keys(pendingByArea);

        if (!areas.length) {
            return res.status(200).json({
                success: true,
                message: "NO_PENDING_ITEMS_FOR_PRODUCTION",
                data: {
                    printed: [],
                    skipped: [],
                },
            });
        }

        const printed = [];
        const skipped = [];

        for (const area of areas) {
            const printer = await findActiveProductionPrinter({
                tenantId,
                clientId,
                category: area,
            });

            if (!printer) {
                skipped.push({
                    area,
                    reason: "PRINTER_NOT_FOUND",
                });
                continue;
            }

            if (printer.mode !== "network") {
                skipped.push({
                    area,
                    reason: "PRINTER_IS_NOT_NETWORK_MODE",
                    printerId: printer._id,
                    alias: printer.alias,
                });
                continue;
            }

            const areaItems = pendingByArea[area] || [];

            const title =
                area === "bar"
                    ? "BAR"
                    : area === "kitchen"
                        ? "COCINA"
                        : "PRODUCCION";

            const text = networkPrintService.buildTicketText({
                businessName: tenant?.business?.name || tenant?.name || "",
                rnc: tenant?.business?.rnc || tenant?.fiscal?.rnc || "",
                address: tenant?.business?.address || "",
                phone: tenant?.business?.phone || "",
                title,
                orderId:
                    order?.operationNumber ||
                    order?._id?.toString()?.slice(-6)?.toUpperCase() ||
                    "N/A",
                mesa:
                    order?.table?.tableNo
                        ? `Mesa ${order.table.tableNo}`
                        : order?.table?.name || "N/A",
                mesero: order?.user?.name || "N/A",
                fecha: new Date().toLocaleString("es-DO"),
                salaArea: order?.table?.area || "N/A",
                orderNote: order?.orderNote || "",
                items: areaItems.map(({ item, pendingQty }) => ({
                    name: item?.name || "Producto",
                    qty: pendingQty,
                    modifiers: buildProductionModifiers(item),
                })),
                showTotals: false,
            });

            const payload = networkPrintService.buildEscPosText(text);

            try {
                const result = await networkPrintService.sendToNetworkPrinter({
                    ip: printer.ip,
                    port: printer.port || 9100,
                    payload,
                });

                for (const { lineId, pendingQty } of areaItems) {
                    const target = (order.items || []).find((it) => String(it.lineId) === String(lineId));
                    if (!target) continue;

                    const nextPrintedQty = Number(target.printedQty || 0) + Number(pendingQty || 0);
                    target.printedQty = Number(nextPrintedQty.toFixed(3));
                    order.inventoryPreparedAt = order.inventoryPreparedAt || new Date();
                }

                printed.push({
                    area,
                    printerId: printer._id,
                    alias: printer.alias,
                    items: areaItems.map(({ item, pendingQty }) => ({
                        lineId: item.lineId,
                        name: item.name,
                        qty: pendingQty,
                    })),
                    result,
                });
            } catch (err) {
                skipped.push({
                    area,
                    reason: err?.message || "NETWORK_PRINT_FAILED",
                    printerId: printer._id,
                    alias: printer.alias,
                    items: areaItems.map(({ item, pendingQty }) => ({
                        lineId: item.lineId,
                        name: item.name,
                        qty: pendingQty,
                    })),
                });
            }
        }

        await order.save();

        return res.status(200).json({
            success: skipped.length === 0,
            message:
                printed.length && skipped.length
                    ? "PRODUCTION_PRINT_PARTIAL"
                    : printed.length
                        ? "PRODUCTION_PRINT_OK"
                        : "PRODUCTION_PRINT_SKIPPED",
            data: {
                printed,
                skipped,
                orderId: order._id,
            },
        });
    } catch (error) {
        console.error("[sendOrderToProduction] error:", error);
        return next(createHttpError(500, "SEND_TO_PRODUCTION_FAILED"));
    }
};



module.exports = {
    addOrder,
    getOrderById,
    getOrderEcfStatus,
    getTenantEcfStatus,
    previewOrderTaxes,
    getOrders,
    updateOrder,
    deleteOrder,
    updatePaymentMethod,
    getSalesByProductReport,
    sendOrderToProduction,
};
