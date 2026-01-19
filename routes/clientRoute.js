const router = require("express").Router();
const  verifyToken   = require("../middlewares/tokenVerification");
const requireScope = require("../middlewares/scope");
const requireRole  = require("../middlewares/requireRole");
const Client = require("../models/clientModel");

router.use(verifyToken );

// Listar clients del tenant actual
router.get("/", requireScope({ level: "tenant" }), requireRole("Owner","Admin","Cajera","Camarero"), async (req, res) => {
    const list = await Client.find({ tenantId: req.scope.tenantId }).sort({ createdAt: -1 });
    res.json({ success: true, data: list });
});

// Crear un client (Owner/Admin)
router.post("/", requireScope({ level: "tenant" }), requireRole("Owner","Admin"), async (req, res) => {
    const { clientId, name } = req.body; // clientId = uuid; name visible
    const doc = await Client.create({ tenantId: req.scope.tenantId, clientId, name, isActive: true });
    res.status(201).json({ success: true, data: doc });
});

module.exports = router;
