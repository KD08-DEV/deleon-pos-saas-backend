const internalEcfGateway = require("./internalEcfGateway");
const dgiiGateway = require("./dgiiGateway");

function getEcfGateway(environment) {
    if (environment === "internal_sandbox") {
        return internalEcfGateway;
    }

    if (environment === "dgii_certification") {
        return dgiiGateway;
    }

    if (environment === "dgii_production") {
        return dgiiGateway;
    }

    throw new Error(`Unsupported ECF environment: ${environment}`);
}

module.exports = { getEcfGateway };