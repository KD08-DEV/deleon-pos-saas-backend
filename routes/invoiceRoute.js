const express = require("express");
const router = express.Router();


const verifyToken = require("../middlewares/tokenVerification");
const requireScope = require("../middlewares/scope");
const requireRole = require("../middlewares/requireRole");
const { createInvoice, getInvoice  } = require("../controllers/invoiceController");

router.get("/:orderId", verifyToken, getInvoice);
router.post("/", verifyToken, createInvoice);

router.post(
    "/create",
    verifyToken,
    requireScope({ level: "client" }),
    requireRole("Owner", "Admin", "Cashier"),
    createInvoice
);

module.exports = router;
