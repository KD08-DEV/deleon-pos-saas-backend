const mongoose = require("mongoose");

function parseTenant(tenantId) {
    if (!tenantId) return null;

    try {
        return new mongoose.Types.ObjectId(tenantId);
    } catch (_) {
        return null;
    }
}

module.exports = parseTenant;
