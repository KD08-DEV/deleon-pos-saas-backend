const mongoose = require("mongoose");

const membershipSchema = new mongoose.Schema({
    user:     { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true, required: true },
    tenantId: { type: String, required: true, index: true },
    role:     { type: String, enum: ["Owner","Admin","Cajera","Camarero"], default: "Camarero" },
    clientIds:{ type: [String], default: [] }, // workspaces a los que puede entrar
    status:   { type: String, enum: ["active","pending","suspended"], default: "active" },
}, { timestamps: true });

membershipSchema.index({ tenantId: 1, user: 1 }, { unique: true });
module.exports = mongoose.model("Membership", membershipSchema);

