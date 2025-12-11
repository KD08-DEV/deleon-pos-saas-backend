const express = require("express");
const router = express.Router();
const  verifyToken   = require("../middlewares/tokenVerification");
const requireScope = require("../middlewares/scope");
const requireRole  = require("../middlewares/requireRole");
const { exportAllInvoices } = require("../controllers/reportExportController");
const { exportExcel } = require("../controllers/reportExportController");



const {
    getReports,
    getEmployees,
    getUsers,
    getUsage,
} = require("../controllers/adminController");

// Panel admin: nivel tenant (no requiere clientId)
router.use(verifyToken );
router.get(
    "/reports/export/invoices",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin"),
    exportAllInvoices
);

router.get("/reports",   requireScope({ level: "tenant" }), requireRole("Owner","Admin"), getReports);
router.get("/employees", requireScope({ level: "tenant" }), requireRole("Owner","Admin"), getEmployees);
router.get("/users",     requireScope({ level: "tenant" }), requireRole("Owner","Admin"), getUsers);
router.get("/usage",     requireScope({ level: "tenant" }), requireRole("Owner","Admin"), getUsage);
router.get(
    "/reports/export/excel",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin"),
    exportExcel
);

module.exports = router;
