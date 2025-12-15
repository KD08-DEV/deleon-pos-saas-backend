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
    const tier = TIERS[plan] || TIERS.basic;
    return {
        admins: tier.limits.maxAdmins,
        cashiers: tier.limits.maxCashiers,
        waiters: tier.limits.maxWaiters,
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
        const isUserPresent = await User.findOne({ email });
        if (isUserPresent) {
            const error = createHttpError(400, "User already exist!");
            return next(error);
        }

        let tenantId;
        let membershipRole = "Waiter";

// 🔥 CASO 1: SUPERADMIN crea un Admin (nueva empresa)
        if (req.user && req.user.role === "SuperAdmin" && role === "Admin") {
            const companyName = tenantName || `${name}'s Business`;
            const tenantPlan = (plan || "basic").toLowerCase();

            // 1) Validar plan
            const allowedPlans = ["basic", "pro", "enterprise"];
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

            await Tenant.create({
                tenantId,
                name: companyName,
                plan: tenantPlan,
                status: "active",

                // BUSINESS INFO
                business: {
                    name: req.body.business?.name || req.body.commercialName,
                    rnc: req.body.business?.rnc || req.body.rnc || null,
                    address: req.body.business?.address || req.body.businessAddress || null,
                    phone: req.body.business?.phone || req.body.businessPhone || null
                },

                // FISCAL INFO
                fiscal: {
                    ncfType: req.body.ncfType || "B02",
                    ncfNumber: req.body.ncfNumber || null,
                    issueDate: req.body.issueDate || null,
                }
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
            } else if (role === "Cashier") {
                const countCashiers = await Membership.countDocuments({
                    tenantId,
                    role: "Cashier",
                    status: "active",
                });
                if (countCashiers >= limits.cashiers) {
                    return next(
                        createHttpError(403, "Cashier limit reached for this plan!")
                    );
                }
                membershipRole = "Cashier";
            } else if (role === "Waiter") {
                const countWaiters = await Membership.countDocuments({
                    tenantId,
                    role: "Waiter",
                    status: "active",
                });
                if (countWaiters >= limits.waiters) {
                    return next(
                        createHttpError(403, "Waiter limit reached for this plan!")
                    );
                }
                membershipRole = "Waiter";
            } else {
                return next(createHttpError(400, "Invalid role!"));
            }
        } else {
            const error = createHttpError(403, "Not allowed to create this user!");
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
            const error = createHttpError(401, "Invalid Credentials");
            return next(error);
        }

        const isMatch = await bcrypt.compare(password, isUserPresent.password);
        if (!isMatch) {
            const error = createHttpError(401, "Invalid Credentials");
            return next(error);
        }

        const accessToken = jwt.sign(
            {
                _id: isUserPresent._id,
                tenantId: isUserPresent.tenantId,
                role: isUserPresent.role,
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

        res.status(200).json({
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
        res.clearCookie("accessToken");
        res
            .status(200)
            .json({ success: true, message: "User logout successfully!" });
    } catch (error) {
        next(error);
    }
};

module.exports = { register, login, getUserData, logout };
