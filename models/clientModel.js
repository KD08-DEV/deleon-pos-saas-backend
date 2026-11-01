const mongoose = require("mongoose");

const clientSchema = new mongoose.Schema({
    clientId: { type: String, required: true, index: true },               // uuid
    tenantId: { type: String, required: true, index: true },
    name:     { type: String, required: true, trim: true, maxlength: 120 },
    address:  { type: String, default: "", trim: true, maxlength: 200 },
    phone:    { type: String, default: "", trim: true, maxlength: 40 },
    // Menu sharing will be enabled only after menu and inventory isolation is implemented.
    menuMode: { type: String, enum: ["independent", "shared"], default: "independent" },
    menuSourceClientId: { type: String, default: null },
    isActive: { type: Boolean, default: true },
    // Fase 12.6.1: preferencia por sucursal, NO autorización DGII ni permiso de emisión.
    // Solo el perfil TenantEcfProfile conserva el RNC, certificado y secuencias fiscales.
    ecf: {
        enabled: { type: Boolean, default: false },
        updatedAt: { type: Date, default: null },
        updatedBy: { type: String, default: null },
    },
}, { timestamps: true });

clientSchema.index({ tenantId: 1, clientId: 1 }, { unique: true });
clientSchema.index({ tenantId: 1, name: 1 }, { unique: true });
module.exports = mongoose.model("Client", clientSchema);
