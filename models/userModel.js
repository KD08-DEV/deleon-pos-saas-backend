const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const userSchema = new mongoose.Schema(
    {
        name : { type: String, required: true },
        email: {
            type: String,
            required: true,
            trim: true,
            // 👇 NO pongas unique: true aquí para que no sea global
            validate: {
                validator: v => /\S+@\S+\.\S+/.test(v),
                message: "Email must be in valid format!"
            }
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

        // 🔐 multi-tenant
        tenantId: { type: String, required: true, index: true },

        // 🔐 single-session (una sola sesión activa por cuenta)
        activeSessionId: { type: String, default: null, index: true },
        activeDeviceId: { type: String, default: null },
        lastLoginAt: { type: Date, default: null },

    },
    { timestamps: true }
);

// ❗️Unicidad por tenant + email (no global)
userSchema.index({ tenantId: 1, email: 1 }, { unique: true });

userSchema.pre("save", async function (next) {
    if (!this.isModified("password")) return next();
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
});

module.exports = mongoose.model("User", userSchema);
