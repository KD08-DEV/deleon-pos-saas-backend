const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const SECRET = process.env.ECF_FIELD_SECRET;

if (!SECRET) {
    throw new Error("ECF_FIELD_SECRET is required");
}

function getKey() {
    return crypto.createHash("sha256").update(String(SECRET)).digest();
}

function encryptField(plainText) {
    if (!plainText) return null;

    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);

    let encrypted = cipher.update(String(plainText), "utf8", "hex");
    encrypted += cipher.final("hex");

    const authTag = cipher.getAuthTag();

    return JSON.stringify({
        iv: iv.toString("hex"),
        content: encrypted,
        tag: authTag.toString("hex"),
    });
}

function decryptField(payload) {
    if (!payload) return null;

    const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;

    const decipher = crypto.createDecipheriv(
        ALGORITHM,
        getKey(),
        Buffer.from(parsed.iv, "hex")
    );

    decipher.setAuthTag(Buffer.from(parsed.tag, "hex"));

    let decrypted = decipher.update(parsed.content, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
}

module.exports = {
    encryptField,
    decryptField,
};