const httpError = require('http-errors');
const Membership = require('../../models/membershipModel');

function wasPrepared(order) {
    return Boolean(order.inventoryPreparedAt) || (order.items || []).some(item => Number(item.printedQty) > 0) ||
        ['Listo', 'Completado'].includes(order.orderStatus) ||
        (order.statusHistory || []).some(entry => ['Listo', 'Completado'].includes(entry.status));
}

async function authorizeInventoryReturn(order, authorization = {}, session = null) {
    if (!wasPrepared(order)) return false;
    if (authorization.confirmed !== true) throw httpError(409, 'INVENTORY_RETURN_CONFIRMATION_REQUIRED');
    const member = await Membership.findOne({ user: authorization.userId, tenantId: order.tenantId, status: 'active' }).session(session).lean();
    if (!member || !['Owner', 'Admin'].includes(member.role)) throw httpError(403, 'INVENTORY_RETURN_ADMIN_REQUIRED');
    return true;
}
module.exports = { wasPrepared, authorizeInventoryReturn };
