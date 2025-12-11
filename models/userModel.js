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
            type: Number,
            required: true,
            validate: {
                validator: v => /\d{10}/.test(v),
                message: "Phone number must be a 10-digit number!"
            }
        },
        password: { type: String, required: true },
        role: { type: String, required: true, enum: ["Admin", "Waiter", "Cashier"] },

        // 🔐 multi-tenant
        tenantId: { type: String, required: true, index: true },
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
