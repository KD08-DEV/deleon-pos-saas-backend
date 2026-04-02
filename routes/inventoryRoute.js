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

// Requiere Premium (ajusta nombres si tu plan es "premium" o "pro")
const requireInventoryPlan = requirePlanOrSuper((tenant) => {
    const plan = (tenant.plan || "").toString().toLowerCase();
    const ok = ["premium", "vip"].includes(plan);

    return {
        ok,
        reason: "Este módulo requiere Plan Premium o VIP",
    };
});
const requireInventoryPremiumOrVip = requireInventoryPlan;



// Base chain:
// - tokenVerification ya setea req.user :contentReference[oaicite:6]{index=6}
router.use(verifyToken);

// scope valida tenant activo + membership :contentReference[oaicite:7]{index=7}
router.use(requireScope({ level: "tenant" }));

// plan gate
router.use(requireInventoryPlan);

// Lectura (Owner/Admin/Cashier)
router.get("/items", requireRole("Owner", "Admin", "Cajera", "Camarero"), inventoryController.listItems);
router.get("/movements", requireRole("Owner", "Admin", "Cajera", "Camarero"), inventoryController.listMovements);
router.get("/low-stock", requireRole("Owner", "Admin", "Cajera", "Camarero"), inventoryController.lowStock);

// Escritura (Owner/Admin)
router.post("/items", requireRole("Owner", "Admin"), inventoryController.createItem);
router.put("/items/:id", requireRole("Owner", "Admin"), inventoryController.updateItem);
router.delete("/items/:id", requireRole("Owner", "Admin"), inventoryController.archiveItem);
router.patch("/items/:id/unarchive", requireRole("Owner", "Admin"), inventoryController.unarchiveItem);

router.post("/movements", requireRole("Owner", "Admin"), inventoryController.createMovement);

// Exports (Owner/Admin)
router.get("/export/items.csv", requireRole("Owner", "Admin"), inventoryExportController.exportItemsCSV);
router.get("/export/movements.csv", requireRole("Owner", "Admin"), inventoryExportController.exportMovementsCSV);
router.get("/consumption", inventoryController.consumption);
// Alias: merma = movement type "waste"
// MERMA simple (movimiento waste)
router.post("/merma", requireRole("Owner", "Admin"), inventoryController.createMerma);

// Lotes de merma (batch)
router.post("/merma/batches", requireRole("Owner", "Admin"), inventoryController.createMermaBatch);
router.get("/merma/batches", requireRole("Owner", "Admin"), inventoryController.listMermaBatches);
router.patch("/merma/batches/:id", requireRole("Owner", "Admin"), inventoryController.updateMermaBatch);
router.patch("/merma/batches/:id/close", requireRole("Owner", "Admin"), inventoryController.closeMermaBatch);

router.get("/merma/summary", requireRole("Owner", "Admin"), inventoryController.getMermaSummary);
router.post("/movements/yield", requireRole("Owner", "Admin"), inventoryController.processYield);





module.exports = router;
