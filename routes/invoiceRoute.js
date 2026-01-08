const express = require("express");
const router = express.Router();


const verifyToken = require("../middlewares/tokenVerification");
const requireScope = require("../middlewares/scope");
const requireRole = require("../middlewares/requireRole");
const { protectTenant } = require("../middlewares/tenantMiddleware");
const { createInvoice, getInvoice  } = require("../controllers/invoiceController");

router.get("/:orderId", verifyToken, protectTenant, getInvoice);
router.post(
    "/",
    verifyToken,
    protectTenant,
    requireScope({ level: "client" }),
    requireRole("Owner", "Admin", "Cashier"),
    createInvoice
);

module.exports = router;
