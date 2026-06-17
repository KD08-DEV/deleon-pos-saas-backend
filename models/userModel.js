const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const normalizeEmailKey = (email) =>
    String(email || "").trim().toLowerCase();

const userSchema = new mongoose.Schema(
    {
        name: { type: String, required: true },

        // Email visible: se guarda como el usuario lo escribió
        email: {
            type: String,
            required: true,
            trim: true,
            validate: {
                validator: v => /\S+@\S+\.\S+/.test(v),
                message: "Email must be in valid format!"
            }
        },

        // Email interno: siempre en minúscula para login y validaciones
        emailKey: {
            type: String,
            trim: true,
            lowercase: true,
            index: true,
            select: false,
        },

        phone: {
            type: String,
            default: "",
            trim: true,
            validate: {
                validator: function (v) {
                    if (!v) return true;
                    return /^\d{7,15}$/.test(String(v));
                },
                message: "Phone number must contain between 7 and 15 digits!"
            }
        },

        password: { type: String, required: true },

        role: {
            type: String,
            required: true,
            enum: ["Admin", "Camarero", "Cocina", "Cajera"]
        },

        tenantId: { type: String, required: true, index: true },

        activeSessionId: { type: String, default: null, index: true },
        activeDeviceId: { type: String, default: null },
        lastLoginAt: { type: Date, default: null },
    },
    { timestamps: true }
);

// ✅ Antes de validar/guardar, siempre prepara emailKey
userSchema.pre("validate", function (next) {
    if (this.email) {
        this.email = String(this.email).trim(); // conserva mayúsculas/minúsculas
        this.emailKey = normalizeEmailKey(this.email);
    }
    next();
});

// ✅ Unicidad por tenant + emailKey, no por email visual
userSchema.index(
    { tenantId: 1, emailKey: 1 },
    { unique: true, sparse: true }
);

userSchema.pre("save", async function (next) {
    if (!this.isModified("password")) return next();

    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
});

module.exports = mongoose.model("User", userSchema);