const express = require("express");
const { addTable, getTables, updateTable, deleteTable } = require("../controllers/tableController");
const verifyToken   = require("../middlewares/tokenVerification");
const requireScope = require("../middlewares/scope");
const { tenantMiddleware } = require("../middlewares/tenantMiddleware");
const requireRole = require("../middlewares/requireRole");
const {tableAccounts,newConsumption,splitAccount}=require("../controllers/tableAccountsController");

const router = express.Router();

router.use(verifyToken, tenantMiddleware);

// 12.8.4.1 cuentas de mesa: siempre autenticado, tenant + clientId vienen del token.
router.get('/:id/accounts', requireScope({level:'client'}), requireRole('Owner','Admin','Cajera','Camarero'), tableAccounts);
router.post('/:id/new-consumption', requireScope({level:'client'}), requireRole('Owner','Admin','Cajera','Camarero'), newConsumption);
router.post('/:id/split', requireScope({level:'client'}), requireRole('Owner','Admin','Cajera','Camarero'), splitAccount);

router.post('/:id/move', requireScope({level:'client'}), requireRole('Owner','Admin','Cajera','Camarero'), require('../controllers/moveTableController'));

// Mesas del client actual
router.post("/",    requireScope({ level: "client" }), requireRole("Owner","Admin"), addTable);
router.get("/",     requireScope({ level: "client" }), requireRole("Owner","Admin","Cajera","Camarero"), getTables);
router.put(
    "/:id",
    requireScope({ level: "client" }),
    requireRole("Owner", "Admin", "Cajera", "Camarero"),
    updateTable
);
router.delete("/:id", requireScope({ level: "client" }), requireRole("Owner","Admin"), deleteTable);

module.exports = router;
