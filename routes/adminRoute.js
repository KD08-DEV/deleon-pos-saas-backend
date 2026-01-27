const express = require("express");
const router = express.Router();
const  verifyToken   = require("../middlewares/tokenVerification");
const requireScope = require("../middlewares/scope");
const requireRole  = require("../middlewares/requireRole");
const { exportAllInvoices } = require("../controllers/reportExportController");
const { exportExcel } = require("../controllers/reportExportController");
const {
    getCashSessionByDate,
    getCurrentCashSession,
    openCashSession,
    addCashToSession,
    adjustOpeningFloat,
    getCashSessionsRange,
} = require("../controllers/cashSessionController");




const {
    getReports,
    getEmployees,
    getUsers,
    getUsage,

    // ✅ NUEVO (agrega estas 2 en tu adminController)
    getFiscalConfig,
    updateFiscalConfig,
    updateEmployee,
} = require("../controllers/adminController");

const {
    getSuppliers,
    createSupplier,
    updateSupplier,
    deleteSupplier,
} = require("../controllers/supplierController");

const {
    getCategories,
    createCategory,
    updateCategory,
    deleteCategory,
} = require("../controllers/inventoryCategoryController");

// Panel admin: nivel tenant (no requiere clientId)
router.use(verifyToken );
router.get(
    "/reports/export/invoices",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin","Cajera"),
    exportAllInvoices
);

router.get("/reports",   requireScope({ level: "tenant" }), requireRole("Owner","Admin","Cajera"), getReports);
router.get("/employees", requireScope({ level: "tenant" }), requireRole("Owner","Admin"), getEmployees);
router.get("/users",     requireScope({ level: "tenant" }), requireRole("Owner","Admin"), getUsers);
router.get("/usage",     requireScope({ level: "tenant" }), requireRole("Owner","Admin"), getUsage);
router.get(
    "/reports/export/excel",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin","Cajera"),
    exportExcel
);
router.get(
    "/fiscal-config",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin", "Cajera", "Camarero"),
    getFiscalConfig
);

router.patch(
    "/fiscal-config",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin", "Cajera", "Camarero"),
    updateFiscalConfig
);

router.patch(
    "/employees/:id",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin"),
    updateEmployee
);

// Suppliers routes
router.get(
    "/suppliers",
    requireScope({ level: "tenant" }),
    requireRole("Owner","Admin","Cajera","Camarero"),
    getSuppliers
);
router.post(
    "/suppliers",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin"),
    createSupplier
);
router.put(
    "/suppliers/:id",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin"),
    updateSupplier
);
router.delete(
    "/suppliers/:id",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin"),
    deleteSupplier
);

// Inventory Categories routes
router.get(
    "/inventory/categories",
    requireScope({ level: "tenant" }),
    requireRole("Owner","Admin","Cajera","Camarero"),
    getCategories
);
router.post(
    "/inventory/categories",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin"),
    createCategory
);
router.put(
    "/inventory/categories/:id",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin"),
    updateCategory
);
router.delete(
    "/inventory/categories/:id",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin"),
    deleteCategory
);

router.get("/cash-session/current",
    requireScope({ level: "client" }),
    requireRole("Owner", "Admin", "Cajera"),
    getCurrentCashSession
);

router.post("/cash-session/open",
    requireScope({ level: "client" }),
    requireRole("Owner", "Admin", "Cajera"),
    openCashSession
);

router.get(
    "/cash-session",
    requireScope({ level: "client" }),
    requireRole("Owner", "Admin", "Cajera"),
    getCashSessionByDate
);
router.get(
    "/cash-session/range",
    requireScope({ level: "client" }),
    requireRole("Owner", "Admin", "Cajera"),
    getCashSessionsRange
);


router.post(
    "/cash-session/add",
    requireScope({ level: "client" }),
    requireRole("Owner", "Admin", "Cajera"),
    addCashToSession
);

router.patch(
    "/cash-session/adjust",
    requireScope({ level: "client" }),
    requireRole("Owner", "Admin"),
    adjustOpeningFloat
);



module.exports = router;
