// DeLeonSoft — evaluador defensivo de producción e-CF (sin llamadas a DGII).
// No toma un PDF ni un clic de SuperAdmin como certificación del software.
const normalizeRnc = (value) => String(value || "").replace(/\D/g, "");
const normalizeFingerprint = (value) => String(value || "").replace(/[^a-fA-F0-9]/g, "").toUpperCase();

function assessProductionAuthorization(profile, { now = new Date() } = {}) {
  const errors = [];
  const approval = profile?.productionApproval || {};
  const enrollment = profile?.certificationVerification || {};
  const cert = profile?.certificate || {};
  const nowTime = new Date(now).getTime();
  const rnc = normalizeRnc(profile?.issuer?.rnc);
  const active = Boolean(approval?.verifiedAt && approval?.verifiedBy && !approval?.revokedAt);

  if (profile?.certificationStatus !== "certified" ||
      !enrollment.verifiedAt || !enrollment.verifiedBy ||
      enrollment.softwareName !== "DeLeonSoft" ||
      !["NEW_SOFTWARE_CERTIFICATION", "SOFTWARE_CHANGE"].includes(enrollment.method)) {
    errors.push("ECF_CERTIFICATION_NOT_VERIFIED");
  }
  if (!active || approval.approvalVersion !== 2) {
    errors.push("ECF_PRODUCTION_APPROVAL_MISSING_OR_REVOKED");
  }
  const date = approval?.evidenceDocumentDate ? new Date(approval.evidenceDocumentDate).getTime() : NaN;
  const method = approval.verificationMethod;
  const queryValid = method === "DGII_PUBLIC_QUERY" &&
      approval.dgiiTaxStatus === "ACTIVE" && approval.dgiiEcfStatus === "YES" &&
      String(approval.queriedLegalName || "").trim().length >= 3 &&
      normalizeRnc(approval.queriedRnc) === rnc &&
      approval.evidenceSource === "DGII_RNC_OFFICIAL_PORTAL";
  const officialDocumentValid = method === "DGII_OFFICIAL_DOCUMENT" &&
      approval.evidenceDocumentType === "DGII_AUTHORIZATION" &&
      String(approval.evidenceReference || "").trim().length >= 8;
  if (!queryValid && !officialDocumentValid || !Number.isFinite(date) || date > nowTime) {
    errors.push("ECF_PRODUCTION_OFFICIAL_EVIDENCE_MISSING");
  }
  // El RNC del perfil puede cambiar: NO se debe reutilizar una verificación anterior.
  if (!/^(\d{9}|\d{11})$/.test(rnc) || (active && normalizeRnc(approval.issuerRnc) !== rnc)) {
    errors.push("ECF_PRODUCTION_ISSUER_RNC_MISMATCH");
  }
  const thumbprint = normalizeFingerprint(cert?.thumbprint);
  // El certificado no es necesario para GUARDAR la consulta; sí para producción
  // mediante el firmador local actual. API de tercero pendiente de integración.
  if (!thumbprint || (active && normalizeFingerprint(approval.certificateThumbprint) !== thumbprint)) {
    errors.push("ECF_PRODUCTION_CERTIFICATE_CHANGED");
  }
  if (!cert?.isActive || !profile?.security?.certificateUploaded || !profile?.security?.passwordConfigured ||
      !cert?.bucket || !cert?.path || !cert?.passwordEncrypted) {
    errors.push("ECF_PRODUCTION_CERTIFICATE_NOT_READY");
  }
  const from = cert?.validFrom ? new Date(cert.validFrom).getTime() : NaN;
  const to = cert?.validTo ? new Date(cert.validTo).getTime() : NaN;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > nowTime || to <= nowTime) {
    errors.push("ECF_PRODUCTION_CERTIFICATE_NOT_CURRENT");
  }
  return { ok: errors.length === 0, errors };
}
module.exports = { normalizeRnc, normalizeFingerprint, assessProductionAuthorization };
