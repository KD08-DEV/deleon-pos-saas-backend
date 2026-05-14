const crypto = require("crypto");
const forge = require("node-forge");
const { SignedXml } = require("xml-crypto");

const { supabase } = require("../../../config/supabaseClient");
const { decryptField } = require("../helpers/encryptField");

function bufferFromSupabaseDownload(data) {
    if (!data) {
        throw new Error("CERTIFICATE_DOWNLOAD_EMPTY");
    }

    if (Buffer.isBuffer(data)) {
        return data;
    }

    if (data instanceof ArrayBuffer) {
        return Buffer.from(data);
    }

    if (typeof data.arrayBuffer === "function") {
        return data.arrayBuffer().then((arrayBuffer) => Buffer.from(arrayBuffer));
    }

    throw new Error("UNSUPPORTED_CERTIFICATE_DOWNLOAD_FORMAT");
}

function pemNormalize(pem = "") {
    return String(pem || "").replace(/\r\n/g, "\n").trim() + "\n";
}

function extractPrivateKeyAndCertificateFromP12({ p12Buffer, password }) {
    const binary = p12Buffer.toString("binary");
    const asn1 = forge.asn1.fromDer(binary);

    let p12;

    try {
        p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
    } catch (error) {
        throw new Error("INVALID_CERTIFICATE_PASSWORD_OR_FILE");
    }

    const keyBags = p12.getBags({
        bagType: forge.pki.oids.pkcs8ShroudedKeyBag,
    })[forge.pki.oids.pkcs8ShroudedKeyBag];

    const fallbackKeyBags = p12.getBags({
        bagType: forge.pki.oids.keyBag,
    })[forge.pki.oids.keyBag];

    const certBags = p12.getBags({
        bagType: forge.pki.oids.certBag,
    })[forge.pki.oids.certBag];

    const keyBag = keyBags?.[0] || fallbackKeyBags?.[0];
    const certBag = certBags?.[0];

    if (!keyBag?.key) {
        throw new Error("PRIVATE_KEY_NOT_FOUND_IN_CERTIFICATE");
    }

    if (!certBag?.cert) {
        throw new Error("PUBLIC_CERTIFICATE_NOT_FOUND_IN_CERTIFICATE");
    }

    const privateKeyPem = forge.pki.privateKeyToPem(keyBag.key);
    const certificatePem = forge.pki.certificateToPem(certBag.cert);

    const subject = certBag.cert.subject.attributes.reduce((acc, attr) => {
        acc[attr.name || attr.shortName] = attr.value;
        return acc;
    }, {});

    const issuer = certBag.cert.issuer.attributes.reduce((acc, attr) => {
        acc[attr.name || attr.shortName] = attr.value;
        return acc;
    }, {});

    return {
        privateKeyPem: pemNormalize(privateKeyPem),
        certificatePem: pemNormalize(certificatePem),
        certificateInfo: {
            subject,
            issuer,
            serialNumber: certBag.cert.serialNumber || null,
            validFrom: certBag.cert.validity?.notBefore || null,
            validTo: certBag.cert.validity?.notAfter || null,
        },
    };
}

function signXmlWithPem({ xml, privateKeyPem, certificatePem }) {
    const sig = new SignedXml({
        privateKey: privateKeyPem,
        publicCert: certificatePem,
        canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
        signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    });

    sig.addReference({
        xpath: "/*",
        transforms: [
            "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
            "http://www.w3.org/2001/10/xml-exc-c14n#",
        ],
        digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    });

    sig.computeSignature(xml, {
        location: {
            reference: "/*",
            action: "append",
        },
    });

    return sig.getSignedXml();
}

async function realSignXml({ xml, profile }) {
    if (!xml) {
        throw new Error("XML_REQUIRED");
    }

    if (!profile?.certificate?.bucket || !profile?.certificate?.path) {
        throw new Error("ECF_CERTIFICATE_NOT_CONFIGURED");
    }

    if (!profile?.certificate?.passwordEncrypted) {
        throw new Error("ECF_CERTIFICATE_PASSWORD_NOT_CONFIGURED");
    }

    const password = decryptField(profile.certificate.passwordEncrypted);

    if (!password) {
        throw new Error("ECF_CERTIFICATE_PASSWORD_DECRYPT_FAILED");
    }

    const { data, error } = await supabase.storage
        .from(profile.certificate.bucket)
        .download(profile.certificate.path);

    if (error) {
        console.error("[realSignXml] Supabase download error:", error);
        throw new Error(`CERTIFICATE_DOWNLOAD_FAILED: ${error.message}`);
    }

    const p12Buffer = await bufferFromSupabaseDownload(data);

    const {
        privateKeyPem,
        certificatePem,
        certificateInfo,
    } = extractPrivateKeyAndCertificateFromP12({
        p12Buffer,
        password,
    });

    const signedXml = signXmlWithPem({
        xml,
        privateKeyPem,
        certificatePem,
    });

    const hash = crypto
        .createHash("sha256")
        .update(signedXml)
        .digest("hex");

    return {
        signedXml,
        hash,
        certificateInfo,
    };
}

module.exports = {
    realSignXml,
};