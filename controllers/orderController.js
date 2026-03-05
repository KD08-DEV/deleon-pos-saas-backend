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
        if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`Cantidad inválida para ${name}`);
        if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error(`Precio inválido para ${name}`);

        const price = Number((unitPrice * quantity).toFixed(2));
        const presentation = (it.presentation || "Regular").toString().trim();


        console.log("[normalizeAndPriceItems] keys =>", Object.keys(it || {}));
        console.log("[normalizeAndPriceItems] presentation =>", it.presentation);
        return {
            dishId,
            name,
            qtyType,
            presentation,
            weightUnit,
            quantity,
            unitPrice,
            price,
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
            table = null, // ✅ ahora puede ser null
            paymentMethod = "Efectivo",
            discount = 0,
            orderSource,
            orderNote = "",
        } = req.body;
        const normalizedStatus = normalizeOrderStatus(orderStatus);


        customerDetails.name = customerDetails.name || "";

        // ⚠️ Ya no es obligatorio que tenga mesa
        let tableRef = null;

        if (table) {                                   // ✅ solo si realmente se envió una mesa
            if (!mongoose.Types.ObjectId.isValid(table))
                return next(createHttpError(400, "INVALID_TABLE_ID"));

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

        // Canal / comisión (ya con tenant disponible)
        const source = normalizeSource(orderSource);
        const { allowed, rate } = getCommissionRateFromTenant(tenant, source);

        if (!allowed) {
            return next(createHttpError(400, `SOURCE_DISABLED_${source}`));
        }


        // Validar que existan items solo si vienen desde el menú
        const normItems = Array.isArray(items) && items.length
            ? normalizeAndPriceItems(items)
            : [];
        const isDraft = normItems.length === 0;


        if (normItems.length === 0) {
            return next(createHttpError(400, "EMPTY_ORDER_NOT_ALLOWED"));
        }
        const features = tenant?.features || {};

        const incomingBills = req.body?.bills || {};
        let tip = 0;

        if (incomingBills.tipAmount !== undefined) tip = Number(incomingBills.tipAmount);
        else if (incomingBills.tip !== undefined) tip = Number(incomingBills.tip);

        tip = round2(tip);

        // ADD: Envío
        let deliveryFee = 0;
        if (incomingBills.deliveryFee !== undefined) deliveryFee = Number(incomingBills.deliveryFee);
        deliveryFee = round2(deliveryFee);
        if (deliveryFee < 0) deliveryFee = 0;


        // Calcular totales
        const subtotal = round2(normItems.reduce((s, i) => s + i.price, 0));
        let discountAmt = round2(Number(discount) || 0);
        if (discountAmt < 0) discountAmt = 0;
        if (discountAmt > subtotal) discountAmt = subtotal;

        const taxable = round2(subtotal - discountAmt);
        const tax = round2(taxable * TAX_RATE);

        const baseBeforeTip = round2(taxable + tax);

        const totalBeforeTip = round2(baseBeforeTip + deliveryFee);
        // base para comisión (sin tip)
        const totalWithTax = round2(totalBeforeTip + tip);
        const { commissionAmount, netTotal } = computeCommission(baseBeforeTip, totalWithTax, rate);



        // Crear payload base
        // ✅ Resolver customer (cliente final) si viene customerId
        let resolvedCustomerId = null;

        let resolvedCustomerDetails = {
            name: String(customerDetails?.name ?? ""),
            phone: String(customerDetails?.phone ?? ""),
            address: String(customerDetails?.address ?? ""), // ✅ NUEVO
            guests: Number(customerDetails?.guests ?? 0),
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
            };
        }



        const payload = {
            tenantId,
            clientId,
            customerId: resolvedCustomerId,            // ✅ NUEVO (si no hay, queda null)
            customerDetails: resolvedCustomerDetails,  // ✅ NUEVO (snapshot)
            orderStatus: normalizedStatus,
            isDraft,

            bills: {
                subtotal,
                total: subtotal,
                discount: discountAmt,
                tax,
                taxEnabled: true,
                tip,
                tipAmount: tip,


                deliveryFee,

                totalWithTax,
            },
            orderNote: String(orderNote || "").trim(),
            orderSource: source,
            commissionRate: round2(rate),
            commissionAmount,
            netTotal,

            items: normItems,
            paymentMethod,
            ...(tableRef ? { table: tableRef } : {}),
            ...(req.user?._id ? { user: req.user._id } : {}),
        };

        const order = await Order.create(payload);
        // ✅ Si la orden se creó con mesa Y ya tiene items, marcar la mesa como Ocupada y asociar currentOrder
        if (tableRef && Array.isArray(payload.items) && payload.items.length > 0) {
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
                    $set: {
                        status: "Ocupada",
                        currentOrder: order._id,
                    },
                }
            );
        }

        // Solo marcar la mesa si fue enviada
        // Solo marcar la mesa si fue enviada
        // IMPORTANTE:
// Al crear la orden desde click en mesa, NO tocamos la mesa.
// La mesa solo se marca como Reservada/Ocupada cuando se presione "Actualizar orden" (updateOrder).



        return res.status(201).json({ success:true, message:"Order created!", data:order });
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
        const baseQuery = {
            tenantId: req.user.tenantId,
            clientId: req.clientId,
        };

        const includeDrafts = String(req.query.includeDrafts || "") === "1";

        const query = includeDrafts
            ? baseQuery
            : {
                ...baseQuery,
                isDraft: { $ne: true },
                orderStatus: { $ne: "Cancelado" },
                "items.0": { $exists: true }, // extra seguridad: mínimo 1 item
            };

        const orders = await Order.find(query)
            .sort({ createdAt: -1, _id: -1 })
            .populate("table")
            .populate("user", "name email role");


        res.status(200).json({ data: orders });
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

        // Si la orden tiene mesa asignada, liberar la mesa
        if (order.table?._id) {
            await Table.findOneAndUpdate(
                { _id: order.table._id, tenantId: req.user.tenantId, clientId: req.clientId  }, // 🔐
                { status: "Disponible", currentOrder: null }
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

        const prevStatus = current.orderStatus;
        const existingBills = current.bills || {};

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
            orderStatus: normalizeOrderStatus(req.body.orderStatus ?? current.orderStatus),
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
        } else if (fiscalFeatureEnabled && incomingFiscal?.requested === true && alreadyHasNCF) {
        // Backfill por si la orden vieja tiene NCF pero le faltan campos
        const currentType = current?.fiscal?.ncfType || incomingFiscal?.ncfType || "B02";

        const expiresAtRaw =
            tenant?.fiscal?.ncfConfig?.[currentType]?.expiresAt ??
            tenant?.fiscal?.ncfConfig?.[currentType]?.expirationDate ??
            tenant?.fiscal?.expiresAt ??
            null;

        const expirationDate = normalizeMongoDate(expiresAtRaw);
        const expirationDateISO = expirationDate ? expirationDate.toISOString() : null;

        safeUpdate.fiscal = {
            ...(safeUpdate.fiscal || {}),
            requested: true,
            ncfType: currentType,
            // si ya existe, lo conserva; si falta, lo rellena
            branchName: safeUpdate.fiscal.branchName || String(tenant?.fiscal?.branchName || "Principal").trim() || "Principal",
            emissionPoint: safeUpdate.fiscal.emissionPoint || String(tenant?.fiscal?.emissionPoint || "001").trim() || "001",
            expirationDate: safeUpdate.fiscal.expirationDate || expirationDateISO,
        };
    }
    else if (!fiscalFeatureEnabled) {
            safeUpdate.fiscal = {
                ...(safeUpdate.fiscal || {}),
                requested: false,
                ncfNumber: undefined,
                ncfType: undefined,
                issuedAt: undefined,
                expirationDate: undefined,
                internalSeq: undefined,
                internalNumber: undefined,
            };
            safeUpdate.ncfNumber = undefined;
        }


        // ✅ Normalizar items si vienen del front
        if (req.body.items) {
            safeUpdate.items = normalizeAndPriceItems(req.body.items);
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
        const effectiveTaxRate = taxEnabled ? TAX_RATE : 0;
        const tax = round2(taxable * effectiveTaxRate);

        // Tip
        let tip = 0;
        if (incomingBills.tipEnabled === false) {
            tip = 0;
        } else if (incomingBills.tipAmount !== undefined) {
            tip = Number(incomingBills.tipAmount);
        } else if (incomingBills.tip !== undefined) {
            tip = Number(incomingBills.tip);
        } else if (safeUpdate.bills.tipAmount !== undefined) {
            tip = Number(safeUpdate.bills.tipAmount);
        } else if (safeUpdate.bills.tip !== undefined) {
            tip = Number(safeUpdate.bills.tip);
        }
        tip = round2(tip);

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

        // ✅ Update
        let order = await Order.findOneAndUpdate(orderScope, safeUpdate, { new: true })
            .populate("table", "tableNo status")
            .populate("user", "name email role");
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


        const incomingStatus = normalizeOrderStatus(req.body.orderStatus ?? current.orderStatus);

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
                .select("_id category inventoryCategoryId isInventoryItem avgCost lastCost recipe")
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

                const hasRecipe = Array.isArray(d?.recipe) && d.recipe.length > 0;

                if (d?.isInventoryItem === true && !hasRecipe) {
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


// ✅ Inventario real:
// - Al completar => descontar (idempotente por order.inventoryDeducted)
// - Al cancelar => restaurar (si ya se había descontado)
        const allowNegativeStock = Boolean(
            tenant?.features?.inventory?.allowNegativeStock ??
            tenant?.inventory?.allowNegativeStock ??
            false
        );

        if (incomingStatus === "Completado") {
            try {
                await deductInventoryForOrder(order._id, {
                    allowNegativeStock,
                    userId: req.user?._id || null,
                });
            } catch (e) {
                console.error("INVENTORY DEDUCT ERROR =>", e);
            }
        }

        if (incomingStatus === "Cancelado") {
            try {
                await restoreInventoryForOrder(order._id, {
                    userId: req.user?._id || null,
                });
            } catch (e) {
                console.error("INVENTORY RESTORE ERROR =>", e);
            }
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
const getSalesByProductReport = async (req, res) => {
    try {
        const tenantId = req.tenantId || req.user?.tenantId;
        const clientId = req.clientId;

        // query params
        const { from, to, paymentMethod, category, presentation, orderSource } = req.query;

        // rango por createdAt (si no mandan fechas, usa hoy)
        const now = new Date();
        const start = from ? new Date(from) : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        const end = to ? new Date(to) : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

        const match = {
            tenantId,
            $or: [{ clientId }, { clientId: { $exists: false } }, { clientId: "default" }],
            isDraft: { $ne: true },
            orderStatus: { $ne: "Cancelado" },
            "items.0": { $exists: true },
            createdAt: { $gte: start, $lte: end },
        };

        if (paymentMethod) match.paymentMethod = paymentMethod;
        if (orderSource) match.orderSource = orderSource;

        // filtros por item
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
                    _revenue: { $ifNull: ["$items.price", 0] }, // line total
                    _unitCost: { $ifNull: ["$items.unitCost", 0] },
                    _tax: { $ifNull: ["$items.taxAmount", 0] },
                },
            },
            {
                $addFields: {
                    _costTotal: { $multiply: ["$_qty", "$_unitCost"] },
                },
            },

            // agrupar como reporte de químicos
            {
                $group: {
                    _id: { category: "$_cat", presentation: "$_pres", product: "$_prod", paymentMethod: "$_pay" },
                    qty: { $sum: "$_qty" },
                    revenue: { $sum: "$_revenue" },
                    costTotal: { $sum: "$_costTotal" },
                    taxTotal: { $sum: "$_tax" },
                },
            },

            // calcular promedios y %s
            {
                $addFields: {
                    unitCost: { $cond: [{ $gt: ["$qty", 0] }, { $divide: ["$costTotal", "$qty"] }, 0] },
                    unitPrice: { $cond: [{ $gt: ["$qty", 0] }, { $divide: ["$revenue", "$qty"] }, 0] },
                    profit: { $subtract: ["$revenue", "$costTotal"] },
                },
            },
            {
                $addFields: {
                    costPct: { $cond: [{ $gt: ["$revenue", 0] }, { $multiply: [{ $divide: ["$costTotal", "$revenue"] }, 100] }, 0] },
                    profitPct: { $cond: [{ $gt: ["$revenue", 0] }, { $multiply: [{ $divide: ["$profit", "$revenue"] }, 100] }, 0] },
                },
            },

            // salida final
            {
                $project: {
                    _id: 0,
                    category: "$_id.category",
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

        return res.json({ success: true, data: rows });
    } catch (err) {
        console.error("getSalesByProductReport error:", err);
        return res.status(500).json({ success: false, message: "Error interno" });
    }
};





module.exports = { addOrder, getOrderById, getOrders, updateOrder, deleteOrder,updatePaymentMethod, getSalesByProductReport  };