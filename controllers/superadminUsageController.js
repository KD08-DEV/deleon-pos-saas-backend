const Tenant = require("../models/tenantModel");
const Membership = require("../models/membershipModel");
const Dish = require("../models/dish");
const Table = require("../models/tableModel");
const TIERS = require("../config/planTiers");

// Misma lógica que /api/admin/usage pero aplicada a TODOS los tenants
exports.getTenantUsage = async (req, res) => {
    try {
        const tenants = await Tenant.find().lean(); // motor, Lizzie, etc.

        const results = await Promise.all(
            tenants.map(async (tenant) => {
                const tenantId = tenant.tenantId;
                const tier = TIERS[tenant.plan] || TIERS.emprendedor;
                const limits = tier.limits || {};

                // Contadores por tenant (solo memberships activas)
                const [totalUsers, admins, cajeras, camareros, dishes, tables] =
                    await Promise.all([
                        Membership.countDocuments({ tenantId, status: "active" }),
                        Membership.countDocuments({
                            tenantId,
                            status: "active",
                            role: { $in: ["Owner", "Admin"] },
                        }),
                        Membership.countDocuments({
                            tenantId,
                            status: "active",
                            role: "Cajeras",
                        }),
                        Membership.countDocuments({
                            tenantId,
                            status: "active",
                            role: "Camareros",
                        }),
                        Dish.countDocuments({ tenantId }),
                        Table.countDocuments({ tenantId }),
                    ]);

                const remaining = (limit, used) =>
                    limit === null || limit === undefined
                        ? null
                        : Math.max(limit - used, 0);

                return {
                    tenantId,
                    name: tenant.name,
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
                };
            })
        );

        return res.status(200).json({ success: true, data: results });
    } catch (err) {
        console.error("❌ Error en getTenantUsage:", err);
        return res
            .status(500)
            .json({ success: false, message: "Error al obtener usage de tenants" });
    }
};
