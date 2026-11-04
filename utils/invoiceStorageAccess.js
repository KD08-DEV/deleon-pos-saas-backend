"use strict";

const { invoiceStoragePaths } = require("./invoiceStoragePaths");

/**
 * Always derive paths from authenticated tenant and verified order ID.
 * Never sign a path, URL or bucket name supplied by the browser / Mongo document.
 * The historical path is tried only for compatibility with older stored files.
 * Private storage bucket must also be enforced in Supabase settings.
 */
async function signStoredInvoice({ storage, tenantId, orderId, ttlSeconds = 120, download = false }) {
    if (!storage || typeof storage.from !== "function") throw new Error("SUPABASE_STORAGE_UNAVAILABLE");
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 600) {
        throw new Error("INVALID_SIGNED_URL_TTL");
    }
    const paths = invoiceStoragePaths(tenantId, orderId);
    for (const filePath of paths) {
        const bucket = storage.from("invoices");
        const { data, error } = await bucket.createSignedUrl(
            filePath,
            ttlSeconds,
            download ? { download: true } : undefined
        );
        if (!error && typeof data?.signedUrl === "string" && data.signedUrl) {
            return { url: data.signedUrl, path: filePath };
        }
    }
    return null;
}

module.exports = { signStoredInvoice };
