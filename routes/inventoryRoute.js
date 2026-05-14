const express = require("express");
const router = express.Router();

const verifyToken = require("../middlewares/tokenVerification");
const requireScope = require("../middlewares/scope");
const requireRole = require("../middlewares/requireRole");
const { requireFeature } = require("../middlewares/requirePlan");

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

// =======================
// BASE CHAIN
// =======================

router.use(verifyToken);

// Scope valida tenant activo + membership.
// Si el usuario pertenece al tenant, puede entrar a las rutas de lectura.
router.use(requireScope({ level: "tenant" }));

// =======================
// LECTURA DE INVENTARIO
// DISPONIBLE PARA TODOS LOS USUARIOS ACTIVOS DEL TENANT
// SIN IMPORTAR ROL NI PLAN
// =======================

router.get(
    "/items",
    inventoryController.listItems
);

router.get(
    "/movements",
    inventoryController.listMovements
);

router.get(
    "/low-stock",
    inventoryController.lowStock
);

router.get(
    "/consumption",
    inventoryController.consumption
);

router.get(
    "/merma/batches",
    inventoryController.listMermaBatches
);

router.get(
    "/merma/summary",
    inventoryController.getMermaSummary
);

// =======================
// DESDE AQUÍ SÍ APLICA EL PLAN DE INVENTARIO
// Estándar / Premium / Pro según planTiers.js
// =======================

router.use(requireFeatureOrSuper("inventory"));

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

// La validación fina de permisos está dentro de inventoryController.createMovement.
// Owner/Admin siempre pueden.
// Cajera/Camarero/Cocina dependen de permissions:
// inventory.entry, inventory.exit, inventory.adjust, inventory.waste.
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

module.exports = router;