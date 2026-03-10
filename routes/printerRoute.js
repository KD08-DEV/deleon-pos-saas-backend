const express = require("express");
const router = express.Router();

const verifyToken = require("../middlewares/tokenVerification");

const {
    listPrinters,
    getPrinterById,
    createPrinter,
    updatePrinter,
    deletePrinter,
    setDefaultPrinter,
    testNetworkPrinter,
    printNetworkTicket,
    printNetworkInvoice,
} = require("../controllers/tenantPrintingController");

router.get("/", verifyToken, listPrinters);
router.get("/:id", verifyToken, getPrinterById);
router.post("/", verifyToken, createPrinter);
router.patch("/:id", verifyToken, updatePrinter);
router.delete("/:id", verifyToken, deletePrinter);
router.patch("/:id/default", verifyToken, setDefaultPrinter);

router.post("/:id/test-network", verifyToken, testNetworkPrinter);
router.post("/:id/print-ticket", verifyToken, printNetworkTicket);
router.post("/:id/print-invoice", verifyToken, printNetworkInvoice);


module.exports = router;