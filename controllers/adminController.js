const Order = require("../models/orderModel");
const User = require("../models/userModel");
const Payment = require("../models/paymentModel");
const Membership = require("../models/membershipModel");
const Dish = require("../models/dish");
const Table = require("../models/tableModel");
const Tenant = require("../models/tenantModel");
const TIERS = require("../config/planTiers");
const InventoryMovement = require("../models/inventoryMovementModel");
const createHttpError = require("http-errors");
const bcrypt = require("bcrypt");
const TenantSettings = require("../models/tenantSettingsModel");
const path = require("path");
const crypto = require("crypto");
const { supabase } = require("../config/supabaseClient");
const sharp = require("sharp");
const {
    normalizePlan,
    getPlanFeatures,
} = require("../middlewares/requirePlan");


function parseReportBoundary(value, endOfDay = false) {
    const raw = String(value || "").trim();
    if (!raw) return null;

    const tzOffset = process.env.REPORT_TZ_OFFSET || "-04:00";

    // Soporta YYYY-MM-DD y también YYYY-MM-DDT...
    const ymdMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (ymdMatch) {
        const ymd = ymdMatch[1];
        return new Date(`${ymd}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}${tzOffset}`);
    }

    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return null;

    if (endOfDay) d.setHours(23, 59, 59, 999);
    else d.setHours(0, 0, 0, 0);

    return d;
}
function buildLegacyReportFilter({ tenantId, clientId, registerId, startDate, endDate }) {
    const rawClientId = String(clientId || "default").trim() || "default";

    const rawRegister = registerId ? String(registerId).trim().toUpperCase() : "";

    const normalizeReg =
        !rawRegister || rawRegister === "__ALL_REGISTERS__" || rawRegister === "ALL"
            ? ""
            : rawRegister;

    const clientScope = {
        $or: [
            { clientId: rawClientId },
            { clientId: "default" },
            { clientId: { $exists: false } },
            { clientId: null },
            { clientId: "" },
        ],
    };

    let registerScope = {};

    if (normalizeReg) {
        if (normalizeReg === "MAIN" || normalizeReg === "DEFAULT") {
            registerScope = {
                $or: [
                    { registerId: "MAIN" },
                    { registerId: "default" },
                    { registerId: { $exists: false } },
                    { registerId: null },
                    { registerId: "" },
                ],
            };
        } else {
            registerScope = { registerId: normalizeReg };
        }
    }

    const paidDateRange =
        startDate && endDate
            ? { paidAt: { $gte: startDate, $lte: endDate } }
            : {};

    const createdDateRange =
        startDate && endDate
            ? { createdAt: { $gte: startDate, $lte: endDate } }
            : {};

    const paidAtMissing = {
        $or: [
            { paidAt: { $exists: false } },
            { paidAt: null },
            { paidAt: "" },
        ],
    };

    return {
        tenantId,

        ...registerScope,

        $and: [
            clientScope,

            // No traer canceladas/anuladas.
            {
                $or: [
                    { orderStatus: { $exists: false } },
                    { orderStatus: { $nin: ["Cancelado", "Canceled", "Cancelled"] } },
                ],
            },
            {
                $or: [
                    { paymentStatus: { $exists: false } },
                    { paymentStatus: { $ne: "Anulado" } },
                ],
            },

            {
                $or: [
                    /*
                     * Venta pagada moderna con paidAt.
                     * No exigimos orderStatus Completado porque algunas ventas
                     * ya están pagadas/facturadas pero el status queda En Progreso.
                     */
                    {
                        paymentStatus: "Pagado",
                        ...paidDateRange,
                    },

                    /*
                     * Venta pagada sin paidAt, usando createdAt.
                     */
                    {
                        paymentStatus: "Pagado",
                        ...paidAtMissing,
                        ...createdDateRange,
                    },

                    /*
                     * Venta completada legacy.
                     */
                    {
                        orderStatus: "Completado",
                        ...createdDateRange,
                    },

                    /*
                     * Factura fiscal/e-CF emitida o solicitada.
                     */
                    {
                        "fiscal.requested": true,
                        ...createdDateRange,
                    },

                    /*
                     * Órdenes que tienen número de factura interno.
                     */
                    {
                        invoiceNumber: { $exists: true, $nin: [null, ""] },
                        ...createdDateRange,
                    },

                    {
                        facturaNo: { $exists: true, $nin: [null, ""] },
                        ...createdDateRange,
                    },

                    {
                        internalInvoiceNumber: { $exists: true, $nin: [null, ""] },
                        ...createdDateRange,
                    },
                ],
            },
        ],
    };
}
// 🔹 Obtener reportes (ventas filtradas + resumen diario)
exports.getReports = async (req, res) => {
    try {
        const { from, to, method, user, registerId } = req.query;

        const getClientId = (req) => {
            return (
                req.scope?.clientId ||
                req.clientId ||
                req.user?.clientId ||
                req.user?.client?._id ||
                req.headers["x-client-id"] ||
                "default"
            );
        };
        const tenantId = req.user.tenantId;
        const clientId = getClientId(req);

        // ✅ MERMA (waste) por rango de fechas (costo y cantidad)
        const rawClientId = String(clientId || "default").trim() || "default";

        const mermaFilter = {
            tenantId,
            type: "waste",
            $or: [
                { clientId: rawClientId },
                { clientId: "default" },
                { clientId: { $exists: false } },
                { clientId: null },
                { clientId: "" },
            ],
        };

        const startDate = from ? parseReportBoundary(from, false) : null;
        const endDate = to ? parseReportBoundary(to, true) : null;

        if ((from && !startDate) || (to && !endDate)) {
            return res.status(400).json({
                success: false,
                message: "INVALID_REPORT_DATE_RANGE",
                details: { from, to },
            });
        }

        if (startDate && endDate) {
            mermaFilter.createdAt = { $gte: startDate, $lte: endDate };
        }

        const mermaAgg = await InventoryMovement.aggregate([
            { $match: mermaFilter },
            {
                $group: {
                    _id: null,
                    mermaQty: { $sum: "$qty" },
                    mermaCost: { $sum: { $ifNull: ["$costAmount", 0] } },
                },
            },
        ]);

        const mermaQty = Number(mermaAgg?.[0]?.mermaQty || 0);
        const mermaCost = Number(mermaAgg?.[0]?.mermaCost || 0);



        const filter = buildLegacyReportFilter({
            tenantId,
            clientId,
            registerId,
            startDate,
            endDate,
        });

// Crédito NO es venta cobrada.
// Las ventas a crédito viven en Cuentas por Cobrar.
        filter.$and = [
            ...(Array.isArray(filter.$and) ? filter.$and : []),
            {
                $or: [
                    { paymentMethod: { $exists: false } },
                    { paymentMethod: { $ne: "Credito" } },
                ],
            },
        ];

// Filtrar por método de pago.
// Si alguien intenta pedir Crédito aquí, devolvemos vacío,
// porque Crédito no pertenece a ventas cobradas.
        if (method) {
            if (String(method).trim() === "Credito") {
                return res.status(200).json({
                    success: true,
                    count: 0,
                    dailySummary: {
                        totalSales: 0,
                        totalTax: 0,
                        orderCount: 0,
                        totalCommission: 0,
                        totalNet: 0,
                        mermaQty,
                        mermaCost,
                        netSales: 0,
                        avgTicket: 0,
                        cashSales: 0,
                        onlineSales: 0,
                        transferSales: 0,
                    },
                    salesByDate: {},
                    data: [],
                });
            }

            filter.$and.push({ paymentMethod: method });
        }

        // ✅ Buscar por nombre del usuario (match con populate)
        let userIds = [];
        if (user) {
            const matchedUsers = await User.find({
                tenantId: req.user.tenantId,
                name: { $regex: user.trim(), $options: "i" },
            }).select("_id");
            userIds = matchedUsers.map((u) => u._id);
            if (userIds.length > 0) filter.user = { $in: userIds };
            else return res.status(200).json({ success: true, data: [] }); // si no hay coincidencias
        }

        // Buscar órdenes que cumplan con los filtros
        const orders = await Order.find(filter)
            .populate("user", "name role email")
            .populate("table", "tableNumber virtualType type isVirtual name")

            .sort({ paidAt: -1, createdAt: -1 });
        // Calcular totales
        const totalSales = orders.reduce((sum, o) => sum + (Number(o.bills?.totalWithTax) || 0), 0);
        const totalTax = orders.reduce((sum, o) => sum + (Number(o.bills?.tax) || 0), 0);
        const totalCommission = orders.reduce((sum, o) => sum + (Number(o.commissionAmount) || 0), 0);
        const totalNet = orders.reduce((sum, o) => sum + (Number(o.netTotal) || 0), 0);
        const orderCount = orders.length;
        const avgTicket = orderCount > 0 ? totalSales / orderCount : 0;

        // 🔹 Cierre de caja diario (resumen)
        const dailySummary = {
            totalSales,
            totalTax,
            orderCount,
            totalCommission,
            totalNet,
            mermaQty,
            mermaCost,
            netSales: Number((totalSales - mermaCost).toFixed(2)),
            avgTicket: Number(avgTicket.toFixed(2)),
            cashSales: orders
                .filter((o) => o.paymentMethod === "Efectivo")
                .reduce((s, o) => s + (Number(o.bills?.totalWithTax) || 0), 0),

            onlineSales: orders
                .filter((o) => o.paymentMethod === "Tarjeta")
                .reduce((s, o) => s + (Number(o.bills?.totalWithTax) || 0), 0),

            transferSales: orders
                .filter((o) => o.paymentMethod === "Transferencia")
                .reduce((s, o) => s + (Number(o.bills?.totalWithTax) || 0), 0),
        };

        // 🔹 También agrupar por fecha (para gráficas)
        const groupedByDate = {};
        orders.forEach((o) => {
            const refDate = o.paidAt || o.createdAt;
            const date = new Date(refDate).toISOString().split("T")[0];
            if (!groupedByDate[date]) groupedByDate[date] = 0;
            groupedByDate[date] += Number(o.bills?.totalWithTax) || 0;
        });

        res.status(200).json({
            success: true,
            count: orderCount,
            dailySummary,


            salesByDate: groupedByDate, // { '2025-10-27': 512, '2025-10-26': 430, ... }
            data: orders,
        });
    } catch (error) {
        console.error("❌ Error al obtener reportes:", error);
        res
            .status(500)
            .json({ success: false, message: "Error al obtener reportes", error });
    }

};

// 🔹 Obtener todos los empleados (sin incluir al admin)
exports.getEmployees = async (req, res) => {
    try {
        const tenantId = req.user.tenantId;

        const employees = await User.find({ tenantId })
            .select("_id name email phone role")
            .lean();

        const memberships = await Membership.find({
            tenantId,
            user: { $in: employees.map((e) => e._id) },
            status: "active",
        })
            .select("user role clientIds permissions status")
            .lean();

        const membershipByUserId = new Map(
            memberships.map((m) => [String(m.user), m])
        );

        const data = employees.map((employee) => {
            const membership = membershipByUserId.get(String(employee._id));

            return {
                ...employee,
                membershipRole: membership?.role || employee.role,
                clientIds: membership?.clientIds || [],
                permissions: normalizePermissions(membership?.permissions || DEFAULT_PERMISSIONS),
            };
        });

        res.status(200).json({
            success: true,
            data,
        });
    } catch (error) {
        console.error("❌ Error al obtener empleados:", error);
        res.status(500).json({
            success: false,
            message: "Error al obtener empleados",
        });
    }
};

// 🔹 Obtener todos los usuarios (incluye admin)
exports.getUsers = async (req, res) => {
    try {
        const users = await User.find({ tenantId: req.user.tenantId })
            .select("name email phone role");
        res.status(200).json({ success:true, data:users });
    } catch (error) {
        console.error("❌ Error al obtener usuarios:", error);
        res
            .status(500)
            .json({ success: false, message: "Error al obtener usuarios" });
    }
};

// 🔹 Actualizar empleado
exports.updateEmployee = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, email, phone, role, password, permissions } = req.body;


        // Verificar que el empleado existe y pertenece al mismo tenant
        const employee = await User.findOne({ _id: id, tenantId: req.user.tenantId });
        
        if (!employee) {
            return res.status(404).json({ success: false, message: "Empleado no encontrado" });
        }

        // No permitir editar al Admin principal (puedes ajustar esta lógica)
        // Si quieres permitir editar admin, puedes remover esta validación
        if (employee.role === "Admin" && role && role !== "Admin") {
            return res.status(400).json({
                success: false,
                message: "No se puede cambiar el rol del administrador principal",
            });
        }

// Guardar rol anterior antes de modificar nada
        const previousRole = employee.role;

// Preparar campos a actualizar
        const updateData = {};
        if (name && name.trim()) updateData.name = name.trim();

        if (email && email.trim()) {
            const normalizedEmail = email.trim().toLowerCase();

            // Verificar que el email no esté en uso por otro usuario del mismo tenant
            const existingUser = await User.findOne({
                tenantId: req.user.tenantId,
                email: normalizedEmail,
                _id: { $ne: id }
            });

            if (existingUser) {
                return res.status(400).json({
                    success: false,
                    message: "El email ya está en uso por otro empleado"
                });
            }

            updateData.email = normalizedEmail;
        }

        if (phone) {
            const phoneNum = Number(phone);
            if (isNaN(phoneNum) || phoneNum.toString().length !== 10) {
                return res.status(400).json({
                    success: false,
                    message: "El teléfono debe ser un número de 10 dígitos"
                });
            }
            updateData.phone = phoneNum;
        }

        if (role && ["Admin", "Camarero", "Cajera", "Cocina"].includes(role)) {
            updateData.role = role;
        }

// ✅ Enforce plan limits on role change
        if (role && role !== previousRole) {
            const tenantId = req.user.tenantId;

            const tenant = await Tenant.findOne({ tenantId }).select("plan");
            const tier = TIERS[tenant?.plan] || TIERS.emprendedor;
            const limits = tier.limits || {};

            // Excluir al usuario que estás editando del conteo
            const base = { tenantId, status: "active", user: { $ne: employee._id } };

            const isUnlimited = (v) => v === null || v === undefined;

            if (role === "Admin") {
                const adminsCount = await Membership.countDocuments({
                    ...base,
                    role: { $in: ["Owner", "Admin"] },
                });

                if (!isUnlimited(limits.maxAdmins) && adminsCount + 1 > limits.maxAdmins) {
                    return res.status(409).json({
                        success: false,
                        message: `Límite de Admins alcanzado (${limits.maxAdmins}). Mejora el plan o cambia otro Admin de rol.`,
                    });
                }
            }

            if (role === "Cajera") {
                const cashiersCount = await Membership.countDocuments({
                    ...base,
                    role: "Cajera",
                });

                if (!isUnlimited(limits.maxCashiers) && cashiersCount + 1 > limits.maxCashiers) {
                    return res.status(409).json({
                        success: false,
                        message: `Límite de Cajeras alcanzado (${limits.maxCashiers}). Mejora el plan o cambia otro usuario de rol.`,
                    });
                }
            }

            if (role === "Camarero" || role === "Cocina") {
                const waitersCount = await Membership.countDocuments({
                    ...base,
                    role: { $in: ["Camarero", "Cocina"] },
                });

                if (!isUnlimited(limits.maxWaiters) && waitersCount + 1 > limits.maxWaiters) {
                    return res.status(409).json({
                        success: false,
                        message: `Límite de Camareros/Cocina alcanzado (${limits.maxWaiters}). Mejora el plan o cambia otro usuario de rol.`,
                    });
                }
            }
        }

        // Actualizar contraseña si se proporciona
        if (typeof password === "string" && password.trim().length > 0) {
            if (password.length < 6) {
                return res.status(400).json({ success: false, message: "La contraseña debe tener al menos 6 caracteres" });
            }
            updateData.password = password.trim();
        }

        // Actualizar usuario de forma segura para que el password pase por pre("save")
        if (updateData.name !== undefined) employee.name = updateData.name;
        if (updateData.email !== undefined) employee.email = updateData.email;
        if (updateData.phone !== undefined) employee.phone = updateData.phone;
        if (updateData.role !== undefined) employee.role = updateData.role;
        if (updateData.password !== undefined) employee.password = updateData.password;

        await employee.save();

        const updatedEmployee = await User.findById(employee._id).select("name email phone role");

// Actualizar membership si el rol cambió
        const membershipRoleMap = {
            Admin: "Admin",
            Cajera: "Cajera",
            Camarero: "Camarero",
            Cocina: "Cocina",
        };

        const membershipSet = {};

        if (role && role !== previousRole) {
            membershipSet.role = membershipRoleMap[role] || role;
        }

        if (permissions && typeof permissions === "object") {
            membershipSet.permissions = normalizePermissions(permissions);
        }

        let updatedMembership = null;

        if (Object.keys(membershipSet).length > 0) {
            const membershipRoleMap = {
                Admin: "Admin",
                Cajera: "Cajera",
                Camarero: "Camarero",
                Cocina: "Cocina",
            };

            updatedMembership = await Membership.findOneAndUpdate(
                {
                    user: employee._id,
                    tenantId: req.user.tenantId,
                },
                {
                    $set: {
                        ...membershipSet,
                        status: "active",
                    },
                    $setOnInsert: {
                        user: employee._id,
                        tenantId: req.user.tenantId,
                        role: membershipRoleMap[role] || role || employee.role || "Camarero",
                        clientIds: ["default"],
                    },
                },
                {
                    new: true,
                    upsert: true,
                }
            ).lean();
        }

        res.status(200).json({
            success: true,
            message: "Empleado actualizado exitosamente",
            data: {
                ...updatedEmployee.toObject(),
                membershipRole: updatedMembership?.role || role || updatedEmployee.role,
                permissions: updatedMembership?.permissions || membershipSet.permissions,
            },
        });
    } catch (error) {
        console.error("❌ Error al actualizar empleado:", error);
        
        // Manejar errores de validación de Mongoose
        if (error.name === "ValidationError") {
            const messages = Object.values(error.errors).map(e => e.message).join(", ");
            return res.status(400).json({ success: false, message: messages });
        }
        
        // Manejar errores de duplicación
        if (error.code === 11000) {
            return res.status(400).json({ success: false, message: "El email ya está en uso" });
        }

        res.status(500).json({ 
            success: false, 
            message: "Error al actualizar empleado",
            error: error.message 
        });
    }
};
exports.getFiscalConfig = async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const tenant = await Tenant.findOne({ tenantId }).select("plan fiscal features business name");
        const normalizedPlan = normalizePlan(tenant?.plan);
        const planFeatures = getPlanFeatures(normalizedPlan);

        const f = tenant?.features || {};
        const norm = {
            ...f,
            tax: {
                ...(f.tax || {}),
                enabled: typeof f.tax?.enabled === "boolean" ? f.tax.enabled : true,
            },
            tip: {
                ...(f.tip || {}),
                enabled: typeof f.tip?.enabled === "boolean" ? f.tip.enabled : true,
            },
            checkout: {
                ...(f.checkout || {}),
                chargeMode: String(f.checkout?.chargeMode || "AT_COMPLETE"),
            },
            discount: {
                ...(f.discount || {}),
                enabled: typeof f.discount?.enabled === "boolean" ? f.discount.enabled : true,
            },
            preInvoice: {
                ...(f.preInvoice || {}),
                enabled: typeof f.preInvoice?.enabled === "boolean" ? f.preInvoice.enabled : false,
            },
            orderSources: {
                ...(f.orderSources || {}),
                pedidosYa: {
                    ...(f.orderSources?.pedidosYa || {}),
                    enabled: typeof f.orderSources?.pedidosYa?.enabled === "boolean"
                        ? f.orderSources.pedidosYa.enabled
                        : false,
                    commissionRate: Number(f.orderSources?.pedidosYa?.commissionRate ?? 0.26),
                },
                uberEats: {
                    ...(f.orderSources?.uberEats || {}),
                    enabled: typeof f.orderSources?.uberEats?.enabled === "boolean"
                        ? f.orderSources.uberEats.enabled
                        : false,
                    commissionRate: Number(f.orderSources?.uberEats?.commissionRate ?? 0.22),
                },
                delivery: {
                    ...(f.orderSources?.delivery || {}),
                    enabled: typeof f.orderSources?.delivery?.enabled === "boolean"
                        ? f.orderSources.delivery.enabled
                        : false,
                },
            },
        };

        return res.json({
            success: true,
            data: {
                plan: normalizedPlan,
                planFeatures,
                fiscal: tenant?.fiscal || null,
                features: norm,
                business: tenant?.business || null,
            },
        });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
    }
};



exports.updateFiscalConfig = async (req, res) => {
    try {
        const tenantId = req.user.tenantId;

        const tenantPrev = await Tenant.findOne({ tenantId }).select("plan features fiscal business");

        if (!tenantPrev) {
            return res.status(404).json({
                success: false,
                message: "Tenant not found",
            });
        }

        const normalizedPlan = normalizePlan(tenantPrev?.plan);
        const planFeatures = getPlanFeatures(normalizedPlan);

        const prevFeatures = tenantPrev?.features || {};

        const $set = {};

        // =========================
        // CONFIGURACIÓN GENERAL
        // Disponible para todos los planes
        // =========================

        const chargeMode = req.body?.features?.checkout?.chargeMode;
        if (["AT_INVOICE", "AT_COMPLETE"].includes(chargeMode)) {
            $set["features.checkout.chargeMode"] = chargeMode;
        }

        const taxEnabled = req.body?.features?.tax?.enabled;
        const tipEnabled = req.body?.features?.tip?.enabled;
        const discountEnabled = req.body?.features?.discount?.enabled;
        const preInvoiceEnabled = req.body?.features?.preInvoice?.enabled;
        const orderSources = req.body?.features?.orderSources;

        const currentTaxEnabled =
            typeof taxEnabled === "boolean"
                ? taxEnabled
                : (typeof prevFeatures?.tax?.enabled === "boolean" ? prevFeatures.tax.enabled : true);

        const currentTipEnabled =
            typeof tipEnabled === "boolean"
                ? tipEnabled
                : (typeof prevFeatures?.tip?.enabled === "boolean" ? prevFeatures.tip.enabled : true);

        const currentDiscountEnabled =
            typeof discountEnabled === "boolean"
                ? discountEnabled
                : (typeof prevFeatures?.discount?.enabled === "boolean" ? prevFeatures.discount.enabled : true);

        const currentPreInvoiceEnabled =
            typeof preInvoiceEnabled === "boolean"
                ? preInvoiceEnabled
                : (typeof prevFeatures?.preInvoice?.enabled === "boolean" ? prevFeatures.preInvoice.enabled : false);

        $set["features.tax.enabled"] = currentTaxEnabled;
        $set["features.tip.enabled"] = currentTipEnabled;
        $set["features.discount.enabled"] = currentDiscountEnabled;
        $set["features.preInvoice.enabled"] = currentPreInvoiceEnabled;

        // Delivery interno: permitido para todos los planes
        if (orderSources?.delivery) {
            if (typeof orderSources.delivery.enabled === "boolean") {
                $set["features.orderSources.delivery.enabled"] = orderSources.delivery.enabled;
            }

            if (orderSources.delivery.defaultFee !== undefined) {
                const fee = Number(orderSources.delivery.defaultFee);
                if (!Number.isFinite(fee) || fee < 0) {
                    throw new Error("delivery.defaultFee inválido");
                }
                $set["features.orderSources.delivery.defaultFee"] = fee;
            }
        }

        // PedidosYa: permitido para todos los planes
        if (orderSources?.pedidosYa) {
            if (typeof orderSources.pedidosYa.enabled === "boolean") {
                $set["features.orderSources.pedidosYa.enabled"] = orderSources.pedidosYa.enabled;
            }

            if (orderSources.pedidosYa.commissionRate !== undefined) {
                const r = Number(orderSources.pedidosYa.commissionRate);
                if (!Number.isFinite(r) || r < 0 || r > 1) {
                    throw new Error("pedidosYa.commissionRate inválido (usa 0.26)");
                }

                $set["features.orderSources.pedidosYa.commissionRate"] = r;
            }
        }

        // Uber Eats: permitido para todos los planes
        if (orderSources?.uberEats) {
            if (typeof orderSources.uberEats.enabled === "boolean") {
                $set["features.orderSources.uberEats.enabled"] = orderSources.uberEats.enabled;
            }

            if (orderSources.uberEats.commissionRate !== undefined) {
                const r = Number(orderSources.uberEats.commissionRate);
                if (!Number.isFinite(r) || r < 0 || r > 1) {
                    throw new Error("uberEats.commissionRate inválido (usa 0.22)");
                }

                $set["features.orderSources.uberEats.commissionRate"] = r;
            }
        }

        // =========================
        // NCF / COMPROBANTE FISCAL
        // Solo Premium / Pro
        // =========================

        const fiscalEnabled = req.body?.fiscalEnabled;

        if (!planFeatures.fiscal && fiscalEnabled === true) {
            return res.status(403).json({
                success: false,
                code: "PLAN_FEATURE_NOT_ALLOWED",
                message: "Tu plan actual no incluye NCF. Mejora a Premium o Pro para activar comprobantes fiscales.",
            });
        }

        const currentFiscalEnabled = planFeatures.fiscal
            ? (
                typeof fiscalEnabled === "boolean"
                    ? fiscalEnabled
                    : (typeof tenantPrev?.fiscal?.enabled === "boolean" ? tenantPrev.fiscal.enabled : false)
            )
            : false;

        $set["fiscal.enabled"] = currentFiscalEnabled;

        // IMPORTANTE:
        // Si el plan no tiene fiscal, ignoramos ncfConfig aunque el frontend lo mande.
        // Así Emprendedor y Estándar pueden guardar Delivery, ITBIS, Propina, etc.
        if (planFeatures.fiscal) {
            const ncfConfig = req.body?.ncfConfig || {};

            const buildUpdateForType = (type, data) => {
                const u = {};
                if (!data) return u;

                ["start", "current", "max"].forEach((k) => {
                    if (data[k] !== undefined && data[k] !== null && data[k] !== "") {
                        const n = Number(data[k]);
                        if (!Number.isFinite(n) || n < 0) {
                            throw new Error(`${type}.${k} inválido`);
                        }

                        u[`fiscal.ncfConfig.${type}.${k}`] = Math.floor(n);
                    }
                });

                if ("active" in data) {
                    u[`fiscal.ncfConfig.${type}.active`] = !!data.active;
                }

                if ("expiresAt" in data) {
                    if (!data.expiresAt) {
                        u[`fiscal.ncfConfig.${type}.expiresAt`] = null;
                    } else {
                        const d = new Date(data.expiresAt);
                        if (Number.isNaN(d.getTime())) {
                            throw new Error(`${type}.expiresAt inválido`);
                        }

                        u[`fiscal.ncfConfig.${type}.expiresAt`] = d;
                    }
                }

                return u;
            };

            Object.assign($set, buildUpdateForType("B01", ncfConfig.B01));
            Object.assign($set, buildUpdateForType("B02", ncfConfig.B02));
        }

        const updated = await Tenant.findOneAndUpdate(
            { tenantId },
            { $set },
            { new: true }
        ).select("plan fiscal features business");

        const io = req.app.get("io");
        if (io) {
            io.to(`tenant:${tenantId}`).emit("tenant:configUpdated", {
                tenantId,
                features: updated.features,
                fiscal: updated.fiscal,
                business: updated.business,
            });
        }

        return res.json({
            success: true,
            data: {
                plan: normalizePlan(updated.plan),
                planFeatures: getPlanFeatures(updated.plan),
                fiscal: updated.fiscal,
                features: updated.features,
                business: updated.business,
            },
        });
    } catch (e) {
        return res.status(400).json({
            success: false,
            message: e.message,
        });
    }
};
const DEFAULT_PERMISSIONS = {
    products: {
        create: false,
        update: false,
        delete: false,
    },
    inventory: {
        entry: false,
        exit: false,
        adjust: false,
        waste: false,
    },
    orders: {
        cancel: false,
    },
};

function normalizePermissions(permissions = {}) {
    return {
        products: {
            create: Boolean(permissions?.products?.create),
            update: Boolean(permissions?.products?.update),
            delete: Boolean(permissions?.products?.delete),
        },
        inventory: {
            entry: Boolean(permissions?.inventory?.entry),
            exit: Boolean(permissions?.inventory?.exit),
            adjust: Boolean(permissions?.inventory?.adjust),
            waste: Boolean(permissions?.inventory?.waste),
        },
        orders: {
            cancel: Boolean(permissions?.orders?.cancel),
        },
    };
}

// 🔹 Uso del plan: usuarios, platos, mesas y límites
exports.getUsage = async (req, res) => {
    try {
        const tenantId = req.user.tenantId;

        // Tenant y plan
        const tenant = await Tenant.findOne({ tenantId });
        if (!tenant) {
            return res.status(404).json({ success: false, message: "Tenant not found" });
        }

        const normalizedPlan = normalizePlan(tenant.plan);
        const tier = TIERS[normalizedPlan] || TIERS.emprendedor;
        const limits = tier.limits || {};
        const features = getPlanFeatures(normalizedPlan);
        const currentMembership = req.scope?.membership || null;

        const currentUser = {
            role: currentMembership?.role || req.user?.role || null,
            permissions: normalizePermissions(currentMembership?.permissions || DEFAULT_PERMISSIONS),
        };

        // Cálculos en paralelo
        const [totalUsers, admins, cajeras, camareros, dishes, tables] = await Promise.all([
            Membership.countDocuments({ tenantId, status: "active" }),
            Membership.countDocuments({ tenantId, status: "active", role: { $in: ["Owner", "Admin"] } }),
            Membership.countDocuments({ tenantId, status: "active", role: "Cajera" }),
            Membership.countDocuments({ tenantId, status: "active", role: { $in: ["Camarero", "Cocina"] } }),
            Dish.countDocuments({ tenantId }),
            Table.countDocuments({ tenantId }),
        ]);

        const remaining = (limit, used) =>
            limit === null || limit === undefined ? null : Math.max(limit - used, 0);

        return res.status(200).json({
            success: true,
            data: {
                plan: normalizedPlan,
                features,
                currentUser,
                limits: {
                    maxUsers: limits.maxUsers ?? null,
                    maxAdmins: limits.maxAdmins ?? null,
                    maxCashiers: limits.maxCashiers ?? null,
                    maxWaiters: limits.maxWaiters ?? null,
                    maxDishes: limits.maxDishes ?? null,
                    maxTables: limits.maxTables ?? null,
                },
                usage: {
                    users: totalUsers,
                    admins,
                    cajeras,
                    camareros,
                    dishes,
                    tables,
                },
                remaining: {
                    users: remaining(limits.maxUsers, totalUsers),
                    admins: remaining(limits.maxAdmins, admins),
                    cajeras: remaining(limits.maxCashiers, cajeras),
                    camareros: remaining(limits.maxWaiters, camareros),
                    dishes: remaining(limits.maxDishes, dishes),
                    tables: remaining(limits.maxTables, tables),
                },
            },
        });
    } catch (error) {
        console.error("❌ Error al obtener usage:", error);
        res.status(500).json({
            success: false,
            message: "Error al obtener usage",
            error,
        });
    }
};
exports.getManagerCodeStatus = async (req, res, next) => {
    try {
        const tenantId = req.tenantId || req.scope?.tenantId || req.user?.tenantId;
        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));

        const settings = await TenantSettings.findOne({ tenantId })
            .populate("managerCodeUpdatedBy", "name role");

        return res.json({
            success: true,
            data: {
                enabled: !!settings?.managerCodeHash,
                hint: settings?.managerCodeHint || "",
                updatedAt: settings?.managerCodeUpdatedAt || null,
                updatedBy: settings?.managerCodeUpdatedBy || null,
            },
        });
    } catch (e) {
        return next(createHttpError(500, "GET_MANAGER_CODE_STATUS_FAILED"));
    }
};

exports.setManagerCode = async (req, res, next) => {
    try {
        const tenantId = req.tenantId || req.scope?.tenantId || req.user?.tenantId;
        const userId = req.user?._id || null;

        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));

        const raw = String(req.body?.managerCode || "").trim();

        // Permite “desactivar” si mandas managerCode = ""
        if (!raw) {
            const settings = await TenantSettings.findOneAndUpdate(
                { tenantId },
                {
                    $set: {
                        managerCodeHash: "",
                        managerCodeHint: "",
                        managerCodeUpdatedAt: new Date(),
                        managerCodeUpdatedBy: userId,
                    },
                },
                { upsert: true, new: true }
            );

            return res.json({ success: true, data: { enabled: false } });
        }

        // Validación: PIN 4-8 dígitos (ajústalo si quieres)
        if (!/^\d{4,8}$/.test(raw)) {
            return next(createHttpError(400, "INVALID_MANAGER_CODE_FORMAT"));
        }

        const hash = await bcrypt.hash(raw, 10);
        const hint = `***${raw.slice(-2)}`;

        const settings = await TenantSettings.findOneAndUpdate(
            { tenantId },
            {
                $set: {
                    managerCodeHash: hash,
                    managerCodeHint: hint,
                    managerCodeUpdatedAt: new Date(),
                    managerCodeUpdatedBy: userId,
                },
            },
            { upsert: true, new: true }
        );

        return res.json({
            success: true,
            data: { enabled: true, hint: settings.managerCodeHint, updatedAt: settings.managerCodeUpdatedAt },
        });
    } catch (e) {
        return next(createHttpError(500, "SET_MANAGER_CODE_FAILED"));
    }
};
const LOGO_BUCKET = process.env.SUPABASE_ASSETS_BUCKET || "invoices";

const ALLOWED_LOGO_MIME = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
};

exports.uploadTenantLogo = async (req, res) => {
    try {
        const tenantId = req.user?.tenantId;

        if (!tenantId) {
            return res.status(400).json({
                success: false,
                message: "Tenant no encontrado.",
            });
        }

        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "Debes seleccionar una imagen.",
            });
        }

        const mime = String(req.file.mimetype || "").toLowerCase();
        const ext = ALLOWED_LOGO_MIME[mime];

        if (!ext) {
            return res.status(400).json({
                success: false,
                message: "Formato inválido. Usa PNG, JPG o JPEG.",
            });
        }

// ✅ Normalizar logo para que se vea mejor en factura
        const processedLogoBuffer = await sharp(req.file.buffer)
            .rotate()
            .trim()
            .resize({
                width: 500,
                height: 220,
                fit: "inside",
                withoutEnlargement: true,
                background: { r: 255, g: 255, b: 255, alpha: 0 },
            })
            .png({
                compressionLevel: 9,
                quality: 100,
            })
            .toBuffer();

        const tenant = await Tenant.findOne({ tenantId }).select("business");

        if (!tenant) {
            return res.status(404).json({
                success: false,
                message: "Tenant no encontrado.",
            });
        }

        const oldLogoPath = tenant?.business?.logoPath || null;

        const safeName = crypto.randomBytes(6).toString("hex");
        const storagePath = `tenant-assets/tenant_${tenantId}/logo_${Date.now()}_${safeName}.png`;

        const { error: uploadError } = await supabase.storage
            .from(LOGO_BUCKET)
            .upload(storagePath, processedLogoBuffer, {
                contentType: "image/png",
                upsert: true,
            });

        if (uploadError) {
            throw uploadError;
        }

        const { data: publicData } = supabase.storage
            .from(LOGO_BUCKET)
            .getPublicUrl(storagePath);

        const logoUrl = publicData?.publicUrl || null;

        if (!logoUrl) {
            return res.status(500).json({
                success: false,
                message: "Logo subido, pero no se pudo obtener la URL pública.",
            });
        }

        const updated = await Tenant.findOneAndUpdate(
            { tenantId },
            {
                $set: {
                    "business.logoUrl": logoUrl,
                    "business.logoPath": storagePath,
                    "business.logoMime": "image/png",
                    "business.logoUpdatedAt": new Date(),
                },
            },
            { new: true }
        ).select("plan fiscal features business");

        // Limpia logo viejo si existía
        if (oldLogoPath && oldLogoPath !== storagePath) {
            try {
                await supabase.storage.from(LOGO_BUCKET).remove([oldLogoPath]);
            } catch (cleanupError) {
                console.warn("[TENANT LOGO] No se pudo borrar logo anterior:", cleanupError?.message);
            }
        }

        const io = req.app.get("io");
        if (io) {
            io.to(`tenant:${tenantId}`).emit("tenant:configUpdated", {
                tenantId,
                features: updated.features,
                fiscal: updated.fiscal,
                business: updated.business,
            });
        }

        return res.json({
            success: true,
            message: "Logo actualizado correctamente.",
            data: {
                business: updated.business,
                logoUrl,
                logoPath: storagePath,
            },
        });
    } catch (error) {
        console.error("❌ Error subiendo logo del tenant:", error);

        return res.status(500).json({
            success: false,
            message: error?.message || "Error subiendo logo del negocio.",
        });
    }
};

exports.deleteTenantLogo = async (req, res) => {
    try {
        const tenantId = req.user?.tenantId;

        if (!tenantId) {
            return res.status(400).json({
                success: false,
                message: "Tenant no encontrado.",
            });
        }

        const tenant = await Tenant.findOne({ tenantId }).select("business");

        if (!tenant) {
            return res.status(404).json({
                success: false,
                message: "Tenant no encontrado.",
            });
        }

        const oldLogoPath = tenant?.business?.logoPath || null;

        if (oldLogoPath) {
            try {
                await supabase.storage.from(LOGO_BUCKET).remove([oldLogoPath]);
            } catch (cleanupError) {
                console.warn("[TENANT LOGO] No se pudo borrar logo:", cleanupError?.message);
            }
        }

        const updated = await Tenant.findOneAndUpdate(
            { tenantId },
            {
                $set: {
                    "business.logoUrl": null,
                    "business.logoPath": null,
                    "business.logoMime": null,
                    "business.logoUpdatedAt": null,
                },
            },
            { new: true }
        ).select("plan fiscal features business");

        const io = req.app.get("io");
        if (io) {
            io.to(`tenant:${tenantId}`).emit("tenant:configUpdated", {
                tenantId,
                features: updated.features,
                fiscal: updated.fiscal,
                business: updated.business,
            });
        }

        return res.json({
            success: true,
            message: "Logo eliminado correctamente.",
            data: {
                business: updated.business,
            },
        });
    } catch (error) {
        console.error("❌ Error eliminando logo del tenant:", error);

        return res.status(500).json({
            success: false,
            message: error?.message || "Error eliminando logo del negocio.",
        });
    }
};