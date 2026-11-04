"use strict";

const EcfEmissionAttempt = require("../models/ecfEmissionAttemptModel");
const ElectronicTaxDocument = require("../models/electronicTaxDocumentModel");
const { parseIncidentQuery, buildIncidentFilter, safeAttempt, safeDocument } =
  require("../services/ecf/ecfIncidentScope");

// Read-only incident console. Authentication, verified tenant membership and
// Owner/Admin authorization are all required at the router. Defense in depth
// deliberately refuses role, tenant or branch overrides in query/body.
function createListEcfIncidents({ Attempts = EcfEmissionAttempt, Documents = ElectronicTaxDocument } = {}) {
  return async (req, res, next) => {
    try {
      const member = req.scope?.membership;
      const tenantId = String(req.scope?.tenantId || "").trim();
      const clientId = String(req.scope?.clientId || "default").trim() || "default";
      const role = String(member?.role || "");
      if (!tenantId || !member || member.status !== "active" ||
          String(member.tenantId) !== tenantId ||
          !["Owner", "Admin"].includes(role)) {
        return res.status(403).json({ success: false, code: "ECF_INCIDENT_ACCESS_DENIED" });
      }
      const options = parseIncidentQuery(req.query);
      const isAttempts = options.mode === "attempts";
      const Model = isAttempts ? Attempts : Documents;
      const filter = buildIncidentFilter({ ...options, tenantId, clientId });
      const projection = isAttempts
        ? "_id orderId documentId documentType environment eNCF trackId stage errorCode lastCheckedAt createdAt updatedAt"
        : "_id orderId ecf.documentType ecf.environment ecf.eNCF ecf.status ecf.trackId ecf.securityCode dgiiResponse.receivedAt createdAt updatedAt";
      const [total, rows] = await Promise.all([
        Model.countDocuments(filter),
        Model.find(filter).select(projection).sort({ createdAt: -1, _id: -1 })
          .skip((options.page - 1) * options.limit).limit(options.limit).lean(),
      ]);
      res.set("Cache-Control", "private, no-store");
      return res.json({ success: true, data: {
        mode: options.mode, filter: options.filter, page: options.page,
        pageSize: options.limit, total,
        items: rows.map(isAttempts ? safeAttempt : safeDocument),
      } });
    } catch (error) {
      if (error.statusCode === 400) {
        return res.status(400).json({ success: false, code: error.message });
      }
      return next(error);
    }
  };
}
const listEcfIncidents = createListEcfIncidents();
module.exports = { createListEcfIncidents, listEcfIncidents };
