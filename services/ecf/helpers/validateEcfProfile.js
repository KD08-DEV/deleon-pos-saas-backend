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

    const allowedTypeKeys = [
        "e31",
        "e32",
        "e33",
        "e34",
        "e41",
        "e43",
        "e44",
        "e45",
        "e46",
        "e47",
    ];

    const hasTypeEnabled = allowedTypeKeys.some(
        (typeKey) => profile.documentTypes?.[typeKey]?.enabled === true
    );

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