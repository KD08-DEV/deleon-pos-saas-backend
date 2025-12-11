require("dotenv").config({ path: "../.env" });

const mongoose = require("mongoose");
const config = require("../config/config"); // ← IMPORTANTE

const Membership = require("../models/membershipModel");
const User = require("../models/userModel");

(async () => {
    try {
        const mongoUri = config.databaseURI;  // ← ESTA ES TU URL REAL

        if (!mongoUri) {
            console.error("❌ ERROR: databaseURI está vacío o no se cargó.");
            process.exit(1);
        }

        await mongoose.connect(mongoUri);
        console.log("✅ Connected to MongoDB");

        const memberships = await Membership.find().lean();
        console.log(`🔍 Found ${memberships.length} memberships`);

        let fixed = 0;

        for (const m of memberships) {
            if (!m.user) continue;

            const user = await User.findById(m.user).lean();
            if (!user || !user.tenantId) continue;

            if (m.tenantId === user.tenantId) continue;

            await Membership.updateOne(
                { _id: m._id },
                { $set: { tenantId: user.tenantId } }
            );

            fixed++;
        }

        console.log(`✅ TenantId corregido en ${fixed} memberships`);
        process.exit(0);
    } catch (err) {
        console.error("❌ Error fixing membership tenantIds:", err);
        process.exit(1);
    }
})();
