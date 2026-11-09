"use strict";
const { createMoveTableOrderHandler } = require("../services/orders/moveTableOrder");
module.exports = createMoveTableOrderHandler({
  Order: require("../models/orderModel"),
  Table: require("../models/tableModel"),
  ElectronicTaxDocument: require("../models/electronicTaxDocumentModel"),
});
