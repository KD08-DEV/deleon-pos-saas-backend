const TenantEcfProfile = require("../../../models/tenantEcfProfileModel");
const {
    normalizeEcfDocumentType,
    getEcfDocumentTypeKey,
} = require("./ecfDocumentTypes");

async function getNextSequence({ tenantId, documentType = "32" }) {
    const type = normalizeEcfDocumentType(documentType);
    const typeKey = getEcfDocumentTypeKey(type);
    const path = `documentTypes.${typeKey}.nextSequence`;
    const enabledPath = `documentTypes.${typeKey}.enabled`;

    const profileBeforeIncrement = await TenantEcfProfile.findOneAndUpdate(
        {
            tenantId,
            enabled: true,
            [enabledPath]: true,
        },
        {
            $inc: {
                [path]: 1,
            },
        },
        {
            new: false,
        }
    );

    if (!profileBeforeIncrement) {
        const err = new Error(`ECF_DOCUMENT_TYPE_NOT_ENABLED_${typeKey.toUpperCase()}`);
        err.statusCode = 400;
        throw err;
    }

    const current = Number(
        profileBeforeIncrement?.documentTypes?.[typeKey]?.nextSequence || 1
    );

    return current;
}

module.exports = {
    getNextSequence,
};