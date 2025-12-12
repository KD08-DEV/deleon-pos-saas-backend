const createHttpError = require("http-errors");
const jwt = require("jsonwebtoken");
const config = require("../config/config");
const User = require("../models/userModel");

const verifyToken = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return next(createHttpError(401, "No token provided"));
        }

        const accessToken = authHeader.split(" ")[1];
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

        // 🔐 Usuario normal (de la base de datos)
        const user = await User.findById(decoded._id).select("_id role tenantId");
        if (!user) {
            return next(createHttpError(401, "User not exist!"));
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
