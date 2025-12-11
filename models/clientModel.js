const mongoose = require("mongoose");

const clientSchema = new mongoose.Schema({
    clientId: { type: String, required: true, index: true },               // uuid
    tenantId: { type: String, required: true, index: true },
    name:     { type: String, required: true },
    isActive: { type: Boolean, default: true },
}, { timestamps: true });

clientSchema.index({ tenantId: 1, clientId: 1 }, { unique: true });
clientSchema.index({ tenantId: 1, name: 1 }, { unique: true });
module.exports = mongoose.model("Client", clientSchema);
