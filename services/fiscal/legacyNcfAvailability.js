"use strict";

// This response contains only capability flags. Never return the NCF sequence,
// certificates, issuer's private configuration, or secrets to cashiers.
const summarizeLegacyNcf = (tenant, planAllowsFiscal = false) => {
    const enabled = tenant?.fiscal?.enabled === true &&
        tenant?.features?.fiscal?.enabled !== false && planAllowsFiscal === true;
    const cfg = tenant?.fiscal?.ncfConfig || {};
    const availableTypes = ["B01", "B02"].filter((type) => {
        const r = cfg[type];
        return enabled && r?.active === true &&
            Number.isSafeInteger(Number(r?.current)) &&
            Number.isSafeInteger(Number(r?.max)) &&
            Number(r.current) >= 1 && Number(r.current) <= Number(r.max);
    });
    return { enabled, availableTypes, available: availableTypes.length > 0 };
};
module.exports = { summarizeLegacyNcf };
