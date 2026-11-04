"use strict";
const mongoose = require("mongoose");

// Las fichas RNC se almacenan en rncregistries. Este modelo SOLO registra
// las operaciones de importacion del padron (coleccion rncimportjobs).
const schema = new mongoose.Schema({
    // No declarar `index: true` aqui: genera automaticamente `status_1`,
    // nombre que antes colisionaba con el indice unico parcial de abajo.
    status: {
        type: String,
        enum: ["ready", "running", "completed", "failed"],
        required: true,
        default: "ready",
    },
    filename: { type: String, required: true },
    filepath: { type: String, required: true, select: false },
    sha256: { type: String, required: true },
    fileSize: { type: Number, required: true },
    valid: { type: Number, default: 0 },
    invalid: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    created: { type: Number, default: 0 },
    updated: { type: Number, default: 0 },
    processed: { type: Number, default: 0 },
    errorCode: { type: String, default: "" },
    startedAt: { type: Date },
    completedAt: { type: Date },
}, { timestamps: true, versionKey: false });

// Unicamente los jobs en estado 'running' estan sujetos a unicidad.
// Nombre explicito distinto de `status_1` para poder convivir con el
// indice normal que una version anterior pudo crear en MongoDB.
schema.index(
    { status: 1 },
    {
        name: "rncimport_one_running_job_unique",
        unique: true,
        partialFilterExpression: { status: "running" },
    }
);

module.exports = mongoose.model("RncImportJob", schema);
