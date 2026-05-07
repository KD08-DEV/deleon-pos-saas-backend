function randomTrackId() {
    return `SANDBOX-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

async function submitDocument({ signedXml }) {
    return {
        ok: true,
        trackId: randomTrackId(),
        raw: {
            environment: "internal_sandbox",
            accepted: true,
            received: true,
            xmlLength: signedXml.length,
        },
    };
}

async function queryStatus({ trackId }) {
    return {
        ok: true,
        status: "accepted",
        code: "200",
        message: "Documento aceptado en sandbox interno",
        trackId,
        raw: {
            status: "accepted",
        },
    };
}

module.exports = {
    submitDocument,
    queryStatus,
};