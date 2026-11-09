"use strict";
const { verifiedScope, branchFilter } = require("./closeAndVacateOrder");
const id = value => String(value?._id || value || "");
const valid = value => /^[a-f\d]{24}$/i.test(id(value));
const fail = (code, status = 409) => { throw Object.assign(new Error(code), { status, code }); };

function createMoveTableOrderHandler({ Order, Table, ElectronicTaxDocument }) {
  return async (req, res, next) => {
    let session;
    try {
      const scope = verifiedScope(req);
      if (!scope) fail("TABLE_MOVE_PERMISSION_DENIED", 403);
      const sourceId = id(req.params.id), targetId = id(req.body?.targetTableId), orderId = id(req.body?.orderId);
      if (![sourceId, targetId, orderId].every(valid) || sourceId === targetId) fail("INVALID_TABLE_MOVE", 400);
      const { tenantId, clientId } = scope;
      const base = { tenantId, ...branchFilter(clientId) };
      session = await Order.db.startSession();
      const result = await session.withTransaction(async () => {
        const source = await Table.findOne({ _id: sourceId, ...base }).session(session).lean();
        const target = await Table.findOne({ _id: targetId, ...base }).session(session).lean();
        const order = await Order.findOne({ _id: orderId, ...base }).session(session).lean();
        if (!source || !target || !order) fail("TABLE_OR_ORDER_NOT_FOUND", 404);
        // A retry after commit must never move the order back or touch a new occupant.
        if (!order.tableReleasedAt && id(order.table) === targetId && id(target.currentOrder) === orderId) {
          return { alreadyMoved: true };
        }
        if (order.tableReleasedAt || id(order.table) !== sourceId || id(source.currentOrder) !== orderId || source.status === "Disponible") {
          fail("TABLE_ORDER_CHANGED");
        }
        if (target.status !== "Disponible" || target.currentOrder || target.tableSessionId) fail("TARGET_TABLE_OCCUPIED");
        if (["Completado", "Cancelado"].includes(order.orderStatus) || order.paymentStatus === "Pagado" ||
            order.invoicedAt || order.invoiceNumber || order.facturaNo || order.invoicePath || order.invoiceUrl ||
            order.ncfNumber || order.fiscal?.ncfNumber || order.fiscal?.issuedAt || order.inventoryDeducted ||
            order.paidAt || order.accountReceivableId) fail("ORDER_NOT_MOVABLE");
        if (await ElectronicTaxDocument.exists({ ...base, orderId: order._id }).session(session)) fail("ORDER_NOT_MOVABLE");
        if (source.tableSessionId && await Order.exists({ ...base, table: source._id,
          tableSessionId: source.tableSessionId, _id: { $ne: order._id }, orderStatus: { $ne: "Cancelado" }
        }).session(session)) fail("TABLE_HAS_MULTIPLE_ACCOUNTS");
        const reserved = await Table.updateOne({ _id: target._id, ...base, status: "Disponible", currentOrder: null, tableSessionId: null },
          { $set: { currentOrder: order._id, tableSessionId: source.tableSessionId || null, status: source.status } }, { session });
        if (reserved.matchedCount !== 1) fail("TARGET_TABLE_OCCUPIED");
        const moved = await Order.updateOne({ _id: order._id, ...base, table: source._id, updatedAt: order.updatedAt },
          { $set: { table: target._id } }, { session });
        if (moved.matchedCount !== 1) fail("TABLE_ORDER_CHANGED");
        const released = await Table.updateOne({ _id: source._id, ...base, currentOrder: order._id },
          { $set: { status: "Disponible", currentOrder: null, tableSessionId: null } }, { session });
        if (released.matchedCount !== 1) fail("TABLE_ORDER_CHANGED");
        return { alreadyMoved: false };
      });
      for (const event of ["tenant:tablesUpdated", "tenant:orderUpdated"]) {
        try { req.app?.get?.("io")?.to?.(`tenant:${tenantId}:branch:${clientId}`)?.emit?.(event,
          { tenantId, clientId, orderId, sourceTableId: sourceId, tableId: targetId }); }
        catch (error) { console.error("SOCKET_POST_COMMIT_NOTIFICATION_FAILED", error.message); }
      }
      return res.json({ success: true, data: { ...result, orderId, sourceTableId: sourceId, tableId: targetId } });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ success: false, code: error.code || error.message });
      return next(error);
    } finally { if (session) await session.endSession(); }
  };
}
module.exports = { createMoveTableOrderHandler };
