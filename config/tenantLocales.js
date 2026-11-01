// Supported launch presets. Fiscal DGII flows are Dominican-only, not translated.
const PRESETS = Object.freeze({
    DO: { countryCode: "DO", language: "es", locale: "es-DO", currency: "DOP", timezone: "America/Santo_Domingo" },
    US: { countryCode: "US", language: "en", locale: "en-US", currency: "USD", timezone: "America/New_York" },
    GB: { countryCode: "GB", language: "en", locale: "en-GB", currency: "GBP", timezone: "Europe/London" },
    CA: { countryCode: "CA", language: "en", locale: "en-CA", currency: "CAD", timezone: "America/Toronto" },
    AU: { countryCode: "AU", language: "en", locale: "en-AU", currency: "AUD", timezone: "Australia/Sydney" },
});
function resolveTenantLocalization(input = {}, existing = null) {
    const countryCode = String(input.countryCode || existing?.countryCode || "DO").trim().toUpperCase();
    if (!Object.hasOwn(PRESETS, countryCode)) {
        const e = new Error("UNSUPPORTED_COUNTRY"); e.status = 400; throw e;
    }
    const preset = PRESETS[countryCode];
    const changedCountry = countryCode !== existing?.countryCode;
    const language = String(input.language || (!changedCountry && existing?.language) || preset.language).toLowerCase();
    if (!["es", "en"].includes(language)) { const e = new Error("UNSUPPORTED_LANGUAGE"); e.status = 400; throw e; }
    const timezone = input.timezone || (changedCountry ? preset.timezone : existing?.timezone) || preset.timezone;
    try { new Intl.DateTimeFormat("en", { timeZone: timezone }); }
    catch { const e = new Error("INVALID_TIMEZONE"); e.status = 400; throw e; }
    return {
        countryCode, language, timezone,
        locale: language === preset.language ? preset.locale : `${language}-${countryCode}`,
        currency: preset.currency,
    };
}
module.exports = { PRESETS, resolveTenantLocalization };
