const createHttpError = require("http-errors");
const mongoose = require("mongoose");
const Order = require("../models/orderModel");
const Table = require("../models/tableModel");
const Tenant = require("../models/tenantModel");
const Dish = require("../models/dish"); // ajusta si el nombre es dishModel.js
// const InventoryItem = require("../models/inventoryItemModel"); // DEPRECATED: Ya no se usa InventoryItem, solo Dish
// const InventoryMovement = require("../models/inventoryMovementModel"); // DEPRECATED
const Customer = require("../models/customerModel");
const { deductInventoryForOrder, restoreInventoryForOrder } = require("../services/inventory/deductInventoryForOrder");
const Printer = require("../models/printerModel");
const networkPrintService = require("../services/networkPrintService");
const Membership = require("../models/membershipModel");



// Impuesto por defecto (0.25% para coincidir con tu UI)
const TAX_RATE = Number(process.env.TAX_RATE ?? 0.18);


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
            $or: [{ clientId }, { clientId: { $exists: false } }, { clientId: "default" }],
        })
            .select("_id productionArea")
            .lean()
        : [];

    const dishAreaMap = new Map(
        dishes.map((d) => [String(d._id), normalizeProductionArea(d.productionArea)])
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

        return {
            ...item,
            lineId: matched?.lineId || item.lineId || makeLineId(),
            productionArea: normalizeProductionArea(
                item.productionArea ||
                matched?.productionArea ||
                dishAreaMap.get(String(item.dishId || "")) ||
                "kitchen"
            ),
            printedQty: Math.max(0, Math.min(prevPrintedQty, quantity)),
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

        const clientId = req.clientId;

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
                $or: [
                    { clientId: req.clientId },
                    { clientId: { $exists: false } },
                    { clientId: "default" },
                ],
            }).select("_id isVirtual virtualType");

            if (!sameTenantTable) {
                return next(createHttpError(403, "TABLE_DOES_NOT_BELONG_TO_TENANT"));
            }
        }

        const tenant = await Tenant.findOne({ tenantId }).lean();
        if (!tenant) return next(createHttpError(404, "TENANT_NOT_FOUND"));

        const features = tenant?.features || {};
        const taxFeatureEnabled = features?.tax?.enabled !== false;
        const tipFeatureEnabled = features?.tip?.enabled !== false;
        const discountFeatureEnabled = features?.discount?.enabled !== false;
        const fiscalFeatureEnabled = tenant?.fiscal?.enabled === true;
        const chargeMode = tenant?.features?.checkout?.chargeMode || "AT_COMPLETE";

        const submitActionNormalized = String(submitAction || "").trim().toLowerCase();
        const isInvoiceAction = submitActionNormalized === "invoice";
        const isCompletionAction = normalizedStatus === "Completado";

        const isFinalizingOrder =
            isInvoiceAction ||
            isCompletionAction ||
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

        const shouldIssueInternalInvoice =
            isInvoiceAction ||
            incomingFiscal?.requested === true ||
            req.body?.markAsPaid === true ||
            req.body?.paid === true ||
            req.body?.isPaid === true ||
            String(req.body?.paymentStatus || "").trim() === "Pagado";

        let assignedInternalInvoice = null;


        const shouldMarkPaidByInvoice =
            chargeMode === "AT_INVOICE" && isInvoiceAction;

        const shouldMarkPaidByCompletion =
            chargeMode === "AT_COMPLETE" && normalizedStatus === "Completado";

        const shouldMarkPaid = shouldMarkPaidByInvoice || shouldMarkPaidByCompletion;

        let fiscalPayload = {
            requested: false,
            ncfType: "B02",
        };

        let topLevelNcfNumber = null;

        if (incomingFiscal?.requested === true) {
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

            const branchName =
                String(tenant?.fiscal?.branchName || "Principal").trim() || "Principal";

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
        const taxable = round2(Math.max(subtotal - discountAmt, 0));
        const effectiveTaxRate = taxEnabled
            ? Number(tenant?.features?.tax?.rate ?? TAX_RATE)
            : 0;
        const tax = round2(taxable * effectiveTaxRate);

        const baseBeforeTip = round2(taxable + tax);
        const totalBeforeTip = round2(baseBeforeTip + deliveryFee);
        const totalWithTax = round2(totalBeforeTip + tip);

        const { commissionAmount, netTotal } = computeCommission(
            baseBeforeTip,
            totalWithTax,
            rate
        );

        // Resolver customer
        let resolvedCustomerId = null;

        let resolvedCustomerDetails = {
            name: String(customerDetails?.name ?? ""),
            phone: String(customerDetails?.phone ?? ""),
            address: String(customerDetails?.address ?? ""),
            guests: Number(customerDetails?.guests ?? 0),
            rnc: String(customerDetails?.rnc ?? customerDetails?.rncCedula ?? ""),
            rncCedula: String(customerDetails?.rncCedula ?? customerDetails?.rnc ?? ""),
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
            resolvedCustomerDetails = {
                name: found.name || "",
                phone: found.phone || "",
                address: found.address || "",
                guests: Number(customerDetails?.guests ?? 0),
                rnc: String(
                    customerDetails?.rnc ??
                    customerDetails?.rncCedula ??
                    found?.rnc ??
                    found?.rncCedula ??
                    ""
                ),
                rncCedula: String(
                    customerDetails?.rncCedula ??
                    customerDetails?.rnc ??
                    found?.rncCedula ??
                    found?.rnc ??
                    ""
                ),
            };
        }
        const registerId = String(req.body?.registerId || "MAIN")
            .trim()
            .toUpperCase();

        const payload = {
            tenantId,
            clientId,
            customerId: resolvedCustomerId,
            customerDetails: resolvedCustomerDetails,
            orderStatus: normalizedStatus,
            isDraft,
            invoiceNumber: assignedInternalInvoice?.internalNumber || null,
            facturaNo: assignedInternalInvoice?.internalNumber || null,


            bills: {
                subtotal,
                total: subtotal,
                discount: discountAmt,
                taxEnabled,
                tax,
                tipEnabled,
                tip,
                tipAmount: tip,
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


            items: normItems,
            paymentMethod,
            registerId,
            paymentStatus: shouldMarkPaid ? "Pagado" : "Pendiente",
            paidAt: shouldMarkPaid ? new Date() : null,
            paidBy: shouldMarkPaid ? (req.user?._id || null) : null,
            invoicedAt: isInvoiceAction || incomingFiscal?.requested === true ? new Date() : null,
            ...(tableRef ? { table: tableRef } : {}),
            ...(req.user?._id ? { user: req.user._id } : {}),
        };

        const order = await Order.create(payload);

// Si la orden se creó con mesa y ya tiene items, marcar mesa ocupada
        if (tableRef && Array.isArray(payload.items) && payload.items.length > 0) {
            const shouldFreeTable =
                normalizedStatus === "Completado" ||
                normalizedStatus === "Cancelado";

            await Table.updateOne(
                {
                    _id: tableRef,
                    tenantId,
                    $or: [
                        { clientId: req.clientId },
                        { clientId: { $exists: false } },
                        { clientId: "default" },
                    ],
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
                orderStatus: normalizedStatus,
                isInvoiceAction,
                userId: req.user?._id || null,
            });

            if (["deduct", "restore"].includes(invResult?.action)) {
                responseOrder = await Order.findById(order._id) || order;
            }
        } catch (e) {
            console.error("INVENTORY SYNC ON ADD ORDER ERROR =>", e);
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

        res.status(200).json({ success: true, data: order });
    } catch (error) {
        next(error);
    }
};

const getOrders = async (req, res, next) => {
    try {
        const tenantId = req.tenantId || req.user?.tenantId;
        const clientId = req.clientId;

        if (!tenantId) {
            return next(createHttpError(401, "TENANT_NOT_FOUND"));
        }

        const includeDrafts = String(req.query.includeDrafts || "") === "1";
        const includeCancelled = String(req.query.includeCancelled || "1") === "1";

        const clientScope = clientId
            ? {
                $or: [
                    { clientId },
                    { clientId: { $exists: false } },
                    { clientId: "default" },
                ],
            }
            : {
                $or: [
                    { clientId: { $exists: false } },
                    { clientId: "default" },
                ],
            };

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

        const orders = await Order.find(query)
            .sort({ createdAt: -1, _id: -1 })
            .populate("table")
            .populate("user", "name email role");

        return res.status(200).json({
            success: true,
            data: orders,
        });
    } catch (error) {
        next(error);
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
        await assertCanCancelOrder(req, req.user.tenantId);

        // Si la orden tiene mesa asignada, liberar la mesa
        if (order.table?._id) {
            await Table.findOneAndUpdate(
                { _id: order.table._id, tenantId: req.user.tenantId, clientId: req.clientId  }, // 🔐
                { status: "Disponible", currentOrder: null }
            );
        }

        if (order.inventoryDeducted === true) {
            try {
                await restoreInventoryForOrder(order._id, {
                    userId: req.user?._id || null,
                });
            } catch (e) {
                console.error("INVENTORY RESTORE BEFORE DELETE ERROR =>", e);
            }
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

    // normal: asignado = next - 1
    // fallback: si el tenant viejo tenía 0, asignado sería 0 (inválido)
    let assigned = next - 1;
    if (!Number.isFinite(assigned) || assigned <= 0) assigned = next;

    if (!Number.isFinite(assigned) || assigned <= 0) {
        const err = new Error("No se pudo asignar secuencia interna.");
        err.statusCode = 500;
        throw err;
    }

    const internalNumber = String(assigned).padStart(8, "0");
    return { internalSeq: assigned, internalNumber };
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

async function syncInventoryForOrderTiming({
                                               orderId,
                                               tenant,
                                               orderStatus,
                                               isInvoiceAction,
                                               userId,
                                           }) {
    const normalizedStatus = normalizeOrderStatus(orderStatus);

    if (normalizedStatus === "Cancelado") {
        const restored = await restoreInventoryForOrder(orderId, {
            userId: userId || null,
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
            userId: userId || null,
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

        const features = tenant?.features || {};
        const taxFeatureEnabled = features?.tax?.enabled !== false; // default true
        const discountFeatureEnabled = features?.discount?.enabled !== false; // default true
        const tipFeatureEnabled = features?.tip?.enabled !== false; // default true

        // ✅ fiscalFeatureEnabled viene del tenant.fiscal.enabled
        const fiscalFeatureEnabled = tenant?.fiscal?.enabled === true;

        // Helper: compatibilidad con docs viejos (sin clientId)
        const orderScope = {
            _id: id,
            tenantId,
            $or: [{ clientId }, { clientId: { $exists: false } }, { clientId: "default" }],
        };

        // ✅ Orden actual primero (evita TDZ errors)
        const current = await Order.findOne(orderScope);
        if (!current) return next(createHttpError(404, "Order not found!"));
        const submitAction = String(req.body?.submitAction || "").trim().toLowerCase();
        const isInvoiceAction = submitAction === "invoice";
        const shouldIssueInternalInvoice =
            isInvoiceAction ||
            req.body?.fiscal?.requested === true ||
            req.body?.markAsPaid === true ||
            req.body?.paid === true ||
            req.body?.isPaid === true ||
            String(req.body?.paymentStatus || "").trim() === "Pagado";

        const prevStatus = current.orderStatus;
        const existingBills = current.bills || {};

        const userRole = String(req.user?.role || "").trim().toLowerCase();
        const isAdminUser = userRole === "admin";

        const currentStatusNormalized = normalizeOrderStatus(current.orderStatus);
        const requestedStatusNormalized = normalizeOrderStatus(
            req.body.orderStatus ?? current.orderStatus
        );
        const isCancellingOrder =
            requestedStatusNormalized === "Cancelado" &&
            currentStatusNormalized !== "Cancelado";

        if (isCancellingOrder) {
            await assertCanCancelOrder(req, tenantId);
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
        const fiscalFromClient = req.body.fiscal || {};
        const fiscalSafeFromClient = {
            requested: fiscalFromClient.requested,
            ncfType: fiscalFromClient.ncfType,
        };
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

        if (fiscalFeatureEnabled && incomingFiscal?.requested === true && !alreadyHasNCF) {
            const requestedType = incomingFiscal.ncfType || current?.fiscal?.ncfType || "B02";

            const { type, ncfNumber } = await allocateNCF({
                tenantId,
                ncfType: requestedType,
            });

            // secuencial interno (empresa/registradora)
            const { internalSeq, internalNumber } = await allocateInternalSeq({ tenantId });

            const emissionPoint = String(tenant?.fiscal?.emissionPoint || "001").trim() || "001";

            const branchName = String(tenant?.fiscal?.branchName || "Principal").trim() || "Principal";


            // ✅ Vence (NCF) (si existe en config)
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
                issuedAt: new Date(),
                expirationDate: expirationDateISO, // <-- para que el front muestre "Vence (NCF)"

                internalSeq,     // numero (1,2,3...)
                internalNumber,  // string "00000001"
                emissionPoint,
                branchName,
            };
            safeUpdate.invoiceNumber = internalNumber;
            safeUpdate.facturaNo = internalNumber;
        } else if (fiscalFeatureEnabled && incomingFiscal?.requested === true && alreadyHasNCF) {
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
                    String(tenant?.fiscal?.branchName || "Principal").trim() ||
                    "Principal",
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
        if (incomingFiscal?.requested === true && !fiscalFeatureEnabled) {
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

        taxEnabled = taxFeatureEnabled ? taxEnabled : false;

        const taxable = round2(Math.max(subtotal - discount, 0));
        const effectiveTaxRate = taxEnabled
            ? Number(tenant?.features?.tax?.rate ?? TAX_RATE)
            : 0;
        const tax = round2(taxable * effectiveTaxRate);

// Tip enabled
        let tipEnabled;
        if (incomingBills.tipEnabled !== undefined) {
            tipEnabled = Boolean(incomingBills.tipEnabled);
        } else if (safeUpdate.bills.tipEnabled !== undefined) {
            tipEnabled = Boolean(safeUpdate.bills.tipEnabled);
        } else if (incomingBills.tipAmount !== undefined) {
            tipEnabled = Number(incomingBills.tipAmount) > 0;
        } else if (incomingBills.tip !== undefined) {
            tipEnabled = Number(incomingBills.tip) > 0;
        } else if (safeUpdate.bills.tipAmount !== undefined) {
            tipEnabled = Number(safeUpdate.bills.tipAmount) > 0;
        } else if (safeUpdate.bills.tip !== undefined) {
            tipEnabled = Number(safeUpdate.bills.tip) > 0;
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
            } else if (safeUpdate.bills.tipAmount !== undefined) {
                tip = Number(safeUpdate.bills.tipAmount);
            } else if (safeUpdate.bills.tip !== undefined) {
                tip = Number(safeUpdate.bills.tip);
            }
        }
        tip = round2(tip);
        if (tip < 0) tip = 0;

        const baseBeforeTip = round2(taxable + tax);
        const totalBeforeTip = round2(baseBeforeTip + deliveryFee);
        const totalWithTax = round2(totalBeforeTip + tip);

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
            subtotal,
            total: subtotal,
            discount,
            taxEnabled,
            tax,
            tipEnabled,
            tipAmount: tip,
            tip,
            deliveryFee,
            totalWithTax,
        };

        // ✅ AUTO-DELETE SOLO SI items: [] fue enviado explícitamente
        const incomingItems = req.body.items;
        const isClearingItems = Array.isArray(incomingItems) && incomingItems.length === 0;
        const deletableStatuses = ["En Progreso", "Cancelado"];

        if (isClearingItems && deletableStatuses.includes(current.orderStatus)) {
            if (current.table) {
                const tableId = current.table?._id ? current.table._id : current.table;
                await Table.findOneAndUpdate(
                    {
                        _id: tableId,
                        tenantId,
                        $or: [{ clientId }, { clientId: { $exists: false } }, { clientId: "default" }],
                    },
                    { status: "Disponible", currentOrder: null }
                );
            }

            await Order.deleteOne(orderScope);

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

        const chargeMode = tenant?.features?.checkout?.chargeMode || "AT_COMPLETE";

        const shouldMarkPaidByInvoice =
            chargeMode === "AT_INVOICE" && isInvoiceAction;

        const shouldMarkPaidByCompletion =
            chargeMode === "AT_COMPLETE" && incomingStatus === "Completado";

        const shouldMarkPaid = shouldMarkPaidByInvoice || shouldMarkPaidByCompletion;


        safeUpdate.registerId = incomingRegisterId;

// guardar fecha de facturación si emitió fiscal
        if (shouldIssueInternalInvoice) {
            safeUpdate.invoicedAt = current.invoicedAt || new Date();
        }

// pago automático según el modo del tenant
        if (incomingStatus === "Cancelado") {
            safeUpdate.paymentStatus = "Anulado";
        } else {
            safeUpdate.paymentStatus = shouldMarkPaid
                ? "Pagado"
                : current.paymentStatus || "Pendiente";
        }

        if (shouldMarkPaid && incomingStatus !== "Cancelado") {
            safeUpdate.paidAt = current.paidAt || new Date();
            safeUpdate.paidBy = req.user?._id || current.paidBy || null;
        }

        // ✅ Update
        let order = await Order.findOneAndUpdate(orderScope, safeUpdate, { new: true })

            .populate("table", "tableNo status")
            .populate("user", "name email role");

        try {
            const invResult = await syncInventoryForOrderTiming({
                orderId: order._id,
                tenant,
                orderStatus: incomingStatus,
                isInvoiceAction,
                userId: req.user?._id || null,
            });

            if (["deduct", "restore"].includes(invResult?.action)) {
                order = await Order.findOne(orderScope)
                    .populate("table", "tableNo status")
                    .populate("user", "name email role") || order;
            }
        } catch (e) {
            console.error("INVENTORY SYNC ERROR =>", e);
        }
        // Si antes no tenía items y ahora sí tiene, ocupar la mesa
        const prevCount = Array.isArray(current.items) ? current.items.length : 0;
        const newCount = Array.isArray(order.items) ? order.items.length : 0;

        if (order.table && prevCount === 0 && newCount > 0) {
            const tableId = order.table?._id ? String(order.table._id) : String(order.table);

            await Table.findOneAndUpdate(
                {
                    _id: tableId,
                    tenantId,
                    $or: [{ clientId }, { clientId: { $exists: false } }, { clientId: "default" }],
                },
                { status: "Ocupada", currentOrder: order._id }
            );
        }

        // ✅ Si se completó => generar PDF (no rompe la respuesta)
        // ✅ Si se completó => descontar inventario (idempotente) + generar PDF
        // ✅ Congelar snapshot de items para reportes (category, unitCost, taxAmount)
        try {
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
                    $or: [{ clientId }, { clientId: { $exists: false } }, { clientId: "default" }],
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
            const taxTotal = Number(order?.bills?.tax || 0);
            const baseTotal = items.reduce((acc, it) => acc + Number(it.price || 0), 0);

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

                // ✅ ITBIS prorrateado (mejor base: suma items.price)
                const line = Number(it.price || 0);
                if (baseTotal > 0 && taxTotal > 0 && line > 0) {
                    it.taxAmount = Number((taxTotal * (line / baseTotal)).toFixed(2));
                } else {
                    it.taxAmount = 0;
                }

                // ✅ Presentación fallback
                if (!it.presentation) it.presentation = "Regular";
            }

            await order.save();
        } catch (e) {
            console.error("SNAPSHOT ITEMS ERROR =>", e);
        }


// ✅ Inventario real según modo del tenant:
// - AT_INVOICE: descuenta al facturar
// - AT_COMPLETE: descuenta al completar
// - Cancelado: restaura si ya había descontado
        try {
            const invResult = await syncInventoryForOrderTiming({
                orderId: order._id,
                tenant,
                orderStatus: incomingStatus,
                isInvoiceAction,
                userId: req.user?._id || null,
            });

            if (["deduct", "restore"].includes(invResult?.action)) {
                order = await Order.findOne(orderScope)
                    .populate("table", "tableNo status")
                    .populate("user", "name email role") || order;
            }
        } catch (e) {
            console.error("INVENTORY SYNC ERROR =>", e);
        }
// ✅ Liberar mesa si cancelada/completada
        if (
            (incomingStatus === "Cancelado" || incomingStatus === "Completado") &&
            current.table
        ) {
            const tableId = current.table?._id ? current.table._id : current.table;

            await Table.findOneAndUpdate(
                {
                    _id: tableId,
                    tenantId,
                    $or: [{ clientId }, { clientId: { $exists: false } }, { clientId: "default" }],
                },
                { status: "Disponible", currentOrder: null }
            );
        }

        // ✅ Manejar cambio/asignación de mesa (libera anterior y ocupa nueva)
        if (req.body.table) {
            const incomingStatusNow = incomingStatus; // ya lo tienes calculado arriba
            const nextTableId = String(req.body.table);

            if (!mongoose.Types.ObjectId.isValid(nextTableId)) {
                return next(createHttpError(400, "INVALID_TABLE_ID"));
            }

            const prevTableId = current.table
                ? (current.table?._id ? String(current.table._id) : String(current.table))
                : null;

            // Si cambió la mesa, libera la anterior
            if (prevTableId && prevTableId !== nextTableId) {
                await Table.findOneAndUpdate(
                    {
                        _id: prevTableId,
                        tenantId,
                        $or: [{ clientId }, { clientId: { $exists: false } }, { clientId: "default" }],
                    },
                    { status: "Disponible", currentOrder: null }
                );
            }
            // Ocupa/Reserva la nueva mesa (según si la orden tiene items)
            if (incomingStatusNow !== "Cancelado" && incomingStatusNow !== "Completado") {
                const nextStatus = safeUpdate.isDraft ? "Reservada" : "Ocupada";

                await Table.findOneAndUpdate(
                    {
                        _id: nextTableId,
                        tenantId,
                        $or: [{ clientId }, { clientId: { $exists: false } }, { clientId: "default" }],
                    },
                    { status: nextStatus, currentOrder: id }
                );
            }

        }


        const io = req.app?.get?.("io");
        if (io) {
            const room = `tenant:${tenantId}`;

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

        return res.status(200).json({
            success: true,
            message: "Order updated successfully",
            data: order,
        });
    } catch (error) {
        console.error("[updateOrder] error:", error);
        return next(createHttpError(500, "UPDATE_ORDER_FAILED"));
    }
};
const updatePaymentMethod = async (req, res) => {
    try {
        const { id } = req.params;
        const { paymentMethod } = req.body;

        if (!paymentMethod) {
            return res.status(400).json({
                success: false,
                message: "paymentMethod es requerido",
            });
        }

        const updated = await Order.findByIdAndUpdate(
            id,
            { $set: { paymentMethod } },
            { new: true }
        );

        if (!updated) {
            return res.status(404).json({
                success: false,
                message: "Orden no encontrada",
            });
        }

        return res.json({
            success: true,
            data: updated,
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

        const now = new Date();

        const start = from
            ? new Date(from)
            : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

        const end = to
            ? new Date(to)
            : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
            return res.status(400).json({
                success: false,
                message: "INVALID_DATE_RANGE",
            });
        }

        const clientScope = clientId
            ? [
                { clientId },
                { clientId: { $exists: false } },
                { clientId: "default" },
            ]
            : [
                { clientId: { $exists: false } },
                { clientId: "default" },
            ];

        const match = {
            tenantId,
            isDraft: { $ne: true },
            orderStatus: { $ne: "Cancelado" },
            "items.0": { $exists: true },

            // ✅ Este reporte debe cuadrar con ventas:
            // solo órdenes pagadas dentro del rango seleccionado.
            paymentStatus: "Pagado",
            paidAt: { $gte: start, $lte: end },

            // ✅ Evita tener dos $or en el mismo objeto.
            $and: [
                { $or: clientScope },
            ],
        };

        if (paymentMethod) match.paymentMethod = paymentMethod;
        if (orderSource) match.orderSource = orderSource;

        const itemMatch = {};
        if (category) itemMatch["items.category"] = category;
        if (presentation) itemMatch["items.presentation"] = presentation;

        const rows = await Order.aggregate([
            { $match: match },
            { $unwind: "$items" },
            ...(Object.keys(itemMatch).length ? [{ $match: itemMatch }] : []),

            {
                $addFields: {
                    _cat: { $ifNull: ["$items.category", "Sin categoría"] },
                    _pres: { $ifNull: ["$items.presentation", "Regular"] },
                    _prod: "$items.name",
                    _pay: { $ifNull: ["$paymentMethod", "Desconocido"] },

                    _qty: { $ifNull: ["$items.quantity", 0] },
                    _revenue: { $ifNull: ["$items.price", 0] },
                    _unitCost: { $ifNull: ["$items.unitCost", 0] },
                    _tax: { $ifNull: ["$items.taxAmount", 0] },
                },
            },
            {
                $addFields: {
                    _costTotal: { $multiply: ["$_qty", "$_unitCost"] },
                },
            },
            {
                $group: {
                    _id: {
                        presentation: "$_pres",
                        product: "$_prod",
                        paymentMethod: "$_pay",
                    },

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

                    qty: { $sum: "$_qty" },
                    revenue: { $sum: "$_revenue" },
                    costTotal: { $sum: "$_costTotal" },
                    taxTotal: { $sum: "$_tax" },
                },
            },
            {
                $addFields: {
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
                    unitCost: { $round: ["$unitCost", 2] },
                    unitPrice: { $round: ["$unitPrice", 2] },
                    revenue: { $round: ["$revenue", 2] },
                    costTotal: { $round: ["$costTotal", 2] },
                    profit: { $round: ["$profit", 2] },
                    costPct: { $round: ["$costPct", 2] },
                    profitPct: { $round: ["$profitPct", 2] },
                    taxTotal: { $round: ["$taxTotal", 2] },
                },
            },
            { $sort: { category: 1, presentation: 1, product: 1, paymentMethod: 1 } },
        ]);

        return res.json({
            success: true,
            data: rows,
            meta: {
                from: start.toISOString(),
                to: end.toISOString(),
                totalRows: rows.length,
            },
        });
    } catch (err) {
        console.error("getSalesByProductReport error:", err);
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
            $or: [{ clientId }, { clientId: { $exists: false } }, { clientId: "default" }],
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
    getOrders,
    updateOrder,
    deleteOrder,
    updatePaymentMethod,
    getSalesByProductReport,
    sendOrderToProduction,
};