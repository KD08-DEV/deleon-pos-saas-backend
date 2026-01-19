const createHttpError = require("http-errors");
const jwt = require("jsonwebtoken");
const config = require("../config/config");
const User = require("../models/userModel");

const verifyToken = async (req, res, next) => {
    try {


        const authHeader = req.headers.authorization;
        const cookieToken = req.cookies?.accessToken;

        let accessToken = null;

            //  Header (localhost)
        if (authHeader && authHeader.startsWith("Bearer ")) {
            accessToken = authHeader.split(" ")[1];
        }

            //  Cookie (producción)
        if (!accessToken && cookieToken) {
            accessToken = cookieToken;
        }

        if (!accessToken) {
            return next(createHttpError(401, "No token provided"));
        }

        if (!accessToken) {
            return next(createHttpError(401, "Please provide token!"));
        }

        const decoded = jwt.verify(accessToken, config.accessTokenSecret);

        // 🔥 SUPERADMIN (no viene de la DB)
        if (decoded.super === true && decoded.role === "SuperAdmin") {
            req.user = {
                _id: null,
                role: "SuperAdmin",
                tenantId: null,
            };
            return next();
        }

        // 🔐 Usuario normal (de la base de datos)=
        const user = await User.findById(decoded._id).select("_id role tenantId activeSessionId");
        if (!user) {
            return next(createHttpError(401, "User not exist!"));
        }

// ✅ Si el token no tiene sid o no coincide => sesión inválida (logueado en otro dispositivo)
        if (!decoded.sid || !user.activeSessionId || decoded.sid !== user.activeSessionId) {
            return next(createHttpError(401, "Session expired. Your account is active on another device."));
        }

        req.user = {
            _id: user._id,
            role: user.role,
            tenantId: user.tenantId,
        };

        next();

    } catch (error) {

        return next(createHttpError(401, "Invalid Token!"));

    }

};

module.exports = verifyToken;
