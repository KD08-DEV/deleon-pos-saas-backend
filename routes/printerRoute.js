const express = require("express");
const router = express.Router();

const verifyToken = require("../middlewares/tokenVerification");
const { tenantMiddleware } = require("../middlewares/tenantMiddleware");

function requirePrinterAdmin(req, res, next) {
    const role = req.scope?.membership?.role;
    if (role !== "Owner" && role !== "Admin") {
        return res.status(403).json({ success: false, message: "PRINTER_MANAGE_DENIED" });
    }
    return next();
}

const {
    listPrinters,
    getPrinterById,
    createPrinter,
    updatePrinter,
    deletePrinter,
    setDefaultPrinter,
    testNetworkPrinter,
    printNetworkTicket,
    printNetworkInvoice,
    getPrintersByCategory,
} = require("../controllers/tenantPrintingController");

// Todas las rutas necesitan tenant activo y sucursal validada.
// SuperAdmin no opera impresoras sin una membresía tenant/sucursal.
router.use(verifyToken, tenantMiddleware, (req, res, next) => {
    if (!req.scope?.tenantId || !req.scope?.clientId || !req.scope?.membership) {
        return res.status(403).json({ success: false, message: "PRINTER_SCOPE_REQUIRED" });
    }
    return next();
});

// Lecturas e impresión: usuarios activos con acceso a la sucursal.
router.get("/", listPrinters);
router.get("/category/:category", getPrintersByCategory);
router.get("/:id", getPrinterById);
router.post("/:id/print-ticket", printNetworkTicket);
router.post("/:id/print-invoice", printNetworkInvoice);

// Configuración y prueba de IP: exclusivamente Owner/Admin del tenant.
router.post("/", requirePrinterAdmin, createPrinter);
router.patch("/:id", requirePrinterAdmin, updatePrinter);
router.delete("/:id", requirePrinterAdmin, deletePrinter);
router.patch("/:id/default", requirePrinterAdmin, setDefaultPrinter);
router.post("/:id/test-network", requirePrinterAdmin, testNetworkPrinter);

module.exports = router;