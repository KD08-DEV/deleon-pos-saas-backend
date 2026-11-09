"use strict";
const { branchFilter } = require("./closeAndVacateOrder");
const id = value => String(value?._id || value || "");
function conflict(code) {
  return Object.assign(new Error(code), { status: 409, statusCode: 409 });
}
// Historical orders remain readable. Only their operational reuse is forbidden.
async function assertActiveTableOrder({ order, Table, tenantId, clientId, incoming = {} }) {
  if (order.tableReleasedAt) throw conflict("ORDER_TABLE_RELEASED");
  if (Object.prototype.hasOwnProperty.call(incoming, "table") && id(incoming.table) !== id(order.table)) {
    throw conflict("TABLE_MOVE_USE_DEDICATED_ENDPOINT");
  }
  if (!order.table) return;
  const table = await Table.findOne({ _id: id(order.table), tenantId, ...branchFilter(clientId) }).lean();
  const sameSession = table?.tableSessionId && order.tableSessionId && table.tableSessionId === order.tableSessionId;
  if (!table || table.status === "Disponible" || (!sameSession && id(table.currentOrder) !== id(order))) {
    throw conflict("ORDER_TABLE_RELEASED");
  }
}
module.exports = { assertActiveTableOrder };
