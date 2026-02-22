const mongoose = require("mongoose");

const tenantSettingsSchema = new mongoose.Schema(
    {
        tenantId: { type: String, required: true, unique: true, index: true },

        managerCodeHash: { type: String, default: "" },
        managerCodeHint: { type: String, default: "" }, // ej "***12"

        managerCodeUpdatedAt: { type: Date, default: null },
        managerCodeUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },
    { timestamps: true }
);

module.exports = mongoose.model("TenantSettings", tenantSettingsSchema);
