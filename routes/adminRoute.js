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
    closeCashSession,
    addCashToSession,
    adjustOpeningFloat,
    getCashSessionsRange,
    adjustCashSessionClosing,
} = require("../controllers/cashSessionController");
const { getManagerCodeStatus, setManagerCode } = require("../controllers/adminController");
const {
    listRegisters,
    createRegister,
    updateRegister,
    toggleRegister,
} = require("../controllers/registerController");




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
    listPurchases,
    createPurchase,
    addPurchasePayment,
} = require("../controllers/purchaseController");

const {
    getCategories,
    createCategory,
    updateCategory,
    deleteCategory,
} = require("../controllers/inventoryCategoryController");
const {
    listExpenseCategories,
    createExpenseCategory,
    updateExpenseCategory,
    deleteExpenseCategory,
    listExpenses,
    createExpense,
    updateExpense,
    voidExpense,
} = require("../controllers/expenseController");

const {
    listPayrollRuns,
    getPayrollRun,
    createPayrollRun,
    updatePayrollRun,
    postPayrollRun,
} = require("../controllers/payrollController");

const { getFinanceSummary } = require("../controllers/summaryController");

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
router.post("/cash-session/close",
    requireScope({ level: "client" }),
    requireRole("Owner", "Admin", "Cajera"),
    closeCashSession
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
    requireRole("Owner", "Admin"),
    addCashToSession
);

router.patch(
    "/cash-session/adjust",
    requireScope({ level: "client" }),
    requireRole("Owner", "Admin"),
    adjustOpeningFloat
);
router.patch(
    "/cash-session/close-adjust",
    requireScope({ level: "client" }),
    requireRole("Owner", "Admin"),
    adjustCashSessionClosing
);

router.get(
    "/manager-code",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin"),
    getManagerCodeStatus
);

router.patch(
    "/manager-code",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin"),
    setManagerCode
);
router.get(
    "/purchases",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin", "Cajera"),
    listPurchases
);

router.post(
    "/purchases",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin"),
    createPurchase
);

router.post(
    "/purchases/:id/payments",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin"),
    addPurchasePayment
);
// Expense Categories (Owner/Admin)
router.get("/expense-categories", requireScope({ level: "tenant" }), requireRole("Owner","Admin","Cajera"), listExpenseCategories);
router.post("/expense-categories", requireScope({ level: "tenant" }), requireRole("Owner","Admin"), createExpenseCategory);
router.put("/expense-categories/:id", requireScope({ level: "tenant" }), requireRole("Owner","Admin"), updateExpenseCategory);
router.delete("/expense-categories/:id", requireScope({ level: "tenant" }), requireRole("Owner","Admin"), deleteExpenseCategory);

// Expenses (Owner/Admin/Cajera)
router.get("/expenses", requireScope({ level: "tenant" }), requireRole("Owner","Admin","Cajera"), listExpenses);
router.post("/expenses", requireScope({ level: "tenant" }), requireRole("Owner","Admin","Cajera"), createExpense);
router.put("/expenses/:id", requireScope({ level: "tenant" }), requireRole("Owner","Admin","Cajera"), updateExpense);
router.patch("/expenses/:id/void", requireScope({ level: "tenant" }), requireRole("Owner","Admin"), voidExpense);

// Payroll (Owner/Admin)
router.get("/payroll/runs", requireScope({ level: "tenant" }), requireRole("Owner","Admin"), listPayrollRuns);
router.get("/payroll/runs/:id", requireScope({ level: "tenant" }), requireRole("Owner","Admin"), getPayrollRun);
router.post("/payroll/runs", requireScope({ level: "tenant" }), requireRole("Owner","Admin"), createPayrollRun);
router.put("/payroll/runs/:id", requireScope({ level: "tenant" }), requireRole("Owner","Admin"), updatePayrollRun);
router.post("/payroll/runs/:id/post", requireScope({ level: "tenant" }), requireRole("Owner","Admin"), postPayrollRun);

// Summary (Owner/Admin/Cajera)
router.get("/summary", requireScope({ level: "tenant" }), requireRole("Owner","Admin","Cajera"), getFinanceSummary);


// Registers (cajas)
router.get(
    "/registers",
    requireScope({ level: "client" }),
    requireRole("Owner", "Admin", "Cajera"),
    listRegisters
);

router.post(
    "/registers",
    requireScope({ level: "client" }),
    requireRole("Owner", "Admin"),
    createRegister
);

router.put(
    "/registers/:id",
    requireScope({ level: "client" }),
    requireRole("Owner", "Admin"),
    updateRegister
);

router.patch(
    "/registers/:id/toggle",
    requireScope({ level: "client" }),
    requireRole("Owner", "Admin"),
    toggleRegister
);
module.exports = router;
