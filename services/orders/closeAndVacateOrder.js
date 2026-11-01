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
    try {
      const scope = verifiedScope(req);
      if (!scope) return res.status(403).json({ success: false, code: "TABLE_RELEASE_PERMISSION_DENIED" });
      const id = String(req.params.id || "");
      if (!isValidId(id)) return res.status(404).json({ success: false, code: "ORDER_NOT_FOUND" });
      const { tenantId, clientId } = scope;
      const base = { tenantId, ...branchFilter(clientId) };
      const orderWhere = { _id: id, ...base };
      const order = await Order.findOne(orderWhere).lean();
      if (!order) return res.status(404).json({ success: false, code: "ORDER_NOT_FOUND" });
      if (order.isDraft === true || order.orderStatus === "Cancelado") {
        return res.status(409).json({ success: false, code: "ORDER_NOT_ELIGIBLE_TO_RELEASE" });
      }
      const tableId = getId(order.table);
      if (!isValidId(tableId)) return res.status(409).json({ success: false, code: "ORDER_HAS_NO_TABLE" });

      // En cierre post-factura solo se permiten órdenes pagadas o con factura
      // registrada. El ECF se consulta, NO se vuelve a crear ni modificar.
      let invoiced = order.paymentStatus === "Pagado" || Boolean(order.invoicedAt || order.invoiceNumber || order.facturaNo);
      if (!invoiced) {
        const ecf = await ElectronicTaxDocument.exists({ tenantId, ...branchFilter(clientId), orderId: order._id,
          "ecf.status": { $in: ["accepted", "accepted_conditional"] } });
        invoiced = Boolean(ecf);
      }
      if (!invoiced) return res.status(409).json({ success: false, code: "ORDER_NOT_INVOICED" });

      const tableWhere = { _id: tableId, ...base };
      const table = await Table.findOne(tableWhere).lean();
      if (!table) return res.status(404).json({ success: false, code: "TABLE_NOT_FOUND" });
      // No cerrar/liberar mesa con otra cuenta dividida pendiente.
      if (table.tableSessionId) {
        const siblingPending = await Order.exists({ tenantId, ...branchFilter(clientId),
          table:table._id, tableSessionId:table.tableSessionId, _id:{$ne:order._id},
          paymentStatus:"Pendiente", orderStatus:{$ne:"Cancelado"}, "items.0":{$exists:true} });
        if (siblingPending) return res.status(409).json({success:false,code:"TABLE_HAS_UNPAID_ACCOUNTS"});
      }
      const linked = getId(table.currentOrder);
      const alreadyReleased = !linked && table.status === "Disponible";
      if (linked !== id && !alreadyReleased) {
        return res.status(409).json({ success: false, code: "TABLE_LINKED_TO_ANOTHER_ORDER" });
      }

      // Modo AT_COMPLETE exige descuento al completar. El servicio original
      // comprueba inventoryDeducted para evitar descontar otra vez.
      const tenant = await Tenant.findOne({ tenantId }).select("features.checkout.chargeMode").lean();
      if (!tenant) return res.status(403).json({ success: false, code: "TENANT_UNAVAILABLE" });
      const mode = String(tenant.features?.checkout?.chargeMode || "AT_COMPLETE").toUpperCase();
      if (mode === "AT_COMPLETE" && order.inventoryDeducted !== true) {
        await deductInventoryForOrder(order._id, { userId: req.user?._id || null });
      }

      // No alterar pagos, ítems, impuestos, XML ni numeración.
      if (order.orderStatus !== "Completado") {
        await Order.updateOne(orderWhere, { $set: { orderStatus: "Completado" } });
      }

      let wasReleased = alreadyReleased;
      if (!alreadyReleased) {
        const updated = await Table.findOneAndUpdate(
          { ...tableWhere, currentOrder: order._id },
          { $set: { status: "Disponible", currentOrder: null, tableSessionId: null } },
          { new: true }
        );
        if (!updated) {
          const current = await Table.findOne(tableWhere).lean();
          if (!current || getId(current.currentOrder) || current.status !== "Disponible") {
            return res.status(409).json({ success: false, code: "TABLE_RELEASE_CONFLICT" });
          }
          wasReleased = true; // otro clic ya liberó esta mesa
        }
      }
      const io = req.app?.get?.("io");
      io?.to?.(`tenant:${tenantId}`)?.emit?.("tenant:orderUpdated", { tenantId, orderId: id, orderStatus: "Completado" });
      io?.to?.(`tenant:${tenantId}`)?.emit?.("tenant:tablesUpdated", { tenantId, tableId, orderId: null, status: "Disponible" });
      res.set?.("Cache-Control", "no-store");
      return res.status(200).json({ success: true, code: "ORDER_TABLE_RELEASED", data: {
        orderId: id, tableId, orderStatus: "Completado", tableStatus: "Disponible", alreadyReleased: wasReleased
      }});
    } catch (error) { return next(error); }
  };
}
module.exports = { createCloseAndVacateHandler, verifiedScope, branchFilter };
