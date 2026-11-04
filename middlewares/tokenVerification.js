const createHttpError = require("http-errors");
const jwt = require("jsonwebtoken");
const config = require("../config/config");
const User = require("../models/userModel");
const Membership = require("../models/membershipModel");

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

        // Nunca ejecutar findById ni conceder permisos con un JWT sin identidad/sesión.
        if (!decoded._id || !decoded.sid) {
            return next(createHttpError(401, "Invalid session"));
        }

        const user = await User.findById(decoded._id).select("_id role tenantId activeSessionId");
        if (!user) {
            return next(createHttpError(401, "User not exist!"));
        }

// ✅ Si el token no tiene sid o no coincide => sesión inválida (logueado en otro dispositivo)
        if (!decoded.sid || !user.activeSessionId || decoded.sid !== user.activeSessionId) {
            return next(createHttpError(401, "Session expired. Your account is active on another device."));
        }

        // Un JWT previamente expedido no debe mantener acceso tras revocar
        // o suspender la membresía. La consulta usa el índice tenantId+user.
        if (decoded.tenantId && String(decoded.tenantId) !== String(user.tenantId)) {
            return next(createHttpError(401, "Session tenant mismatch"));
        }
        const membership = await Membership.findOne({
            tenantId: user.tenantId,
            user: user._id,
            status: "active",
        });
        if (!membership) {
            return next(createHttpError(401, "Membership inactive"));
        }
        req.authzMembership = membership;
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
