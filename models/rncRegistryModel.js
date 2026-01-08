const mongoose = require("mongoose");

const rncRegistrySchema = new mongoose.Schema(
    {
        rnc: { type: String, required: true, unique: true, index: true },
        nombre: { type: String, default: "" },

        // Campos opcionales (depende del TXT)
        categoria: { type: String, default: "" },
        regimen: { type: String, default: "" },
        estatus: { type: String, default: "" },
        actividad_economica: { type: String, default: "" },
        provincia: { type: String, default: "" },
        municipio: { type: String, default: "" },

        // Metadata
        source: { type: String, default: "DGII_TXT" },
        sourceUpdatedAt: { type: Date, default: null },
    },
    { timestamps: true }
);

// Extra: índice para búsquedas por nombre (autocomplete)
rncRegistrySchema.index({ nombre: "text" });

module.exports = mongoose.model("RncRegistry", rncRegistrySchema);
