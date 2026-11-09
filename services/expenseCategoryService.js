const mongoose = require('mongoose');
const httpError = require('http-errors');
const Category = require('../models/expenseCategoryModel');
const Tenant = require('../models/tenantModel');

const normalizeName = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();

async function writeCategory({ tenantId, clientId, id, body = {} }) {
    const session = await mongoose.startSession();
    let result;
    try {
        await session.withTransaction(async () => {
            // Serialize name checks without a new unique index on legacy data.
            const lock = await Tenant.updateOne({ tenantId, status: 'active' }, { $inc: { __v: 1 } }, { session, timestamps: false });
            if (!lock.matchedCount) throw httpError(403, 'TENANT_UNAVAILABLE');
            const doc = id ? await Category.findOne({ _id: id, tenantId, clientId }).session(session) : new Category({ tenantId, clientId });
            if (!doc) throw httpError(404, 'CATEGORY_NOT_FOUND');
            const oldName = normalizeName(doc.name);
            const originalName = doc.name;
            if (body.name != null) doc.name = String(body.name).trim().replace(/\s+/g, ' ');
            if (!doc.name) throw httpError(400, 'NAME_REQUIRED');
            if (body.status != null && !['active', 'inactive'].includes(body.status)) throw httpError(400, 'CATEGORY_STATUS_INVALID');
            if (doc.systemKey && (body.status === 'inactive' || doc.name !== originalName)) throw httpError(409, 'SYSTEM_CATEGORY_PROTECTED');
            const name = normalizeName(doc.name);
            if (!id || name !== oldName) {
                const peers = await Category.find({ tenantId, clientId, _id: { $ne: doc._id } }).select('name').session(session).lean();
                if (peers.some(p => normalizeName(p.name) === name)) throw httpError(409, 'CATEGORY_ALREADY_EXISTS');
            }
            if (body.description != null) doc.description = String(body.description).trim();
            if (body.status != null) doc.status = body.status;
            // systemKey belongs to internal integrations, never to user input.
            await doc.save({ session });
            result = doc;
        });
        return result;
    } finally {
        await session.endSession();
    }
}

async function withCategoryLock({ tenantId, clientId, id }, work) {
    const session = await mongoose.startSession();
    let result;
    try {
        await session.withTransaction(async () => {
            // Creating/reassigning an expense and deleting its category must not race.
            const category = await Category.findOneAndUpdate(
                { _id: id, tenantId, clientId }, { $inc: { __v: 1 } },
                { session, new: true, timestamps: false }
            );
            if (!category) throw httpError(404, 'CATEGORY_NOT_FOUND');
            result = await work(category, session);
        });
        return result;
    } finally { await session.endSession(); }
}

module.exports = { writeCategory, withCategoryLock, normalizeName };
