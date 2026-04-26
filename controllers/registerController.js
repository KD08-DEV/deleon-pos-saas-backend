const createHttpError = require("http-errors");
const mongoose = require("mongoose");
const Register = require("../models/registerModel");

const getScope = (req) => {
    const tenantId =
        req.tenantId ||
        req.scope?.tenantId ||
        req.user?.tenantId ||
        req.headers["x-tenant-id"] ||
        req.headers["x-tenant"];

    const clientId =
        req.clientId ||
        req.scope?.clientId ||
        req.headers["x-client-id"] ||
        req.body?.clientId ||
        req.query?.clientId ||
        "default";

    const role = req.user?.role || req.scope?.membership?.role || null;

    return { tenantId, clientId, role };
};

const normalizeCode = (v = "") =>
    String(v || "")
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "");

const normalizeName = (v = "") => String(v || "").trim();
const normalizeLocation = (v = "") => String(v || "").trim();

const listRegisters = async (req, res, next) => {
    try {
        const { tenantId, clientId, role } = getScope(req);

        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!clientId) return next(createHttpError(400, "MISSING_CLIENT_ID"));

        const includeInactive = String(req.query?.includeInactive || "").trim() === "1";
        const isAdmin = role === "Admin" || role === "Owner";

        const query = { tenantId, clientId };

        // Cajera solo ve activas
        if (!isAdmin || !includeInactive) {
            query.isActive = true;
        }

        const items = await Register.find(query)
            .populate("defaultCashierUserId", "name email role")
            .sort({
                sortOrder: 1,
                name: 1,
                createdAt: 1,
            });

        return res.status(200).json({ success: true, data: items });
    } catch (err) {
        return next(createHttpError(500, "LIST_REGISTERS_FAILED"));
    }
};

const createRegister = async (req, res, next) => {
    try {
        const { tenantId, clientId } = getScope(req);

        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!clientId) return next(createHttpError(400, "MISSING_CLIENT_ID"));

        const code = normalizeCode(req.body?.code);
        const name = normalizeName(req.body?.name);
        const location = normalizeLocation(req.body?.location);
        const isActive = req.body?.isActive !== undefined ? Boolean(req.body.isActive) : true;
        const sortOrder = Number(req.body?.sortOrder ?? 0);
        const defaultCashierUserId =
            req.body?.defaultCashierUserId && mongoose.Types.ObjectId.isValid(req.body.defaultCashierUserId)
                ? req.body.defaultCashierUserId
                : null;

        if (!code) return next(createHttpError(400, "MISSING_REGISTER_CODE"));
        if (!name) return next(createHttpError(400, "MISSING_REGISTER_NAME"));
        if (!Number.isFinite(sortOrder)) return next(createHttpError(400, "INVALID_SORT_ORDER"));

        const exists = await Register.findOne({ tenantId, clientId, code });
        if (exists) return next(createHttpError(409, "REGISTER_CODE_ALREADY_EXISTS"));

        const created = await Register.create({
            tenantId,
            clientId,
            code,
            name,
            location,
            isActive,
            sortOrder,
            defaultCashierUserId,
        });

        return res.status(201).json({ success: true, data: created });
    } catch (err) {
        if (err?.code === 11000) {
            return next(createHttpError(409, "REGISTER_CODE_ALREADY_EXISTS"));
        }
        return next(createHttpError(500, "CREATE_REGISTER_FAILED"));
    }
};

const updateRegister = async (req, res, next) => {
    try {
        const { tenantId, clientId } = getScope(req);

        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!clientId) return next(createHttpError(400, "MISSING_CLIENT_ID"));

        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return next(createHttpError(400, "INVALID_REGISTER_ID"));
        }

        const current = await Register.findOne({ _id: id, tenantId, clientId });
        if (!current) return next(createHttpError(404, "REGISTER_NOT_FOUND"));

        const nextCode =
            req.body?.code !== undefined ? normalizeCode(req.body.code) : current.code;

        const nextName =
            req.body?.name !== undefined ? normalizeName(req.body.name) : current.name;

        const nextLocation =
            req.body?.location !== undefined ? normalizeLocation(req.body.location) : current.location;

        const nextIsActive =
            req.body?.isActive !== undefined ? Boolean(req.body.isActive) : current.isActive;

        const nextSortOrder =
            req.body?.sortOrder !== undefined ? Number(req.body.sortOrder) : current.sortOrder;

        const nextDefaultCashierUserId =
            req.body?.defaultCashierUserId !== undefined
                ? (
                    req.body.defaultCashierUserId &&
                    mongoose.Types.ObjectId.isValid(req.body.defaultCashierUserId)
                        ? req.body.defaultCashierUserId
                        : null
                )
                : current.defaultCashierUserId;
        current.defaultCashierUserId = nextDefaultCashierUserId;

        if (!nextCode) return next(createHttpError(400, "MISSING_REGISTER_CODE"));
        if (!nextName) return next(createHttpError(400, "MISSING_REGISTER_NAME"));
        if (!Number.isFinite(nextSortOrder)) return next(createHttpError(400, "INVALID_SORT_ORDER"));

        if (nextCode !== current.code) {
            const duplicate = await Register.findOne({
                tenantId,
                clientId,
                code: nextCode,
                _id: { $ne: current._id },
            });

            if (duplicate) return next(createHttpError(409, "REGISTER_CODE_ALREADY_EXISTS"));
        }

        current.code = nextCode;
        current.name = nextName;
        current.location = nextLocation;
        current.isActive = nextIsActive;
        current.sortOrder = nextSortOrder;

        await current.save();

        return res.status(200).json({ success: true, data: current });
    } catch (err) {
        if (err?.code === 11000) {
            return next(createHttpError(409, "REGISTER_CODE_ALREADY_EXISTS"));
        }
        return next(createHttpError(500, "UPDATE_REGISTER_FAILED"));
    }
};

const toggleRegister = async (req, res, next) => {
    try {
        const { tenantId, clientId } = getScope(req);

        if (!tenantId) return next(createHttpError(400, "MISSING_TENANT_ID"));
        if (!clientId) return next(createHttpError(400, "MISSING_CLIENT_ID"));

        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return next(createHttpError(400, "INVALID_REGISTER_ID"));
        }

        const current = await Register.findOne({ _id: id, tenantId, clientId });
        if (!current) return next(createHttpError(404, "REGISTER_NOT_FOUND"));

        current.isActive =
            req.body?.isActive !== undefined ? Boolean(req.body.isActive) : !current.isActive;

        await current.save();

        return res.status(200).json({ success: true, data: current });
    } catch (err) {
        return next(createHttpError(500, "TOGGLE_REGISTER_FAILED"));
    }
};

module.exports = {
    listRegisters,
    createRegister,
    updateRegister,
    toggleRegister,
};