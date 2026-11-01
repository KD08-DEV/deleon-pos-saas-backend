const Order = require("../models/orderModel");
const User = require("../models/userModel");
const Payment = require("../models/paymentModel");
const Membership = require("../models/membershipModel");
const Dish = require("../models/dish");
const Table = require("../models/tableModel");
const Tenant = require("../models/tenantModel");
const {
    getTenantTimezone,
    getUtcRangeForYMDRange,
    getYMDInTimeZone,
} = require(
    "../utils/timezone"
);
const TIERS = require("../config/planTiers");
const { membershipFilter, visibleInBranch, validateBranchIds } = require("../services/employeeBranchAccess");
const Client = require("../models/clientModel");
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

const normalizePaymentText = (v) =>
    String(v || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

function getEffectivePaymentMethodForReport(o = {}) {
    const pm = normalizePaymentText(o?.paymentMethod);

    if (pm === "efectivo" || pm === "cash") return "Efectivo";
    if (pm === "tarjeta" || pm === "card") return "Tarjeta";
    if (pm === "transferencia" || pm === "transfer") return "Transferencia";
    if (pm === "credito" || pm === "credit") return "Credito";

    const alt = normalizePaymentText(
        o?.paymentMethodType ||
        o?.paymentMethodReal ||
        o?.deliveryPaymentMethod ||
        o?.payment?.method ||
        o?.paidWith
    );

    if (alt === "efectivo" || alt === "cash") return "Efectivo";
    if (alt === "tarjeta" || alt === "card") return "Tarjeta";
    if (alt === "transferencia" || alt === "transfer") return "Transferencia";
    if (alt === "credito" || alt === "credit") return "Credito";

    return o?.paymentMethod || "Otros";
}
function buildLegacyReportFilter({ tenantId, clientId, registerId, startDate, endDate }) {
    const rawClientId = String(clientId || "default").trim() || "default";

    const rawRegister = registerId ? String(registerId).trim().toUpperCase() : "";

    const normalizeReg =
        !rawRegister || rawRegister === "__ALL_REGISTERS__" || rawRegister === "ALL"
            ? ""
            : rawRegister;

    const clientScope = rawClientId === "default"
        ? { $or: [{ clientId: "default" }, { clientId: { $exists: false } }, { clientId: null }, { clientId: "" }] }
        : { clientId: rawClientId };

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

    const invoiceDateRange =
        startDate && endDate
            ? {
                $or: [
                    { invoicedAt: { $gte: startDate, $lte: endDate } },
                    { createdAt: { $gte: startDate, $lte: endDate } },
                ],
            }
            : {};

    const paidAtMissing = {
        $or: [
            { paidAt: { $exists: false } },
            { paidAt: null },
            { paidAt: "" },
        ],
    };

    const legacyPaymentStatusFilter = {
        $or: [
            { paymentStatus: { $exists: false } },
            { paymentStatus: null },
            { paymentStatus: "" },
            { paymentStatus: "Pendiente" },
        ],
    };

    return {
        tenantId,

        ...registerScope,

        $and: [
            clientScope,

            {
                isDraft: { $ne: true },
            },

            {
                "items.0": { $exists: true },
            },

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
                    // Venta moderna pagada: usa paidAt
                    {
                        paymentStatus: "Pagado",
                        ...paidDateRange,
                    },

                    // Venta pagada vieja sin paidAt: usa invoicedAt o createdAt
                    {
                        paymentStatus: "Pagado",
                        ...paidAtMissing,
                        ...invoiceDateRange,
                    },

                    // Legacy: completada pero sin paymentStatus moderno
                    {
                        ...legacyPaymentStatusFilter,
                        orderStatus: "Completado",
                        ...createdDateRange,
                    },

                    // Legacy: fiscal solicitada pero sin paymentStatus moderno
                    {
                        ...legacyPaymentStatusFilter,
                        "fiscal.requested": true,
                        ...createdDateRange,
                    },

                    // Legacy: factura interna pero sin paymentStatus moderno
                    {
                        ...legacyPaymentStatusFilter,
                        invoiceNumber: { $exists: true, $nin: [null, ""] },
                        ...createdDateRange,
                    },

                    {
                        ...legacyPaymentStatusFilter,
                        facturaNo: { $exists: true, $nin: [null, ""] },
                        ...createdDateRange,
                    },

                    {
                        ...legacyPaymentStatusFilter,
                        internalInvoiceNumber: { $exists: true, $nin: [null, ""] },
                        ...createdDateRange,
                    },
                ],
            },
        ],
    };
}
function buildCreditReportFilter({
                                     tenantId,
                                     clientId,
                                     registerId,
                                     startDate,
                                     endDate,
                                 }) {
    const rawClientId =
        String(clientId || "default").trim() ||
        "default";

    const rawRegister =
        registerId
            ? String(registerId)
                .trim()
                .toUpperCase()
            : "";

    const normalizedRegister =
        !rawRegister ||
        rawRegister ===
        "__ALL_REGISTERS__" ||
        rawRegister === "ALL"
            ? ""
            : rawRegister;

    const clientScope = rawClientId === "default"
        ? { $or: [{ clientId: "default" }, { clientId: { $exists: false } }, { clientId: null }, { clientId: "" }] }
        : { clientId: rawClientId };

    let registerScope = {};

    if (normalizedRegister) {
        if (
            normalizedRegister === "MAIN" ||
            normalizedRegister === "DEFAULT"
        ) {
            registerScope = {
                $or: [
                    { registerId: "MAIN" },
                    { registerId: "default" },
                    {
                        registerId: {
                            $exists: false,
                        },
                    },
                    { registerId: null },
                    { registerId: "" },
                ],
            };
        } else {
            registerScope = {
                registerId:
                normalizedRegister,
            };
        }
    }

    const andConditions = [
        clientScope,

        {
            isDraft: {
                $ne: true,
            },
        },

        {
            "items.0": {
                $exists: true,
            },
        },

        {
            orderStatus: {
                $nin: [
                    "Cancelado",
                    "Canceled",
                    "Cancelled",
                ],
            },
        },

        {
            paymentStatus: {
                $ne: "Anulado",
            },
        },

        {
            paymentMethod: {
                $regex:
                    "^(Credito|Crédito|Credit)$",
                $options: "i",
            },
        },
    ];

    if (startDate && endDate) {
        andConditions.push({
            $or: [
                {
                    invoicedAt: {
                        $gte: startDate,
                        $lte: endDate,
                    },
                },

                {
                    $and: [
                        {
                            $or: [
                                {
                                    invoicedAt: {
                                        $exists:
                                            false,
                                    },
                                },
                                {
                                    invoicedAt:
                                        null,
                                },
                                {
                                    invoicedAt:
                                        "",
                                },
                            ],
                        },
                        {
                            createdAt: {
                                $gte:
                                startDate,
                                $lte:
                                endDate,
                            },
                        },
                    ],
                },
            ],
        });
    }

    return {
        tenantId,

        ...registerScope,

        $and: andConditions,
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

        // ✅ MERMA (waste) por rango de fechas (costo y cantidad)
        const rawClientId = String(clientId || "default").trim() || "default";

        const mermaFilter = {
            tenantId,
            type: "waste",
            ...(rawClientId === "default"
                ? { $or: [{ clientId: "default" }, { clientId: { $exists: false } }, { clientId: null }, { clientId: "" }] }
                : { clientId: rawClientId }),
        };

        let startDate =
            null;

        let endDate =
            null;

        if (
            from ||
            to
        ) {
            const range =
                getUtcRangeForYMDRange(
                    from || to,
                    to || from,
                    timezone
                );

            if (!range) {
                return res
                    .status(400)
                    .json({
                        success: false,

                        message:
                            "INVALID_REPORT_DATE_RANGE",

                        details: {
                            from,
                            to,
                        },
                    });
            }

            startDate =
                range.start;

            endDate =
                range.end;
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
        const creditFilter = buildCreditReportFilter({
            tenantId,
            clientId,
            registerId,
            startDate,
            endDate,
        });

        const normalizedRequestedMethod =
            normalizePaymentText(method);

        const creditMethodRequested =
            normalizedRequestedMethod === "credito" ||
            normalizedRequestedMethod === "credit";

// ==========================================
// EXCLUIR CRÉDITO DE LAS VENTAS COBRADAS
// ==========================================
        filter.$and = [
            ...(Array.isArray(filter.$and)
                ? filter.$and
                : []),

            {
                $nor: [
                    {
                        paymentMethod: {
                            $regex: "^(Credito|Crédito|Credit)$",
                            $options: "i",
                        },
                    },
                ],
            },
        ];

// ==========================================
// FILTRO POR MÉTODO DE PAGO
// ==========================================
// Si pidieron Crédito, NO filtramos `filter`
// porque esas ventas salen de `creditFilter`.
        if (
            method &&
            !creditMethodRequested
        ) {
            filter.$and.push({
                paymentMethod: method,
            });
        }

// Filtrar por método de pago.
// Si alguien intenta pedir Crédito aquí, devolvemos vacío,
// porque Crédito no pertenece a ventas cobradas.

        // ✅ Buscar por nombre del usuario (match con populate)
        let userIds = [];

        if (user) {
            const matchedUsers =
                await User.find({
                    tenantId:
                    req.user.tenantId,

                    name: {
                        $regex:
                            user.trim(),

                        $options:
                            "i",
                    },
                }).select("_id");

            userIds =
                matchedUsers.map(
                    (u) => u._id
                );

            if (userIds.length > 0) {
                const userFilter = {
                    $in: userIds,
                };

                filter.user =
                    userFilter;

                creditFilter.user =
                    userFilter;
            } else {
                // Fuerza ambas consultas
                // a devolver vacío.
                filter._id = {
                    $exists: false,
                };

                creditFilter._id = {
                    $exists: false,
                };
            }
        }

        // Buscar órdenes que cumplan con los filtros
        const orders =
            creditMethodRequested
                ? []
                : await Order.find(filter)
                    .populate(
                        "user",
                        "name role email"
                    )
                    .populate(
                        "table",
                        "tableNumber virtualType type isVirtual name"
                    )
                    .sort({
                        paidAt: -1,
                        createdAt: -1,
                    });

        const creditOrders =
            method &&
            !creditMethodRequested
                ? []
                : await Order.find(creditFilter)
                    .populate(
                        "user",
                        "name role email"
                    )
                    .populate(
                        "table",
                        "tableNumber virtualType type isVirtual name"
                    )
                    .sort({
                        invoicedAt: -1,
                        createdAt: -1,
                    });
        // Calcular totales
        const totalSales = orders.reduce((sum, o) => sum + (Number(o.bills?.totalWithTax) || 0), 0);
        const totalTax = orders.reduce((sum, o) => sum + (Number(o.bills?.tax) || 0), 0);
        const totalCommission = orders.reduce((sum, o) => sum + (Number(o.commissionAmount) || 0), 0);
        const totalNet = orders.reduce((sum, o) => sum + (Number(o.netTotal) || 0), 0);
        const orderCount = orders.length;
        const avgTicket = orderCount > 0 ? totalSales / orderCount : 0;
        const creditSales =
            creditOrders.reduce(
                (sum, order) =>
                    sum +
                    (
                        Number(
                            order
                                ?.bills
                                ?.totalWithTax
                        ) || 0
                    ),
                0
            );

        const creditOrderCount =
            creditOrders.length;

        // 🔹 Cierre de caja diario (resumen)
        const dailySummary = {
            totalSales,
            totalTax,
            orderCount,
            totalCommission,
            totalNet,
            creditSales,
            creditOrderCount,
            mermaQty,
            mermaCost,
            netSales: Number((totalSales - mermaCost).toFixed(2)),
            avgTicket: Number(avgTicket.toFixed(2)),
            cashSales: orders
                .filter((o) => getEffectivePaymentMethodForReport(o) === "Efectivo")
                .reduce((s, o) => s + (Number(o.bills?.totalWithTax) || 0), 0),

            onlineSales: orders
                .filter((o) => getEffectivePaymentMethodForReport(o) === "Tarjeta")
                .reduce((s, o) => s + (Number(o.bills?.totalWithTax) || 0), 0),

            transferSales: orders
                .filter((o) => getEffectivePaymentMethodForReport(o) === "Transferencia")
                .reduce((s, o) => s + (Number(o.bills?.totalWithTax) || 0), 0),
        };

        // 🔹 También agrupar por fecha (para gráficas)
        const groupedByDate = {};
        orders.forEach((o) => {
            const refDate = o.paidAt || o.invoicedAt || o.createdAt;
            const date =
                getYMDInTimeZone(
                    refDate,
                    timezone
                );

            if (!date) return;

            if (!groupedByDate[date]) groupedByDate[date] = 0;
            groupedByDate[date] += Number(o.bills?.totalWithTax) || 0;
        });

        res.status(200).json({
            success: true,

            // Ventas cobradas
            count:
            orderCount,

            // Ventas a crédito
            creditCount:
            creditOrderCount,

            dailySummary,

            salesByDate:
            groupedByDate,

            // Dinero cobrado
            data:
            orders,

            // Ventas realizadas a crédito
            creditData:
            creditOrders,
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
        const tenantId = req.scope.tenantId;
        const clientId = req.scope.clientId;
        const memberships = await Membership.find(membershipFilter(tenantId, clientId))
            .select("user role clientIds permissions status").lean();
        const members = memberships.filter(m => visibleInBranch(m, clientId));
        const users = await User.find({ tenantId, _id: { $in: members.map(m => m.user) } })
            .select("_id name email phone role").lean();
        const byId = new Map(users.map(u => [String(u._id), u]));
        const data = members.filter(m => byId.has(String(m.user))).map(m => ({
            ...byId.get(String(m.user)), membershipRole: m.role,
            clientIds: Array.isArray(m.clientIds) && m.clientIds.length ? m.clientIds : ["default"],
            permissions: normalizePermissions(m.permissions || DEFAULT_PERMISSIONS),
        }));
        return res.json({ success: true, data });
    } catch (error) {
        console.error("GET_EMPLOYEES_FAILED:", error);
        return res.status(500).json({ success: false, message: "Error al obtener empleados" });
    }
};

// Users/cashier selector must observe the same branch filter as Employees.
exports.getUsers = async (req, res) => {
    try {
        const tenantId = req.scope.tenantId;
        const clientId = req.scope.clientId;
        const memberships = await Membership.find(membershipFilter(tenantId, clientId))
            .select("user role clientIds status").lean();
        const members = memberships.filter(m => visibleInBranch(m, clientId));
        const users = await User.find({ tenantId, _id: { $in: members.map(m => m.user) } })
            .select("_id name email phone role").lean();
        const byUser = new Map(members.map(m => [String(m.user), m]));
        const data = users.map(u => ({ ...u, role: byUser.get(String(u._id))?.role || u.role }));
        return res.json({ success: true, data });
    } catch (error) {
        console.error("GET_USERS_FAILED:", error);
        return res.status(500).json({ success: false, message: "Error al obtener usuarios" });
    }
};

// 🔹 Actualizar empleado
exports.updateEmployee = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, email, phone, role, password, permissions, clientIds } = req.body;


        // Verificar que el empleado existe y pertenece al mismo tenant
        const employee = await User.findOne({ _id: id, tenantId: req.user.tenantId });
        
        if (!employee) {
            return res.status(404).json({ success: false, message: "Empleado no encontrado" });
        }

        // PATCH is limited to users visible in the active branch, not every user in tenant.
        const memberInBranch = await Membership.findOne({ user: employee._id, tenantId: req.scope.tenantId, status: "active" });
        if (!visibleInBranch(memberInBranch, req.scope.clientId)) {
            return res.status(404).json({ success: false, code: "EMPLOYEE_NOT_IN_BRANCH", message: "Empleado no asignado a esta sucursal" });
        }
        let verifiedClientIds;
        if (clientIds !== undefined) {
            verifiedClientIds = validateBranchIds(clientIds);
            if (!verifiedClientIds) return res.status(400).json({ code: "INVALID_BRANCH_ASSIGNMENT" });
            const secondaryIds = verifiedClientIds.filter(id => id !== "default");
            if (secondaryIds.length) {
                const available = await Client.countDocuments({ tenantId: req.scope.tenantId, clientId: { $in: secondaryIds }, isActive: true });
                if (available !== secondaryIds.length) return res.status(400).json({ code: "INVALID_BRANCH_ASSIGNMENT" });
            }
            // Owner/Admin tienen alcance global por membresía. Un PATCH de permisos
            // no debe fallar si un cliente antiguo reenvía sin cambios clientIds.
            // Bloquear únicamente un cambio REAL de las asignaciones globales.
            const activeRole = role || memberInBranch.role;
            if (["Owner", "Admin"].includes(memberInBranch.role) ||
                ["Owner", "Admin"].includes(activeRole)) {
                const currentClientIds = validateBranchIds(
                    Array.isArray(memberInBranch.clientIds) && memberInBranch.clientIds.length
                        ? memberInBranch.clientIds : ["default"]
                ) || ["default"];
                const sameIds = verifiedClientIds.length === currentClientIds.length &&
                    verifiedClientIds.every(id => currentClientIds.includes(id));
                if (!sameIds) {
                    return res.status(403).json({ success: false, code: "GLOBAL_ADMIN_ASSIGNMENT_READ_ONLY",
                        message: "Los administradores globales no pueden cambiar sus sucursales desde Empleados" });
                }
                verifiedClientIds = undefined;
            }
        }

        // No permitir editar al Admin principal (puedes ajustar esta lógica)
        // Si quieres permitir editar admin, puedes remover esta validación
        if (employee.role === "Admin" && role && role !== "Admin") {
            return res.status(400).json({
                success: false,
                message: "No se puede cambiar el rol del administrador principal",
            });
        }

// Obtener el Membership actual para comparar el rol real del tenant
        const currentMembership = await Membership.findOne({
            user: employee._id,
            tenantId: req.user.tenantId,
        }).lean();

// Membership es la fuente usada para permisos, límites y listado de empleados
        const previousRole = currentMembership?.role || employee.role;

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

        if (phone !== undefined) {
            // El schema User guarda phone como STRING (7..15 dígitos), no como Number.
            // Soportar formato legible y prefijos internacionales sin perder ceros.
            const digits = String(phone ?? "").replace(/\D/g, "");
            if (digits && !/^\d{7,15}$/.test(digits)) {
                return res.status(400).json({
                    success: false,
                    code: "INVALID_PHONE",
                    message: "El teléfono debe contener entre 7 y 15 dígitos"
                });
            }
            updateData.phone = digits;
        }

        if (role && ["Admin", "Camarero", "Cajera", "Cocina"].includes(role)) {
            updateData.role = role;
        }

// ✅ Enforce plan limits on role change
        if (role && role !== previousRole) {
            const tenantId = req.user.tenantId;

            const tenant = await Tenant.findOne({ tenantId }).select("plan");
            const tier = TIERS[normalizePlan(tenant?.plan)] || TIERS.emprendedor;
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

// Sincronizar siempre Membership con User
        const allowedMembershipRoles = [
            "Owner",
            "Admin",
            "Cajera",
            "Camarero",
            "Cocina",
        ];

        const effectiveMembershipRole = allowedMembershipRoles.includes(role)
            ? role
            : currentMembership?.role || employee.role || "Camarero";

        const membershipSet = {
            role: effectiveMembershipRole,
            status: "active",
        };
        if (verifiedClientIds) membershipSet.clientIds = verifiedClientIds;

        if (permissions && typeof permissions === "object") {
            membershipSet.permissions = normalizePermissions(permissions);
            // No conceder permisos DGII a negocios extranjeros ni planes sin fiscal.
            const fiscalTenant = await Tenant.findOne({ tenantId: req.user.tenantId })
                .select("plan localization.countryCode").lean();
            const fiscalDelegationAllowed =
                String(fiscalTenant?.localization?.countryCode || "DO").toUpperCase() === "DO" &&
                getPlanFeatures(fiscalTenant?.plan).fiscal === true &&
                effectiveMembershipRole === "Cajera";
            if (!fiscalDelegationAllowed) {
                membershipSet.permissions.fiscal = { ecfIssue:false,creditNote:false,debitNote:false,manage:false };
            }
        } else if (effectiveMembershipRole !== "Cajera") {
            // Al cambiar el rol sin enviar el objeto permissions, revocar igual.
            membershipSet["permissions.fiscal"] = {
                ecfIssue:false,creditNote:false,debitNote:false,manage:false,
            };
        }

        // La membresía activa fue validada arriba. NO crearla otra vez durante
        // una edición: $set.clientIds y $setOnInsert.clientIds colisionan en
        // MongoDB y generan un error 500 al guardar permisos de cajeras.
        const updatedMembership = await Membership.findOneAndUpdate(
            {
                _id: memberInBranch._id,
                user: employee._id,
                tenantId: req.scope.tenantId,
                status: "active",
            },
            { $set: membershipSet },
            {
                new: true,
                upsert: false,
                runValidators: true,
            }
        ).lean();
        if (!updatedMembership) {
            return res.status(409).json({ success: false, code: "EMPLOYEE_MEMBERSHIP_CHANGED",
                message: "La asignación del empleado cambió. Actualiza la lista y vuelve a intentar." });
        }

        res.status(200).json({
            success: true,
            message: "Empleado actualizado exitosamente",
            data: {
                ...updatedEmployee.toObject(),
                membershipRole: updatedMembership?.role || updatedEmployee.role,
                permissions: normalizePermissions(
                    updatedMembership?.permissions || DEFAULT_PERMISSIONS
                ),
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
const DEFAULT_LOCALIZATION = {
    countryCode: "DO",
    language: "es",
    locale: "es-DO",
    currency: "DOP",
    timezone: "America/Santo_Domingo",
    dateFormat: "DD/MM/YYYY",
    timeFormat: "12h",
    measurementSystem: "imperial",
    weightUnit: "lb",
};

function normalizeTenantLocalization(
    tenant
) {
    const current =
        tenant?.localization || {};

    return {
        countryCode:
            String(
                current.countryCode ||
                DEFAULT_LOCALIZATION.countryCode
            )
                .trim()
                .toUpperCase(),

        language:
            String(
                current.language ||
                DEFAULT_LOCALIZATION.language
            )
                .trim()
                .toLowerCase(),

        locale:
            String(
                current.locale ||
                DEFAULT_LOCALIZATION.locale
            ).trim(),

        currency:
            String(
                current.currency ||
                DEFAULT_LOCALIZATION.currency
            )
                .trim()
                .toUpperCase(),

        timezone:
            String(
                current.timezone ||
                DEFAULT_LOCALIZATION.timezone
            ).trim(),

        dateFormat:
            String(
                current.dateFormat ||
                DEFAULT_LOCALIZATION.dateFormat
            ).trim(),

        timeFormat:
            String(
                current.timeFormat ||
                DEFAULT_LOCALIZATION.timeFormat
            ).trim(),

        measurementSystem:
            String(
                current.measurementSystem ||
                DEFAULT_LOCALIZATION
                    .measurementSystem
            ).trim(),

        weightUnit:
            String(
                current.weightUnit ||
                DEFAULT_LOCALIZATION.weightUnit
            ).trim(),
    };
}

function normalizeLegacyTaxPercent(
    value
) {
    const number =
        Number(value);

    if (!Number.isFinite(number)) {
        return 18;
    }

    // Legacy guarda:
    // 0.18 = 18%
    if (
        number >= 0 &&
        number <= 1
    ) {
        return Number(
            (number * 100)
                .toFixed(4)
        );
    }

    return number;
}

function normalizeTenantTaxConfig(
    tenant
) {
    const storedTaxes =
        Array.isArray(
            tenant?.taxConfig?.taxes
        )
            ? tenant.taxConfig.taxes
            : [];

    if (storedTaxes.length > 0) {
        const taxes =
            storedTaxes.map(
                (tax) => ({
                    id:
                        String(
                            tax?.id || ""
                        ).trim(),

                    name:
                        String(
                            tax?.name || ""
                        ).trim(),

                    code:
                        String(
                            tax?.code || ""
                        )
                            .trim()
                            .toUpperCase(),

                    ratePercent:
                        Number(
                            tax?.ratePercent ||
                            0
                        ),

                    active:
                        tax?.active !==
                        false,

                    includedInPrice:
                        tax
                            ?.includedInPrice ===
                        true,

                    appliesToDeliveryFee:
                        tax
                            ?.appliesToDeliveryFee ===
                        true,
                })
            );

        const activeTaxes =
            taxes.filter(
                (tax) =>
                    tax.active
            );

        const requestedDefault =
            String(
                tenant
                    ?.taxConfig
                    ?.defaultTaxId ||
                ""
            ).trim();

        const validDefault =
            activeTaxes.some(
                (tax) =>
                    tax.id ===
                    requestedDefault
            )
                ? requestedDefault
                : (
                    activeTaxes[0]
                        ?.id ||
                    null
                );

        return {
            enabled:
                typeof tenant
                    ?.taxConfig
                    ?.enabled ===
                "boolean"
                    ? tenant
                        .taxConfig
                        .enabled
                    : true,

            defaultTaxId:
            validDefault,

            taxes,
        };
    }

    // ==========================================
    // COMPATIBILIDAD CON CLIENTES EXISTENTES
    // ==========================================
    //
    // Si todavía no existe taxConfig,
    // convertimos virtualmente el antiguo
    // features.tax en un impuesto genérico.
    //
    // No modifica MongoDB hasta que el usuario
    // guarde Configuración Fiscal.
    // ==========================================

    const legacyEnabled =
        typeof tenant
            ?.features
            ?.tax
            ?.enabled ===
        "boolean"
            ? tenant
                .features
                .tax
                .enabled
            : true;

    const legacyRate =
        normalizeLegacyTaxPercent(
            tenant
                ?.features
                ?.tax
                ?.rate ??
            0.18
        );

    const localization =
        normalizeTenantLocalization(
            tenant
        );

    const isDominican =
        localization.countryCode ===
        "DO";

    const legacyTax = {
        id:
            "legacy_default_tax",

        name:
            isDominican
                ? "ITBIS"
                : "Tax",

        code:
            isDominican
                ? "ITBIS"
                : "TAX",

        ratePercent:
        legacyRate,

        active:
            true,

        includedInPrice:
            false,

        appliesToDeliveryFee:
            true,
    };

    return {
        enabled:
        legacyEnabled,

        defaultTaxId:
        legacyTax.id,

        taxes: [
            legacyTax,
        ],
    };
}
function normalizeTaxIdentifierInput(
    raw = {},
    {
        required = false,
        fallbackCountryCode = "",
    } = {}
) {
    const type =
        String(
            raw?.type || ""
        )
            .trim()
            .toUpperCase()
            .replace(
                /[^A-Z0-9_-]/g,
                "_"
            )
            .slice(
                0,
                40
            );

    const label =
        String(
            raw?.label || ""
        )
            .trim()
            .slice(
                0,
                80
            );

    const value =
        String(
            raw?.value || ""
        )
            .trim()
            .slice(
                0,
                120
            );

    const countryCode =
        String(
            raw?.countryCode ||
            fallbackCountryCode ||
            ""
        )
            .trim()
            .toUpperCase();

    if (
        countryCode &&
        !/^[A-Z]{2}$/.test(
            countryCode
        )
    ) {
        throw createHttpError(
            400,
            "TAX_IDENTITY_COUNTRY_INVALID"
        );
    }

    if (
        required &&
        !type
    ) {
        throw createHttpError(
            400,
            "TAX_IDENTITY_TYPE_REQUIRED"
        );
    }

    if (
        required &&
        !value
    ) {
        throw createHttpError(
            400,
            "TAX_IDENTITY_VALUE_REQUIRED"
        );
    }

    if (
        !type &&
        !label &&
        !value
    ) {
        return null;
    }

    return {
        type,

        label:
            label ||
            type,

        value,

        countryCode,

        active:
            raw?.active !==
            false,
    };
}


function validateTaxIdentityInput(
    raw = {},
    fallbackCountryCode = "DO"
) {
    const enabled =
        raw?.enabled ===
        true;

    const countryCode =
        String(
            raw?.countryCode ||
            fallbackCountryCode ||
            "DO"
        )
            .trim()
            .toUpperCase();

    if (
        !/^[A-Z]{2}$/.test(
            countryCode
        )
    ) {
        throw createHttpError(
            400,
            "TAX_IDENTITY_COUNTRY_INVALID"
        );
    }

    const legalName =
        String(
            raw?.legalName || ""
        )
            .trim()
            .slice(
                0,
                160
            );

    if (
        enabled &&
        !legalName
    ) {
        throw createHttpError(
            400,
            "TAX_IDENTITY_LEGAL_NAME_REQUIRED"
        );
    }

    const primaryTaxId =
        normalizeTaxIdentifierInput(
            raw?.primaryTaxId,
            {
                required:
                enabled,

                fallbackCountryCode:
                countryCode,
            }
        );

    const incomingAdditional =
        Array.isArray(
            raw?.additionalTaxIds
        )
            ? raw.additionalTaxIds
            : [];

    if (
        incomingAdditional.length >
        10
    ) {
        throw createHttpError(
            400,
            "TOO_MANY_TAX_IDENTIFIERS"
        );
    }

    const additionalTaxIds =
        incomingAdditional
            .map(
                (
                    identifier
                ) =>
                    normalizeTaxIdentifierInput(
                        identifier,
                        {
                            required:
                                false,

                            fallbackCountryCode:
                            countryCode,
                        }
                    )
            )
            .filter(Boolean);

    return {
        enabled,
        countryCode,
        legalName,
        primaryTaxId,
        additionalTaxIds,
    };
}
function normalizeTenantTaxIdentity(
    tenant
) {
    const raw =
        tenant?.taxIdentity ||
        {};

    const localization =
        normalizeTenantLocalization(
            tenant
        );

    const legacyRnc =
        String(
            tenant
                ?.business
                ?.rnc ||
            tenant
                ?.fiscal
                ?.rnc ||
            ""
        ).trim();

    const hasNewIdentity =
        Boolean(
            raw?.legalName ||
            raw?.primaryTaxId
                ?.value ||
            (
                Array.isArray(
                    raw
                        ?.additionalTaxIds
                ) &&
                raw
                    .additionalTaxIds
                    .length >
                0
            )
        );

    if (
        hasNewIdentity
    ) {
        return {
            enabled:
                raw.enabled ===
                true,

            countryCode:
                String(
                    raw.countryCode ||
                    localization
                        .countryCode
                )
                    .trim()
                    .toUpperCase(),

            legalName:
                String(
                    raw.legalName ||
                    tenant
                        ?.business
                        ?.name ||
                    tenant?.name ||
                    ""
                ).trim(),

            primaryTaxId:
                raw.primaryTaxId ||
                null,

            additionalTaxIds:
                Array.isArray(
                    raw
                        .additionalTaxIds
                )
                    ? raw
                        .additionalTaxIds
                    : [],
        };
    }

    /*
     * Compatibilidad legacy RD.
     *
     * No modifica MongoDB.
     * Solo presenta el RNC viejo
     * como taxIdentity hasta que
     * el usuario guarde la pantalla.
     */
    return {
        enabled:
            Boolean(
                legacyRnc
            ),

        countryCode:
        localization
            .countryCode,

        legalName:
            String(
                tenant
                    ?.business
                    ?.name ||
                tenant?.name ||
                ""
            ).trim(),

        primaryTaxId:
            legacyRnc
                ? {
                    type:
                        "RNC",

                    label:
                        "RNC",

                    value:
                    legacyRnc,

                    countryCode:
                        "DO",

                    active:
                        true,
                }
                : null,

        additionalTaxIds:
            [],
    };
}
function validateLocalizationInput(
    raw = {}
) {
    const countryCode =
        String(
            raw.countryCode || ""
        )
            .trim()
            .toUpperCase();

    if (
        !/^[A-Z]{2}$/.test(
            countryCode
        )
    ) {
        throw new Error(
            "Código de país inválido. Usa 2 letras, por ejemplo DO, US o GB."
        );
    }

    const language =
        String(
            raw.language || ""
        )
            .trim()
            .toLowerCase();

    if (
        !/^[a-z]{2,3}$/.test(
            language
        )
    ) {
        throw new Error(
            "Idioma inválido."
        );
    }

    const locale =
        String(
            raw.locale || ""
        ).trim();

    try {
        new Intl.NumberFormat(
            locale
        );
    } catch {
        throw new Error(
            "Locale inválido."
        );
    }

    const currency =
        String(
            raw.currency || ""
        )
            .trim()
            .toUpperCase();

    if (
        !/^[A-Z]{3}$/.test(
            currency
        )
    ) {
        throw new Error(
            "Moneda inválida."
        );
    }

    try {
        new Intl.NumberFormat(
            locale,
            {
                style:
                    "currency",

                currency,
            }
        );
    } catch {
        throw new Error(
            "Moneda no soportada."
        );
    }

    const timezone =
        String(
            raw.timezone || ""
        ).trim();

    try {
        new Intl.DateTimeFormat(
            locale,
            {
                timeZone:
                timezone,
            }
        );
    } catch {
        throw new Error(
            "Zona horaria inválida."
        );
    }

    const dateFormat =
        String(
            raw.dateFormat || ""
        ).trim();

    if (
        ![
            "DD/MM/YYYY",
            "MM/DD/YYYY",
            "YYYY-MM-DD",
        ].includes(
            dateFormat
        )
    ) {
        throw new Error(
            "Formato de fecha inválido."
        );
    }

    const timeFormat =
        String(
            raw.timeFormat || ""
        ).trim();

    if (
        ![
            "12h",
            "24h",
        ].includes(
            timeFormat
        )
    ) {
        throw new Error(
            "Formato de hora inválido."
        );
    }

    const measurementSystem =
        String(
            raw.measurementSystem ||
            ""
        ).trim();

    if (
        ![
            "metric",
            "imperial",
        ].includes(
            measurementSystem
        )
    ) {
        throw new Error(
            "Sistema de medidas inválido."
        );
    }

    const weightUnit =
        String(
            raw.weightUnit || ""
        ).trim();

    if (
        ![
            "lb",
            "kg",
        ].includes(
            weightUnit
        )
    ) {
        throw new Error(
            "Unidad de peso inválida."
        );
    }

    return {
        countryCode,
        language,
        locale,
        currency,
        timezone,
        dateFormat,
        timeFormat,
        measurementSystem,
        weightUnit,
    };
}

function normalizeTaxCode(
    value
) {
    return String(
        value || ""
    )
        .trim()
        .toUpperCase()
        .replace(
            /[^A-Z0-9_-]/g,
            "_"
        )
        .slice(
            0,
            30
        );
}

function validateTaxConfigInput(
    raw = {}
) {
    const enabled =
        raw.enabled !==
        false;

    const incomingTaxes =
        Array.isArray(
            raw.taxes
        )
            ? raw.taxes
            : [];

    if (
        incomingTaxes.length >
        20
    ) {
        throw new Error(
            "Puedes configurar un máximo de 20 impuestos."
        );
    }

    const usedIds =
        new Set();

    const usedCodes =
        new Set();

    const taxes =
        incomingTaxes.map(
            (
                tax,
                index
            ) => {
                let id =
                    String(
                        tax?.id ||
                        ""
                    ).trim();

                if (!id) {
                    id =
                        `tax_${crypto.randomUUID()}`;
                }

                if (
                    usedIds.has(id)
                ) {
                    throw new Error(
                        `El impuesto #${index + 1} tiene un ID duplicado.`
                    );
                }

                usedIds.add(id);

                const name =
                    String(
                        tax?.name ||
                        ""
                    ).trim();

                if (!name) {
                    throw new Error(
                        `El impuesto #${index + 1} necesita un nombre.`
                    );
                }

                const code =
                    normalizeTaxCode(
                        tax?.code ||
                        name
                    );

                if (!code) {
                    throw new Error(
                        `El impuesto "${name}" necesita un código.`
                    );
                }

                if (
                    usedCodes.has(
                        code
                    )
                ) {
                    throw new Error(
                        `El código ${code} está repetido.`
                    );
                }

                usedCodes.add(
                    code
                );

                const ratePercent =
                    Number(
                        tax
                            ?.ratePercent
                    );

                if (
                    !Number.isFinite(
                        ratePercent
                    ) ||
                    ratePercent <
                    0 ||
                    ratePercent >
                    100
                ) {
                    throw new Error(
                        `Porcentaje inválido para "${name}".`
                    );
                }

                return {
                    id,

                    name:
                        name.slice(
                            0,
                            80
                        ),

                    code,

                    ratePercent:
                        Number(
                            ratePercent
                                .toFixed(4)
                        ),

                    active:
                        tax?.active !==
                        false,

                    includedInPrice:
                        tax
                            ?.includedInPrice ===
                        true,

                    appliesToDeliveryFee:
                        tax
                            ?.appliesToDeliveryFee ===
                        true,
                };
            }
        );

    const activeTaxes =
        taxes.filter(
            (tax) =>
                tax.active
        );

    if (
        enabled &&
        activeTaxes.length === 0
    ) {
        throw new Error(
            "Si los impuestos están activos, debes tener al menos un impuesto activo."
        );
    }

    let defaultTaxId =
        String(
            raw.defaultTaxId ||
            ""
        ).trim();

    if (
        !activeTaxes.some(
            (tax) =>
                tax.id ===
                defaultTaxId
        )
    ) {
        defaultTaxId =
            activeTaxes[0]?.id ||
            null;
    }

    return {
        enabled,
        defaultTaxId,
        taxes,
    };
}
exports.getFiscalConfig = async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const tenant =
            await Tenant.findOne({
                tenantId,
            }).select(
                "plan fiscal features business localization taxConfig taxIdentity name"
            );
        const normalizedPlan = normalizePlan(tenant?.plan);
        const planFeatures = getPlanFeatures(normalizedPlan);

        const f = tenant?.features || {};
        const localization =
            normalizeTenantLocalization(
                tenant
            );

        const taxConfig =
            normalizeTenantTaxConfig(
                tenant
            );
        const taxIdentity =
            normalizeTenantTaxIdentity(
                tenant
            );
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
                plan:
                normalizedPlan,

                planFeatures,

                localization,

                taxIdentity,

                taxConfig,

                fiscal:
                    tenant?.fiscal ||
                    null,

                features:
                norm,

                business:
                    tenant?.business ||
                    null,
            },
        });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
    }
};

function normalizeServiceChargesInput(
    raw
) {
    const enabled =
        raw?.enabled ===
        true;

    const charges =
        Array.isArray(
            raw?.charges
        )
            ? raw.charges
            : [];

    if (
        charges.length >
        20
    ) {
        throw createHttpError(
            400,
            "TOO_MANY_SERVICE_CHARGES"
        );
    }

    const ids =
        new Set();

    const codes =
        new Set();

    const normalized =
        charges.map(
            (
                charge,
                index
            ) => {
                const id =
                    String(
                        charge?.id ||
                        `charge_${index + 1}`
                    ).trim();

                const name =
                    String(
                        charge?.name ||
                        ""
                    ).trim();

                const code =
                    String(
                        charge?.code ||
                        ""
                    )
                        .trim()
                        .toUpperCase();

                const ratePercent =
                    Number(
                        charge
                            ?.ratePercent
                    );

                if (!id) {
                    throw createHttpError(
                        400,
                        "SERVICE_CHARGE_ID_REQUIRED"
                    );
                }

                if (!name) {
                    throw createHttpError(
                        400,
                        "SERVICE_CHARGE_NAME_REQUIRED"
                    );
                }

                if (!code) {
                    throw createHttpError(
                        400,
                        "SERVICE_CHARGE_CODE_REQUIRED"
                    );
                }

                if (
                    !Number.isFinite(
                        ratePercent
                    ) ||
                    ratePercent < 0 ||
                    ratePercent > 100
                ) {
                    throw createHttpError(
                        400,
                        "SERVICE_CHARGE_RATE_INVALID"
                    );
                }

                if (
                    ids.has(id)
                ) {
                    throw createHttpError(
                        400,
                        "SERVICE_CHARGE_ID_DUPLICATED"
                    );
                }

                if (
                    codes.has(code)
                ) {
                    throw createHttpError(
                        400,
                        "SERVICE_CHARGE_CODE_DUPLICATED"
                    );
                }

                ids.add(id);
                codes.add(code);

                return {
                    id,

                    name,

                    code,

                    ratePercent,

                    active:
                        charge?.active !==
                        false,

                    calculationBase:
                        charge
                            ?.calculationBase ===
                        "AFTER_TAX"
                            ? "AFTER_TAX"
                            : "NET",
                    appliesToDeliveryOrders:
                        charge
                            ?.appliesToDeliveryOrders !==
                        false,

                    appliesToDeliveryFee:
                        charge
                            ?.appliesToDeliveryFee ===
                        true,

                    addToTotal:
                        charge
                            ?.addToTotal !==
                        false,
                };
            }
        );

    return {
        enabled,
        charges:
        normalized,
    };
}

exports.updateFiscalConfig = async (req, res) => {

    try {
        const tenantId = req.user.tenantId;

        const tenantPrev =
            await Tenant.findOne({
                tenantId,
            }).select(
                "plan features fiscal business localization taxConfig taxIdentity"
            );

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

        // ======================================================
// LOCALIZACIÓN
// ======================================================

        if (
            req.body?.localization &&
            typeof req.body
                .localization ===
            "object"
        ) {
            const localization =
                validateLocalizationInput(
                    req.body
                        .localization
                );

            $set[
                "localization.countryCode"
                ] =
                localization.countryCode;

            $set[
                "localization.language"
                ] =
                localization.language;

            $set[
                "localization.locale"
                ] =
                localization.locale;

            $set[
                "localization.currency"
                ] =
                localization.currency;

            $set[
                "localization.timezone"
                ] =
                localization.timezone;

            $set[
                "localization.dateFormat"
                ] =
                localization.dateFormat;

            $set[
                "localization.timeFormat"
                ] =
                localization.timeFormat;

            $set[
                "localization.measurementSystem"
                ] =
                localization
                    .measurementSystem;

            $set[
                "localization.weightUnit"
                ] =
                localization.weightUnit;
        }
        // ======================================================
        // IDENTIDAD FISCAL INTERNACIONAL
        // ======================================================

        if (
            req.body?.taxIdentity &&
            typeof req.body
                .taxIdentity ===
            "object"
        ) {
            const fallbackCountryCode =
                req.body
                    ?.localization
                    ?.countryCode ||
                tenantPrev
                    ?.localization
                    ?.countryCode ||
                "DO";

            const taxIdentity =
                validateTaxIdentityInput(
                    req.body
                        .taxIdentity,
                    fallbackCountryCode
                );

            $set[
                "taxIdentity"
                ] =
                taxIdentity;
        }
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

        // ======================================================
// MOTOR DE IMPUESTOS GENÉRICO
// ======================================================

        if (
            req.body?.taxConfig &&
            typeof req.body
                .taxConfig ===
            "object"
        ) {
            const taxConfig =
                validateTaxConfigInput(
                    req.body.taxConfig
                );
            const previousIds = new Set((tenantPrev?.taxConfig?.taxes || []).map((tax) => String(tax.id)));
            const nextIds = new Set((taxConfig.taxes || []).map((tax) => String(tax.id)));
            const removedIds = [...previousIds].filter((id) => !nextIds.has(id));
            if (removedIds.length) {
                const linkedProducts = await Dish.countDocuments({
                    tenantId, taxId: { $in: removedIds }
                });
                if (linkedProducts) {
                    return res.status(409).json({ success: false, code: "TAX_ASSIGNED_TO_PRODUCTS",
                        message: "El impuesto está asignado a productos. Reasígnalos o desactiva el impuesto antes de eliminarlo.",
                        linkedProducts });
                }
            }

            $set["taxConfig"] =
                taxConfig;

            // Compatibilidad temporal:
            // Bill.jsx todavía mira
            // features.tax.enabled.
            //
            // En Fase 2B eliminaremos
            // esta dependencia.
            $set[
                "features.tax.enabled"
                ] =
                taxConfig.enabled;
        }
        // ======================================================
        // CARGOS AUTOMÁTICOS / SERVICE CHARGES
        // ======================================================

        if (
            req.body
                ?.features
                ?.serviceCharges !==
            undefined
        ) {
            const serviceCharges =
                normalizeServiceChargesInput(
                    req.body
                        .features
                        .serviceCharges
                );

            $set[
                "features.serviceCharges"
                ] =
                serviceCharges;
        }
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

        const updated =
            await Tenant.findOneAndUpdate(
                {
                    tenantId,
                },
                {
                    $set,
                },
                {
                    new: true,
                }
            ).select(
                "plan fiscal features business localization taxConfig taxIdentity"
            );

        const io = req.app.get("io");
        if (io) {
            io.to(
                `tenant:${tenantId}`
            ).emit(
                "tenant:configUpdated",
                {
                    tenantId,

                    localization:
                    updated.localization,

                    taxIdentity:
                    updated.taxIdentity,

                    taxConfig:
                    updated.taxConfig,

                    features:
                    updated.features,

                    fiscal:
                    updated.fiscal,

                    business:
                    updated.business,
                }
            );
        }

        return res.json({
            success: true,

            data: {
                plan:
                    normalizePlan(
                        updated.plan
                    ),

                planFeatures:
                    getPlanFeatures(
                        updated.plan
                    ),

                localization:
                updated.localization,

                taxIdentity:
                updated.taxIdentity,

                taxConfig:
                updated.taxConfig,

                fiscal:
                updated.fiscal,

                features:
                updated.features,

                business:
                updated.business,
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
        edit: false,
    },
    fiscal: { ecfIssue:false, creditNote:false, debitNote:false, manage:false },
    accountsReceivable: {
        view: false,
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
            edit: Boolean(permissions?.orders?.edit),
        },
        fiscal: {
            ecfIssue: Boolean(permissions?.fiscal?.ecfIssue),
            creditNote: Boolean(permissions?.fiscal?.creditNote),
            debitNote: Boolean(permissions?.fiscal?.debitNote),
            manage: false, // nunca delegar el control de certificados
        },
        accountsReceivable: {
            view: Boolean(
                permissions?.accountsReceivable?.view
            ),
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
                countryCode: String(tenant.localization?.countryCode || "DO").toUpperCase(),
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