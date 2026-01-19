const mongoose = require("mongoose");

const inventoryCategorySchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        description: { type: String, default: "" },
        color: { type: String, default: "#f6b100" }, // Color para identificación visual
        icon: { type: String, default: "Package" }, // Icono de lucide-react
        
        // 🔐 multi-tenant
        tenantId: { type: String, required: true, index: true },
        clientId: { type: String, required: true, index: true, default: "default" },
    },
    { timestamps: true }
);

inventoryCategorySchema.index({ tenantId: 1, clientId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("InventoryCategory", inventoryCategorySchema);
