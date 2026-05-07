function validateEcfProfile(profile) {
    const errors = [];

    if (!profile) {
        errors.push("Perfil e-CF no encontrado");
        return { ok: false, errors };
    }

    if (!profile.enabled) {
        errors.push("El módulo e-CF está desactivado");
    }

    if (!profile.issuer?.rnc) errors.push("Falta RNC del emisor");
    if (!profile.issuer?.legalName) errors.push("Falta razón social");
    if (!profile.issuer?.taxAddress) errors.push("Falta dirección fiscal");
    if (!profile.environment) errors.push("Falta ambiente");

    const hasTypeEnabled =
        profile.documentTypes?.e31?.enabled ||
        profile.documentTypes?.e32?.enabled ||
        profile.documentTypes?.e33?.enabled ||
        profile.documentTypes?.e34?.enabled;

    if (!hasTypeEnabled) {
        errors.push("Debes habilitar al menos un tipo de e-CF");
    }

    const requiresRealCertificate =
        profile.environment === "dgii_certification" ||
        profile.environment === "dgii_production";

    if (requiresRealCertificate) {
        if (!profile.certificate?.path) errors.push("Falta certificado");
        if (!profile.certificate?.passwordEncrypted) {
            errors.push("Falta contraseña del certificado");
        }
    }

    return {
        ok: errors.length === 0,
        errors,
    };
}

module.exports = { validateEcfProfile };