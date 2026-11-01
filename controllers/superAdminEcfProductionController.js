const crypto = require("node:crypto");
const multer = require("multer");
const Tenant = require("../models/tenantModel");
const TenantEcfProfile = require("../models/tenantEcfProfileModel");
const { normalizeRnc, normalizeFingerprint, assessProductionAuthorization } =
  require("../services/ecf/helpers/ecfProductionAuthorization");

// No se comunica con la DGII ni emite autorización oficial.
// Solo documenta la verificación humana realizada FUERA de DeLeonSoft.
const DOCUMENT_TYPES = new Set(["DGII_PUBLIC_QUERY", "DGII_OFFICIAL_DOCUMENT"]); // Consulta de RNC o documento auténtico.
const ENROLLMENT_METHODS = new Set(["NEW_SOFTWARE_CERTIFICATION", "SOFTWARE_CHANGE"]);
const APPROVAL_PHRASE = "VERIFIQUE AUTORIZACION DGII";
const REVOKE_PHRASE = "REVOCAR PRODUCCION ECF";
// El sistema opera con emisores dominicanos. Comparar DÍAS locales,
// nunca la hora de un Date artificial a mediodía UTC: hoy antes de las
// 08:00 en RD se consideraba erróneamente «fecha futura».
const todayInDR = () => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Santo_Domingo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const part = (key) => parts.find(({ type }) => type === key)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
};
const CERTIFICATION_PHRASE = "CONFIRME CERTIFICACION DGII";
const actor = (req) => String(req?.user?.email || req?.user?._id || req?.user?.id || process.env.SUPERADMIN_EMAIL || "SuperAdmin").trim().toLowerCase();

const reject = (res, status, code, details) => res.status(status).json({ success: false, code, ...(details ? { errors: details } : {}) });
const isSuper = (req) => req.user?.role === "SuperAdmin";
const isDO = (tenant) => String(tenant?.localization?.countryCode || "DO").toUpperCase() === "DO";
const approvalActive = (p) => Boolean(p?.productionApproval?.verifiedAt && !p?.productionApproval?.revokedAt && p?.productionApproval?.approvalVersion === 2);
const formatState = (p) => p?.productionApproval?.revokedAt ? "revoked" : (approvalActive(p) ? "verified" : "pending");

function publicProfile(profile) {
  if (!profile) return null;
  const p = profile.toObject ? profile.toObject() : profile;
  const a = p.productionApproval || {};
  const cert = p.certificate || {};
  const assessment = assessProductionAuthorization(p);
  return {
    tenantId: p.tenantId, enabled: Boolean(p.enabled), environment: p.environment,
    certificationStatus: p.certificationStatus, authorizationState: formatState(p),
    certificationVerification: {
      verifiedAt: p.certificationVerification?.verifiedAt || null,
      verifiedBy: p.certificationVerification?.verifiedBy || null,
      method: p.certificationVerification?.method || null,
      reference: p.certificationVerification?.reference || null,
      softwareName: p.certificationVerification?.softwareName || null,
    },
    issuer: { rnc: p.issuer?.rnc || "", legalName: p.issuer?.legalName || "" },
    certificate: {
      subjectName: cert.subjectName || null, serialNumber: cert.serialNumber || null,
      thumbprint: cert.thumbprint || null, validFrom: cert.validFrom || null,
      validTo: cert.validTo || null, isActive: cert.isActive === true,
      uploadedAt: cert.uploadedAt || null,
    },
    productionApproval: {
      verificationMethod: a.verificationMethod || null,
      dgiiTaxStatus: a.dgiiTaxStatus || null,
      dgiiEcfStatus: a.dgiiEcfStatus || null,
      queriedRnc: a.queriedRnc || null,
      queriedLegalName: a.queriedLegalName || null,
      evidenceSource: a.evidenceSource || null,
      evidenceReference: a.evidenceReference || null,
      evidenceDocumentType: a.evidenceDocumentType || null,
      evidenceDocumentDate: a.evidenceDocumentDate || null,
      evidenceFile: a.evidenceFile?.sha256 ? {
        name: a.evidenceFile.name, sha256: a.evidenceFile.sha256,
        uploadedAt: a.evidenceFile.uploadedAt, size: a.evidenceFile.size,
      } : null,
      verificationNotes: a.verificationNotes || null,
      issuerRnc: a.issuerRnc || null, certificateThumbprint: a.certificateThumbprint || null,
      verifiedAt: a.verifiedAt || null, verifiedBy: a.verifiedBy || null,
      revokedAt: a.revokedAt || null, revokedBy: a.revokedBy || null,
      revocationReason: a.revocationReason || null,
    },
    productionGuard: assessment,
    history: (p.approvalHistory || []).slice().reverse().map(({ action, at, actor: who, reason, issuerRnc, certificateThumbprint, evidenceReference, evidenceFileSha256 }) => ({
      action, at, actor: who, reason, issuerRnc, certificateThumbprint, evidenceReference, evidenceFileSha256,
    })),
  };
}

async function loadTarget(tenantId) {
  const tenant = await Tenant.findOne({ tenantId }).select("tenantId name status plan localization.countryCode fiscal.enabled features.fiscal.enabled").lean();
  if (!tenant) return { code: "TENANT_NOT_FOUND", status: 404 };
  if (!isDO(tenant)) return { code: "DOMINICAN_FISCAL_NOT_ALLOWED", status: 403 };
  const profile = await TenantEcfProfile.findOne({ tenantId });
  if (!profile) return { code: "ECF_PROFILE_NOT_FOUND", status: 404 };
  if (!profile.enabled) return { code: "ECF_NOT_ENABLED", status: 409 };
  return { tenant, profile };
}

exports.list = async (req, res) => {
  if (!isSuper(req)) return reject(res, 403, "ECF_APPROVAL_SUPERADMIN_ONLY");
  try {
    const profiles = await TenantEcfProfile.find({ enabled: true })
      .select("tenantId enabled environment certificationStatus issuer.rnc issuer.legalName certificate.subjectName certificate.serialNumber certificate.thumbprint certificate.validFrom certificate.validTo certificate.isActive certificate.uploadedAt certificate.bucket certificate.path certificate.passwordEncrypted security productionApproval certificationVerification approvalHistory")
      .lean();
    const tenants = await Tenant.find({ tenantId: { $in: profiles.map(p => p.tenantId) } })
      .select("tenantId name status plan localization.countryCode fiscal.enabled features.fiscal.enabled").lean();
    const byId = new Map(tenants.map(t => [t.tenantId, t]));
    const rows = profiles.filter(p => byId.has(p.tenantId) && isDO(byId.get(p.tenantId))).map(p => {
      const t = byId.get(p.tenantId);
      const { history, ...safe } = publicProfile(p);
      return { ...safe, company: t.name, tenantStatus: t.status,
        fiscalEnabled: t.fiscal?.enabled === true && t.features?.fiscal?.enabled !== false, plan: t.plan };
    });
    rows.sort((a,b) => String(a.company).localeCompare(String(b.company), "es"));
    return res.json({ success: true, data: rows });
  } catch (error) {
    console.error("[ecf authorizations list]", error);
    return reject(res, 500, "ECF_AUTHORIZATIONS_LIST_FAILED");
  }
};

exports.detail = async (req, res) => {
  if (!isSuper(req)) return reject(res, 403, "ECF_APPROVAL_SUPERADMIN_ONLY");
  try {
    const result = await loadTarget(String(req.params.tenantId || "").trim());
    if (result.code) return reject(res, result.status, result.code);
    return res.json({ success: true, data: {
      ...publicProfile(result.profile), company: result.tenant.name,
      tenantStatus: result.tenant.status,
      fiscalEnabled: result.tenant.fiscal?.enabled === true && result.tenant.features?.fiscal?.enabled !== false,
    }});
  } catch (error) {
    console.error("[ecf authorization detail]", error);
    return reject(res, 500, "ECF_AUTHORIZATION_DETAIL_FAILED");
  }
};

// Rechazar archivos enormes antes de almacenar en RAM. PDF oficial, no P12/PFX.
exports.evidenceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, /\.pdf$/i.test(file.originalname) && ["application/pdf", "application/octet-stream"].includes(file.mimetype)),
}).single("evidence");

function privateStorage() {
  const bucket = String(process.env.ECF_EVIDENCE_BUCKET || "").trim();
  if (!bucket) return null;
  // Carga diferida: no afectar el arranque de servidores de pruebas sin Supabase.
  return { bucket, storage: require("../config/supabaseClient").supabase.storage };
}

async function verifiedPrivateBucket(config) {
  const { data, error } = await config.storage.getBucket(config.bucket);
  return !error && data && data.public === false;
}

exports.uploadEvidence = async (req, res) => {
  if (!isSuper(req)) return reject(res, 403, "ECF_APPROVAL_SUPERADMIN_ONLY");
  if (!req.file || req.file.buffer.subarray(0, 5).toString() !== "%PDF-") return reject(res, 400, "ECF_EVIDENCE_PDF_REQUIRED");
  try {
    const tenantId = String(req.params.tenantId || "").trim();
    const target = await loadTarget(tenantId);
    if (target.code) return reject(res, target.status, target.code);
    if (approvalActive(target.profile)) return reject(res, 409, "ECF_REVOKE_BEFORE_REPLACING_EVIDENCE");
    const config = privateStorage();
    if (!config || !(await verifiedPrivateBucket(config))) return reject(res, 503, "ECF_EVIDENCE_PRIVATE_BUCKET_REQUIRED");
    const fingerprint = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
    const path = `${crypto.createHash("sha256").update(tenantId).digest("hex")}/${crypto.randomUUID()}.pdf`;
    const { error } = await config.storage.from(config.bucket).upload(path, req.file.buffer, { contentType: "application/pdf", upsert: false });
    if (error) return reject(res, 503, "ECF_EVIDENCE_UPLOAD_FAILED");
    const p = target.profile;
    const now = new Date();
    p.productionApproval = {
      ...(p.productionApproval?.toObject?.() || p.productionApproval || {}),
      evidenceFile: { bucket: config.bucket, path, name: String(req.file.originalname).slice(0, 160),
        sha256: fingerprint, size: req.file.size, uploadedAt: now },
    };
    p.approvalHistory.push({ action: "EVIDENCE_UPLOADED", at: now, actor: actor(req), reason: "PDF de evidencia almacenado en bucket privado",
      issuerRnc: normalizeRnc(p.issuer?.rnc), certificateThumbprint: normalizeFingerprint(p.certificate?.thumbprint),
      evidenceFileSha256: fingerprint, evidenceBucket: config.bucket, evidencePath: path });
    try { await p.save(); } catch (err) {
      await config.storage.from(config.bucket).remove([path]).catch(() => {});
      throw err;
    }
    // La copia anterior se conserva para la cadena de custodia; no se sirve al negocio.
    return res.json({ success: true, data: publicProfile(p) });
  } catch (error) {
    console.error("[ecf evidence upload]", error);
    return reject(res, 500, "ECF_EVIDENCE_SAVE_FAILED");
  }
};

exports.evidenceUrl = async (req, res) => {
  if (!isSuper(req)) return reject(res, 403, "ECF_APPROVAL_SUPERADMIN_ONLY");
  try {
    const result = await loadTarget(String(req.params.tenantId || "").trim());
    if (result.code) return reject(res, result.status, result.code);
    const file = result.profile.productionApproval?.evidenceFile;
    const config = privateStorage();
    if (!file?.path || !config || file.bucket !== config.bucket || !(await verifiedPrivateBucket(config))) {
      return reject(res, 404, "ECF_EVIDENCE_NOT_AVAILABLE");
    }
    const { data, error } = await config.storage.from(file.bucket).createSignedUrl(file.path, 60);
    if (error || !data?.signedUrl) return reject(res, 503, "ECF_EVIDENCE_VIEW_FAILED");
    return res.json({ success: true, data: { url: data.signedUrl, validForSeconds: 60 } });
  } catch (error) {
    console.error("[ecf evidence view]", error);
    return reject(res, 500, "ECF_EVIDENCE_VIEW_FAILED");
  }
};

// Registra una consulta pública REAL o comunicación oficial verificada manualmente.
// NO afirma que el software DeLeonSoft completó el proceso de certificación.
exports.approve = async (req, res) => {
  if (!isSuper(req)) return reject(res, 403, "ECF_APPROVAL_SUPERADMIN_ONLY");
  try {
    const tenantId = String(req.params.tenantId || "").trim();
    const method = String(req.body?.verificationMethod || "");
    const notes = String(req.body?.verificationNotes || "").trim();
    const ref = String(req.body?.evidenceReference || "").trim();
    const dateValue = String(req.body?.evidenceDocumentDate || "");
    const dt = /^\d{4}-\d{2}-\d{2}$/.test(dateValue) ? new Date(`${dateValue}T12:00:00Z`) : new Date(NaN);
    if (req.body?.confirmation !== APPROVAL_PHRASE || !DOCUMENT_TYPES.has(method) ||
        notes.length < 12 || notes.length > 1000 || ref.length > 180) {
      return reject(res, 400, "ECF_APPROVAL_EVIDENCE_REQUIRED", [
        "Comprueba el método, la confirmación literal y las notas (12–1000 caracteres).",
      ]);
    }
    if (!Number.isFinite(dt.getTime()) || dt.getUTCFullYear() < 2000 ||
        dt.toISOString().slice(0, 10) !== dateValue) {
      return reject(res, 400, "ECF_APPROVAL_INVALID_DATE", [
        "La fecha de consulta debe ser una fecha real en formato AAAA-MM-DD.",
      ]);
    }
    // Se compara la fecha civil en RD, NO la hora ficticia T12:00:00Z de dt.
    if (dateValue > todayInDR()) {
      return reject(res, 400, "ECF_APPROVAL_FUTURE_DATE", [
        "La fecha de consulta no puede ser posterior a hoy en República Dominicana.",
      ]);
    }
    const target = await loadTarget(tenantId);
    if (target.code) return reject(res, target.status, target.code);
    const profile = target.profile;
    if (approvalActive(profile)) return reject(res, 409, "ECF_ALREADY_APPROVED");
    if (profile.environment === "dgii_production") return reject(res, 409, "ECF_SWITCH_OUT_OF_PRODUCTION_FIRST");

    const rnc = normalizeRnc(profile.issuer?.rnc);
    const submittedRnc = normalizeRnc(req.body?.issuerRnc);
    if (!/^(\d{9}|\d{11})$/.test(rnc) || submittedRnc !== rnc) {
      return reject(res, 400, "ECF_APPROVAL_IDENTITY_MISMATCH");
    }
    const currentFingerprint = normalizeFingerprint(profile.certificate?.thumbprint);
    const submittedFingerprint = normalizeFingerprint(req.body?.certificateThumbprint);
    if (submittedFingerprint && submittedFingerprint !== currentFingerprint) {
      return reject(res, 400, "ECF_APPROVAL_IDENTITY_MISMATCH");
    }
    const queriedRnc = normalizeRnc(req.body?.queriedRnc);
    const queriedLegalName = String(req.body?.queriedLegalName || "").trim();
    const dgiiTaxStatus = String(req.body?.dgiiTaxStatus || "");
    const dgiiEcfStatus = String(req.body?.dgiiEcfStatus || "");
    const publicQuery = method === "DGII_PUBLIC_QUERY";
    if (publicQuery && (queriedRnc !== rnc || queriedLegalName.length < 3 ||
        queriedLegalName.length > 240 || dgiiTaxStatus !== "ACTIVE" || dgiiEcfStatus !== "YES")) {
      return reject(res, 400, "ECF_DGII_QUERY_NOT_CONFIRMED");
    }
    if (!publicQuery && ref.length < 8) return reject(res, 400, "ECF_OFFICIAL_DOCUMENT_REFERENCE_REQUIRED");

    const previous = profile.productionApproval?.toObject?.() || profile.productionApproval || {};
    const now = new Date();
    profile.productionApproval = {
      ...previous,
      approvalVersion: 2,
      verificationMethod: method,
      evidenceSource: publicQuery ? "DGII_RNC_OFFICIAL_PORTAL" : "DGII_OFFICIAL_DOCUMENT",
      evidenceReference: ref || null,
      evidenceDocumentType: publicQuery ? "DGII_PUBLIC_QUERY" : "DGII_AUTHORIZATION",
      evidenceDocumentDate: dt,
      dgiiTaxStatus: publicQuery ? "ACTIVE" : null,
      dgiiEcfStatus: publicQuery ? "YES" : null,
      queriedRnc: publicQuery ? queriedRnc : null,
      queriedLegalName: publicQuery ? queriedLegalName : null,
      issuerRnc: rnc, certificateThumbprint: currentFingerprint || null,
      verificationNotes: notes, verifiedAt: now, verifiedBy: actor(req),
      revokedAt: null, revokedBy: null, revocationReason: null,
    };
    // CRÍTICO: no mutar certificationStatus ni habilitar production.
    profile.approvalHistory.push({ action: "APPROVED", at: now, actor: actor(req), reason: notes,
      issuerRnc: rnc, certificateThumbprint: currentFingerprint || "",
      evidenceReference: ref || `CONSULTA_RNC:${rnc}`,
      evidenceFileSha256: previous.evidenceFile?.sha256 || "",
      evidenceBucket: previous.evidenceFile?.bucket || "", evidencePath: previous.evidenceFile?.path || "" });
    await profile.save();
    return res.json({ success: true, data: publicProfile(profile),
      note: "Consulta DGII guardada en auditoría. No certifica el software ni activa producción." });
  } catch (error) {
    console.error("[ecf approve]", error);
    return reject(res, 500, "ECF_PRODUCTION_APPROVAL_SAVE_FAILED");
  }
};

// Paso INDEPENDIENTE: comprobar que DGII terminó la certificación o cambio
// del contribuyente AL SOFTWARE DeLeonSoft. Nunca se ejecuta al registrar RNC.
exports.confirmCertification = async (req, res) => {
  if (!isSuper(req)) return reject(res, 403, "ECF_APPROVAL_SUPERADMIN_ONLY");
  try {
    const method = String(req.body?.method || "");
    const reference = String(req.body?.reference || "").trim();
    const notes = String(req.body?.notes || "").trim();
    if (req.body?.confirmation !== CERTIFICATION_PHRASE || !ENROLLMENT_METHODS.has(method) ||
        notes.length < 20 || notes.length > 1000 || reference.length < 8 || reference.length > 180) {
      return reject(res, 400, "ECF_SOFTWARE_CERTIFICATION_EVIDENCE_REQUIRED");
    }
    const target = await loadTarget(String(req.params.tenantId || "").trim());
    if (target.code) return reject(res, target.status, target.code);
    const p = target.profile;
    if (!approvalActive(p) || p.productionApproval?.approvalVersion !== 2) {
      return reject(res, 409, "ECF_VERIFY_DGII_ISSUER_FIRST");
    }
    if (p.environment === "dgii_production") return reject(res, 409, "ECF_SWITCH_OUT_OF_PRODUCTION_FIRST");
    if (p.certificationVerification?.verifiedAt) return reject(res, 409, "ECF_SOFTWARE_ALREADY_VERIFIED");
    const now = new Date();
    p.certificationVerification = { verifiedAt: now, verifiedBy: actor(req), method,
      reference, notes, softwareName: "DeLeonSoft" };
    p.certificationStatus = "certified";
    p.approvalHistory.push({ action: "CERTIFICATION_CONFIRMED", at: now, actor: actor(req), reason: notes,
      issuerRnc: normalizeRnc(p.issuer?.rnc),
      certificateThumbprint: normalizeFingerprint(p.certificate?.thumbprint), evidenceReference: reference });
    await p.save();
    return res.json({ success: true, data: publicProfile(p), note: "Confirmación interna de incorporación a DeLeonSoft. Producción NO activada." });
  } catch (error) {
    console.error("[ecf certify software]", error);
    return reject(res, 500, "ECF_CERTIFICATION_SAVE_FAILED");
  }
};

exports.revoke = async (req, res) => {
  if (!isSuper(req)) return reject(res, 403, "ECF_APPROVAL_SUPERADMIN_ONLY");
  try {
    const tenantId = String(req.params.tenantId || "").trim();
    const reason = String(req.body?.reason || "").trim();
    if (req.body?.confirmation !== REVOKE_PHRASE || reason.length < 10 || reason.length > 1000) {
      return reject(res, 400, "ECF_REVOCATION_CONFIRMATION_REQUIRED");
    }
    const target = await loadTarget(tenantId);
    if (target.code) return reject(res, target.status, target.code);
    const p = target.profile;
    if (!approvalActive(p)) return reject(res, 409, "ECF_NOT_CURRENTLY_APPROVED");
    const now = new Date();
    p.productionApproval.revokedAt = now;
    p.productionApproval.revokedBy = actor(req);
    p.productionApproval.revocationReason = reason;
    // Bloquea la aprobación interna; NO revoca la certificación otorgada por DGII.
    // Cambia el entorno únicamente para deshabilitar producción, nunca para activarla.
    if (p.environment === "dgii_production") p.environment = "dgii_certification";
    p.approvalHistory.push({ action: "REVOKED", at: now, actor: actor(req), reason,
      issuerRnc: normalizeRnc(p.issuer?.rnc), certificateThumbprint: normalizeFingerprint(p.certificate?.thumbprint),
      evidenceReference: p.productionApproval.evidenceReference,
      evidenceFileSha256: p.productionApproval.evidenceFile?.sha256,
      evidenceBucket: p.productionApproval.evidenceFile?.bucket,
      evidencePath: p.productionApproval.evidenceFile?.path });
    await p.save();
    return res.json({ success: true, data: publicProfile(p) });
  } catch (error) {
    console.error("[ecf revoke]", error);
    return reject(res, 500, "ECF_PRODUCTION_REVOCATION_FAILED");
  }
};
