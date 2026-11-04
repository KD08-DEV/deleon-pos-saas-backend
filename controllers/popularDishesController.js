"use strict";
const mongoose = require("mongoose");
const Order = require("../models/orderModel");
const Dish = require("../models/dish");

// Clasificación histórica de unidades vendidas, sin el filtro de fechas del informe financiero.
// Los extras no cuentan como platos separados. Se excluyen borradores y cancelaciones.
async function getAllTimePopularDishes(req, res, next) {
    try {
        if (!req.tenantId || !req.clientId) {
            return res.status(403).json({ success: false, code: "BRANCH_SCOPE_REQUIRED" });
        }
        const branchFilter = req.clientId === "default"
            ? { $or: [{ clientId: "default" }, { clientId: { $exists: false } }, { clientId: null }, { clientId: "" }] }
            : { clientId: req.clientId };
        const matches = {
            tenantId: req.tenantId,
            ...branchFilter,
            isDraft: { $ne: true },
            orderStatus: { $nin: ["Cancelado", "Cancelled", "Canceled"] },
            "items.0": { $exists: true },
            $and: [{ $or: [
                { paymentStatus: "Pagado" },
                { orderStatus: { $in: ["Completado", "Completed"] } },
                { accountReceivableId: { $exists: true, $ne: null } },
                { invoicedAt: { $type: "date" } },
            ] }],
        };
        const rows = await Order.aggregate([
            { $match: matches },
            { $unwind: "$items" },
            { $project: {
                dishId: { $convert: { input: "$items.dishId", to: "string", onError: "", onNull: "" } },
                name: { $trim: { input: { $ifNull: ["$items.name", ""] } } },
                category: { $ifNull: ["$items.category", ""] },
                qty: { $ifNull: ["$items.quantity", 0] },
            } },
            { $match: { name: { $ne: "" }, qty: { $gt: 0 } } },
            { $group: {
                _id: { $cond: [{ $ne: ["$dishId", ""] }, { $concat: ["id:", "$dishId"] }, { $concat: ["name:", { $toLower: "$name" }] }] },
                dishId: { $first: "$dishId" },
                name: { $first: "$name" },
                category: { $first: "$category" },
                qtySold: { $sum: "$qty" },
            } },
            { $sort: { qtySold: -1, name: 1 } },
            { $limit: 10 },
        ]).allowDiskUse(true);
        const ids = rows.map(r => r.dishId).filter(id => mongoose.isValidObjectId(id));
        const dishDocs = ids.length ? await Dish.find({
            _id: { $in: ids },
            tenantId: req.tenantId,
            ...(req.clientId === "default"
                ? { $or: [{ clientId: "default" }, { clientId: { $exists: false } }] }
                : { clientId: req.clientId }),
        }).select("name category imageUrl").lean() : [];
        const dishById = new Map(dishDocs.map(d => [String(d._id), d]));
        res.set("Cache-Control", "private, no-store");
        return res.json({ success: true, data: rows.map(r => {
            const dish = dishById.get(r.dishId);
            return {
                dishId: r.dishId || r._id,
                name: r.name,
                category: r.category || dish?.category || "",
                imageUrl: dish?.imageUrl || "/placeholder.jpg",
                qtySold: r.qtySold,
            };
        }) });
    } catch (error) { return next(error); }
}
module.exports = { getAllTimePopularDishes };
