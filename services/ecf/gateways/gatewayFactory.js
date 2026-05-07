const internalEcfGateway = require("./internalEcfGateway");

function getEcfGateway(environment) {
    if (environment === "internal_sandbox") {
        return internalEcfGateway;
    }

    if (environment === "dgii_certification") {
        throw new Error("DGII certification gateway not implemented yet");
    }

    if (environment === "dgii_production") {
        throw new Error("DGII production gateway not implemented yet");
    }

    throw new Error(`Unsupported ECF environment: ${environment}`);
}

module.exports = { getEcfGateway };