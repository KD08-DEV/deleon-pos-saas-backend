const createHttpError = require("http-errors");
const User = require("../models/userModel");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const config = require("../config/config");
const { v4: uuidv4 } = require("uuid");
const Tenant = require("../models/tenantModel");
const Membership = require("../models/membershipModel");
const TIERS = require("../config/planTiers");

function getPlanLimits(plan) {
    const tier = TIERS[plan] || TIERS.emprendedor;
    return {
        admins: tier.limits.maxAdmins,
        cajeras: tier.limits.maxCashiers,
        camareros: tier.limits.maxWaiters,
        maxUsers: tier.limits.maxUsers,
    };
}

const register = async (req, res, next) => {
    try {
        const { name, phone, email, password, role, tenantName, plan } = req.body;

        if (!name || !phone || !email || !password || !role) {
            const error = createHttpError(400, "All fields are required!");
            return next(error);
        }

        // 💡 SUPERADMIN no está en la DB, así que este chequeo es por email global.
        const isUserPresent = await User.findOne({ email, tenantId })

        if (isUserPresent) {
            const error = createHttpError(400, "User already exist!");
            return next(error);
        }

        let tenantId;
        let membershipRole = "Camarero";

/// 🔥 CASO 1: SUPERADMIN crea un Admin (nueva empresa)
        if (req.user && req.user.role === "SuperAdmin" && role === "Admin") {
            const companyName = tenantName || `${name}'s Business`;
            const tenantPlan = (plan || "emprendedor").toLowerCase();

            // 1) Validar plan
            const allowedPlans = ["emprendedor", "premium", "vip"];
            if (!allowedPlans.includes(tenantPlan)) {
                return next(createHttpError(400, "Invalid plan for tenant!"));
            }

            // 2) Evitar nombres de tenant duplicados (case-insensitive)
            const existingTenant = await Tenant.findOne({
                name: { $regex: `^${companyName}$`, $options: "i" },
            });
            if (existingTenant) {
                return next(
                    createHttpError(400, "Tenant name already exists. Choose another.")
                );
            }

            tenantId = uuidv4();

            // ✅ FISCAL INFO (nuevo formato)
            const fiscalPayload = req.body.fiscal || {};

            const normalizeCfg = (cfg = {}) => {
                const start = Number(cfg.start) || 1;
                const current = Number(cfg.current) || start;
                const max = Number(cfg.max) || 0;
                const active = Boolean(cfg.active);
                return { start, current, max, active };
            };

            const fiscalToSave = {
                enabled: Boolean(fiscalPayload.enabled),
                nextInvoiceNumber: Number(fiscalPayload.nextInvoiceNumber) || 1,
                ncfConfig: {
                    B01: normalizeCfg(fiscalPayload.ncfConfig?.B01),
                    B02: normalizeCfg(fiscalPayload.ncfConfig?.B02),
                },
            };

            // Si fiscal.enabled es false => apagamos los tipos
            if (!fiscalToSave.enabled) {
                fiscalToSave.ncfConfig.B01.active = false;
                fiscalToSave.ncfConfig.B02.active = false;
            }

            // ✅ Crear tenant UNA sola vez (sin duplicados)
            await Tenant.create({
                tenantId,
                name: companyName,
                plan: tenantPlan,
                status: "active",

                // BUSINESS INFO
                business: {
                    name: req.body.business?.name || null,
                    rnc: req.body.business?.rnc || null,
                    address: req.body.business?.address || null,
                    phone: req.body.business?.phone || null,
                },

                fiscal: fiscalToSave,
            });

            membershipRole = "Owner"; // primer admin = dueño
        }

        // 🔥 CASO 2: Admin de empresa crea empleados en SU tenant
        else if (req.user && req.user.role === "Admin") {
            tenantId = req.user.tenantId;
            if (!tenantId) {
                const error = createHttpError(403, "Tenant not identified for Admin!");
                return next(error);
            }

            const tenant = await Tenant.findOne({ tenantId });
            if (!tenant) {
                const error = createHttpError(404, "Tenant not found!");
                return next(error);
            }
            const limits = getPlanLimits(tenant.plan);

            // 🔐 Límite TOTAL de usuarios del tenant
            const totalUsers = await Membership.countDocuments({
                tenantId,
                status: "active",
            });

            if (limits.maxUsers !== null && totalUsers >= limits.maxUsers) {
                return next(
                    createHttpError(
                        403,
                        `User limit reached for your plan. Maximum allowed: ${limits.maxUsers}`
                    )
                );
            }
            // Contar memberships activas por rol
            if (role === "Admin") {
                const countAdmins = await Membership.countDocuments({
                    tenantId,
                    role: { $in: ["Owner", "Admin"] },
                    status: "active",
                });
                if (countAdmins >= limits.admins) {
                    return next(
                        createHttpError(403, "Admin limit reached for this plan!")
                    );
                }
                membershipRole = "Admin";
            } else if (role === "Cajera") {
                const countCashiers = await Membership.countDocuments({
                    tenantId,
                    role: "Cajera",
                    status: "active",
                });
                if (countCashiers >= limits.cajeras) {
                    return next(
                        createHttpError(403, "Se alcanzó el límite de cajeros para este plan!")
                    );
                }
                membershipRole = "Cajera";
            } else if (role === "Camarero") {
                const countWaiters = await Membership.countDocuments({
                    tenantId,
                    role: "Camarero",
                    status: "active",
                });
                if (countWaiters >= limits.camareros) {
                    return next(
                        createHttpError(403, "¡Se alcanzó el límite de camareros para este plan!")
                    );
                }
                membershipRole = "Camarero";
            } else {
                return next(createHttpError(400, "Invalid role!"));
            }
        } else {
            const error = createHttpError(403, "¡No está permitido crear este usuario!");
            return next(error);
        }

        // Crear usuario
        const newUser = await User.create({
            name,
            phone,
            email,
            password,
            role,      // Admin / Cashier / Waiter
            tenantId,  // NO existe para SuperAdmin porque él no se guarda aquí
        });

        // Crear membership
        await Membership.create({
            user: newUser._id,
            tenantId,
            role: membershipRole, // Owner/Admin/Cashier/Waiter
            clientIds: ["default"],
            status: "active",
        });

        res
            .status(201)
            .json({ success: true, message: "New user created!", data: newUser });
    } catch (error) {
        next(error);
    }
};

const login = async (req, res, next) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            const error = createHttpError(400, "All fields are required!");
            return next(error);
        }

        // 🔥 LOGIN SUPERADMIN (no va contra la DB)
        if (
            email === process.env.SUPERADMIN_EMAIL &&
            password === process.env.SUPERADMIN_PASSWORD
        ) {
            const accessToken = jwt.sign(
                {
                    super: true,
                    role: "SuperAdmin",
                },
                config.accessTokenSecret,
                { expiresIn: "1d" }
            );

            res.cookie("accessToken", accessToken, {
                maxAge: 1000 * 60 * 60 * 24 * 30,
                httpOnly: true,
                sameSite: "lax",
                secure: false,
            });

            return res.status(200).json({
                message: "SuperAdmin login successfully!",
                token: accessToken,
                data: {
                    name: process.env.SUPERADMIN_NAME || "SuperAdmin",
                    email: process.env.SUPERADMIN_EMAIL,
                    role: "SuperAdmin",
                    tenantId: null,
                },
            });
        }

        // 🔐 LOGIN USUARIO NORMAL
        const isUserPresent = await User.findOne({ email });
        if (!isUserPresent) {
            return next(createHttpError(401, "Invalid Credentials"));
        }

        const isMatch = await bcrypt.compare(password, isUserPresent.password);
        if (!isMatch) {
            return next(createHttpError(401, "Invalid Credentials"));
        }

// ✅ 1) Crear nueva sesión (invalidará la anterior)
        const { deviceId } = req.body; // opcional
        const sessionId = uuidv4();

// ✅ 2) Guardar session activa en el usuario
        await User.updateOne(
            { _id: isUserPresent._id },
            {
                $set: {
                    activeSessionId: sessionId,
                    activeDeviceId: deviceId || null,
                    lastLoginAt: new Date(),
                },
            }
        );

// ✅ 3) Incluir sid en el JWT
        const accessToken = jwt.sign(
            {
                _id: isUserPresent._id,
                tenantId: isUserPresent.tenantId,
                role: isUserPresent.role,
                sid: sessionId,
            },
            config.accessTokenSecret,
            { expiresIn: "1d" }
        );

        res.cookie("accessToken", accessToken, {
            maxAge: 1000 * 60 * 60 * 24 * 30,
            httpOnly: true,
            sameSite: "lax",
            secure: false,
        });

        return res.status(200).json({
            message: "User login successfully!",
            token: accessToken,
            data: {
                _id: isUserPresent._id,
                name: isUserPresent.name,
                email: isUserPresent.email,
                role: isUserPresent.role,
                tenantId: isUserPresent.tenantId,
            },
        });
    } catch (error) {
        next(error);
    }
};

const getUserData = async (req, res, next) => {
    try {
        // SUPERADMIN
        if (req.user.role === "SuperAdmin") {
            return res.status(200).json({
                success: true,
                data: {
                    name: process.env.SUPERADMIN_NAME || "SuperAdmin",
                    email: process.env.SUPERADMIN_EMAIL,
                    role: "SuperAdmin",
                    tenantId: null,
                },
            });
        }

        const user = await User.findById(req.user._id);
        res.status(200).json({ success: true, data: user });
    } catch (error) {
        next(error);
    }
};

const logout = async (req, res, next) => {
    try {
        await User.updateOne(
            { _id: req.user._id },
            { $set: { activeSessionId: null, activeDeviceId: null } }
        );
        res.clearCookie("accessToken");
        res
            .status(200)
            .json({ success: true, message: "User logout successfully!" });
    } catch (error) {
        next(error);
    }
};
// ✅ PATCH /api/superadmin/tenants/:tenantId/features
// Body soportado (2 formas):
// A) { taxEnabled: false, discountEnabled: false, fiscalEnabled: false }
// B) { features: { tax: { enabled: false }, discount: { enabled: false }, fiscal: { enabled: false } } }

const updateTenantFeatures = async (req, res, next) => {
    try {
        // tenantId viene por URL
        const { tenantId } = req.params;

        if (!tenantId) {
            return res.status(400).json({ success: false, message: "tenantId is required" });
        }

        // Soportar ambos formatos
        const taxEnabled =
            req.body?.taxEnabled ?? req.body?.features?.tax?.enabled;

        const discountEnabled =
            req.body?.discountEnabled ?? req.body?.features?.discount?.enabled;

        const fiscalEnabled =
            req.body?.fiscalEnabled ?? req.body?.features?.fiscal?.enabled;

        // Validación: si viene definido, debe ser boolean
        const isBool = (v) => typeof v === "boolean";

        if (taxEnabled !== undefined && !isBool(taxEnabled)) {
            return res.status(400).json({ success: false, message: "taxEnabled must be boolean" });
        }
        if (discountEnabled !== undefined && !isBool(discountEnabled)) {
            return res.status(400).json({ success: false, message: "discountEnabled must be boolean" });
        }
        if (fiscalEnabled !== undefined && !isBool(fiscalEnabled)) {
            return res.status(400).json({ success: false, message: "fiscalEnabled must be boolean" });
        }

        // Construir $set solo con lo que venga
        const $set = {};
        if (taxEnabled !== undefined) $set["features.tax.enabled"] = taxEnabled;
        if (discountEnabled !== undefined) $set["features.discount.enabled"] = discountEnabled;
        if (fiscalEnabled !== undefined) $set["features.fiscal.enabled"] = fiscalEnabled;

        if (Object.keys($set).length === 0) {
            return res.status(400).json({
                success: false,
                message: "No features provided to update",
            });
        }

        const tenant = await Tenant.findOneAndUpdate(
            { tenantId },
            { $set },
            { new: true }
        );

        if (!tenant) {
            return res.status(404).json({ success: false, message: "Tenant not found" });
        }

        return res.json({
            success: true,
            message: "Tenant features updated",
            data: tenant,
        });
    } catch (error) {
        next(error);
    }
};



module.exports = { register, login, getUserData, logout, updateTenantFeatures };

