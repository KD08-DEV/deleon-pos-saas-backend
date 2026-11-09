const mongoose = require('mongoose');
const { randomUUID } = require('crypto');
const httpError = require('http-errors');
const Tenant = require('../models/tenantModel');
const Client = require('../models/clientModel');
const { getTierByPlan } = require('../middlewares/requirePlan');

async function getBranchPolicy(tenantId, session = null) {
    const tenant = await Tenant.findOne({ tenantId }).select('plan status').session(session).lean();
    if (!tenant || tenant.status !== 'active') throw httpError(403, 'TENANT_UNAVAILABLE');
    const { plan, tier } = getTierByPlan(tenant.plan);
    // Principal counts once, whether stored or represented by the legacy virtual branch.
    // Preserve the existing quota rule: inactive secondary branches still count.
    const used = 1 + await Client.countDocuments({ tenantId, clientId: { $ne: 'default' } }).session(session);
    const maximum = tier.limits.maxClients;
    return { plan, label: tier.label, multiClient: tier.features.multiClient === true,
        maxBranches: maximum, used, canCreate: tier.features.multiClient === true && (maximum == null || used < maximum) };
}

async function createBranch(tenantId, body = {}) {
    const name = String(body.name || '').trim();
    if (!name || name.length > 120) throw httpError(400, 'INVALID_BRANCH_NAME');
    if (body.menuMode === 'shared' || body.shareMenu === true) throw httpError(409, 'SHARED_MENU_NOT_IMPLEMENTED');
    const session = await mongoose.startSession();
    let result;
    try {
        await session.withTransaction(async () => {
            // All branch creation requests contend on this tenant document, including
            // concurrent plan updates. Check the current plan and quota after locking.
            const lock = await Tenant.updateOne({ tenantId, status: 'active' }, { $inc: { __v: 1 } }, { session, timestamps: false });
            if (!lock.matchedCount) throw httpError(403, 'TENANT_UNAVAILABLE');
            const policy = await getBranchPolicy(tenantId, session);
            if (!policy.multiClient) throw httpError(403, 'PLAN_MULTI_BRANCH_DENIED');
            if (!policy.canCreate) throw httpError(403, 'BRANCH_LIMIT_REACHED');
            [result] = await Client.create([{
                tenantId, clientId: randomUUID(), name, menuMode: 'independent', isActive: true,
                ecf: { enabled: false }, address: String(body.address || '').slice(0, 200),
                phone: String(body.phone || '').slice(0, 40),
            }], { session });
        });
        return result;
    } finally { await session.endSession(); }
}

module.exports = { getBranchPolicy, createBranch };
