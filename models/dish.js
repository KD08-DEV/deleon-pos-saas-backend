const mongoose = require("mongoose");

const dishSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        price: { type: Number, required: true, min: 0 },
        category: { type: String, required: true, trim: true },
        imageUrl: { type: String },

        // 🔐 multi-tenant
        tenantId: { type: String, required: true, index: true },
        clientId: { type: String, required: true, index: true },
    },
    { timestamps: true } // crea createdAt / updatedAt automáticos
);


dishSchema.index({ tenantId: 1,clientId: 1, name: 1, }, { unique: true });

module.exports = mongoose.model("dish", dishSchema);