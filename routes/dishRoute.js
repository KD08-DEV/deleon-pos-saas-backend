const express = require("express");
const verifyToken = require("../middlewares/tokenVerification");
const requireScope = require("../middlewares/scope");
const requireRole = require("../middlewares/requireRole");
const { tenantMiddleware } = require("../middlewares/tenantMiddleware");
const uploadMemory = require("../middlewares/uploadMemory");

const {
    addDish,
    getDishes,
    updateDish,
    deleteDish,
} = require("../controllers/dishController");

const router = express.Router();

router.use(verifyToken);
router.use(tenantMiddleware);

// CREATE
router.post("/",
    requireRole("Owner", "Admin"),
    uploadMemory.single("image"),
    addDish
);

// READ
router.get("/",
    requireRole("Owner", "Admin", "Cashier", "Waiter"),
    getDishes
);

// UPDATE
router.put("/:id",
    requireRole("Owner", "Admin"),
    uploadMemory.single("image"),
    updateDish
);

// DELETE
router.delete("/:id",
    requireRole("Owner", "Admin"),
    deleteDish
);

module.exports = router;

module.exports = router;
