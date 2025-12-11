// backend/routes/tenantRoute.js
const express = require("express");
const router = express.Router();
const Tenant = require("../models/tenantModel");

router.get("/:tenantId", async (req, res) => {
    try {
        const tenant = await Tenant.findOne({ tenantId: req.params.tenantId });

        if (!tenant) {
            return res.status(404).json({
                success: false,
                message: "Tenant not found",
            });
        }

        return res.json({
            success: true,
            data: tenant,
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            message: "Error loading tenant",
        });
    }
});

module.exports = router;
