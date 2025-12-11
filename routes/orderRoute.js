// pos-backend/routes/orderRoute.js
const express = require("express");
const router = express.Router();
const Order = require("../models/orderModel");
const supabase = require("../config/supabaseClient");

// Middlewares
const verifyToken = require("../middlewares/tokenVerification");
const { tenantMiddleware } = require("../middlewares/tenantMiddleware");

// Controllers
const {
    getOrders,
    getOrderById,
    addOrder,
    updateOrder,
    deleteOrder
} = require("../controllers/orderController");

/**
 * GET /api/order
 */
router.get(
    "/",
    verifyToken,
    tenantMiddleware,
    getOrders
);
router.get("/:orderId/invoice", verifyToken, async (req, res) => {
    try {
        const { orderId } = req.params;

        // 1) Buscar orden
        const order = await Order.findById(orderId);
        if (!order) {
            return res.status(404).json({
                success: false,
                message: "Orden no encontrada"
            });
        }

        // 2) Obtener tenantId correcto (CAMBIO AQUÍ)
        const tenantId = order.tenantId;
        if (!tenantId) {
            return res.status(400).json({
                success: false,
                message: "La orden no tiene tenant asignado"
            });
        }

        // 3) Construir ruta exacta del PDF según Supabase
        const filePath = `tenant_${tenantId}/orders/invoice_${orderId}.pdf`;

        console.log("[GET INVOICE] buscando archivo:", filePath);

        // 4) URL firmada
        const { data, error } = await supabase.storage
            .from("invoices")
            .createSignedUrl(filePath, 60 * 10);

        if (error || !data) {
            console.log("Supabase ERROR:", error);
            return res.status(404).json({
                success: false,
                message: "Factura no encontrada"
            });
        }

        return res.json({
            success: true,
            url: data.signedUrl
        });

    } catch (err) {
        console.error("GET INVOICE ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Error interno"
        });
    }
});

router.get("/:id/invoice/download", async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);

        if (!order || !order.invoiceUrl) {
            return res.status(404).json({
                success: false,
                message: "Factura no encontrada",
            });
        }

        // Redirigir al archivo en Supabase con "download=1"
        const downloadUrl = `${order.invoiceUrl}?download=1`;
        return res.redirect(downloadUrl);

    } catch (err) {
        console.error("Download Error:", err);
        res.status(500).json({
            success: false,
            message: "Error downloading invoice",
        });
    }
});


/**
 * GET /api/order/:id
 */
router.get(
    "/:id",
    verifyToken,
    tenantMiddleware,
    getOrderById
);

/**
 * POST /api/order
 */
router.post(
    "/",
    verifyToken,
    tenantMiddleware,
    addOrder
);

/**
 * PUT /api/order/:id
 */
router.put(
    "/:id",
    verifyToken,
    tenantMiddleware,
    updateOrder
);

/**
 * DELETE /api/order/:id
 */
router.delete(
    "/:id",
    verifyToken,
    tenantMiddleware,
    deleteOrder
);

module.exports = router;
