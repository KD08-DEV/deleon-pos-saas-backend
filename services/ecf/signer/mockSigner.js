const crypto = require("crypto");

async function mockSignXml(xml) {
    const hash = crypto.createHash("sha256").update(xml).digest("hex");

    return {
        signedXml: xml,
        hash,
        certificateInfo: {
            mock: true,
        },
    };
}

module.exports = {
    mockSignXml,
};