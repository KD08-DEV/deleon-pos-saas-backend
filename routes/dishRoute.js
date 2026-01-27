const express = require("express");
const verifyToken = require("../middlewares/tokenVerification");
const requireRole = require("../middlewares/requireRole");
const { tenantMiddleware } = require("../middlewares/tenantMiddleware");
const uploadMemory = require("../middlewares/uploadMemory");

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

// CREATE
router.post(
    "/",
    requireRole("Owner", "Admin"),
    uploadMemory.single("image"),
    addDish
);

// READ
router.get(
    "/",
    requireRole("Owner", "Admin", "Cajera", "Camarero"),
    getDishes
);

// UPDATE
router.put(
    "/:id",
    requireRole("Owner", "Admin"),
    uploadMemory.single("image"),
    updateDish
);

// DELETE
router.delete(
    "/:id",
    requireRole("Owner", "Admin"),
    deleteDish
);

// RECIPE (NEW)
router.get(
    "/:id/recipe",
    requireRole("Owner", "Admin", "Cajera", "Camarero"),
    getDishRecipe
);

router.put(
    "/:id/recipe",
    requireRole("Owner", "Admin"),
    updateDishRecipe
);

// INGREDIENTS (NEW)
router.post(
    "/ingredients",
    requireRole("Owner", "Admin"),
    createIngredient
);

router.get(
    "/ingredients",
    requireRole("Owner", "Admin", "Cajera", "Camarero"),
    listIngredients
);



module.exports = router;
