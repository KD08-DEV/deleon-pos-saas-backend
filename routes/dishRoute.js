const express = require("express");
const verifyToken = require("../middlewares/tokenVerification");
const requireRole = require("../middlewares/requireRole");
const { tenantMiddleware } = require("../middlewares/tenantMiddleware");
const uploadMemory = require("../middlewares/uploadMemory");
const { requireFeature } = require("../middlewares/requirePlan");
const requirePermission = require("../middlewares/requirePermission");

const {
    addDish,
    getDishes,
    updateDish,
    deleteDish,
    getDishRecipe,
    updateDishRecipe,
    createIngredient,
    listIngredients,
} = require("../controllers/dishController");

const router = express.Router();

router.use(verifyToken);
router.use(tenantMiddleware);

// CREATE - Owner/Admin o permiso individual products.create
router.post(
    "/",
    requirePermission("products.create"),
    uploadMemory.single("image"),
    addDish
);

// READ - menú básico permitido para operación
router.get(
    "/",
    requireRole("Owner", "Admin", "Cajera", "Camarero", "Cocina"),
    getDishes
);

// UPDATE - Owner/Admin o permiso individual products.update
router.put(
    "/:id",
    requirePermission("products.update"),
    uploadMemory.single("image"),
    updateDish
);

// DELETE - Owner/Admin o permiso individual products.delete
router.delete(
    "/:id",
    requirePermission("products.delete"),
    deleteDish
);

// RECIPE - Premium / Pro
router.get(
    "/:id/recipe",
    requireFeature("recipes"),
    requireRole("Owner", "Admin", "Cajera", "Camarero", "Cocina"),
    getDishRecipe
);

router.put(
    "/:id/recipe",
    requireFeature("recipes"),
    requireRole("Owner", "Admin"),
    updateDishRecipe
);

// INGREDIENTS / INVENTORY - por ahora solo Owner/Admin
router.post(
    "/ingredients",
    requireFeature("inventory"),
    requireRole("Owner", "Admin"),
    createIngredient
);

router.get(
    "/ingredients",
    requireFeature("inventory"),
    requireRole("Owner", "Admin", "Cajera", "Camarero", "Cocina"),
    listIngredients
);

module.exports = router;