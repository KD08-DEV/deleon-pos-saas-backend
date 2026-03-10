const mongoose = require("mongoose");

const printerSchema = new mongoose.Schema(
    {
        tenantId: {
            type: String,
            required: true,
            index: true,
            trim: true,
        },

        clientId: {
            type: String,
            default: "default",
            index: true,
            trim: true,
        },

        alias: {
            type: String,
            required: true,
            trim: true,
        },

        name: {
            type: String,
            default: "",
            trim: true,
        },

        category: {
            type: String,
            enum: ["ticket", "invoice", "kitchen", "bar", "delivery", "other"],
            required: true,
            default: "ticket",
            index: true,
        },

        mode: {
            type: String,
            enum: ["browser", "qz", "network"],
            default: "browser",
            index: true,
        },

        type: {
            type: String,
            enum: ["thermal", "laser", "inkjet", "escpos", "other"],
            default: "thermal",
        },

        ip: {
            type: String,
            default: "",
            trim: true,
        },

        port: {
            type: Number,
            default: 9100,
        },

        host: {
            type: String,
            default: "",
            trim: true,
        },

        paperSize: {
            type: String,
            enum: ["58mm", "80mm", "A4"],
            default: "80mm",
        },

        qzHost: {
            type: String,
            default: "localhost",
            trim: true,
        },

        qzPort: {
            type: Number,
            default: 8181,
        },

        isDefault: {
            type: Boolean,
            default: false,
            index: true,
        },

        isActive: {
            type: Boolean,
            default: true,
            index: true,
        },

        notes: {
            type: String,
            default: "",
            trim: true,
        },

        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },

        updatedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

printerSchema.index({ tenantId: 1, clientId: 1, category: 1, isDefault: 1 });
printerSchema.index({ tenantId: 1, clientId: 1, alias: 1 });

module.exports = mongoose.model("Printer", printerSchema);