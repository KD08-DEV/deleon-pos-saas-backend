const Table = require("../models/tableModel");
const createHttpError = require("http-errors");
const mongoose = require("mongoose");
const Tenant = require("../models/tenantModel");
const TIERS = require("../config/planTiers");

const addTable = async (req, res, next) => {
    // 🔒 límites por plan: mesas
    const tenant = await Tenant.findOne({ tenantId: req.user.tenantId });
    if (!tenant) {
        return next(createHttpError(404, "Tenant not found!"));
    }

    const tier = TIERS[tenant.plan] || TIERS.basic;
    const maxTables = tier.limits.maxTables;

    if (maxTables !== null) {
        const currentTables = await Table.countDocuments({
            tenantId: req.user.tenantId,
        });

        if (currentTables >= maxTables) {
            return next(
                createHttpError(403, "Table limit reached for your current plan.")
            );
        }
    }
  try {
    const { tableNo, seats } = req.body;
    if (!tableNo) {
      const error = createHttpError(400, "Please provide table No!");
      return next(error);
    }
    const isTablePresent = await Table.findOne({ tableNo, tenantId: req.user.tenantId });

    if (isTablePresent) {
      const error = createHttpError(400, "Table already exist!");
      return next(error);
    }

      const newTable = new Table({
          tableNo,
          seats,
          tenantId: req.tenantId || req.user?.tenantId,
          clientId: req.clientId || "default"
      });
    await newTable.save();
    res
      .status(201)
      .json({ success: true, message: "Table added!", data: newTable });
  } catch (error) {
    next(error);
  }
};

const getTables = async (req, res, next) => {
    try {
        // Trae todas las mesas y su orden actual (si existe)
        const tables = await Table.find({ tenantId: req.user.tenantId })
            .populate({ path: "currentOrder", model: "Order", select: "_id customerDetails orderStatus total" });

        res.status(200).json({ success: true, data: tables });
    } catch (error) {
        console.error("Error en getTables:", error);
        next(error);
    }
};

const deleteTable = async (req, res, next) => {
    try {
        const { id } = req.params;
        await Table.findOneAndDelete({ _id: id, tenantId: req.user.tenantId });
        res.status(200).json({ success: true, message: "Table removed!" });
    } catch (error) {
        next(error);
    }
};

const updateTable = async (req, res, next) => {
  try {
    const { status, orderId } = req.body;

    const { id } = req.params;

    if(!mongoose.Types.ObjectId.isValid(id)){
        const error = createHttpError(404, "Invalid id!");
        return next(error);
    }

    const table = await Table.findOneAndUpdate(
        { _id: id, tenantId: req.user.tenantId },
        { status, currentOrder: orderId },
        { new: true }
    );


    if (!table) {
      const error = createHttpError(404, "Table not found!");
      return error;
    }

    res.status(200).json({success: true, message: "Table updated!", data: table});

  } catch (error) {
    next(error);
  }
};

module.exports = { addTable, getTables, updateTable, deleteTable };
