const {
    normalizeEcfDocumentType,
} = require("./ecfDocumentTypes");

const MAX_ECF_SEQUENCE =
    9999999999;

function buildENcf({
                       documentType = "31",
                       sequenceNumber,
                   }) {
    const type =
        normalizeEcfDocumentType(
            documentType
        );

    const n =
        Number(sequenceNumber);

    if (
        !Number.isInteger(n) ||
        n <= 0 ||
        n > MAX_ECF_SEQUENCE
    ) {
        const err =
            new Error(
                "INVALID_ECF_SEQUENCE_NUMBER"
            );

        err.statusCode = 400;

        throw err;
    }

    const seq =
        String(n).padStart(
            10,
            "0"
        );

    return `E${type}${seq}`;
}

module.exports = {
    buildENcf,
};