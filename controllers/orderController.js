const createHttpError = require("http-errors");
const mongoose = require("mongoose");
const Order = require("../models/orderModel");
const Table = require("../models/tableModel");
const Tenant = require("../models/tenantModel");
const Dish = require("../models/dish"); // ajusta si el nombre es dishModel.js
const InventoryItem = require("../models/inventoryItemModel");
const InventoryMovement = require("../models/inventoryMovementModel");

// Impuesto por defecto (0.25% para coincidir con tu UI)
const TAX_RATE = Number(process.env.TAX_RATE ?? 0.18);


function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
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




async function deductInventoryForOrder(order, userId) {
    const session = await mongoose.startSession();

    try {
        await session.withTransaction(async () => {
            const freshOrder = await Order.findById(order._id).session(session);
            if (!freshOrder) throw new Error("Orden no encontrada");

            // idempotente
            if (freshOrder.inventoryDeducted) {
                console.log("[INV] order already deducted:", String(freshOrder._id));
                return;
            }

            console.log("[INV] deductInventoryForOrder => order:", String(freshOrder._id));
            console.log("[INV] tenantId:", String(freshOrder.tenantId), "clientId:", String(freshOrder.clientId));
            console.log("[INV] status:", freshOrder.orderStatus, "inventoryDeducted:", freshOrder.inventoryDeducted);

            let deductedCount = 0;

            for (const item of freshOrder.items || []) {
                console.log("[INV] item:", {
                    name: item.name,
                    dishId: item.dishId,
                    qtyType: item.qtyType,
                    weightUnit: item.weightUnit,
                    quantity: item.quantity,
                });

                if (!item.dishId) {
                    console.log(`[INV] WARNING: item "${item.name}" no tiene dishId. Saltando.`);
                    continue;
                }

                const dishQuery = {
                    _id: item.dishId,
                    tenantId: freshOrder.tenantId,
                    $or: [
                        { clientId: freshOrder.clientId },
                        { clientId: { $exists: false } },
                        { clientId: "default" },
                    ],
                };

                const dish = await Dish.findOne(dishQuery).session(session);

                console.log("[INV] dishQuery:", dishQuery);

                if (!dish) {
                    console.log(`[INV] WARNING: Dish no encontrado para item "${item.name}". Saltando.`);
                    continue;
                }

                const dishSellMode = dish.sellMode || "unit";
                const itemQtyType = item.qtyType || "unit";

                // consistencia (no lo rompo, solo aviso)
                if (dishSellMode !== itemQtyType) {
                    console.log(
                        `[INV] WARNING: modo inconsistente para "${dish.name}". Dish=${dishSellMode} vs Order=${itemQtyType}. Saltando.`
                    );
                    continue;
                }

                const factor = Number(item.quantity);
                if (!Number.isFinite(factor) || factor <= 0) {
                    console.log(`[INV] WARNING: cantidad inválida en item "${item.name}". Saltando.`);
                    continue;
                }


                const recipe = Array.isArray(dish.recipe) ? dish.recipe : [];
                console.log("[INV] dish:", dish.name, "sellMode:", dishSellMode, "recipeCount:", recipe.length);

                // 1) Si tiene receta -> descuenta por receta
                if (recipe.length > 0) {
                    for (const r of recipe) {
                        const consume = Number(r.qty) * factor; // qty por unidad o por lb
                        if (!Number.isFinite(consume) || consume <= 0) continue;

                        const invItem = await InventoryItem.findOne({
                            _id: r.inventoryItemId,
                            tenantId: freshOrder.tenantId,
                            clientId: freshOrder.clientId,
                            isArchived: false,
                        }).session(session);

                        if (!invItem) {
                            throw new Error(`Insumo no encontrado para receta de "${dish.name}"`);
                        }

                        const beforeStock = Number(invItem.stockCurrent || 0);
                        const afterStock = beforeStock - Math.abs(consume);

                        console.log(`[INV] recipe deduct -> ${invItem.name}:`, {
                            consume,
                            beforeStock,
                            afterStock,
                        });

                        if (afterStock < 0) {
                            throw new Error(
                                `Stock insuficiente: ${invItem.name}. Necesitas ${consume}, disponible ${beforeStock}`
                            );
                        }

                        invItem.stockCurrent = afterStock;
                        await invItem.save({ session });

                        await InventoryMovement.create(
                            [
                                {
                                    tenantId: freshOrder.tenantId,
                                    clientId: freshOrder.clientId,
                                    itemId: invItem._id,
                                    type: "sale",
                                    qty: Math.abs(consume),
                                    unitCost: null,
                                    note: `Venta: ${dish.name} (Order ${freshOrder._id})`,
                                    beforeStock,
                                    afterStock,
                                    createdBy: userId || null,
                                },
                            ],
                            { session }
                        );

                        deductedCount++;
                    }

                    continue; // ya deduje por receta
                }

                // 2) FALLBACK: no hay receta -> intenta match por nombre de plato == nombre de insumo
                //    Esto permite que "Chuleta" descuente del insumo "Chuleta" sin receta.
                // 2) FALLBACK: no hay receta -> intenta match por nombre (case-insensitive + trim)
//    y compatible con clientId missing/default

                const dishName = (dish.name || "").trim();
                const itemName = (item.name || "").trim(); // por si el item.name viene mejor que dish.name

                const nameRegex = dishName
                    ? new RegExp(`^${escapeRegex(dishName)}$`, "i")
                    : null;

                const itemNameRegex = itemName
                    ? new RegExp(`^${escapeRegex(itemName)}$`, "i")
                    : null;

                const fallbackQuery = {
                    tenantId: freshOrder.tenantId,
                    isArchived: false,
                    $or: [
                        // match por dish.name
                        ...(nameRegex ? [{ name: nameRegex }] : []),

                        // match por item.name (por si el dish.name difiere)
                        ...(itemNameRegex ? [{ name: itemNameRegex }] : []),
                    ],
                    // compat clientId
                    $and: [
                        {
                            $or: [
                                { clientId: freshOrder.clientId },
                                { clientId: { $exists: false } },
                                { clientId: "default" },
                            ],
                        },
                    ],
                };

                console.log("[INV] fallbackQuery:", fallbackQuery);

                const fallbackInv = await InventoryItem.findOne(fallbackQuery).session(session);

                if (!fallbackInv) {
                    console.log(
                        `[INV] NO RECIPE + NO FALLBACK MATCH: Dish "${dish.name}" no tiene receta y no existe insumo con nombre compatible.`
                    );
                    console.log("[INV] DEBUG fallback names:", { dishName, orderItemName, clientId: freshOrder.clientId });

                    continue;
                }


                // consumo: si vendes por unidad -> consume = quantity
                //         si vendes por weight -> consume = quantity (lbs/kg según tu sistema)
                const consume = factor;

                const beforeStock = Number(fallbackInv.stockCurrent || 0);
                const afterStock = beforeStock - Math.abs(consume);

                console.log(`[INV] fallback deduct -> ${fallbackInv.name}:`, {
                    consume,
                    beforeStock,
                    afterStock,
                });

                if (afterStock < 0) {
                    throw new Error(
                        `Stock insuficiente: ${fallbackInv.name}. Necesitas ${consume}, disponible ${beforeStock}`
                    );
                }

                fallbackInv.stockCurrent = afterStock;
                await fallbackInv.save({ session });

                await InventoryMovement.create(
                    [
                        {
                            tenantId: freshOrder.tenantId,
                            clientId: freshOrder.clientId,
                            itemId: fallbackInv._id,
                            type: "sale",
                            qty: Math.abs(consume),
                            unitCost: null,
                            note: `Venta (fallback): ${dish.name} (Order ${freshOrder._id})`,
                            beforeStock,
                            afterStock,
                            createdBy: userId || null,
                        },
                    ],
                    { session }
                );

                deductedCount++;
            }

            // Solo marca como descontado si realmente descontó algo
            if (deductedCount > 0) {
                freshOrder.inventoryDeducted = true;
                freshOrder.inventoryDeductedAt = new Date();
                await freshOrder.save({ session });
                console.log("[INV] inventory deducted OK for order:", String(freshOrder._id), "deductions:", deductedCount);
            } else {
                console.log(
                    "[INV] No deductions applied. Order NOT marked inventoryDeducted. order:",
                    String(freshOrder._id)
                );
            }
        });
    } finally {
        session.endSession();
    }
}



// Normaliza items y calcula price por ítem
function normalizeAndPriceItems(items) {
    if (!Array.isArray(items)) return [];

    return items.map((it) => {
        const dishId = it.dishId || null;

        const name = (it.name || "").toString().trim();
        const qtyType = (it.qtyType || "unit").toString();
        const weightUnit = (it.weightUnit || "lb").toString();

        const quantity = Number(it.quantity);
        const unitPrice = Number(it.unitPrice);

        if (!name) throw new Error("Item sin name");
        if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`Cantidad inválida para ${name}`);
        if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error(`Precio inválido para ${name}`);

        const price = Number((unitPrice * quantity).toFixed(2));

        return {
            dishId,
            name,
            qtyType,
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
            customerDetails = {},
            orderStatus,
            items = [],
            table = null, // ✅ ahora puede ser null
            paymentMethod = "Efectivo",
            discount = 0,
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
            tenantId,
            clientId,
            customerDetails: {
                name: String(customerDetails?.name ?? ""),
                phone: String(customerDetails?.phone ?? ""),
                guests: Number(customerDetails?.guests ?? 0),
            },
            orderStatus: normalizedStatus,
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
                {
                    _id: tableRef,
                    tenantId,
                    $or: [
                        { clientId: req.clientId },
                        { clientId: { $exists: false } },
                        { clientId: "default" },
                    ],
                },
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
            console.log("[FISCAL] expiresAtRaw:", expiresAtRaw);
            console.log("[FISCAL] expirationDate normalized:", expirationDateISO);

            console.log("[FISCAL] assigned =>", {
                tenantId,
                type,
                ncfNumber,
                internalSeq,
                internalNumber,
                emissionPoint,
                branchName,
                expirationDate,
            });
            console.log("[FISCAL] tenant ncfConfig:", tenant?.fiscal?.ncfConfig);

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

        const totalWithTax = round2(taxable + tax + tip);

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

        // ✅ Update
        let order = await Order.findOneAndUpdate(orderScope, safeUpdate, { new: true })
            .populate("table", "tableNo status")
            .populate("user", "name email role");

        const incomingStatus = normalizeOrderStatus(req.body.orderStatus ?? current.orderStatus);

        // ✅ Si se completó => generar PDF (no rompe la respuesta)
        if (incomingStatus === "Completado") {
            try {
                const generateInvoicePDF = require("../utils/generateInvoicePDF");
                const pdfUrl = await generateInvoicePDF(order._id.toString(), tenantId);
                order.invoiceUrl = pdfUrl;

                // (si quieres, puedes dejar esto o quitarlo; ya no lo mostramos como “fecha impresión”)
                order.fiscal = order.fiscal || {};
                order.fiscal.printedAt = new Date();

                await order.save();
            } catch (err) {
                console.error("PDF ERROR =>", err);
            }
        }

        // ✅ Liberar mesa si cancelada/completada
        if (
            (incomingStatus === "Cancelado" || incomingStatus=== "Completado") &&
            current.table
        ) {
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






module.exports = { addOrder, getOrderById, getOrders, updateOrder, deleteOrder };