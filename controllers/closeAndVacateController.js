"use strict";
const Order = require("../models/orderModel");
const Table = require("../models/tableModel");
const Tenant = require("../models/tenantModel");
const ElectronicTaxDocument = require("../models/electronicTaxDocumentModel");
const { deductInventoryForOrder } = require("../services/inventory/deductInventoryForOrder");
const { createCloseAndVacateHandler } = require("../services/orders/closeAndVacateOrder");
const closeAndVacateOrder = createCloseAndVacateHandler({
  Order, Table, Tenant, ElectronicTaxDocument, deductInventoryForOrder
});
module.exports = { closeAndVacateOrder };
