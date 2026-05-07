function buildENcf({ documentType, sequenceNumber }) {
    const padded = String(sequenceNumber).padStart(10, "0");
    return `E${documentType}${padded}`;
}

module.exports = { buildENcf };