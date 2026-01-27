const router = require("express").Router();
const createHttpError = require("http-errors");
const verifyToken = require("../middlewares/tokenVerification");
const { tenantMiddleware } = require("../middlewares/tenantMiddleware");
const Customer = require("../models/customerModel");

// GET /api/customer?q=...
router.get("/", verifyToken, tenantMiddleware, async (req, res, next) => {
    try {
        const tenantId = req.tenantId || req.user?.tenantId;
        const clientId = req.clientId || "default";

        const q = String(req.query.q || "").trim();
        const limit = Math.min(Number(req.query.limit || 20), 50);

        const filter = { tenantId, clientId, isActive: true };

        if (q) {
            const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
            filter.$or = [{ name: rx }, { phone: rx }, { address: rx }];
        }

        const list = await Customer.find(filter).sort({ createdAt: -1 }).limit(limit);
        return res.json({ success: true, data: list });
    } catch (e) {
        return next(createHttpError(500, "GET_CUSTOMERS_FAILED"));
    }
});

// POST /api/customer
router.post("/", verifyToken, tenantMiddleware, async (req, res, next) => {
    try {
        const tenantId = req.tenantId || req.user?.tenantId;
        const clientId = req.clientId || "default";

        const name = String(req.body?.name || "").trim();
        const phone = String(req.body?.phone || "").trim();
        const address = String(req.body?.address || "").trim();

        if (!name) return next(createHttpError(400, "NAME_REQUIRED"));

        // Normaliza teléfono
        const phoneNormalized = String(phone || "").replace(/\D/g, "");

        // Si hay teléfono, verifica si ya existe
        if (phoneNormalized) {
            const existing = await Customer.findOne({
                tenantId,
                clientId,
                phoneNormalized,
                isActive: true,
            });

            if (existing) {
                // ✅ OPCIÓN 1: NO crear, devolver 409
                return res.status(409).json({
                    success: false,
                    code: "PHONE_ALREADY_EXISTS",
                    data: existing,
                });

                // ✅ OPCIÓN 2 (alternativa): Reutilizar sin error
                // return res.json({ success: true, data: existing, reused: true });
            }
        }

        const doc = await Customer.create({
            tenantId,
            clientId,
            name,
            phone,
            phoneNormalized, // importante para que quede guardado en create
            address,
            isActive: true,
        });

        return res.status(201).json({ success: true, data: doc });
    } catch (e) {
        // Si hubo una carrera (2 requests a la vez), el índice único dispara esto
        if (e?.code === 11000) {
            return res.status(409).json({
                success: false,
                code: "PHONE_ALREADY_EXISTS",
            });
        }
        return next(createHttpError(500, "CREATE_CUSTOMER_FAILED"));
    }
});

module.exports = router;
