const mongoose = require("mongoose");

const permissionSchema = new mongoose.Schema(
    {
        products: {
            create: { type: Boolean, default: false },
            update: { type: Boolean, default: false },
            delete: { type: Boolean, default: false },
        },
        inventory: {
            entry: { type: Boolean, default: false },  // Solo entrada / purchase
            exit: { type: Boolean, default: false },   // Salida manual
            adjust: { type: Boolean, default: false }, // Ajustes
            waste: { type: Boolean, default: false },  // Merma
        },
        orders: {
            cancel: { type: Boolean, default: false }, // Cancelar órdenes
            edit: { type: Boolean, default: false }, // Corregir órdenes normales
        },
        fiscal: {
            ecfIssue: { type: Boolean, default: false },
            creditNote: { type: Boolean, default: false },
            debitNote: { type: Boolean, default: false },
            manage: { type: Boolean, default: false }, // reservado a Owner/Admin
        },
        accountsReceivable: {
            view: {
                type: Boolean,
                default: false,
            },
        },
    },
    { _id: false }
);

const membershipSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            index: true,
            required: true,
        },

        tenantId: {
            type: String,
            required: true,
            index: true,
        },

        role: {
            type: String,
            enum: ["Owner", "Admin", "Cajera", "Camarero", "Cocina"],
            default: "Camarero",
        },

        clientIds: {
            type: [String],
            default: [],
        },

        permissions: {
            type: permissionSchema,
            default: () => ({
                products: {
                    create: false,
                    update: false,
                    delete: false,
                },
                inventory: {
                    entry: false,
                    exit: false,
                    adjust: false,
                    waste: false,
                },
                orders: {
                    cancel: false,
                    edit: false,
                },
                fiscal: { ecfIssue:false, creditNote:false, debitNote:false, manage:false },
                accountsReceivable: {
                    view: false,
                },
            }),
        },

        status: {
            type: String,
            enum: ["active", "pending", "suspended"],
            default: "active",
        },
    },
    { timestamps: true }
);

membershipSchema.index({ tenantId: 1, user: 1 }, { unique: true });

module.exports = mongoose.model("Membership", membershipSchema);