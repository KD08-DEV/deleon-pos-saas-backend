'use strict';
/** DeLeonSoft 12.8.4.2 — cuentas por mesa: estados visuales claros, split post-factura NO e-CF y sin popups viejos en frontend. */
const mongoose = require('mongoose');
const Table = require('../models/tableModel');
const Order = require('../models/orderModel');
const ElectronicTaxDocument = require('../models/electronicTaxDocumentModel');
const Tenant = require('../models/tenantModel');
const TenantEcfProfile = require('../models/tenantEcfProfileModel');
const { getBranchEcfStatus } = require('../services/ecf/ecfBranchAccess');
const { getPlanFeatures } = require('../middlewares/requirePlan');

function fail(code, status = 409) { const e = new Error(code); e.status = status; e.statusCode = status; throw e; }
function scope(req) {
  const tenantId = req.tenantId || req.user?.tenantId;
  const clientId = req.clientId;
  if (!tenantId || !clientId) fail('BRANCH_SCOPE_REQUIRED', 403);
  return { tenantId, clientId };
}
function tableFilter(req, id) { if (!mongoose.isValidObjectId(id)) fail('INVALID_TABLE_ID', 400); return { _id: id, ...scope(req) }; }
function accepted(doc) { return ['accepted', 'accepted_with_observation'].includes(String(doc?.ecf?.status || '').toLowerCase()); }
const eScope = (s, id) => ({ ...s, orderId: id, sourceDocumentType: 'ORDER' });
const cents = (x) => Math.round((Number(x) || 0) * 100);
const dec = (x) => Math.round((Number(x) || 0) * 100) / 100;

function getVisualStatus(payload) {
  if (payload?.hasEcfRecord && !payload?.hasEcf) return 'e-CF en proceso';
  if (payload?.hasEcf) return accepted({ ecf: { status: payload.ecfStatus } }) ? 'Facturada e-CF' : 'e-CF en proceso';
  if (payload?.hasFiscal) return 'Facturada';
  if (String(payload?.paymentStatus) === 'Pagado') return 'Pagada';
  return 'Pendiente';
}

function canSplitAccount(payload) {
  return !payload?.hasEcf &&
    !payload?.hasEcfRecord &&
    !payload?.hasIssuedNcf &&
    !payload?.inventoryDeducted &&
    !payload?.financialLocked &&
    !payload?.invoiceAlreadyFinalized &&
    !payload?.splitUnsupportedCharges &&
    !payload?.splitMixedTaxes &&
    String(payload?.orderStatus) !== 'Cancelado' &&
    String(payload?.paymentStatus) === 'Pendiente' &&
    Number(payload?.itemCount || 0) > 0;
}

async function tableAccounts(req, res, next) {
  try {
    const filter = tableFilter(req, req.params.id);
    const table = await Table.findOne(filter).lean();
    if (!table) fail('TABLE_NOT_IN_SELECTED_BRANCH', 404);

    let orders = [];
    if (table.tableSessionId) {
      orders = await Order.find({ ...scope(req), table: table._id, tableSessionId: table.tableSessionId })
        .select('_id createdAt items orderStatus paymentStatus bills invoiceNumber facturaNo invoicePath invoiceUrl invoicedAt fiscal isDraft paidAt ncfNumber inventoryDeducted creditStatus accountReceivableId commissionAmount')
        .sort({ createdAt: 1 })
        .lean();
    } else if (table.currentOrder) {
      const one = await Order.findOne({ _id: table.currentOrder, table: table._id, ...scope(req) })
        .select('_id createdAt items orderStatus paymentStatus bills invoiceNumber facturaNo invoicePath invoiceUrl invoicedAt fiscal isDraft paidAt ncfNumber inventoryDeducted creditStatus accountReceivableId commissionAmount')
        .lean();
      if (one) orders = [one];
    }

    const ids = orders.map((x) => x._id);
    const docs = ids.length
      ? await ElectronicTaxDocument.find({ ...scope(req), orderId: { $in: ids }, sourceDocumentType: 'ORDER' })
          .select('orderId ecf.eNCF ecf.status ecf.documentType')
          .lean()
      : [];
    const byOrder = new Map(docs.map((x) => [String(x.orderId), x.ecf]));
    const knownEcfOrders = new Set(docs.map((x) => String(x.orderId)));
    const accounts = orders.map((o) => {
      const ecf = byOrder.get(String(o._id));
      const payload = {
        orderId: String(o._id),
        createdAt: o.createdAt,
        orderStatus: o.orderStatus,
        paymentStatus: o.paymentStatus,
        itemCount: o.items?.length || 0,
        items: (o.items || []).map((i, index) => ({
          index,
          lineId: i.lineId,
          name: i.name,
          quantity: i.quantity,
          price: i.price,
          unitPrice: i.unitPrice,
        })),
        total: Number(o.bills?.totalWithTax || 0),
        hasEcf: !!ecf?.eNCF,
        hasEcfRecord: knownEcfOrders.has(String(o._id)),
        ecfStatus: ecf?.status || null,
        eNCF: ecf?.eNCF || null,
        hasFiscal: !!(o.invoiceNumber || o.fiscal?.ncfNumber || o.fiscal?.issuedAt),
        hasIssuedNcf: !!(o.ncfNumber || o.fiscal?.ncfNumber || o.fiscal?.issuedAt),
        invoiceAlreadyFinalized: !!(o.invoicePath || o.invoiceUrl),
        splitUnsupportedCharges: ['discount', 'tip', 'tipAmount', 'deliveryFee', 'serviceChargeTotal'].some((k) => cents(o.bills?.[k]) !== 0) || cents(o.commissionAmount) !== 0,
        splitMixedTaxes: new Set((o.items || []).map((i) => JSON.stringify({ rate: i.taxSnapshot?.ratePercent || 0, id: i.taxSnapshot?.taxId || null, included: i.taxSnapshot?.includedInPrice || false }))).size > 1 || (o.bills?.taxBreakdown || []).length > 1,
        inventoryDeducted: !!o.inventoryDeducted,
        financialLocked: !!(o.paidAt || o.creditStatus === 'pending' || o.accountReceivableId),
        paidAt: o.paidAt || null,
      };
      return {
        ...payload,
        visualStatus: getVisualStatus(payload),
        canSplit: canSplitAccount(payload),
      };
    });

    return res.json({
      success: true,
      data: {
        tableId: String(table._id),
        tableSessionId: table.tableSessionId || null,
        currentOrderId: table.currentOrder || null,
        accounts,
      },
    });
  } catch (e) { next(e); }
}

async function assertEcfBranchOn(s) {
  const [tenant, profile, branch] = await Promise.all([
    Tenant.findOne({ tenantId: s.tenantId }).select('status plan fiscal.enabled features.fiscal.enabled').lean(),
    TenantEcfProfile.findOne({ tenantId: s.tenantId }).select('enabled environment').lean(),
    getBranchEcfStatus(s),
  ]);
  if (
    tenant?.status !== 'active' ||
    getPlanFeatures(tenant?.plan)?.fiscal !== true ||
    tenant?.fiscal?.enabled !== true ||
    tenant?.features?.fiscal?.enabled === false ||
    profile?.enabled !== true ||
    branch?.prepared !== true ||
    (branch?.secondary && profile?.environment !== 'internal_sandbox')
  ) fail('BRANCH_ECF_NOT_ENABLED', 403);
}

async function newConsumption(req, res, next) {
  const session = await mongoose.startSession();
  try {
    const filter = tableFilter(req, req.params.id), s = scope(req);
    await assertEcfBranchOn(s);
    let created;
    await session.withTransaction(async () => {
      const table = await Table.findOne(filter).session(session);
      if (!table || !table.currentOrder) fail('TABLE_WITHOUT_INVOICED_ORDER');
      const old = await Order.findOne({ _id: table.currentOrder, table: table._id, ...s }).session(session);
      if (!old) fail('ORDER_NOT_IN_SELECTED_BRANCH', 403);
      const doc = await ElectronicTaxDocument.findOne(eScope(s, old._id)).session(session);
      if (!doc || !accepted(doc) || !doc.ecf?.eNCF) fail('ECF_NOT_ACCEPTED_NO_NEW_CONSUMPTION');
      const tableSessionId = table.tableSessionId || new mongoose.Types.ObjectId().toString();
      old.tableSessionId = tableSessionId;
      await old.save({ session });
      const [nextOrder] = await Order.create([{
        tenantId: s.tenantId,
        clientId: s.clientId,
        table: table._id,
        tableSessionId,
        customerDetails: old.customerDetails?.toObject?.() || old.customerDetails || { name: '' },
        customerId: old.customerId || null,
        registerId: old.registerId || 'MAIN',
        user: req.user?._id,
        orderSource: 'DINE_IN',
        items: [],
        isDraft: true,
        orderStatus: 'En Progreso',
        paymentStatus: 'Pendiente',
        orderNote: 'Consumo adicional posterior a e-CF',
      }], { session });
      const changed = await Table.updateOne(
        { ...filter, currentOrder: old._id },
        { $set: { currentOrder: nextOrder._id, tableSessionId, status: 'Ocupada' } },
        { session }
      );
      if (changed.modifiedCount !== 1) fail('TABLE_CHANGED_TRY_AGAIN');
      created = nextOrder;
    });
    return res.status(201).json({ success: true, data: { orderId: String(created._id), tableId: req.params.id } });
  } catch (e) { next(e); } finally { await session.endSession(); }
}

function splitItems(items, selection) {
  if (!Array.isArray(selection) || !selection.length) fail('SPLIT_SELECTION_REQUIRED', 400);
  const picks = new Map();
  for (const p of selection) {
    const key = String(p.lineId || '');
    if (!key || picks.has(key)) fail('SPLIT_INVALID_LINE', 400);
    picks.set(key, Number(p.quantity));
  }
  const old = [], moved = [];
  for (const source of items) {
    const obj = source.toObject ? source.toObject() : { ...source };
    const orig = Number(obj.quantity), take = picks.get(String(obj.lineId)) || 0;
    if (take && (!Number.isFinite(take) || take <= 0 || take > orig || (!Number.isInteger(take) && obj.qtyType !== 'weight'))) fail('SPLIT_QUANTITY_INVALID', 400);
    if (!take) { old.push(obj); continue; }
    picks.delete(String(obj.lineId));
    const ratio = take / orig;
    const mk = (q, share, newLine) => {
      const o = JSON.parse(JSON.stringify(obj));
      o.quantity = q;
      if (newLine) o.lineId = new mongoose.Types.ObjectId().toString();
      for (const k of ['price', 'lineTotalWithTax', 'discountAmount', 'printedQty']) {
        if (typeof obj[k] === 'number') o[k] = dec(obj[k] * share);
      }
      if (obj.taxSnapshot) {
        for (const k of ['taxableBase', 'amount']) if (typeof obj.taxSnapshot[k] === 'number') o.taxSnapshot[k] = dec(obj.taxSnapshot[k] * share);
      }
      return o;
    };
    if (take === orig) { moved.push({ ...obj, lineId: new mongoose.Types.ObjectId().toString() }); continue; }
    const transferred = mk(take, ratio, true), remaining = mk(dec(orig - take), 1 - ratio, false);
    for (const k of ['price', 'lineTotalWithTax', 'discountAmount']) if (typeof obj[k] === 'number') remaining[k] = dec(obj[k] - transferred[k]);
    if (obj.taxSnapshot) for (const k of ['taxableBase', 'amount']) if (typeof obj.taxSnapshot[k] === 'number') remaining.taxSnapshot[k] = dec(obj.taxSnapshot[k] - transferred.taxSnapshot[k]);
    moved.push(transferred); old.push(remaining);
  }
  if (picks.size || !moved.length || !old.length) fail('SPLIT_MUST_LEAVE_ITEMS_IN_BOTH_ACCOUNTS', 400);
  return { old, moved };
}

function allocateBills(original, oldItems, movedItems) {
  const src = original.toObject ? original.toObject() : original || {};
  const gross = (rows) => rows.reduce((sum, i) => sum + (Number(i.price) || 0), 0);
  const sum = gross(oldItems) + gross(movedItems);
  if (sum <= 0) fail('SPLIT_UNSUPPORTED_AMOUNT', 400);
  const ratio = gross(movedItems) / sum;
  const a = JSON.parse(JSON.stringify(src)), b = JSON.parse(JSON.stringify(src));
  for (const key of ['subtotal', 'total', 'subtotalAfterDiscount', 'netAmount', 'tax', 'totalWithTax', 'serviceChargeTotal', 'deliveryFee', 'discount', 'tip', 'tipAmount', 'deliveryTaxAmount']) {
    if (typeof src[key] === 'number') { b[key] = dec(src[key] * ratio); a[key] = dec(src[key] - b[key]); }
  }
  if (Array.isArray(src.taxBreakdown)) {
    for (let i = 0; i < src.taxBreakdown.length; i++) {
      for (const key of ['taxableBase', 'amount', 'grossAmount']) {
        if (typeof src.taxBreakdown[i][key] === 'number') {
          b.taxBreakdown[i][key] = dec(src.taxBreakdown[i][key] * ratio);
          a.taxBreakdown[i][key] = dec(src.taxBreakdown[i][key] - b.taxBreakdown[i][key]);
        }
      }
    }
  }
  return { remaining: a, separated: b };
}

async function splitAccount(req, res, next) {
  let session;
  try {
    const filter = tableFilter(req, req.params.id), s = scope(req);
    const id = req.body?.orderId;
    if (!mongoose.isValidObjectId(id)) fail('INVALID_ORDER_ID', 400);
    session = await mongoose.startSession();
    let created;
    await session.withTransaction(async () => {
      const table = await Table.findOne(filter).session(session);
      if (!table || table.status === 'Disponible') fail('TABLE_NOT_OCCUPIED');
      const order = await Order.findOne({ _id: id, table: table._id, ...s }).session(session);
      if (!order) fail('ORDER_NOT_IN_SELECTED_BRANCH', 403);
      if (table.tableSessionId ? String(order.tableSessionId) !== String(table.tableSessionId) : String(table.currentOrder) !== String(order._id)) {
        fail('ORDER_NOT_IN_CURRENT_TABLE_SESSION', 403);
      }

      const hasEcf = await ElectronicTaxDocument.exists(eScope(s, order._id)).session(session);
      if (hasEcf) fail('ECF_ALREADY_ISSUED_CANNOT_BE_SPLIT');
      // Un comprobante fiscal emitido es inmutable, sea electrónico E31/E32 o convencional B01/B02.
      if (order.ncfNumber || order.fiscal?.ncfNumber || order.fiscal?.issuedAt) fail('INVOICED_ORDER_CANNOT_BE_SPLIT');
      if (order.invoicePath || order.invoiceUrl) fail('INVOICED_ORDER_CANNOT_BE_SPLIT');
      if (String(order.orderStatus) === 'Cancelado') fail('ORDER_CANCELLED_CANNOT_BE_SPLIT');
      if (String(order.paymentStatus) !== 'Pendiente' || order.paidAt || order.creditStatus === 'pending' || order.accountReceivableId || order.inventoryDeducted) fail('ORDER_FINANCIAL_LOCKED');

      const b = order.bills || {};
      if (['discount', 'tip', 'tipAmount', 'deliveryFee', 'serviceChargeTotal'].some((k) => cents(b[k]) !== 0) || cents(order.commissionAmount) !== 0) {
        fail('SPLIT_WITH_DISCOUNTS_OR_CHARGES_NOT_SUPPORTED');
      }
      const taxes = new Set((order.items || []).map((i) => JSON.stringify({ rate: i.taxSnapshot?.ratePercent || 0, id: i.taxSnapshot?.taxId || null, included: i.taxSnapshot?.includedInPrice || false })));
      if (taxes.size > 1 || (b.taxBreakdown || []).length > 1) fail('SPLIT_MIXED_TAXES_NOT_SUPPORTED');

      const { old, moved } = splitItems(order.items || [], req.body?.lines);
      const alloc = allocateBills(b, old, moved);
      const tableSessionId = table.tableSessionId || new mongoose.Types.ObjectId().toString();
      // Nunca duplicar una rebaja de inventario al separar cuentas en estado editable.
      const [fresh] = await Order.create([{
        tenantId: s.tenantId,
        clientId: s.clientId,
        table: table._id,
        tableSessionId,
        customerId: order.customerId || null,
        customerDetails: order.customerDetails?.toObject?.() || order.customerDetails || {},
        registerId: order.registerId,
        user: req.user?._id,
        orderSource: 'DINE_IN',
        isDraft: order.isDraft,
        paymentStatus: 'Pendiente',
        orderStatus: 'En Progreso',
        items: moved,
        bills: alloc.separated,
        paymentMethod: order.paymentMethod,
        orderNote: 'Cuenta dividida',
        inventoryDeducted: false,
      }], { session });

      order.items = old;
      order.bills = alloc.remaining;
      order.tableSessionId = tableSessionId;
      await order.save({ session });
      table.tableSessionId = tableSessionId;
      await table.save({ session });
      created = fresh;
    });
    return res.status(201).json({ success: true, data: { orderId: String(created._id), tableId: req.params.id } });
  } catch (e) { next(e); } finally { if (session) await session.endSession(); }
}

module.exports = { tableAccounts, newConsumption, splitAccount, splitItems, allocateBills, getVisualStatus, canSplitAccount };
