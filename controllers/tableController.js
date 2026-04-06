const Table = require("../models/tableModel");
const createHttpError = require("http-errors");
const mongoose = require("mongoose");
const Tenant = require("../models/tenantModel");
const TIERS = require("../config/planTiers");

const addTable = async (req, res, next) => {
    try {
        const { tableNo, seats, area } = req.body;

        if (!tableNo) return next(createHttpError(400, "Please provide table No!"));
        if (!seats || Number(seats) < 1)
            return next(createHttpError(400, "Please provide seats (>= 1)!"));

        const clientId = req.clientId || "default";

        // 🔒 límites por plan: mesas
        const tenant = await Tenant.findOne({ tenantId: req.user.tenantId });
        if (!tenant) return next(createHttpError(404, "Tenant not found!"));

        const tier = TIERS[tenant.plan] || TIERS.emprendedor;
        const maxTables = tier.limits.maxTables;

        if (maxTables !== null) {
            const currentTables = await Table.countDocuments({
                tenantId: req.user.tenantId,
                clientId,
            });
            if (currentTables >= maxTables) {
                return next(createHttpError(403, "Table limit reached for your current plan."));
            }
        }
        const normalizedArea = String(area || "General").trim();

        const isTablePresent = await Table.findOne({
            tableNo,
            tenantId: req.user.tenantId,
            clientId,
            area: normalizedArea,
        });
        if (isTablePresent) return next(createHttpError(400, "Table already exist!"));

        const newTable = new Table({
            tableNo,
            seats,
            area: String(area || "General").trim(),
            tenantId: req.user.tenantId,
            clientId,
        });

        await newTable.save();
        return res.status(201).json({ success: true, message: "Table added!", data: newTable });
    } catch (error) {
        next(error);
    }
};
const getTables = async (req, res, next) => {
    try {
        const clientId = req.clientId || "default";
        const tenantId = req.tenantId || req.user?.tenantId;

        const tables = await Table.find({
            tenantId,
            clientId,
        })
            .populate({
                path: "currentOrder",
                model: "Order",
                select: "_id customerDetails orderStatus total createdAt",
            })
            .lean();

        const staleTableIds = [];

        const sanitizedTables = tables.map((table) => {
            const currentOrder = table?.currentOrder || null;
            const currentOrderStatus = String(currentOrder?.orderStatus || "").trim();

            const hasClosedOrder =
                Boolean(currentOrder?._id) &&
                ["Cancelado", "Completado"].includes(currentOrderStatus);

            if (hasClosedOrder) {
                staleTableIds.push(table._id);

                return {
                    ...table,
                    status: "Disponible",
                    currentOrder: null,
                };
            }

            return table;
        });

        if (staleTableIds.length > 0) {
            await Table.updateMany(
                {
                    _id: { $in: staleTableIds },
                    tenantId,
                    clientId,
                },
                {
                    $set: {
                        status: "Disponible",
                        currentOrder: null,
                    },
                }
            );
        }

        return res.status(200).json({
            success: true,
            data: sanitizedTables,
        });
    } catch (error) {
        console.error("Error en getTables:", error);
        next(error);
    }
};

const deleteTable = async (req, res, next) => {
    try {
        const clientId = req.clientId || "default";
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return next(createHttpError(400, "Invalid table id"));
        }

        await Table.findOneAndDelete({
            _id: id,
            tenantId: req.user.tenantId,
            clientId,
        });

        res.status(200).json({ success: true, message: "Table removed!" });
    } catch (error) {
        next(error);
    }
};

const updateTable = async (req, res, next) => {
    try {
        const { status, orderId, area } = req.body;
        const { id } = req.params;
        const clientId = req.clientId || "default";

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return next(createHttpError(400, "Invalid table id"));
        }

        const update = {};
        if (area !== undefined) update.area = String(area || "General").trim();

        // Solo valida orderId cuando status quiere ser Ocupada/Reservada
        if (status === "Reservada" && !orderId) {
            return next(createHttpError(400, "No se puede marcar la mesa como reservada sin una orden"));
        }

        if (status === "Disponible") {
            update.status = "Disponible";
            update.currentOrder = null;

            const table = await Table.findOneAndUpdate(
                { _id: id, tenantId: req.user.tenantId, clientId },
                update,
                { new: true }
            );

            const io = req.app?.get?.("io");
            io?.to?.(`tenant:${req.user.tenantId}`)?.emit?.("tenant:tablesUpdated", {
                tenantId: req.user.tenantId,
                tableId: String(table?._id || id),
                orderId: null,
                status: "Disponible",
            });

            return res.status(200).json({
                success: true,
                message: "Table released",
                data: table,
            });
        }

        const nextStatus = status === "Reservada" ? "Reservada" : "Ocupada";
        update.status = nextStatus;
        update.currentOrder = orderId || null;

        const table = await Table.findOneAndUpdate(
            { _id: id, tenantId: req.user.tenantId, clientId },
            update,
            { new: true }
        );

        const io = req.app?.get?.("io");
        io?.to?.(`tenant:${req.user.tenantId}`)?.emit?.("tenant:tablesUpdated", {
            tenantId: req.user.tenantId,
            tableId: String(table?._id || id),
            orderId: update.currentOrder ? String(update.currentOrder) : null,
            status: nextStatus,
        });

        return res.status(200).json({
            success: true,
            message: "Table updated",
            data: table,
        });
    } catch (error) {
        next(error);
    }
};


module.exports = { addTable, getTables, updateTable, deleteTable };
