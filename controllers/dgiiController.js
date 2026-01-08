const RncRegistry = require("../models/rncRegistryModel");

const normalize = (v) => String(v || "").replace(/\D/g, "");

exports.lookupRncLocal = async (req, res, next) => {
    try {
        const rnc = normalize(req.params.rnc);
        if (!rnc) return res.status(400).json({ ok: false, error: "RNC inválido" });

        const found = await RncRegistry.findOne({ rnc }).lean();

        if (!found) {
            return res.status(404).json({ ok: true, data: null });
        }

        return res.json({ ok: true, data: found });
    } catch (err) {
        return next(err);
    }
};

// Autocomplete (por nombre o por rnc parcial)
exports.autocompleteLocal = async (req, res, next) => {
    try {
        const q = String(req.query.q || "").trim();
        const limit = Math.min(Number(req.query.limit || 10), 20);

        if (!q) return res.json({ ok: true, data: [] });

        const qDigits = q.replace(/\D/g, "");

        const filter = qDigits
            ? { rnc: { $regex: `^${qDigits}` } }
            : { $text: { $search: q } };

        const data = await RncRegistry.find(filter)
            .select("rnc nombre categoria regimen estatus provincia municipio")
            .limit(limit)
            .lean();

        return res.json({ ok: true, data });
    } catch (err) {
        return next(err);
    }
};
