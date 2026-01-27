const Order = require("../models/orderModel");
const User = require("../models/userModel");
const Payment = require("../models/paymentModel");
const Membership = require("../models/membershipModel");
const Dish = require("../models/dish");
const Table = require("../models/tableModel");
const Tenant = require("../models/tenantModel");
const TIERS = require("../config/planTiers");
const InventoryMovement = require("../models/inventoryMovementModel");



// 🔹 Obtener reportes (ventas filtradas + resumen diario)
exports.getReports = async (req, res) => {
    try {
        const { from, to, method, user } = req.query;

        const getClientId = (req) => {
            // prioridad: scope -> user -> headers (por si lo mandas)
            return (
                req.scope?.clientId ||
                req.user?.clientId ||
                req.user?.client?._id ||
                req.headers["x-client-id"] ||
                ""
            );
        };
        const tenantId = req.user.tenantId;
        const clientId = getClientId(req);

        // ✅ MERMA (waste) por rango de fechas (costo y cantidad)
        const mermaFilter = {
            tenantId,
            clientId,
            type: "waste",
        };

        if (from && to) {
            mermaFilter.createdAt = { $gte: new Date(from), $lte: new Date(to) };
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



        const filter = { tenantId, clientId };

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
            .populate("table", "tableNumber virtualType type isVirtual name")

            .sort({ createdAt: -1 });

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
            const date = o.createdAt.toISOString().split("T")[0];
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
        const employees = await User.find({
            tenantId: req.user.tenantId,
        }).select("_id name email phone role");
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

// 🔹 Actualizar empleado
exports.updateEmployee = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, email, phone, role, password } = req.body;


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

        // Preparar campos a actualizar
        const updateData = {};
        if (name && name.trim()) updateData.name = name.trim();
        if (email && email.trim()) {
            // Verificar que el email no esté en uso por otro usuario del mismo tenant
            const existingUser = await User.findOne({ 
                tenantId: req.user.tenantId, 
                email: email.trim(),
                _id: { $ne: id }
            });
            if (existingUser) {
                return res.status(400).json({ success: false, message: "El email ya está en uso por otro empleado" });
            }
            updateData.email = email.trim();
        }
        if (phone) {
            const phoneNum = Number(phone);
            if (isNaN(phoneNum) || phoneNum.toString().length !== 10) {
                return res.status(400).json({ success: false, message: "El teléfono debe ser un número de 10 dígitos" });
            }
            updateData.phone = phoneNum;
        }
        if (role && ["Admin", "Camarero", "Cajera"].includes(role)) {
            updateData.role = role;
        }
        // ✅ Enforce plan limits on role change
        if (role && role !== employee.role) {
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

            if (role === "Camarero") {
                const waitersCount = await Membership.countDocuments({
                    ...base,
                    role: "Camarero",
                });

                if (!isUnlimited(limits.maxWaiters) && waitersCount + 1 > limits.maxWaiters) {
                    return res.status(409).json({
                        success: false,
                        message: `Límite de Camareros alcanzado (${limits.maxWaiters}). Mejora el plan o cambia otro usuario de rol.`,
                    });
                }
            }
        }

        // Actualizar contraseña si se proporciona
        if (password && password.trim()) {
            if (password.length < 6) {
                return res.status(400).json({ success: false, message: "La contraseña debe tener al menos 6 caracteres" });
            }
            updateData.password = password.trim();
        }

        // Actualizar usuario
        const updatedEmployee = await User.findByIdAndUpdate(
            id,
            { $set: updateData },
            { new: true, runValidators: true }
        ).select("name email phone role");

        // Actualizar membership si el rol cambió
        if (role && role !== employee.role) {
            const Membership = require("../models/membershipModel");
            const membershipRoleMap = {
                "Admin": "Admin",
                "Cajera": "Cajera",
                "Camarero": "Camarero"
            };
            
            await Membership.updateMany(
                { user: id, tenantId: req.user.tenantId },
                { $set: { role: membershipRoleMap[role] || role } }
            );
        }

        res.status(200).json({ 
            success: true, 
            message: "Empleado actualizado exitosamente", 
            data: updatedEmployee 
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
        const tenant = await Tenant.findOne({ tenantId }).select("fiscal features");

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
            discount: {
                ...(f.discount || {}),
                enabled: typeof f.discount?.enabled === "boolean" ? f.discount.enabled : true,
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
                fiscal: tenant?.fiscal || null,
                features: norm,
            },
        });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
    }
};



exports.updateFiscalConfig = async (req, res) => {
    try {
        const tenantId = req.user.tenantId;


        // ✅ declarar primero (UNA sola vez)
        const $set = {};

        // ✅ leer values
        const fiscalEnabled = req.body?.fiscalEnabled;
        const taxEnabled = req.body?.features?.tax?.enabled;
        const tipEnabled = req.body?.features?.tip?.enabled;
        const discountEnabled = req.body?.features?.discount?.enabled;
        const orderSources = req.body?.features?.orderSources;

        // ✅ SOLO setear si viene boolean (para que false se guarde)
        if (typeof fiscalEnabled === "boolean") $set["fiscal.enabled"] = fiscalEnabled;
        if (typeof taxEnabled === "boolean") $set["features.tax.enabled"] = taxEnabled;
        if (typeof tipEnabled === "boolean") $set["features.tip.enabled"] = tipEnabled;
        if (typeof discountEnabled === "boolean") $set["features.discount.enabled"] = discountEnabled;

        const ncfConfig = req.body?.ncfConfig || {};
        const B01 = ncfConfig.B01;
        const B02 = ncfConfig.B02;

        const buildUpdateForType = (type, data) => {
            const u = {};
            if (!data) return u;

            ["start", "current", "max"].forEach((k) => {
                if (data[k] !== undefined && data[k] !== null && data[k] !== "") {
                    const n = Number(data[k]);
                    if (!Number.isFinite(n) || n < 0) throw new Error(`${type}.${k} inválido`);
                    u[`fiscal.ncfConfig.${type}.${k}`] = Math.floor(n);
                }
            });
            if (orderSources?.delivery) {
                if (typeof orderSources.delivery.enabled === "boolean") {
                    $set["features.orderSources.delivery.enabled"] = orderSources.delivery.enabled;
                }
            }

            if ("active" in data) u[`fiscal.ncfConfig.${type}.active`] = !!data.active;

            if ("expiresAt" in data) {
                if (!data.expiresAt) u[`fiscal.ncfConfig.${type}.expiresAt`] = null;
                else {
                    const d = new Date(data.expiresAt);
                    if (Number.isNaN(d.getTime())) throw new Error(`${type}.expiresAt inválido`);
                    u[`fiscal.ncfConfig.${type}.expiresAt`] = d;
                }
            }

            return u;
        };

        Object.assign($set, buildUpdateForType("B01", B01));
        Object.assign($set, buildUpdateForType("B02", B02));

        if (orderSources?.pedidosYa) {
            if (typeof orderSources.pedidosYa.enabled === "boolean") {
                $set["features.orderSources.pedidosYa.enabled"] = orderSources.pedidosYa.enabled;
            }
            if (orderSources.pedidosYa.commissionRate !== undefined) {
                const r = Number(orderSources.pedidosYa.commissionRate);
                if (!Number.isFinite(r) || r < 0 || r > 1) throw new Error("pedidosYa.commissionRate inválido (usa 0.26)");
                $set["features.orderSources.pedidosYa.commissionRate"] = r;
            }
        }

        if (orderSources?.uberEats) {
            if (typeof orderSources.uberEats.enabled === "boolean") {
                $set["features.orderSources.uberEats.enabled"] = orderSources.uberEats.enabled;
            }
            if (orderSources.uberEats.commissionRate !== undefined) {
                const r = Number(orderSources.uberEats.commissionRate);
                if (!Number.isFinite(r) || r < 0 || r > 1) throw new Error("uberEats.commissionRate inválido (usa 0.22)");
                $set["features.orderSources.uberEats.commissionRate"] = r;
            }
        }
        const tenantPrev = await Tenant.findOne({ tenantId }).select("features");
        const prev = tenantPrev?.features || {};
        const tenantPrev2 = await Tenant.findOne({ tenantId }).select("features fiscal");
        const prevFiscalEnabled =
            typeof tenantPrev2?.fiscal?.enabled === "boolean" ? tenantPrev2.fiscal.enabled : true;

        const currentFiscalEnabled =
            typeof fiscalEnabled === "boolean" ? fiscalEnabled : prevFiscalEnabled;



        const currentTaxEnabled =
            typeof taxEnabled === "boolean"
                ? taxEnabled
                : (typeof prev?.tax?.enabled === "boolean" ? prev.tax.enabled : true);

        const currentTipEnabled =
            typeof tipEnabled === "boolean"
                ? tipEnabled
                : (typeof prev?.tip?.enabled === "boolean" ? prev.tip.enabled : true);

        const currentDiscountEnabled =
            typeof discountEnabled === "boolean"
                ? discountEnabled
                : (typeof prev?.discount?.enabled === "boolean" ? prev.discount.enabled : true);

// SIEMPRE setearlos (para que nunca queden undefined)

        $set["fiscal.enabled"] = currentFiscalEnabled;
        $set["features.tax.enabled"] = currentTaxEnabled;
        $set["features.tip.enabled"] = currentTipEnabled;
        $set["features.discount.enabled"] = currentDiscountEnabled;


        const updated = await Tenant.findOneAndUpdate(
            { tenantId },
            { $set },
            { new: true }
        ).select("fiscal features");

        const io = req.app.get("io");
        if (io) {
            io.to(`tenant:${tenantId}`).emit("tenant:configUpdated", {
                tenantId,
                features: updated.features,
                fiscal: updated.fiscal,
            });
        }

        return res.json({
            success: true,
            data: { fiscal: updated.fiscal, features: updated.features },
        });
    } catch (e) {
        return res.status(400).json({ success: false, message: e.message });
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
        const [totalUsers, admins, cajeras, camareros, dishes, tables] = await Promise.all([
            Membership.countDocuments({ tenantId, status: "active" }),
            Membership.countDocuments({ tenantId, status: "active", role: { $in: ["Owner", "Admin"] } }),
            Membership.countDocuments({ tenantId, status: "active", role: "Cajera" }),
            Membership.countDocuments({ tenantId, status: "active", role: "Camarero" }),
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
