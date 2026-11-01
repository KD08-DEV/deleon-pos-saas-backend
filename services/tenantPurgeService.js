"use strict";
const mongoose = require("mongoose");
const Tenant = require("../models/tenantModel");

// Las colecciones globales (p.ej. registro público RNC) no forman parte de un tenant.
const TENANT_MODELS = [
    "accountReceivableModel", "cashSessionModel", "clientModel", "customerModel",
    "dish", "electronicTaxDocumentModel", "expenseCategoryModel", "expenseModel",
    "inventoryCategoryModel", "inventoryMovementModel", "invoiceModel", "membershipModel",
    "mermaBatchModel", "orderModel", "paymentModel", "payrollRunModel", "printerModel",
    "purchaseModel", "registerModel", "supplierModel", "supplierPaymentModel",
    "tableModel", "tenantEcfProfileModel", "tenantModel", "tenantSettingsModel", "userModel"
];
function getTenantCollections() {
    return [...new Set(TENANT_MODELS.map(n => {
        const m = require(`../models/${n}`);
        if (!m.schema.path("tenantId")) throw new Error(`Model without tenantId: ${n}`);
        return m.collection.name;
    }))];
}
async function scanTenant(tenantId) {
    const tenant = await Tenant.findOne({ tenantId }).select("tenantId name status").lean();
    if (!tenant) return null;
    const known = getTenantCollections();
    const counts = {};
    for (const name of known) counts[name] = await mongoose.connection.db.collection(name).countDocuments({ tenantId });
    // Fail closed if any UNREGISTERED collection holds data from this tenant.
    const all = await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray();
    const unknownCollections = [];
    for (const { name } of all) {
        if (known.includes(name) || name.startsWith("system.") || name === "rncregistries") continue;
        const count = await mongoose.connection.db.collection(name).countDocuments({ tenantId });
        if (count > 0) unknownCollections.push({ collection: name, count });
    }
    return { tenant: { tenantId: tenant.tenantId, name: tenant.name, status: tenant.status }, counts,
        totalDocuments: Object.values(counts).reduce((s, n) => s + n, 0), unknownCollections };
}

// Se eliminan solamente archivos que estén dentro de prefijos exclusivos de tenant.
async function purgeCloudStorage(tenantId) {
    const { supabase } = require("../config/supabaseClient");
    const jobs = [
        { bucket: process.env.SUPABASE_BUCKET, prefix: `${tenantId}` },
        { bucket: "invoices", prefix: `invoices/tenant_${tenantId}` },
        { bucket: "invoices", prefix: `tenant_${tenantId}` },
        { bucket: process.env.SUPABASE_ASSETS_BUCKET || "invoices", prefix: `tenant-assets/tenant_${tenantId}` },
        { bucket: process.env.SUPABASE_ECF_CERT_BUCKET || "ecf-certificates", prefix: `tenant_${tenantId}` },
    ].filter(job => job.bucket);
    const errors = [];
    let deletedFiles = 0;
    for (const { bucket, prefix } of jobs) {
        try {
            const files = [];
            const seen = new Set();
            async function listAll(dir) {
                if (seen.has(dir)) return;
                seen.add(dir);
                for (let offset = 0; ; offset += 100) {
                    const { data, error } = await supabase.storage.from(bucket).list(dir, { limit: 100, offset });
                    if (error) throw error;
                    for (const entry of data || []) {
                        if (!entry.name || entry.name === ".emptyFolderPlaceholder") continue;
                        const full = `${dir}/${entry.name}`;
                        if (entry.id) files.push(full);
                        else await listAll(full);
                    }
                    if (!data || data.length < 100) break;
                    if (files.length > 10000) throw new Error("STORAGE_SCAN_LIMIT_EXCEEDED");
                }
            }
            await listAll(prefix);
            for (let i = 0; i < files.length; i += 100) {
                const { error } = await supabase.storage.from(bucket).remove(files.slice(i, i + 100));
                if (error) throw error;
                deletedFiles += Math.min(100, files.length - i);
            }
        } catch (error) {
            errors.push({ bucket, prefix, message: error.message || String(error) });
        }
    }
    return { deletedFiles, errors };
}

async function deleteTenant(tenantId) {
    const before = await scanTenant(tenantId);
    if (!before) return null;
    if (before.unknownCollections.length) {
        const e = new Error("UNKNOWN_TENANT_COLLECTIONS"); e.status = 409; e.details = before.unknownCollections; throw e;
    }
    if (before.tenant.status !== "suspended") {
        const e = new Error("SUSPEND_TENANT_BEFORE_DELETION"); e.status = 409; throw e;
    }
    const session = await mongoose.startSession();
    try {
        // Requiere MongoDB con soporte de transacciones (Atlas replica set).
        await session.withTransaction(async () => {
            for (const name of getTenantCollections().filter(n => n !== Tenant.collection.name)) {
                await mongoose.connection.db.collection(name).deleteMany({ tenantId }, { session });
            }
            const result = await Tenant.deleteOne({ tenantId, status: "suspended" }).session(session);
            if (result.deletedCount !== 1) throw new Error("TENANT_STATUS_CHANGED_DURING_DELETION");
        });
    } finally { await session.endSession(); }
    const storage = await purgeCloudStorage(tenantId);
    return { databaseDeleted: true, deletedDocuments: before.totalDocuments,
        storage, complete: storage.errors.length === 0,
        warning: storage.errors.length ? "CLOUD_STORAGE_CLEANUP_PARTIAL_MANUAL_REVIEW_REQUIRED" : null };
}
module.exports = { scanTenant, deleteTenant };
