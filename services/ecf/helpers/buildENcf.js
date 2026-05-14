const { normalizeEcfDocumentType } = require("./ecfDocumentTypes");

function buildENcf({ documentType = "31", sequenceNumber }) {
    const type = normalizeEcfDocumentType(documentType);

    const n = Number(sequenceNumber);

    if (!Number.isFinite(n) || n <= 0) {
        const err = new Error("INVALID_ECF_SEQUENCE_NUMBER");
        err.statusCode = 400;
        throw err;
    }

    const seq = String(Math.floor(n)).padStart(10, "0");

    return `E${type}${seq}`;
}

module.exports = {
    buildENcf,
};