"use strict";
/**
 * Acción operativa posterior a la facturación: completar orden y liberar su mesa.
 * NO vuelve a entrar a updateOrder ni al motor de emisión e-CF/NCF.
 * Inyectamos dependencias para probar la política y el controlador sin MongoDB real.
 */
const OBJECT_ID = /^[a-f\d]{24}$/i;
const ROLE_ALLOWED = new Set(["Owner", "Admin", "Cajera", "Camarero"]);
function getId(v) { return String(v?._id || v || ""); }
function branchFilter(clientId) {
  return clientId === "default"
    ? { $or: [{ clientId: "default" }, { clientId: { $exists: false } }, { clientId: null }, { clientId: "" }] }
    : { clientId };
}
function verifiedScope(req) {
  const tenantId = String(req.scope?.tenantId || "");
  const clientId = String(req.scope?.clientId || "");
  const member = req.scope?.membership;
  if (!tenantId || !clientId || !member || member.status !== "active" ||
      !ROLE_ALLOWED.has(member.role) ||
      String(member.tenantId) !== tenantId ||
      getId(member.user) !== getId(req.user?._id)) return null;
  if (!["Owner", "Admin"].includes(member.role)) {
    const assigned = (member.clientIds || []).map(String);
    if (assigned.length ? !assigned.includes(clientId) : clientId !== "default") return null;
  }
  return { tenantId, clientId };
}
function createCloseAndVacateHandler({ Order, Table, ElectronicTaxDocument, Tenant,
  deductInventoryForOrder = async () => {}, isValidId = value => OBJECT_ID.test(String(value)) }) {
  if (!Order || !Table || !ElectronicTaxDocument || !Tenant) throw new Error("Missing dependencies");
  return async (req, res, next) => {
    const conflict = (status, code, extra = {}) => {
      const error = new Error(code);
      error.publicStatus = status;
      error.publicCode = code;
      error.publicExtra = extra;
      return error;
    };

    try {
      const scope = verifiedScope(req);

      if (!scope) {
        return res.status(403).json({
          success: false,
          code: "TABLE_RELEASE_PERMISSION_DENIED"
        });
      }

      const id = String(req.params.id || "");

      if (!isValidId(id)) {
        return res.status(404).json({
          success: false,
          code: "ORDER_NOT_FOUND"
        });
      }

      if (!Order.db || typeof Order.db.startSession !== "function") {
        throw new Error("MONGO_TRANSACTION_SESSION_UNAVAILABLE");
      }

      const { tenantId, clientId } = scope;
      const base = { tenantId, ...branchFilter(clientId) };
      const orderWhere = { _id: id, ...base };

      const session = await Order.db.startSession();
      let outcome;

      try {
        outcome = await session.withTransaction(async () => {
          const order = await Order.findOne(orderWhere)
            .session(session).lean();

          if (!order) {
            throw conflict(404, "ORDER_NOT_FOUND");
          }

          if (order.tableReleasedAt) {
            return { orderId: id, tableId: getId(order.table), alreadyReleased: true };
          }
          if (order.isDraft === true || order.orderStatus === "Cancelado") {
            throw conflict(409, "ORDER_NOT_ELIGIBLE_TO_RELEASE");
          }

          const tableId = getId(order.table);

          if (!isValidId(tableId)) {
            throw conflict(409, "ORDER_HAS_NO_TABLE");
          }

          // El cierre no emite ni modifica documentos fiscales.
          let invoiced = order.paymentStatus === "Pagado" ||
            Boolean(order.invoicedAt || order.invoiceNumber || order.facturaNo);

          if (!invoiced) {
            const ecf = await ElectronicTaxDocument.exists({
              tenantId,
              ...branchFilter(clientId),
              orderId: order._id,
              "ecf.status": {
                $in: ["accepted", "accepted_conditional"]
              }
            }).session(session);

            invoiced = Boolean(ecf);
          }

          if (!invoiced) {
            throw conflict(409, "ORDER_NOT_INVOICED");
          }

          const tableWhere = { _id: tableId, ...base };

          const table = await Table.findOne(tableWhere)
            .session(session).lean();

          if (!table) {
            throw conflict(404, "TABLE_NOT_FOUND");
          }

          if (table.tableSessionId) {
            const siblingPending = await Order.exists({
              tenantId,
              ...branchFilter(clientId),
              table: table._id,
              tableSessionId: table.tableSessionId,
              _id: { $ne: order._id },
              paymentStatus: "Pendiente",
              orderStatus: { $ne: "Cancelado" },
              "items.0": { $exists: true }
            }).session(session);

            if (siblingPending) {
              throw conflict(409, "TABLE_HAS_UNPAID_ACCOUNTS");
            }
          }

          const linked = getId(table.currentOrder);
          const alreadyReleased =
            !linked && table.status === "Disponible";

          if (linked !== id && !alreadyReleased) {
            throw conflict(409, "TABLE_LINKED_TO_ANOTHER_ORDER");
          }

          const tenant = await Tenant.findOne({ tenantId })
            .session(session)
            .select("features.checkout.chargeMode")
            .lean();

          if (!tenant) {
            throw conflict(403, "TENANT_UNAVAILABLE");
          }

          const mode = String(
            tenant.features?.checkout?.chargeMode || "AT_COMPLETE"
          ).toUpperCase();

          // Inventario participa en la MISMA transaccion.
          if (mode === "AT_COMPLETE" && order.inventoryDeducted !== true) {
            await deductInventoryForOrder(order._id, {
              userId: req.user?._id || null,
              session
            });
          }

          // Escritura condicional para evitar cambios concurrentes.
          if (!order.tableReleasedAt) {
            const updatedOrder = await Order.updateOne(
              { ...orderWhere, orderStatus: order.orderStatus },
              { $set: { orderStatus: "Completado", tableReleasedAt: new Date() } },
              { session }
            );

            if (!updatedOrder || updatedOrder.matchedCount !== 1) {
              throw conflict(409, "ORDER_COMPLETION_CONFLICT", {
                requiresRecovery: true,
                orderId: id,
                tableId
              });
            }
          }

          if (table.tableSessionId) {
            await Order.updateMany({ ...base, table: table._id, tableSessionId: table.tableSessionId },
              { $set: { tableReleasedAt: new Date() } }, { session });
          }
          let wasReleased = alreadyReleased;

          if (!alreadyReleased) {
            const updatedTable = await Table.findOneAndUpdate(
              { ...tableWhere, currentOrder: order._id },
              {
                $set: {
                  status: "Disponible",
                  currentOrder: null,
                  tableSessionId: null
                }
              },
              { new: true, session }
            );

            if (!updatedTable) {
              const current = await Table.findOne(tableWhere)
                .session(session).lean();

              if (
                !current ||
                getId(current.currentOrder) ||
                current.status !== "Disponible"
              ) {
                throw conflict(409, "TABLE_RELEASE_CONFLICT", {
                  requiresRecovery: true,
                  requiresReview: true,
                  orderId: id,
                  tableId
                });
              }

              wasReleased = true;
            }
          }

          return {
            orderId: id,
            tableId,
            tenantId,
            orderStatus: "Completado",
            tableStatus: "Disponible",
            alreadyReleased: wasReleased
          };
        });
      } finally {
        await session.endSession();
      }

      if (!outcome) {
        throw new Error("TABLE_RELEASE_TRANSACTION_NO_RESULT");
      }

      // Las notificaciones ocurren SOLO despues del commit.
      // Un error Socket.IO no puede revertir ni negar un commit confirmado.
      const emitAfterCommit = (event, payload) => {
        try {
          const io = req.app?.get?.("io");
          io?.to?.(`tenant:${tenantId}:branch:${clientId}`)?.emit?.(event, payload);
        } catch (error) {
          console.error(
            "SOCKET_POST_COMMIT_NOTIFICATION_FAILED",
            event,
            error?.message || "UNKNOWN_SOCKET_ERROR"
          );
        }
      };

      if (!outcome.alreadyReleased) {
      emitAfterCommit("tenant:orderUpdated", {
        tenantId,
        clientId,
        orderId: id,
        orderStatus: "Completado"
      });

      emitAfterCommit("tenant:tablesUpdated", {
        tenantId,
        clientId,
        tableId: outcome.tableId,
        orderId: null,
        status: "Disponible"
      });

      }
      res.set?.("Cache-Control", "no-store");

      return res.status(200).json({
        success: true,
        code: "ORDER_TABLE_RELEASED",
        data: {
          orderId: outcome.orderId,
          tableId: outcome.tableId,
          orderStatus: outcome.orderStatus,
          tableStatus: outcome.tableStatus,
          alreadyReleased: outcome.alreadyReleased
        }
      });
    } catch (error) {
      if (error?.publicStatus && error?.publicCode) {
        res.set?.("Cache-Control", "no-store");

        return res.status(error.publicStatus).json({
          success: false,
          code: error.publicCode,
          ...error.publicExtra
        });
      }

      return next(error);
    }
  };
}
module.exports = { createCloseAndVacateHandler, verifiedScope, branchFilter };
