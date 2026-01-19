const express = require("express");
const router = express.Router();
const verifyToken  = require("../middlewares/tokenVerification");
const requireScope = require("../middlewares/scope");
const requireRole = require("../middlewares/requireRole");

const { createOrder, verifyPayment, webHookVerification } = require("../controllers/paymentController");

// pagos del client actual
router.post("/create-order",   verifyToken , requireScope({ level: "client" }), requireRole("Owner", "Admin", "Cajera", "Camarero"), createOrder);
router.post("/verify-payment", verifyToken , requireScope({ level: "client" }), requireRole("Owner", "Admin", "Cajera", "Camarero"), verifyPayment);

// Webhook de pasarela (sin token)
router.post("/webhook-verification", webHookVerification);

module.exports = router;
