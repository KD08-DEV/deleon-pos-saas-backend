"use strict";
// Fase 12.7: punto único de integración para firmadores externos.
// No se infiere el proveedor desde la solicitud HTTP del usuario ni se envían
// certificados privados a terceros sin un convenio y adaptador validado.
const crypto = require("node:crypto");
const ALLOWED = Object.freeze(["local_p12", "external_provider"]);
function resolveMode(value = process.env.ECF_SIGNING_MODE) {
  const mode = String(value || "local_p12").trim();
  if (!ALLOWED.includes(mode)) {
    throw Object.assign(new Error("ECF_SIGNING_MODE_INVALID"), { statusCode: 503 });
  }
  return mode;
}
async function signEcfXml({ xml, profile }, deps = {}) {
  if (!xml || typeof xml !== "string") throw new Error("ECF_SIGNING_XML_REQUIRED");
  if (!profile?.issuer?.rnc) throw new Error("ECF_SIGNING_ISSUER_REQUIRED");
  const mode = resolveMode(deps.mode);
  if (mode === "local_p12") {
    // Conserva la ruta validada que existía antes de la Fase 12.7.
    const signLocal = deps.signLocal || require("./realSigner").realSignXml;
    return signLocal({ xml, profile });
  }
  // Falla de forma segura: nunca cae silenciosamente a un .p12 local.
  // El proveedor deberá firmar semilla y e-CF/RFCE, mantener claves bajo custodia
  // autorizada y devolver firma XMLDSIG verificada por un adaptador específico.
  const adapter = deps.externalAdapter;
  if (!adapter || typeof adapter.signXml !== "function") {
    throw Object.assign(new Error("ECF_EXTERNAL_SIGNER_ADAPTER_NOT_CONFIGURED"), { statusCode: 503 });
  }
  if (profile.environment === "dgii_production") {
    throw Object.assign(new Error("ECF_EXTERNAL_SIGNER_PRODUCTION_NOT_VALIDATED"), { statusCode: 403 });
  }
  const result = await adapter.signXml({ xml, issuerRnc: String(profile.issuer.rnc).replace(/\D/g, ""), environment: profile.environment });
  if (!result?.signedXml || typeof result.signedXml !== "string" ||
      !/<(?:[\w.-]+:)?Signature(?:\s|>)/.test(result.signedXml) ||
      !/<(?:[\w.-]+:)?SignatureValue(?:\s|>)/.test(result.signedXml)) {
    throw Object.assign(new Error("ECF_EXTERNAL_SIGNER_RESPONSE_INVALID"), { statusCode: 502 });
  }
  // A vendor's `verified: true` flag is NOT cryptographic evidence by itself.
  // Require a separate verifier in the provider adapter. No implementation has
  // been approved yet: this intentionally fails closed without one.
  if (result.verified !== true) {
    throw Object.assign(new Error("ECF_EXTERNAL_SIGNATURE_NOT_VERIFIED"), { statusCode: 502 });
  }
  if (typeof result.hash !== "string" || !/^[a-f0-9]{64}$/i.test(result.hash) ||
      typeof result.securityCode !== "string" || !/^[A-Za-z0-9+/=]{6,32}$/.test(result.securityCode)) {
    throw Object.assign(new Error("ECF_EXTERNAL_SIGNER_METADATA_REQUIRED"), { statusCode: 502 });
  }
  const expectedHash = crypto.createHash("sha256").update(result.signedXml, "utf8").digest("hex");
  if (result.hash.toLowerCase() !== expectedHash) {
    throw Object.assign(new Error("ECF_EXTERNAL_SIGNER_HASH_MISMATCH"), { statusCode: 502 });
  }
  if (typeof adapter.verifySignature !== "function") {
    throw Object.assign(new Error("ECF_EXTERNAL_SIGNER_VERIFIER_NOT_CONFIGURED"), { statusCode: 503 });
  }
  const verification = await adapter.verifySignature({
    signedXml: result.signedXml, originalXml: xml,
    expectedIssuerRnc: String(profile.issuer.rnc).replace(/\D/g, ""),
  });
  if (verification?.valid !== true ||
      String(verification.issuerRnc || "").replace(/\D/g, "") !== String(profile.issuer.rnc).replace(/\D/g, "")) {
    throw Object.assign(new Error("ECF_EXTERNAL_SIGNATURE_NOT_VERIFIED"), { statusCode: 502 });
  }
  return result;
}
module.exports = { ALLOWED, resolveMode, signEcfXml };
