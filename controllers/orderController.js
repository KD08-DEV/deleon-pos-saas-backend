const createHttpError = require("http-errors");
const { default: mongoose } = require("mongoose");
const Order = require("../models/orderModel");
const Table = require("../models/tableModel");
const Tenant = require("../models/tenantModel");

// Impuesto por defecto (5.25% para coincidir con tu UI)
const TAX_RATE = Number(process.env.TAX_RATE ?? 0.18);

function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}

// Normaliza items y calcula price por ítem
function normalizeAndPriceItems(items = []) {
    return items.map((it) => {
        const pricePerQuantity = Number(
            it.pricePerQuantity ??
            it.unitPrice ??
            it.price ??
            it?.dish?.price ??
            0
        );

        const quantity = Number(it.quantity ?? 1);

        return {
            name: String(it.name ?? it?.dish?.name ?? "Unnamed Dish"),
            quantity,
            unitPrice: pricePerQuantity,
            price: pricePerQuantity * quantity,
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
            customerDetails = {},
            orderStatus = "In Progress",
            items = [],
            table = null, // ✅ ahora puede ser null
            paymentMethod = "Cash",
            discount = 0,
        } = req.body;


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
                    { clientId: req.clientId },             // mesas nuevas
                    { clientId: { $exists: false } },       // mesas viejas sin clientId
                    { clientId: "default" },                // compatibilidad por si acaso
                ],
            }).select("_id");

            if (!sameTenantTable) {
                return next(createHttpError(403, "TABLE_DOES_NOT_BELONG_TO_TENANT"));
            }
        }


        // Validar que existan items solo si vienen desde el menú
        const normItems = Array.isArray(items) && items.length
            ? normalizeAndPriceItems(items)
            : [];
        const tenant = await Tenant.findOne({ tenantId }).lean();
        const features = tenant?.features || {};


        // Calcular totales
        const subtotal = round2(normItems.reduce((s, i) => s + i.price, 0));
        let discountAmt = round2(Number(discount) || 0);
        if (discountAmt < 0) discountAmt = 0;
        if (discountAmt > subtotal) discountAmt = subtotal;

        const taxable = round2(subtotal - discountAmt);
        const tax = round2(taxable * TAX_RATE);
        const totalWithTax = round2(taxable + tax);


        // Crear payload base
        const payload = {
            tenantId: req.tenantId,
            clientId: req.clientId,
            customerDetails: {
                name: String(customerDetails?.name ?? ""),
                phone: String(customerDetails?.phone ?? ""),
                guests: Number(customerDetails?.guests ?? 0),
            },
            orderStatus,
            bills: {
                total: subtotal,
                discount: discountAmt,
                tax,
                totalWithTax,
                // si viene tip desde el front, lo guardamos
                ...(req.body?.bills?.tip !== undefined
                    ? { tip: Number(req.body.bills.tip) }
                    : {}),
            },

            items: normItems,
            paymentMethod,
            ...(tableRef ? { table: tableRef } : {}),          // ✅ solo pones mesa si existe
            ...(req.user?._id ? { user: req.user._id } : {}),
        };

        const order = await Order.create(payload);

        // Solo marcar la mesa si fue enviada
        if (tableRef) {
            await Table.findOneAndUpdate(
                { _id: tableRef, tenantId: req.tenantId, clientId: req.clientId },
                { status: "Booked", currentOrder: order._id }
            );
        }

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
        const orders = await Order.find({ tenantId: req.user.tenantId, clientId: req.clientId  })
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
                { status: "Available", currentOrder: null }
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
    // Formato típico: B02 + 8 dígitos => B0200000001 (11 chars)
    return `${type}${String(seq).padStart(8, "0")}`;
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


const updateOrder = async (req, res, next) => {
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

// ✅ Traer settings/features del tenant ANTES de calcular totales
        const tenant = await Tenant.findOne({ tenantId }).lean();
        const features = tenant?.features || {};

        const taxFeatureEnabled = features?.tax?.enabled !== false;         // default true
        const discountFeatureEnabled = features?.discount?.enabled !== false; // default true
        const fiscalFeatureEnabled = features?.fiscal?.enabled !== false;

        const clientId = req.clientId;

        // Helper: compatibilidad con datos viejos (por si existen docs sin clientId)
        const orderScope = {
            _id: id,
            tenantId,
            $or: [{ clientId }, { clientId: { $exists: false } }, { clientId: "default" }],
        };

        // Obtener orden actual
        let current = await Order.findOne(orderScope);

        if (!current) {
            return next(createHttpError(404, "Order not found!"));
        }

        // Partir SIEMPRE de los bills que ya existen en la DB
        const existingBills = current.bills || {};

        // Mezclar de forma segura sin borrar nested objects
        const safeUpdate = {
            customerDetails: {
                ...current.customerDetails,
                ...(req.body.customerDetails || {}),
            },
            items: req.body.items ?? current.items,
            table: req.body.table ?? current.table,
            paymentMethod: req.body.paymentMethod ?? current.paymentMethod,
            orderStatus: req.body.orderStatus ?? current.orderStatus,
            bills: { ...existingBills },
            fiscal: {
                ...(current.fiscal || {}),
                ...(req.body.fiscal || {}),
            },
        };

        // Normalizar tipAmount previo (por compatibilidad con 'tip')
        if (safeUpdate.bills.tipAmount === undefined && safeUpdate.bills.tip !== undefined) {
            safeUpdate.bills.tipAmount = Number(safeUpdate.bills.tip);
        }

        const incomingFiscal = req.body.fiscal;

        // ✅ NCF: si lo pidió y aún no tiene NCF, asignar
        const alreadyHasNCF = current?.fiscal?.ncfNumber || current?.ncfNumber;

        if (fiscalFeatureEnabled && incomingFiscal?.requested === true && !alreadyHasNCF) {
            const { type, ncfNumber } = await allocateNCF({
                tenantId,
                ncfType: incomingFiscal.ncfType || current?.fiscal?.ncfType || "B02",
            });

            safeUpdate.ncfNumber = ncfNumber;
            safeUpdate.fiscal = {
                ...(safeUpdate.fiscal || {}),
                requested: true,
                ncfType: type,
                ncfNumber,
                issuedAt: new Date(),
            };
        } else if (!fiscalFeatureEnabled) {
            // Si fiscal está apagado, aseguramos que no quede requested true
            safeUpdate.fiscal = {
                ...(safeUpdate.fiscal || {}),
                requested: false,
                ncfNumber: undefined,
                ncfType: undefined,
                issuedAt: undefined,
            };
            safeUpdate.ncfNumber = undefined;
        }


        // Si vienen items nuevos, normalizarlos
        if (req.body.items) {
            safeUpdate.items = normalizeAndPriceItems(req.body.items);
        }

        // === RECALCULAR SUBTOTAL, DESCUENTO, ITBIS Y TOTAL ===
        let subtotal = 0;

        if (safeUpdate.items && Array.isArray(safeUpdate.items)) {
            subtotal = safeUpdate.items.reduce((sum, item) => {
                const line = Number(item.unitPrice || 0) * Number(item.quantity || 1);
                return sum + line;
            }, 0);
        }

        const incomingBills = req.body.bills || {};

        // ---- DESCUENTO ----
        let discount = 0;

        if (discountFeatureEnabled) {
            discount = Number(incomingBills.discount ?? safeUpdate.bills.discount ?? 0);
            if (discount < 0) discount = 0;
            if (discount > subtotal) discount = subtotal;
        } else {
            discount = 0;
        }
        if (discount < 0) discount = 0;
        if (discount > subtotal) discount = subtotal;

        // ---- ITBIS (taxEnabled verdadero o falso) ----
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
            taxEnabled = false;
        }

        taxEnabled = taxFeatureEnabled ? taxEnabled : false;
        const taxable = Math.max(subtotal - discount, 0);
        const effectiveTaxRate = taxEnabled ? TAX_RATE : 0;
        const tax = taxable * effectiveTaxRate;

        // ---- TIP ----
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

        const totalWithTax = taxable + tax + tip;

        // Guardar bills actualizados (respetando compatibilidad con 'tip')
        safeUpdate.bills = {
            ...safeUpdate.bills,
            subtotal,
            total: subtotal,
            discount,
            taxEnabled,
            tax,
            tipAmount: tip,
            tip,
            totalWithTax,
        };

        // ✅ Update seguro multi-tenant
        let order = await Order.findOneAndUpdate(orderScope, safeUpdate, { new: true })
            .populate("table", "tableNo status")
            .populate("user", "name email role");

        // -------- AUTO-DELETE SOLO SI items: [] FUE ENVIADO DESDE EL FRONT --------
        const incomingItems = req.body.items;
        const isClearingItems = Array.isArray(incomingItems) && incomingItems.length === 0;
        const deletableStatuses = ["In Progress", "Cancelled"];

        if (isClearingItems && deletableStatuses.includes(current.orderStatus)) {
            if (current.table?._id || current.table) {
                const tableId = current.table?._id ? current.table._id : current.table;

                await Table.findOneAndUpdate(
                    {
                        _id: tableId,
                        tenantId,
                        $or: [{ clientId }, { clientId: { $exists: false } }, { clientId: "default" }],
                    },
                    { status: "Available", currentOrder: null }
                );
            }

            await Order.deleteOne(orderScope);

            return res.status(200).json({
                success: true,
                autoDeleted: true,
                message: "Order deleted because items were explicitly cleared.",
            });
        }

        // ✅ Si se completó → generar factura PDF
        if (req.body.orderStatus === "Completed") {
            try {
                const { generateInvoicePDF } = require("../utils/generateInvoicePDF");

                const pdf = await generateInvoicePDF(order._id.toString(), tenantId);
                order.invoiceUrl = pdf.url;
                await order.save();
            } catch (err) {
                console.error("PDF ERROR =>", err);
            }
        }

        // ✅ Liberar mesa si se cancela/completa
        if (
            (req.body.orderStatus === "Cancelled" || req.body.orderStatus === "Completed") &&
            current.table
        ) {
            await Table.findOneAndUpdate(
                {
                    _id: current.table,
                    tenantId,
                    $or: [{ clientId }, { clientId: { $exists: false } }, { clientId: "default" }],
                },
                { status: "Available", currentOrder: null }
            );
        }

        // ✅ Marcar nueva mesa si se asigna
        if (req.body.table) {
            await Table.findOneAndUpdate(
                {
                    _id: req.body.table,
                    tenantId,
                    $or: [{ clientId }, { clientId: { $exists: false } }, { clientId: "default" }],
                },
                { status: "Booked", currentOrder: order._id }
            );
        }

        return res.status(200).json({
            success: true,
            message: "Order updated successfully",
            data: order,
        });
    } catch (error) {
        console.error("[updateOrder] error:", error);
        next(createHttpError(500, "UPDATE_ORDER_FAILED"));
    }
};




module.exports = { addOrder, getOrderById, getOrders, updateOrder, deleteOrder };