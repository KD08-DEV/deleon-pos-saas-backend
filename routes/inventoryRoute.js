const express = require("express");
const router = express.Router();

const verifyToken = require("../middlewares/tokenVerification");
const requireScope = require("../middlewares/scope");
const requirePlan = require("../middlewares/requirePlan");
const requireRole = require("../middlewares/requireRole");

const inventoryController = require("../controllers/inventoryController");
const inventoryExportController = require("../controllers/inventoryExportController");

// Bypass para SuperAdmin (porque tu verifyToken/scope lo permiten, pero requirePlan exige tenantId)
// scope ya bypass a SuperAdmin :contentReference[oaicite:4]{index=4}, y requirePlan pide tenantId :contentReference[oaicite:5]{index=5}.
const requirePlanOrSuper = (checkFn) => {
    const mw = requirePlan(checkFn);
    return (req, res, next) => {
        if (req.user?.role === "SuperAdmin") return next();
        return mw(req, res, next);
    };
};

// Requiere Premium (ajusta nombres si tu plan es "premiun" o "pro")
const requireInventoryPlan = requirePlanOrSuper((tenant) => {
    const plan = (tenant.plan || "").toString().toLowerCase(); // viene de Tenant.plan

    const ok = ["pro", "vip"].includes(plan); // Pro (Premium) + VIP

    return {
        ok,
        reason: "Este módulo requiere Plan Premium o VIP",
    };
});


// Base chain:
// - tokenVerification ya setea req.user :contentReference[oaicite:6]{index=6}
router.use(verifyToken);

// scope valida tenant activo + membership :contentReference[oaicite:7]{index=7}
router.use(requireScope({ level: "tenant" }));

// plan gate
router.use(requireInventoryPlan);

// Lectura (Owner/Admin/Cashier)
router.get("/items", requireRole("Owner", "Admin", "Cashier"), inventoryController.listItems);
router.get("/movements", requireRole("Owner", "Admin", "Cashier"), inventoryController.listMovements);
router.get("/low-stock", requireRole("Owner", "Admin", "Cashier"), inventoryController.lowStock);

// Escritura (Owner/Admin)
router.post("/items", requireRole("Owner", "Admin"), inventoryController.createItem);
router.put("/items/:id", requireRole("Owner", "Admin"), inventoryController.updateItem);
router.delete("/items/:id", requireRole("Owner", "Admin"), inventoryController.archiveItem);

router.post("/movements", requireRole("Owner", "Admin"), inventoryController.createMovement);

// Exports (Owner/Admin)
router.get("/export/items.csv", requireRole("Owner", "Admin"), inventoryExportController.exportItemsCSV);
router.get("/export/movements.csv", requireRole("Owner", "Admin"), inventoryExportController.exportMovementsCSV);
router.get("/consumption", inventoryController.consumption);


module.exports = router;
