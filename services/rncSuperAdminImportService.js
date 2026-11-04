"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const readline = require("node:readline");
const iconv = require("iconv-lite");
const RncRegistry = require("../models/rncRegistryModel");
const RncImportJob = require("../models/rncImportJobModel");
const { parseDgiiRncLine } = require("../utils/dgiiRncParser");

const TEMP_DIR = path.join(os.tmpdir(), "deleonsoft-rnc-imports");
const MAX_UPLOAD_BYTES = 150 * 1024 * 1024;
const BATCH = 1250;
const MAX_BAD_FRACTION = 0.20;
const MIN_VALID = 100;
const ONE_HOUR_MS = 3600 * 1000;

function makeLineIterator(filepath) {
    // DGII_RNC.TXT usa Windows-1252; se lee en streaming, nunca completo en RAM.
    const decoder = fs.createReadStream(filepath).pipe(iconv.decodeStream("win1252"));
    return readline.createInterface({ input: decoder, crlfDelay: Infinity });
}
async function hashFile(filepath) {
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(filepath)) hash.update(chunk);
    return hash.digest("hex");
}
function validStats(valid, invalid) {
    return valid >= MIN_VALID && invalid <= valid * MAX_BAD_FRACTION;
}
async function previewFile(filepath) {
    let valid = 0, invalid = 0;
    const sample = [];
    for await (const line of makeLineIterator(filepath)) {
        if (!line.trim()) continue;
        const doc = parseDgiiRncLine(line);
        if (!doc) { invalid++; continue; }
        valid++;
        if (sample.length < 5) sample.push(doc);
    }
    if (!validStats(valid, invalid)) {
        const err = new Error("INVALID_DGII_RNC_TXT"); err.status = 422; throw err;
    }
    return { valid, invalid, total: valid + invalid, sample };
}
async function removeFile(filepath) {
    if (filepath) await fsp.unlink(filepath).catch(() => {});
}
async function cleanOldTempFiles() {
    await fsp.mkdir(TEMP_DIR, { recursive: true, mode: 0o700 });
    for (const file of await fsp.readdir(TEMP_DIR)) {
        const filepath = path.join(TEMP_DIR, file);
        const stat = await fsp.stat(filepath).catch(() => null);
        if (stat?.isFile() && Date.now() - stat.mtimeMs > 24 * ONE_HOUR_MS) await removeFile(filepath);
    }
}
async function processImport(jobId) {
    let job;
    try {
        job = await RncImportJob.findById(jobId).select("+filepath");
        if (!job || job.status !== "running") return;
        // Evitar aplicar un archivo modificado después de validar la vista previa.
        if (await hashFile(job.filepath) !== job.sha256) throw new Error("UPLOADED_FILE_CHANGED");
        let valid = 0, invalid = 0;
        for await (const line of makeLineIterator(job.filepath)) {
            if (!line.trim()) continue;
            if (parseDgiiRncLine(line)) valid++; else invalid++;
        }
        if (!validStats(valid, invalid) || valid !== job.valid || invalid !== job.invalid) {
            throw new Error("FILE_VALIDATION_CHANGED");
        }
        let ops = [], created = 0, updated = 0, processed = 0;
        const flush = async () => {
            if (!ops.length) return;
            const response = await RncRegistry.bulkWrite(ops, { ordered: false });
            created += response.upsertedCount || 0;
            updated += response.modifiedCount || 0;
            processed += ops.length;
            ops = [];
            await RncImportJob.updateOne({ _id: jobId }, { $set: { processed, created, updated } });
        };
        for await (const line of makeLineIterator(job.filepath)) {
            const doc = parseDgiiRncLine(line);
            if (!doc) continue;
            // No eliminar documentos anteriores, preservar su _id, solo establecer los dos campos.
            ops.push({ updateOne: { filter: { rnc: doc.rnc }, update: {
                $set: { nombre: doc.nombre }, $setOnInsert: { rnc: doc.rnc },
            }, upsert: true }});
            if (ops.length >= BATCH) await flush();
        }
        await flush();
        await RncImportJob.updateOne({ _id: jobId, status: "running" }, {
            $set: { status: "completed", completedAt: new Date(), processed, created, updated },
        });
    } catch (error) {
        console.error("[RNC_IMPORT]", jobId, error?.message);
        await RncImportJob.updateOne({ _id: jobId }, {
            $set: { status: "failed", errorCode: String(error?.code || error?.message || "IMPORT_FAILED").slice(0, 100), completedAt: new Date() },
        }).catch(() => {});
    } finally {
        if (job?.filepath) await removeFile(job.filepath);
    }
}
module.exports = { TEMP_DIR, MAX_UPLOAD_BYTES, ONE_HOUR_MS, previewFile, hashFile, cleanOldTempFiles, processImport, removeFile };
