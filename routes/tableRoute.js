const express = require("express");
const { addTable, getTables, updateTable, deleteTable } = require("../controllers/tableController");
const verifyToken   = require("../middlewares/tokenVerification");
const requireScope = require("../middlewares/scope");
const requireRole = require("../middlewares/requireRole");

const router = express.Router();

router.use(verifyToken );

// Mesas del client actual
router.post("/",    requireScope({ level: "client" }), requireRole("Owner","Admin"), addTable);
router.get("/",     requireScope({ level: "client" }), requireRole("Owner","Admin","Cashier","Waiter"), getTables);
router.put("/:id",  requireScope({ level: "client" }), requireRole("Owner","Admin"), updateTable);
router.delete("/:id", requireScope({ level: "client" }), requireRole("Owner","Admin"), deleteTable);

module.exports = router;
