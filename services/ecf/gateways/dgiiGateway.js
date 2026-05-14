const axios = require("axios");
const FormData = require("form-data");

const { realSignXml } = require("../signer/realSigner");
const { generateRfceXmlFromDocument } = require("../xmlBuilder");

const TOKEN_CACHE = new Map();

const DEFAULT_ECF_HOST = "https://ecf.dgii.gov.do";
const DEFAULT_FC_HOST = "https://fc.dgii.gov.do";

function getEnvironmentSlug(profile) {
    const env = String(profile?.environment || "").trim();

    if (env === "dgii_production") {
        return process.env.DGII_ECF_PROD_ENV_SLUG || "ecf";
    }

    if (env === "dgii_certification") {
        // DGII documenta testecf y certecf en diferentes etapas.
        // Déjalo configurable por .env según lo que DGII te habilite.
        return process.env.DGII_ECF_CERT_ENV_SLUG || "certecf";
    }

    throw new Error(`DGII_ENVIRONMENT_NOT_SUPPORTED: ${env}`);
}

function getUrls(profile) {
    const slug = getEnvironmentSlug(profile);

    const ecfHost = String(process.env.DGII_ECF_BASE_URL || DEFAULT_ECF_HOST).replace(/\/+$/, "");
    const fcHost = String(process.env.DGII_FC_BASE_URL || DEFAULT_FC_HOST).replace(/\/+$/, "");

    return {
        slug,

        seedUrl:
            `${ecfHost}/${slug}/autenticacion/api/autenticacion/semilla`,

        validateSeedUrl:
            `${ecfHost}/${slug}/autenticacion/api/autenticacion/validarsemilla`,

        receptionUrl:
            `${ecfHost}/${slug}/recepcion/api/facturaselectronicas`,

        queryStatusUrl:
            `${ecfHost}/${slug}/consultaresultado/api/consultas/estado`,

        // Para resumen de factura de consumo e32 menor a RD$250,000.
        // Ojo: tu xmlBuilder todavía genera XML extendido, no resumen FC.
        receptionFcUrl:
            `${fcHost}/${slug}/recepcionfc/api/recepcion/ecf`,
    };
}

function isObject(value) {
    return value && typeof value === "object" && !Buffer.isBuffer(value);
}

function extractXmlTag(xml, tagName) {
    const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
    const match = String(xml || "").match(re);
    return match?.[1]?.trim() || null;
}

function normalizeDgiiResponse(data) {
    if (Buffer.isBuffer(data)) {
        return data.toString("utf8");
    }

    return data;
}

function extractToken(data) {
    const payload = normalizeDgiiResponse(data);

    if (isObject(payload)) {
        return {
            token: payload.token || payload.Token || null,
            expira: payload.expira || payload.Expira || null,
            expedido: payload.expedido || payload.Expedido || null,
            raw: payload,
        };
    }

    const xml = String(payload || "");

    return {
        token: extractXmlTag(xml, "token"),
        expira: extractXmlTag(xml, "expira"),
        expedido: extractXmlTag(xml, "expedido"),
        raw: xml,
    };
}

function extractTrackId(data) {
    const payload = normalizeDgiiResponse(data);

    if (isObject(payload)) {
        return (
            payload.trackId ||
            payload.TrackId ||
            payload.trackID ||
            payload.TrackID ||
            null
        );
    }

    const xml = String(payload || "");
    return (
        extractXmlTag(xml, "trackId") ||
        extractXmlTag(xml, "TrackId") ||
        null
    );
}

function extractMessage(data) {
    const payload = normalizeDgiiResponse(data);

    if (isObject(payload)) {
        return (
            payload.mensaje ||
            payload.Mensaje ||
            payload.message ||
            payload.error ||
            payload.Error ||
            null
        );
    }

    const xml = String(payload || "");
    return (
        extractXmlTag(xml, "mensaje") ||
        extractXmlTag(xml, "Mensaje") ||
        extractXmlTag(xml, "error") ||
        extractXmlTag(xml, "Error") ||
        null
    );
}

function getStatusCode(data) {
    const payload = normalizeDgiiResponse(data);

    if (isObject(payload)) {
        return String(payload.codigo ?? payload.Codigo ?? payload.code ?? "");
    }

    const xml = String(payload || "");
    return String(
        extractXmlTag(xml, "codigo") ||
        extractXmlTag(xml, "Codigo") ||
        ""
    );
}

function getStatusText(data) {
    const payload = normalizeDgiiResponse(data);

    if (isObject(payload)) {
        return String(payload.estado || payload.Estado || payload.status || "");
    }

    const xml = String(payload || "");
    return String(
        extractXmlTag(xml, "estado") ||
        extractXmlTag(xml, "Estado") ||
        ""
    );
}

function mapDgiiStatus(data) {
    const code = getStatusCode(data);
    const estado = getStatusText(data);
    const text = `${estado} ${extractMessage(data) || ""}`.toLowerCase();

    if (code === "1") return "accepted";
    if (code === "2") return "rejected";
    if (code === "3") return "track_received";
    if (code === "4") return "accepted_with_observation";

    if (text.includes("aceptado condicional")) return "accepted_with_observation";
    if (text.includes("aceptado")) return "accepted";
    if (text.includes("rechaz")) return "rejected";
    if (text.includes("proceso") || text.includes("procesando")) return "track_received";
    if (text.includes("no encontrado")) return "track_received";

    return "track_received";
}

function getTokenCacheKey(profile) {
    const slug = getEnvironmentSlug(profile);
    const rnc = String(profile?.issuer?.rnc || "").trim();
    return `${slug}:${rnc}`;
}

function isTokenValid(cached) {
    if (!cached?.token) return false;

    if (!cached.expiresAt) {
        return true;
    }

    // margen de 2 minutos antes de expirar
    return Date.now() < cached.expiresAt - 120000;
}

function parseExpiryDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function buildXmlForm({ xml, filename }) {
    const form = new FormData();

    form.append("xml", Buffer.from(String(xml || ""), "utf8"), {
        filename,
        contentType: "text/xml",
    });

    return form;
}

async function requestSeed(profile) {
    const urls = getUrls(profile);

    const response = await axios.get(urls.seedUrl, {
        headers: {
            accept: "*/*",
        },
        responseType: "text",
        timeout: Number(process.env.DGII_ECF_TIMEOUT_MS || 30000),
    });

    if (!response.data) {
        throw new Error("DGII_SEED_EMPTY_RESPONSE");
    }

    return String(response.data);
}

async function validateSignedSeed({ profile, signedSeedXml }) {
    const urls = getUrls(profile);

    const form = buildXmlForm({
        xml: signedSeedXml,
        filename: "semilla_firmada.xml",
    });

    const response = await axios.post(urls.validateSeedUrl, form, {
        headers: {
            accept: "application/json",
            ...form.getHeaders(),
        },
        timeout: Number(process.env.DGII_ECF_TIMEOUT_MS || 30000),
        validateStatus: () => true,
    });

    if (response.status < 200 || response.status >= 300) {
        throw new Error(
            `DGII_VALIDATE_SEED_FAILED_HTTP_${response.status}: ${JSON.stringify(response.data)}`
        );
    }

    const tokenPayload = extractToken(response.data);

    if (!tokenPayload.token) {
        throw new Error(
            `DGII_TOKEN_NOT_FOUND_IN_RESPONSE: ${JSON.stringify(response.data)}`
        );
    }

    return tokenPayload;
}

async function getToken(profile) {
    const cacheKey = getTokenCacheKey(profile);
    const cached = TOKEN_CACHE.get(cacheKey);

    if (isTokenValid(cached)) {
        return cached.token;
    }

    const seedXml = await requestSeed(profile);

    const signedSeed = await realSignXml({
        xml: seedXml,
        profile,
    });

    const tokenPayload = await validateSignedSeed({
        profile,
        signedSeedXml: signedSeed.signedXml,
    });

    const expiresAt = parseExpiryDate(tokenPayload.expira);

    TOKEN_CACHE.set(cacheKey, {
        token: tokenPayload.token,
        expiresAt,
        raw: tokenPayload.raw,
    });

    return tokenPayload.token;
}

function shouldUseConsumerSummary(document) {
    const documentType = String(document?.ecf?.documentType || "").trim();
    const total = Number(document?.totals?.total || 0);

    // DGII indica que e32 menor a 250,000 va por resumen de factura de consumo.
    return documentType === "32" && total > 0 && total < 250000;
}

async function submitDocument({ signedXml, profile, document }) {
    if (!signedXml) {
        throw new Error("SIGNED_XML_REQUIRED");
    }

    const urls = getUrls(profile);
    const token = await getToken(profile);

    const useConsumerSummary = shouldUseConsumerSummary(document);

    const targetUrl = useConsumerSummary
        ? urls.receptionFcUrl
        : urls.receptionUrl;

    let xmlToSend = signedXml;
    let filename = `${document?.ecf?.eNCF || "ecf"}.xml`;
    let rawRfceXml = null;

    if (useConsumerSummary) {
        rawRfceXml = generateRfceXmlFromDocument({
            profile,
            document,
        });

        const signedRfce = await realSignXml({
            xml: rawRfceXml,
            profile,
        });

        xmlToSend = signedRfce.signedXml;
        filename = `${document?.ecf?.eNCF || "rfce"}_RFCE.xml`;
    }

    const form = buildXmlForm({
        xml: xmlToSend,
        filename,
    });

    const response = await axios.post(targetUrl, form, {
        headers: {
            accept: "application/json",
            Authorization: `bearer ${token}`,
            ...form.getHeaders(),
        },
        timeout: Number(process.env.DGII_ECF_TIMEOUT_MS || 30000),
        validateStatus: () => true,
    });

    const trackId = extractTrackId(response.data);
    const message = extractMessage(response.data);

    if (response.status < 200 || response.status >= 300) {
        throw new Error(
            `DGII_SUBMIT_FAILED_HTTP_${response.status}: ${JSON.stringify(response.data)}`
        );
    }

    if (!trackId) {
        throw new Error(
            `DGII_TRACKID_NOT_FOUND_IN_RESPONSE: ${JSON.stringify(response.data)}`
        );
    }

    return {
        ok: true,
        trackId,
        message,
        raw: {
            environment: profile.environment,
            dgiiEnvironmentSlug: urls.slug,
            endpoint: targetUrl,
            usedConsumerSummary: useConsumerSummary,
            rfceGenerated: Boolean(rawRfceXml),
            rfceXmlLength: rawRfceXml ? rawRfceXml.length : 0,
            httpStatus: response.status,
            response: response.data,
        },
    };
}

async function queryStatus({ trackId, profile }) {
    if (!trackId) {
        throw new Error("TRACK_ID_REQUIRED");
    }

    const urls = getUrls(profile);
    const token = await getToken(profile);

    const response = await axios.get(urls.queryStatusUrl, {
        params: {
            trackid: trackId,
        },
        headers: {
            accept: "application/json",
            Authorization: `bearer ${token}`,
        },
        timeout: Number(process.env.DGII_ECF_TIMEOUT_MS || 30000),
        validateStatus: () => true,
    });

    if (response.status < 200 || response.status >= 300) {
        throw new Error(
            `DGII_QUERY_STATUS_FAILED_HTTP_${response.status}: ${JSON.stringify(response.data)}`
        );
    }

    const status = mapDgiiStatus(response.data);
    const code = getStatusCode(response.data);
    const estado = getStatusText(response.data);
    const message = extractMessage(response.data) || estado || status;

    return {
        ok: true,
        status,
        code,
        message,
        trackId,
        raw: {
            environment: profile.environment,
            dgiiEnvironmentSlug: urls.slug,
            endpoint: urls.queryStatusUrl,
            httpStatus: response.status,
            response: response.data,
        },
    };
}

module.exports = {
    submitDocument,
    queryStatus,

    // exports útiles para pruebas manuales si luego quieres un endpoint de diagnóstico
    getToken,
    requestSeed,
};