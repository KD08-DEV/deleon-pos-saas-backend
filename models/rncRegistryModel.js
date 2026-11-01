"use strict";
const mongoose = require("mongoose");

// Padrón mínimo: no crear campos extra en las fichas RNC existentes.
// La metadata de las importaciones reside en RncImportJob, NO en esta colección.
const schema = new mongoose.Schema({
    rnc: { type: String, required: true, unique: true, index: true },
    nombre: { type: String, required: true, trim: true },
}, { strict: true, versionKey: false, collection: "rncregistries" });

// Conservar autocomplete por nombre.
schema.index({ nombre: "text" });
module.exports = mongoose.model("RncRegistry", schema);
