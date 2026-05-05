const express = require("express");
const router = express.Router();

const verifyToken = require("../middlewares/tokenVerification");
const requireScope = require("../middlewares/scope");
const requireRole = require("../middlewares/requireRole");
const { requireFeature } = require("../middlewares/requirePlan");
const requirePermission = require("../middlewares/requirePermission");

const inventoryController = require("../controllers/inventoryController");
const inventoryExportController = require("../controllers/inventoryExportController");

// Bypass para SuperAdmin cuando no venga tenantId
const requireFeatureOrSuper = (featureKey) => {
    const mw = requireFeature(featureKey);

    return (req, res, next) => {
        if (req.user?.role === "SuperAdmin") return next();
        return mw(req, res, next);
    };
};

// Base chain
router.use(verifyToken);

// Scope valida tenant activo + membership
router.use(requireScope({ level: "tenant" }));

// Plan gate: Estándar / Premium / Pro según planTiers.js
router.use(requireFeatureOrSuper("inventory"));

// =======================
// LECTURA DE INVENTARIO
// =======================

router.get(
    "/items",
    requireRole("Owner", "Admin", "Cajera", "Camarero", "Cocina"),
    inventoryController.listItems
);

router.get(
    "/movements",
    requireRole("Owner", "Admin", "Cajera", "Camarero", "Cocina"),
    inventoryController.listMovements
);

router.get(
    "/low-stock",
    requireRole("Owner", "Admin", "Cajera", "Camarero", "Cocina"),
    inventoryController.lowStock
);

// =======================
// ARTÍCULOS DE INVENTARIO
// =======================

// Crear item de inventario directo sigue siendo Owner/Admin.
// Para "crear productos del menú" usamos /api/dishes con permission products.create.
router.post(
    "/items",
    requireRole("Owner", "Admin"),
    inventoryController.createItem
);

router.put(
    "/items/:id",
    requireRole("Owner", "Admin"),
    inventoryController.updateItem
);

router.delete(
    "/items/:id",
    requireRole("Owner", "Admin"),
    inventoryController.archiveItem
);

router.patch(
    "/items/:id/unarchive",
    requireRole("Owner", "Admin"),
    inventoryController.unarchiveItem
);

// =======================
// MOVIMIENTOS DE INVENTARIO
// =======================

// Permite a Owner/Admin siempre.
// Permite a una Cajera/Camarero/Cocina solo si tiene permission inventory.entry.
// IMPORTANTE: en inventoryController.createMovement también debes validar que,
// si no es Owner/Admin, solo pueda mandar type: "purchase".
router.post(
    "/movements",
    inventoryController.createMovement
);
// Yield / rendimiento sigue solo Owner/Admin
router.post(
    "/movements/yield",
    requireRole("Owner", "Admin"),
    inventoryController.processYield
);

// =======================
// EXPORTS
// =======================

router.get(
    "/export/items.csv",
    requireRole("Owner", "Admin"),
    inventoryExportController.exportItemsCSV
);

router.get(
    "/export/movements.csv",
    requireRole("Owner", "Admin"),
    inventoryExportController.exportMovementsCSV
);

// =======================
// CONSUMO
// =======================

router.get(
    "/consumption",
    requireRole("Owner", "Admin", "Cajera"),
    inventoryController.consumption
);

// =======================
// MERMA
// =======================

// Merma simple: Owner/Admin
router.post(
    "/merma",
    requireRole("Owner", "Admin"),
    inventoryController.createMerma
);

// Lotes de merma: Owner/Admin
router.post(
    "/merma/batches",
    requireRole("Owner", "Admin"),
    inventoryController.createMermaBatch
);

router.get(
    "/merma/batches",
    requireRole("Owner", "Admin", "Cajera"),
    inventoryController.listMermaBatches
);

router.patch(
    "/merma/batches/:id",
    requireRole("Owner", "Admin"),
    inventoryController.updateMermaBatch
);

router.patch(
    "/merma/batches/:id/close",
    requireRole("Owner", "Admin"),
    inventoryController.closeMermaBatch
);

router.get(
    "/merma/summary",
    requireRole("Owner", "Admin", "Cajera"),
    inventoryController.getMermaSummary
);

module.exports = router;