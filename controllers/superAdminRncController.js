"use strict";
const multer = require("multer");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const RncImportJob = require("../models/rncImportJobModel");
const RncRegistry = require("../models/rncRegistryModel");
const {
    TEMP_DIR, MAX_UPLOAD_BYTES, ONE_HOUR_MS, previewFile, hashFile,
    cleanOldTempFiles, processImport, removeFile,
} = require("../services/rncSuperAdminImportService");

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            fs.mkdir(TEMP_DIR, { recursive: true, mode: 0o700 }, err => cb(err, TEMP_DIR));
        },
        filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.txt`),
    }),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0 },
    fileFilter: (req, file, cb) => {
        if (path.extname(file.originalname || "").toLowerCase() !== ".txt") {
            const err = new Error("SOLO_ARCHIVOS_TXT"); err.status = 400;
            return cb(err);
        }
        cb(null, true);
    },
}).single("file");

exports.uploadMiddleware = (req, res, next) => upload(req, res, err => {
    if (!err) return next();
    if (err instanceof multer.MulterError) return res.status(413).json({ code: err.code });
    return res.status(err.status || 400).json({ code: err.message || "UPLOAD_FAILED" });
});

exports.preview = async (req, res, next) => {
    const filepath = req.file?.path;
    if (!filepath) return res.status(400).json({ code: "FILE_REQUIRED" });
    try {
        await cleanOldTempFiles();
        const [stats, sha256] = await Promise.all([previewFile(filepath), hashFile(filepath)]);
        const job = await RncImportJob.create({
            filename: path.basename(req.file.originalname), filepath, sha256,
            fileSize: req.file.size, valid: stats.valid, invalid: stats.invalid, total: stats.total,
        });
        return res.status(201).json({ success: true, data: {
            jobId: job._id, filename: job.filename, sha256, fileSize: job.fileSize,
            valid: stats.valid, invalid: stats.invalid, sample: stats.sample,
            note: "No se eliminarán registros antiguos no presentes en este TXT.",
        }});
    } catch (err) {
        await removeFile(filepath);
        if (err.status) return res.status(err.status).json({ code: err.message });
        next(err);
    }
};
exports.commit = async (req, res, next) => {
    try {
        if (req.body?.confirmation !== "ACTUALIZAR RNC") {
            return res.status(400).json({ code: "CONFIRMATION_REQUIRED" });
        }
        await RncImportJob.init();
        const running = await RncImportJob.findOne({ status: "running" }).select("_id").lean();
        if (running) return res.status(409).json({ code: "RNC_IMPORT_ALREADY_RUNNING" });
        const job = await RncImportJob.findOne({
            _id: req.params.id, status: "ready", createdAt: { $gte: new Date(Date.now() - ONE_HOUR_MS) },
        }).select("+filepath");
        if (!job) return res.status(409).json({ code: "PREVIEW_EXPIRED_OR_ALREADY_APPLIED" });
        if (!fs.existsSync(job.filepath)) return res.status(410).json({ code: "STAGED_FILE_NOT_FOUND" });
        job.status = "running";
        job.startedAt = new Date();
        try { await job.save(); } catch (e) {
            if (e?.code === 11000) return res.status(409).json({ code: "RNC_IMPORT_ALREADY_RUNNING" });
            throw e;
        }
        // El backend ejecuta la importación y la interfaz consulta el avance por GET.
        setImmediate(() => void processImport(job._id));
        return res.status(202).json({ success: true, data: { jobId: job._id, status: "running" } });
    } catch (err) { next(err); }
};
exports.getJob = async (req, res, next) => {
    try {
        const job = await RncImportJob.findById(req.params.id).lean();
        if (!job) return res.status(404).json({ code: "IMPORT_NOT_FOUND" });
        return res.json({ success: true, data: job });
    } catch (err) { next(err); }
};
exports.status = async (req, res, next) => {
    try {
        const [total, latest, running] = await Promise.all([
            RncRegistry.estimatedDocumentCount(),
            RncImportJob.findOne({ status: "completed" }).sort({ completedAt: -1 }).lean(),
            RncImportJob.findOne({ status: "running" }).sort({ startedAt: -1 }).lean(),
        ]);
        return res.json({ success: true, data: { total, latest, running } });
    } catch (err) { next(err); }
};
