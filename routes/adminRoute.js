const express = require("express");
const router = express.Router();

const verifyToken = require("../middlewares/tokenVerification");
const requireScope = require("../middlewares/scope");
const requireRole = require("../middlewares/requireRole");
const { requireFeature } = require("../middlewares/requirePlan");

const { exportAllInvoices } = require("../controllers/reportExportController");
const { exportExcel } = require("../controllers/reportExportController");

const {
    getCashSessionByDate,
    getCurrentCashSession,
    getPendingCashSession,
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

// Panel admin: nivel tenant
router.use(verifyToken);

// =======================
// REPORTES BÁSICOS
// =======================

router.get(
    "/reports",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin", "Cajera"),
    getReports
);

router.get(
    "/usage",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin", "Cajera"),
    getUsage
);

// Exportaciones: Estándar / Premium / Pro
router.get(
    "/reports/export/invoices",
    requireScope({ level: "tenant" }),
    requireFeature("advancedReports"),
    requireRole("Owner", "Admin", "Cajera"),
    exportAllInvoices
);

router.get(
    "/reports/export/excel",
    requireScope({ level: "tenant" }),
    requireFeature("advancedReports"),
    requireRole("Owner", "Admin", "Cajera"),
    exportExcel
);

// =======================
// EMPLEADOS
// =======================

router.get(
    "/employees",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin"),
    getEmployees
);

router.get(
    "/users",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin"),
    getUsers
);

router.patch(
    "/employees/:id",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin"),
    updateEmployee
);

// =======================
// FISCAL / NCF
// =======================

// GET queda abierto porque el frontend lo usa para cargar tax, propina, checkout, pre-factura, etc.
router.get(
    "/fiscal-config",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin", "Cajera", "Camarero"),
    getFiscalConfig
);

// PATCH solo Premium / Pro
router.patch(
    "/fiscal-config",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin"),
    updateFiscalConfig
);

// =======================
// PROVEEDORES - Estándar / Premium / Pro
// =======================

router.get(
    "/suppliers",
    requireScope({ level: "tenant" }),
    requireFeature("suppliers"),
    requireRole("Owner", "Admin", "Cajera", "Camarero"),
    getSuppliers
);

router.post(
    "/suppliers",
    requireScope({ level: "tenant" }),
    requireFeature("suppliers"),
    requireRole("Owner", "Admin"),
    createSupplier
);

router.put(
    "/suppliers/:id",
    requireScope({ level: "tenant" }),
    requireFeature("suppliers"),
    requireRole("Owner", "Admin"),
    updateSupplier
);

router.delete(
    "/suppliers/:id",
    requireScope({ level: "tenant" }),
    requireFeature("suppliers"),
    requireRole("Owner", "Admin"),
    deleteSupplier
);

// =======================
// CATEGORÍAS DE INVENTARIO - Estándar / Premium / Pro
// =======================

router.get(
    "/inventory/categories",
    requireScope({ level: "tenant" }),
    requireFeature("inventoryCategories"),
    requireRole("Owner", "Admin", "Cajera", "Camarero"),
    getCategories
);

router.post(
    "/inventory/categories",
    requireScope({ level: "tenant" }),
    requireFeature("inventoryCategories"),
    requireRole("Owner", "Admin"),
    createCategory
);

router.put(
    "/inventory/categories/:id",
    requireScope({ level: "tenant" }),
    requireFeature("inventoryCategories"),
    requireRole("Owner", "Admin"),
    updateCategory
);

router.delete(
    "/inventory/categories/:id",
    requireScope({ level: "tenant" }),
    requireFeature("inventoryCategories"),
    requireRole("Owner", "Admin"),
    deleteCategory
);

// =======================
// CAJA - disponible desde Emprendedor
// =======================

router.get(
    "/cash-session/pending-close",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin", "Cajera"),
    getPendingCashSession
);

router.get(
    "/cash-session/current",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin", "Cajera"),
    getCurrentCashSession
);

router.post(
    "/cash-session/open",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin", "Cajera"),
    openCashSession
);

router.post(
    "/cash-session/close",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin", "Cajera"),
    closeCashSession
);

router.get(
    "/cash-session",
    requireScope({ level: "tenant" }),
    requireRole("Owner", "Admin", "Cajera"),
    getCashSessionByDate
);

router.get(
    "/cash-session/range",
    requireScope({ level: "tenant" }),
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

// =======================
// REGISTROS / CAJAS
// =======================

// Se deja el listado abierto porque Emprendedor puede tener 1 caja.
// Los límites de cantidad deben controlarse en registerController.
router.get(
    "/registers",
    requireScope({ level: "tenant" }),
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

// =======================
// MANAGER CODE
// =======================

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

// =======================
// COMPRAS - Estándar / Premium / Pro
// =======================

router.get(
    "/purchases",
    requireScope({ level: "tenant" }),
    requireFeature("purchases"),
    requireRole("Owner", "Admin", "Cajera"),
    listPurchases
);

router.post(
    "/purchases",
    requireScope({ level: "tenant" }),
    requireFeature("purchases"),
    requireRole("Owner", "Admin"),
    createPurchase
);

router.post(
    "/purchases/:id/payments",
    requireScope({ level: "tenant" }),
    requireFeature("purchases"),
    requireRole("Owner", "Admin"),
    addPurchasePayment
);

// =======================
// GASTOS - Pro
// =======================

router.get(
    "/expense-categories",
    requireScope({ level: "tenant" }),
    requireFeature("expenses"),
    requireRole("Owner", "Admin", "Cajera"),
    listExpenseCategories
);

router.post(
    "/expense-categories",
    requireScope({ level: "tenant" }),
    requireFeature("expenses"),
    requireRole("Owner", "Admin"),
    createExpenseCategory
);

router.put(
    "/expense-categories/:id",
    requireScope({ level: "tenant" }),
    requireFeature("expenses"),
    requireRole("Owner", "Admin"),
    updateExpenseCategory
);

router.delete(
    "/expense-categories/:id",
    requireScope({ level: "tenant" }),
    requireFeature("expenses"),
    requireRole("Owner", "Admin"),
    deleteExpenseCategory
);

router.get(
    "/expenses",
    requireScope({ level: "tenant" }),
    requireFeature("expenses"),
    requireRole("Owner", "Admin", "Cajera"),
    listExpenses
);

router.post(
    "/expenses",
    requireScope({ level: "tenant" }),
    requireFeature("expenses"),
    requireRole("Owner", "Admin", "Cajera"),
    createExpense
);

router.put(
    "/expenses/:id",
    requireScope({ level: "tenant" }),
    requireFeature("expenses"),
    requireRole("Owner", "Admin", "Cajera"),
    updateExpense
);

router.patch(
    "/expenses/:id/void",
    requireScope({ level: "tenant" }),
    requireFeature("expenses"),
    requireRole("Owner", "Admin"),
    voidExpense
);

// =======================
// NÓMINA - Pro
// =======================

router.get(
    "/payroll/runs",
    requireScope({ level: "tenant" }),
    requireFeature("payroll"),
    requireRole("Owner", "Admin"),
    listPayrollRuns
);

router.get(
    "/payroll/runs/:id",
    requireScope({ level: "tenant" }),
    requireFeature("payroll"),
    requireRole("Owner", "Admin"),
    getPayrollRun
);

router.post(
    "/payroll/runs",
    requireScope({ level: "tenant" }),
    requireFeature("payroll"),
    requireRole("Owner", "Admin"),
    createPayrollRun
);

router.put(
    "/payroll/runs/:id",
    requireScope({ level: "tenant" }),
    requireFeature("payroll"),
    requireRole("Owner", "Admin"),
    updatePayrollRun
);

router.post(
    "/payroll/runs/:id/post",
    requireScope({ level: "tenant" }),
    requireFeature("payroll"),
    requireRole("Owner", "Admin"),
    postPayrollRun
);

// =======================
// RESUMEN FINANCIERO - Pro
// =======================

router.get(
    "/summary",
    requireScope({ level: "tenant" }),
    requireFeature("financeSummary"),
    requireRole("Owner", "Admin", "Cajera"),
    getFinanceSummary
);

module.exports = router;