const Order = require("../models/orderModel");
const User = require("../models/userModel");
const Payment = require("../models/paymentModel");
const Membership = require("../models/membershipModel");
const Dish = require("../models/dish");
const Table = require("../models/tableModel");
const Tenant = require("../models/tenantModel");
const TIERS = require("../config/planTiers");


// 🔹 Obtener reportes (ventas filtradas + resumen diario)
exports.getReports = async (req, res) => {
    try {

        const { from, to, method, user } = req.query;
        const filter = { tenantId: req.user.tenantId };

        // Filtrar por rango de fechas
        if (from && to) {
            filter.createdAt = { $gte: new Date(from), $lte: new Date(to) };
        }

        // Filtrar por método de pago (Cash / Online)
        if (method) {
            filter.paymentMethod = method;
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
            .populate("table", "tableNumber")
            .sort({ createdAt: -1 });

        // Calcular totales
        const totalSales = orders.reduce((sum, o) => sum + (o.totalAmount || 0), 0);
        const totalTax = orders.reduce((sum, o) => sum + (o.taxAmount || 0), 0);
        const orderCount = orders.length;
        const avgTicket = orderCount > 0 ? totalSales / orderCount : 0;

        // 🔹 Cierre de caja diario (resumen)
        const dailySummary = {
            totalSales,
            totalTax,
            orderCount,
            avgTicket: Number(avgTicket.toFixed(2)),
            cashSales: orders
                .filter((o) => o.paymentMethod === "Cash")
                .reduce((s, o) => s + o.totalAmount, 0),
            onlineSales: orders
                .filter((o) => o.paymentMethod === "Tarjeta")
                .reduce((s, o) => s + o.totalAmount, 0),
        };

        // 🔹 También agrupar por fecha (para gráficas)
        const groupedByDate = {};
        orders.forEach((o) => {
            const date = o.createdAt.toISOString().split("T")[0];
            if (!groupedByDate[date]) groupedByDate[date] = 0;
            groupedByDate[date] += o.totalAmount || 0;
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
        const employees = await User.find({
            tenantId: req.user.tenantId,
            role: { $ne: "Admin" },
        }).select("name email phone role");
        res.status(200).json({ success: true, data: employees });
    } catch (error) {
        console.error("❌ Error al obtener empleados:", error);
        res
            .status(500)
            .json({ success: false, message: "Error al obtener empleados" });
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
// 🔹 Uso del plan: usuarios, platos, mesas y límites
exports.getUsage = async (req, res) => {
    try {
        const tenantId = req.user.tenantId;

        // Tenant y plan
        const tenant = await Tenant.findOne({ tenantId });
        if (!tenant) {
            return res.status(404).json({ success: false, message: "Tenant not found" });
        }

        const tier = TIERS[tenant.plan] || TIERS.emprendedor;
        const limits = tier.limits || {};

        // Cálculos en paralelo
        const [totalUsers, admins, cashiers, waiters, dishes, tables] = await Promise.all([
            Membership.countDocuments({ tenantId, status: "active" }),
            Membership.countDocuments({ tenantId, status: "active", role: { $in: ["Owner", "Admin"] } }),
            Membership.countDocuments({ tenantId, status: "active", role: "Cajera" }),
            Membership.countDocuments({ tenantId, status: "active", role: "Waiter" }),
            Dish.countDocuments({ tenantId }),
            Table.countDocuments({ tenantId }),
        ]);

        const remaining = (limit, used) =>
            limit === null || limit === undefined ? null : Math.max(limit - used, 0);

        return res.status(200).json({
            success: true,
            data: {
                plan: tenant.plan,
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
                    cashiers,
                    waiters,
                    dishes,
                    tables,
                },
                remaining: {
                    users: remaining(limits.maxUsers, totalUsers),
                    admins: remaining(limits.maxAdmins, admins),
                    cashiers: remaining(limits.maxCashiers, cashiers),
                    waiters: remaining(limits.maxWaiters, waiters),
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
