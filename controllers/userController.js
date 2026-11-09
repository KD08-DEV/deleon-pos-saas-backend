const createHttpError = require("http-errors");
const User = require("../models/userModel");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const config = require("../config/config");
const { v4: uuidv4 } = require("uuid");
const Tenant = require("../models/tenantModel");
const Membership = require("../models/membershipModel");
const { selected } = require("../services/employeeBranchAccess");
const TIERS = require("../config/planTiers");
const { resolveTenantLocalization } = require("../config/tenantLocales");

function getPlanLimits(plan) {
    const tier = TIERS[String(plan || "emprendedor").trim().toLowerCase()] || TIERS.emprendedor;
    return {
        admins: tier.limits.maxAdmins,
        cajeras: tier.limits.maxCashiers,
        camareros: tier.limits.maxWaiters,
        maxUsers: tier.limits.maxUsers,
    };
}

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
        },
        accountsReceivable: {
            view: Boolean(
                permissions?.accountsReceivable?.view
            ),
        },
    };
}
function normalizeEmailKey(email) {
    return String(email || "").trim().toLowerCase();
}

function escapeRegex(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildEmailRegex(email) {
    return new RegExp(`^${escapeRegex(String(email || "").trim())}$`, "i");
}
const register = async (req, res, next) => {
    try {
        const { name, phone, email, password, role, tenantName, plan } = req.body;

        if (!name || !email || !password || !role) {
            return next(createHttpError(400, "Name, email, password and role are required!"));
        }

        // ✅ Declarar primero (para evitar el error "Cannot access tenantId before initialization")
        let tenantId;
        let membershipRole = "Camarero";

        // 🔥 CASO 1: SUPERADMIN crea un Admin (nueva empresa)
        if (req.user && req.user.role === "SuperAdmin" && role === "Admin") {
            const companyName = tenantName || `${name}'s Business`;
            const tenantPlan = (plan || "emprendedor").toLowerCase();
            const tenantTier =
                TIERS[tenantPlan] ||
                TIERS.emprendedor;

            const planAllowsFiscal =
                Boolean(
                    tenantTier?.features?.fiscal
                );

            // 1) Validar plan
            const allowedPlans = ["emprendedor", "estandar", "premium", "pro"];
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
            const localization = resolveTenantLocalization(req.body.localization || {});
            const isDominican = localization.countryCode === "DO";
            const fiscalPayload = isDominican ? (req.body.fiscal || {}) : {};

            const normalizeCfg = (cfg = {}) => {
                const start = Number(cfg.start) || 1;
                const current = Number(cfg.current) || start;
                const max = Number(cfg.max) || 0;
                const active = Boolean(cfg.active);
                return { start, current, max, active };
            };

            const fiscalToSave = {
                enabled:
                    isDominican && planAllowsFiscal &&
                    Boolean(fiscalPayload.enabled),
                nextInvoiceNumber: Number(fiscalPayload.nextInvoiceNumber) || 1,
                ncfConfig: {
                    B01: normalizeCfg(fiscalPayload.ncfConfig?.B01),
                    B02: normalizeCfg(fiscalPayload.ncfConfig?.B02),
                },
            };

            // Si fiscal.enabled es false => apagamos los tipos
            if (
                !planAllowsFiscal ||
                !fiscalToSave.enabled
            ) {
                fiscalToSave.ncfConfig.B01.active = false;
                fiscalToSave.ncfConfig.B02.active = false;
            }

            // ✅ Crear tenant UNA sola vez (sin duplicados)
            await Tenant.create({
                tenantId,
                name: companyName,
                plan: tenantPlan,
                status: "active",
                localization,

                // BUSINESS INFO
                business: {
                    name: req.body.business?.name || null,
                    rnc: isDominican ? (req.body.business?.rnc || null) : null,
                    address: req.body.business?.address || null,
                    phone: req.body.business?.phone || null,
                },

                fiscal: fiscalToSave,
            });

            membershipRole = "Owner"; // primer admin = dueño
        }

        // 🔥 CASO 2: Admin de empresa crea empleados en SU tenant
        else if (req.scope?.membership && ["Owner", "Admin"].includes(req.scope.membership.role)) {
            tenantId = req.user.tenantId;

            if (!tenantId) {
                return next(createHttpError(403, "Tenant not identified for Admin!"));
            }

            const tenant = await Tenant.findOne({ tenantId });
            if (!tenant) {
                return next(createHttpError(404, "Tenant not found!"));
            }

            const limits = getPlanLimits(tenant.plan);
            // Always use the branch validated by requireScope, never an untrusted tenant/branch in POST data.
            const activeClientId = selected(req.scope?.clientId);
            if (req.body.clientIds !== undefined &&
                (!Array.isArray(req.body.clientIds) || req.body.clientIds.length !== 1 || String(req.body.clientIds[0]) !== activeClientId)) {
                return next(createHttpError(403, "BRANCH_ASSIGNMENT_MISMATCH"));
            }

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
                if (limits.admins !== null && countAdmins >= limits.admins) {
                    return next(createHttpError(403, "Admin limit reached for this plan!"));
                }
                membershipRole = "Admin";
            } else if (role === "Cajera") {
                const countCashiers = await Membership.countDocuments({
                    tenantId,
                    role: "Cajera",
                    status: "active",
                });
                if (limits.cajeras !== null && countCashiers >= limits.cajeras) {
                    return next(
                        createHttpError(
                            403,
                            "Se alcanzó el límite de cajeros para este plan!"
                        )
                    );
                }
                membershipRole = "Cajera";
            } else if (role === "Camarero" || role === "Cocina") {
                const countWaitersAndKitchen = await Membership.countDocuments({
                    tenantId,
                    role: { $in: ["Camarero", "Cocina"] },
                    status: "active",
                });

                if (limits.camareros !== null && countWaitersAndKitchen >= limits.camareros) {
                    return next(
                        createHttpError(
                            403,
                            "¡Se alcanzó el límite de camareros/cocina para este plan!"
                        )
                    );
                }

                membershipRole = role;
            } else {
                return next(createHttpError(400, "Invalid role!"));
            }
        } else {
            return next(createHttpError(403, "¡No está permitido crear este usuario!"));
        }

        // ✅ AQUÍ VA EL CHECK (cuando tenantId ya está definido)
        if (!tenantId) {
            return next(createHttpError(400, "tenantId is required"));
        }

        const cleanEmail = String(email || "").trim();
        const emailKey = normalizeEmailKey(cleanEmail);

        if (!emailKey) {
            return next(createHttpError(400, "Email is required!"));
        }

        // ✅ Validar usuario existente en ESTE tenant sin importar mayúsculas/minúsculas
        const isUserPresent = await User.findOne({
            tenantId,
            $or: [
                { emailKey },
                { email: { $regex: buildEmailRegex(cleanEmail) } }, // fallback para usuarios viejos
            ],
        });

        if (isUserPresent) {
            return next(createHttpError(400, "User already exist!"));
        }

        // Crear usuario
        const newUser = await User.create({
            name: String(name || "").trim(),
            phone: String(phone || "").trim(),
            email: cleanEmail,       // ✅ se guarda como lo escribiste
            emailKey,                // ✅ se usa para login y validación
            password,
            role,
            tenantId,
        });

        // Crear membership
        try {
            await Membership.create({
                user: newUser._id,
                tenantId,
                role: membershipRole,
                clientIds: [req.scope?.clientId || "default"],
                status: "active",
            });
        } catch (membershipError) {
            await User.deleteOne({ _id: newUser._id, tenantId });
            throw membershipError;
        }

        return res.status(201).json({
            success: true,
            message: "New user created!",
            data: { _id: newUser._id, name: newUser.name, email: newUser.email, phone: newUser.phone, role: newUser.role, tenantId: newUser.tenantId },
        });
    } catch (error) {
        return next(error);
    }
};


const login = async (req, res, next) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return next(createHttpError(400, "All fields are required!"));
        }

        const cleanEmail = String(email || "").trim();
        const emailKey = normalizeEmailKey(cleanEmail);

        // 🔥 LOGIN SUPERADMIN case-insensitive para el correo
        const superAdminEmailKey = normalizeEmailKey(process.env.SUPERADMIN_EMAIL);

        if (
            emailKey === superAdminEmailKey &&
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
                maxAge: 1000 * 60 * 60 * 24,
                httpOnly: true,
                sameSite: "lax",
                secure: config.nodeEnv === "production",
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

        // 🔐 LOGIN USUARIO NORMAL case-insensitive
        const isUserPresent = await User.findOne({
            $or: [
                { emailKey },
                { email: { $regex: buildEmailRegex(cleanEmail) } }, // fallback para usuarios viejos
            ],
        }).select("+password");

        if (!isUserPresent) {
            return next(createHttpError(401, "Invalid Credentials"));
        }

        const isMatch = await bcrypt.compare(password, isUserPresent.password);

        if (!isMatch) {
            return next(createHttpError(401, "Invalid Credentials"));
        }

        const membership = await Membership.findOne({
            user: isUserPresent._id,
            tenantId: isUserPresent.tenantId,
            status: "active",
        }).lean();

        // El login no debe crear una sesión cuando la membresía está
        // suspendida, pendiente o ya no existe.
        if (!membership) {
            return next(createHttpError(403, "Account membership unavailable"));
        }
        const tenant = await Tenant.findOne({ tenantId: isUserPresent.tenantId })
            .select("status").lean();
        if (!tenant || tenant.status !== "active") {
            return next(createHttpError(403, "Business unavailable"));
        }

        const normalizedPermissions = normalizePermissions(
            membership.permissions || DEFAULT_PERMISSIONS
        );

        const { deviceId } = req.body;
        const sessionId = uuidv4();

        await User.updateOne(
            { _id: isUserPresent._id },
            {
                $set: {
                    activeSessionId: sessionId,
                    activeDeviceId: deviceId || null,
                    lastLoginAt: new Date(),
                    emailKey: normalizeEmailKey(isUserPresent.email), // ✅ repara usuarios viejos al iniciar sesión
                },
            }
        );

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
            maxAge: 1000 * 60 * 60 * 24,
            httpOnly: true,
            sameSite: "lax",
            secure: config.nodeEnv === "production",
        });

        return res.status(200).json({
            message: "User login successfully!",
            token: accessToken,
            data: {
                _id: isUserPresent._id,
                name: isUserPresent.name,
                email: isUserPresent.email, // ✅ devuelve el correo como fue guardado
                role: isUserPresent.role,
                membershipRole: membership?.role || isUserPresent.role,
                tenantId: isUserPresent.tenantId,
                clientIds: membership?.clientIds || ["default"],
                permissions: normalizedPermissions,
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
                    permissions: DEFAULT_PERMISSIONS,
                },
            });
        }

        const user = await User.findById(req.user._id).select("-activeSessionId -activeDeviceId").lean();

        if (!user) {
            return next(createHttpError(404, "USER_NOT_FOUND"));
        }

        const membership = await Membership.findOne({
            user: user._id,
            tenantId: user.tenantId,
            status: "active",
        }).lean();

        return res.status(200).json({
            success: true,
            data: {
                ...user,

                // Mantener rol real para frontend/protected routes.
                role: user.role,

                // Membership separado.
                membershipRole: membership?.role || user.role,

                clientIds: membership?.clientIds || ["default"],
                permissions: normalizePermissions(
                    membership?.permissions || DEFAULT_PERMISSIONS
                ),
            },
        });
    } catch (error) {
        next(error);
    }
};

const logout = async (req, res, next) => {
    try {
        if (req.user.role !== "SuperAdmin") await User.updateOne(
            { _id: req.user._id },
            { $set: { activeSessionId: null, activeDeviceId: null } }
        );
        try {
            if (req.user.role !== "SuperAdmin") {
                req.app?.get?.("io")
                    ?.in?.(`tenant:${req.user.tenantId}:user:${req.user._id}`)
                    ?.disconnectSockets?.(true);
            }
        } catch (socketError) {
            console.error(
                "SOCKET_LOGOUT_DISCONNECT_FAILED",
                socketError?.message
            );
        }

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

        if (fiscalEnabled === true) {
            const tenantForCountry = await Tenant.findOne({ tenantId }).select("plan localization.countryCode").lean();
            if (!tenantForCountry) return res.status(404).json({ message: "Tenant not found" });
            if (String(tenantForCountry.localization?.countryCode || "DO").toUpperCase() !== "DO") {
                return res.status(403).json({ code: "DGII_ONLY_DOMINICAN_REPUBLIC" });
            }
            if (!TIERS[tenantForCountry.plan]?.features?.fiscal) {
                return res.status(403).json({ code: "PLAN_FISCAL_DENIED" });
            }
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

