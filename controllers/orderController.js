const createHttpError = require("http-errors");
const { default: mongoose } = require("mongoose");
const Order = require("../models/orderModel");
const Table = require("../models/tableModel");

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
                tenantId: req.tenantId,
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

const updateOrder = async (req, res, next) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return next(createHttpError(404, "Invalid id!"));
        }

        // Obtener orden actual
        let current = await Order.findOne({
            _id: id,
            tenantId: req.user.tenantId,
            clientId: req.clientId
        });

        if (!current) {
            return next(createHttpError(404, "Order not found!"));
        }

        console.log("📦 ORDEN ACTUAL EN DB (ANTES DE UPDATE):");
        console.log("   bills:", current.bills);
        console.log("   tipAmount DB:", current.bills?.tipAmount);
        console.log("   taxEnabled DB:", current.bills?.taxEnabled);
        console.log("   ---------------------------------------------");

        // Partir SIEMPRE de los bills que ya existen en la DB
        const existingBills = current.bills || {};

        // Mezclar de forma segura sin borrar nested objects
        const safeUpdate = {
            customerDetails: {
                ...current.customerDetails,
                ...req.body.customerDetails
            },
            items: req.body.items ?? current.items,
            table: req.body.table ?? current.table,
            paymentMethod: req.body.paymentMethod ?? current.paymentMethod,
            orderStatus: req.body.orderStatus ?? current.orderStatus,
            bills: { ...existingBills }, // <-- muy importante
        };

        // Normalizar tipAmount previo (por compatibilidad con 'tip')
        if (
            safeUpdate.bills.tipAmount === undefined &&
            safeUpdate.bills.tip !== undefined
        ) {
            safeUpdate.bills.tipAmount = Number(safeUpdate.bills.tip);
        }

        // Si vienen items nuevos, normalizarlos y recalcular subtotal
        if (req.body.items) {
            safeUpdate.items = normalizeAndPriceItems(req.body.items);
        }

        // === RECALCULAR SUBTOTAL, DESCUENTO, ITBIS Y TOTAL ===
        let subtotal = 0;

        // 1) Subtotal a partir de los items normalizados
        if (safeUpdate.items && Array.isArray(safeUpdate.items)) {
            subtotal = safeUpdate.items.reduce((sum, item) => {
                const line = Number(item.unitPrice || 0) * Number(item.quantity || 1);
                return sum + line;
            }, 0);
        }

        // 2) Bills que llegan desde el frontend (Bill.jsx o OrderCard.jsx)
        const incomingBills = req.body.bills || {};

        console.log("🔥 FRONTEND BILLS RECIBIDO:");
        console.log("   incomingBills:", incomingBills);
        console.log(
            "   DESDE FRONT: tipAmount=",
            incomingBills.tipAmount,
            " tip=",
            incomingBills.tip,
            " tipEnabled=",
            incomingBills.tipEnabled
        );
        console.log("   DESDE FRONT: taxEnabled=", incomingBills.taxEnabled);
        console.log("   ---------------------------------------------");

        // ---- DESCUENTO ----
        const discount = Number(
            incomingBills.discount ??
            safeUpdate.bills.discount ??
            0
        );

        // ---- ITBIS (taxEnabled verdadero o falso) ----
        let taxEnabled;

        // Caso 1: si el frontend lo envía explícitamente
        if (incomingBills.taxEnabled !== undefined) {
            taxEnabled = Boolean(incomingBills.taxEnabled);
        }
        // Caso 2: si la orden anterior ya tenía un valor guardado
        else if (existingBills.taxEnabled !== undefined) {
            taxEnabled = Boolean(existingBills.taxEnabled);
        }
        // Caso 3: inferir a partir del tax previo
        else if (incomingBills.tax !== undefined) {
            taxEnabled = Number(incomingBills.tax) > 0;
        } else if (existingBills.tax !== undefined) {
            taxEnabled = Number(existingBills.tax) > 0;
        }
        // Caso 4: default seguro
        else {
            taxEnabled = false;
        }

        // Base imponible
        const taxable = Math.max(subtotal - discount, 0);

        // ITBIS
        const effectiveTaxRate = taxEnabled ? TAX_RATE : 0;
        const tax = taxable * effectiveTaxRate;

        console.log("🧮 CÁLCULO ITBIS:");
        console.log("   subtotal:", subtotal);
        console.log("   discount:", discount);
        console.log("   taxable:", taxable);
        console.log("   taxEnabled:", taxEnabled);
        console.log("   effectiveTaxRate:", effectiveTaxRate);
        console.log("   tax CALCULATED:", tax);
        console.log("   ---------------------------------------------");

        // ---- TIP (Propina en monto) ----
        let tip = 0;

        // Caso 1: Si el frontend dice que tipEnabled es false → propina 0
        if (incomingBills.tipEnabled === false) {
            tip = 0;
        }
        // Caso 2: Si el frontend envía tipAmount → usarlo
        else if (incomingBills.tipAmount !== undefined) {
            tip = Number(incomingBills.tipAmount);
        }
        // Caso 3: Si el frontend envía tip → usarlo
        else if (incomingBills.tip !== undefined) {
            tip = Number(incomingBills.tip);
        }
        // Caso 4: Orden existente → mantener propina previa (tipAmount o tip)
        else if (safeUpdate.bills.tipAmount !== undefined) {
            tip = Number(safeUpdate.bills.tipAmount);
        } else if (safeUpdate.bills.tip !== undefined) {
            tip = Number(safeUpdate.bills.tip);
        }

        // Total final
        const totalWithTax = taxable + tax + tip;

        console.log("💰 CÁLCULO PROPINA:");
        console.log("   incoming.tipEnabled:", incomingBills.tipEnabled);
        console.log("   incoming.tipAmount:", incomingBills.tipAmount);
        console.log("   incoming.tip:", incomingBills.tip);
        console.log("   PREV TIP (DB):", safeUpdate.bills.tipAmount);
        console.log("   FINAL TIP TO SAVE:", tip);
        console.log("   ---------------------------------------------");

        console.log("📤 BILLS QUE SE VAN A GUARDAR EN DB:");
        console.log({
            total: subtotal,
            discount,
            taxEnabled,
            tax,
            tipAmount: tip,
            totalWithTax,
        });
        console.log("   ---------------------------------------------");

        // Guardamos bills actualizados (respetando compatibilidad con 'tip')
        safeUpdate.bills = {
            ...safeUpdate.bills,
            total: subtotal,
            discount,
            taxEnabled,
            tax,
            tipAmount: tip,
            tip,
            totalWithTax,
        };

        let order = await Order.findByIdAndUpdate(id, safeUpdate, {
            new: true,
        })
            .populate("table", "tableNo status")
            .populate("user", "name email role");

        console.log("✅ ORDEN GUARDADA EN DB (DESPUÉS DEL UPDATE):");
        console.log("   bills:", order.bills);
        console.log("   tipAmount DB:", order.bills?.tipAmount);
        console.log("   taxEnabled DB:", order.bills?.taxEnabled);
        console.log("   tax DB:", order.bills?.tax);
        console.log("   totalWithTax DB:", order.bills?.totalWithTax);
        console.log("   ---------------------------------------------");

        // -------- AUTO-DELETE SOLO SI items: [] FUE ENVIADO DESDE EL FRONT --------
        const incomingItems = req.body.items;
        const isClearingItems = Array.isArray(incomingItems) && incomingItems.length === 0;
        const deletableStatuses = ["In Progress", "Cancelled"];

        if (isClearingItems && deletableStatuses.includes(current.orderStatus)) {
            console.log(`🗑 Eliminando orden vacía (items explícitamente limpiados): ${current._id}`);

            if (current.table?._id) {
                await Table.findOneAndUpdate(
                    { _id: current.table._id, tenantId: req.user.tenantId, clientId: req.clientId },
                    { status: "Available", currentOrder: null }
                );
            }

            await Order.deleteOne({
                _id: current._id,
                tenantId: req.user.tenantId,
                clientId: req.clientId
            });

            return res.status(200).json({
                success: true,
                autoDeleted: true,
                message: "Order deleted because items were explicitly cleared."
            });
        }

        // Si se completó → generar factura PDF
        if (req.body.orderStatus === "Completed") {
            try {
                console.log("LO QUE ESTOY ENVIANDO AL PDF:", order, "ID:", order._id);
                const { generateInvoicePDF } = require("../utils/generateInvoicePDF");

                const pdf = await generateInvoicePDF(order._id.toString(), req.user.tenantId);
                console.log("[updateOrder] Factura generada OK");
                order.invoiceUrl = pdf.url;
                await order.save();
            } catch (err) {
                console.error("PDF ERROR =>", err);
            }
        }

        // Liberar mesa si se cancela/completa
        if ((req.body.orderStatus === "Cancelled" ||
            req.body.orderStatus === "Completed") && current.table) {

            await Table.findOneAndUpdate(
                { _id: current.table, tenantId: req.user.tenantId, clientId: req.clientId },
                { status: "Available", currentOrder: null }
            );
        }

        // Marcar nueva mesa si se asigna
        if (req.body.table) {
            await Table.findOneAndUpdate(
                { _id: req.body.table, tenantId: req.user.tenantId, clientId: req.clientId },
                { status: "Booked", currentOrder: order._id }
            );
        }

        return res.status(200).json({
            success: true,
            message: "Order updated successfully",
            data: order
        });

    } catch (error) {
        console.error("[updateOrder] error:", error);
        next(createHttpError(500, "UPDATE_ORDER_FAILED"));
    }
};



module.exports = { addOrder, getOrderById, getOrders, updateOrder, deleteOrder };