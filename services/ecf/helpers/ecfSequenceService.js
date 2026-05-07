const TenantEcfProfile = require("../../../models/tenantEcfProfileModel");

async function getNextSequence({ tenantId, documentType }) {
    const profile = await TenantEcfProfile.findOne({ tenantId });

    if (!profile) {
        throw new Error("ECF profile not found");
    }

    const map = {
        "31": "e31",
        "32": "e32",
        "33": "e33",
        "34": "e34",
    };

    const key = map[documentType];
    if (!key) throw new Error("Unsupported document type");

    const current = profile.documentTypes[key]?.nextSequence || 1;
    profile.documentTypes[key].nextSequence = current + 1;
    await profile.save();

    return current;
}

module.exports = {
    getNextSequence,
};