const Printer = require("../models/printerModel");
const networkPrintService = require("../services/networkPrintService");
console.log("[networkPrintService keys]", Object.keys(networkPrintService || {}));
function normalizePrinterPayload(body = {}) {
    return {
        alias: String(body.alias || "").trim(),
        name: String(body.name || "").trim(),
        category: ["ticket", "invoice", "kitchen", "bar", "delivery", "other"].includes(body.category)
            ? body.category
            : "ticket",
        mode: ["browser", "qz", "network"].includes(body.mode)
            ? body.mode
            : "browser",
        type: ["thermal", "laser", "inkjet", "escpos", "other"].includes(body.type)
            ? body.type
            : "thermal",
        ip: String(body.ip || "").trim(),
        port: Number(body.port || 9100),
        host: String(body.host || "").trim(),
        paperSize: ["58mm", "80mm", "A4"].includes(body.paperSize)
            ? body.paperSize
            : "80mm",
        qzHost: String(body.qzHost || "localhost").trim(),
        qzPort: Number(body.qzPort || 8181),
        isDefault: !!body.isDefault,
        isActive: body.isActive !== false,
        notes: String(body.notes || "").trim(),
    };
}

exports.listPrinters = async (req, res) => {
    try {
        const tenantId = req.user?.tenantId || req.tenantId;
        const clientId = req.headers["x-client-id"] || "default";

        const query = { tenantId, clientId };

        if (req.query.category) {
            query.category = req.query.category;
        }

        const printers = await Printer.find(query).sort({
            category: 1,
            isDefault: -1,
            alias: 1,
            createdAt: -1,
        });

        return res.json({
            success: true,
            data: printers,
        });
    } catch (error) {
        console.error("listPrinters error:", error);
        return res.status(500).json({
            success: false,
            message: "ERROR_LISTING_PRINTERS",
            error: error.message,
        });
    }
};

exports.getPrinterById = async (req, res) => {
    try {
        const tenantId = req.user?.tenantId || req.tenantId;
        const clientId = req.headers["x-client-id"] || "default";

        const printer = await Printer.findOne({
            _id: req.params.id,
            tenantId,
            clientId,
        });

        if (!printer) {
            return res.status(404).json({
                success: false,
                message: "PRINTER_NOT_FOUND",
            });
        }

        return res.json({
            success: true,
            data: printer,
        });
    } catch (error) {
        console.error("getPrinterById error:", error);
        return res.status(500).json({
            success: false,
            message: "ERROR_GETTING_PRINTER",
            error: error.message,
        });
    }
};

exports.createPrinter = async (req, res) => {
    try {
        const tenantId = req.user?.tenantId || req.tenantId;
        const clientId = req.headers["x-client-id"] || "default";

        const payload = normalizePrinterPayload(req.body);

        if (!payload.alias) {
            return res.status(400).json({
                success: false,
                message: "PRINTER_ALIAS_REQUIRED",
            });
        }

        if (payload.isDefault) {
            await Printer.updateMany(
                { tenantId, clientId, category: payload.category },
                { $set: { isDefault: false } }
            );
        }

        const created = await Printer.create({
            tenantId,
            clientId,
            ...payload,
            createdBy: req.user?._id || null,
            updatedBy: req.user?._id || null,
        });

        return res.status(201).json({
            success: true,
            message: "PRINTER_CREATED",
            data: created,
        });
    } catch (error) {
        console.error("createPrinter error:", error);
        return res.status(500).json({
            success: false,
            message: "ERROR_CREATING_PRINTER",
            error: error.message,
        });
    }
};

exports.updatePrinter = async (req, res) => {
    try {
        const tenantId = req.user?.tenantId || req.tenantId;
        const clientId = req.headers["x-client-id"] || "default";

        const existing = await Printer.findOne({
            _id: req.params.id,
            tenantId,
            clientId,
        });

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "PRINTER_NOT_FOUND",
            });
        }

        const payload = normalizePrinterPayload(req.body);

        if (!payload.alias) {
            return res.status(400).json({
                success: false,
                message: "PRINTER_ALIAS_REQUIRED",
            });
        }

        if (payload.isDefault) {
            await Printer.updateMany(
                {
                    tenantId,
                    clientId,
                    category: payload.category,
                    _id: { $ne: existing._id },
                },
                { $set: { isDefault: false } }
            );
        }

        const updated = await Printer.findOneAndUpdate(
            { _id: req.params.id, tenantId, clientId },
            {
                $set: {
                    ...payload,
                    updatedBy: req.user?._id || null,
                },
            },
            { new: true, runValidators: true }
        );

        return res.json({
            success: true,
            message: "PRINTER_UPDATED",
            data: updated,
        });
    } catch (error) {
        console.error("updatePrinter error:", error);
        return res.status(500).json({
            success: false,
            message: "ERROR_UPDATING_PRINTER",
            error: error.message,
        });
    }
};

exports.deletePrinter = async (req, res) => {
    try {
        const tenantId = req.user?.tenantId || req.tenantId;
        const clientId = req.headers["x-client-id"] || "default";

        const deleted = await Printer.findOneAndDelete({
            _id: req.params.id,
            tenantId,
            clientId,
        });

        if (!deleted) {
            return res.status(404).json({
                success: false,
                message: "PRINTER_NOT_FOUND",
            });
        }

        return res.json({
            success: true,
            message: "PRINTER_DELETED",
            data: deleted,
        });
    } catch (error) {
        console.error("deletePrinter error:", error);
        return res.status(500).json({
            success: false,
            message: "ERROR_DELETING_PRINTER",
            error: error.message,
        });
    }
};

exports.setDefaultPrinter = async (req, res) => {
    try {
        const tenantId = req.user?.tenantId || req.tenantId;
        const clientId = req.headers["x-client-id"] || "default";

        const printer = await Printer.findOne({
            _id: req.params.id,
            tenantId,
            clientId,
        });

        if (!printer) {
            return res.status(404).json({
                success: false,
                message: "PRINTER_NOT_FOUND",
            });
        }

        await Printer.updateMany(
            { tenantId, clientId, category: printer.category },
            { $set: { isDefault: false } }
        );

        printer.isDefault = true;
        printer.updatedBy = req.user?._id || null;
        await printer.save();

        return res.json({
            success: true,
            message: "PRINTER_SET_AS_DEFAULT",
            data: printer,
        });
    } catch (error) {
        console.error("setDefaultPrinter error:", error);
        return res.status(500).json({
            success: false,
            message: "ERROR_SETTING_DEFAULT_PRINTER",
            error: error.message,
        });
    }
};
exports.testNetworkPrinter = async (req, res) => {
    try {
        const tenantId = req.user?.tenantId || req.tenantId;
        const clientId = req.headers["x-client-id"] || "default";

        const printer = await Printer.findOne({
            _id: req.params.id,
            tenantId,
            clientId,
            isActive: true,
        });

        if (!printer) {
            return res.status(404).json({
                success: false,
                message: "PRINTER_NOT_FOUND",
            });
        }

        if (printer.mode !== "network") {
            return res.status(400).json({
                success: false,
                message: "PRINTER_IS_NOT_NETWORK_MODE",
            });
        }

        const testText = [
            "==========================================",
            "PRUEBA DE IMPRESION",
            `Alias: ${printer.alias || ""}`,
            `Nombre: ${printer.name || ""}`,
            `IP: ${printer.ip || ""}`,
            `Port: ${printer.port || 9100}`,
            `Fecha: ${new Date().toLocaleString()}`,
            "==========================================",
        ].join("\n");

        const payload = networkPrintService.buildEscPosText(testText);

        const result = await networkPrintService.sendToNetworkPrinter({
            ip: printer.ip,
            port: printer.port || 9100,
            payload,
        });
        return res.json({
            success: true,
            message: "Test de red enviado a la impresora",
            data: {
                printerId: printer._id,
                alias: printer.alias,
                ip: printer.ip,
                port: printer.port,
                result,
            },
        });
    } catch (error) {
        console.error("testNetworkPrinter error:", error);
        return res.status(500).json({
            success: false,
            message: "Error probando la impresora de red",
            error: error.message,
        });
    }
};

exports.printNetworkTicket = async (req, res) => {
    try {
        const tenantId = req.user?.tenantId || req.tenantId;
        const clientId = req.headers["x-client-id"] || "default";

        const printer = await Printer.findOne({
            _id: req.params.id,
            tenantId,
            clientId,
            isActive: true,
        });

        if (!printer) {
            return res.status(404).json({
                success: false,
                message: "Impresora no encontrada",
            });
        }

        if (printer.mode !== "network") {
            return res.status(400).json({
                success: false,
                message: "Impresora no esta en modo NETWORK",
            });
        }

        const {
            businessName,
            rnc,
            address,
            phone,
            title,
            orderId,
            mesa,
            mesero,
            fecha,
            items,
            subtotal,
            tax,
            total,
            paymentMethod,
        } = req.body || {};

        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Ticket items requeridos",
            });
        }

        const text = networkPrintService.buildTicketText({
            businessName,
            rnc,
            address,
            phone,
            title: title || "TICKET",
            orderId,
            mesa,
            mesero,
            fecha,
            items,
            subtotal,
            tax,
            total,
            paymentMethod,
        });

        const payload = networkPrintService.buildEscPosText(text);

        const result = await networkPrintService.sendToNetworkPrinter({
            ip: printer.ip,
            port: printer.port || 9100,
            payload,
        });

        return res.json({
            success: true,
            message: "Impresión exitosa",
            data: {
                printerId: printer._id,
                alias: printer.alias,
                ip: printer.ip,
                port: printer.port,
                result,
            },
        });
    } catch (error) {
        console.error("printNetworkTicket error:", error);
        return res.status(500).json({
            success: false,
            message: "Error imprimiendo el ticket",
            error: error.message,
        });
    }
};
exports.printNetworkInvoice = async (req, res) => {
    try {
        const tenantId = req.user?.tenantId || req.tenantId;
        const clientId = req.headers["x-client-id"] || "default";

        const printer = await Printer.findOne({
            _id: req.params.id,
            tenantId,
            clientId,
            isActive: true,
        });

        if (!printer) {
            return res.status(404).json({
                success: false,
                message: "PRINTER_NOT_FOUND",
            });
        }

        if (printer.mode !== "network") {
            return res.status(400).json({
                success: false,
                message: "PRINTER_IS_NOT_NETWORK_MODE",
            });
        }

        const { items } = req.body || {};

        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({
                success: false,
                message: "INVOICE_ITEMS_REQUIRED",
            });
        }

        const text = networkPrintService.buildInvoiceText(req.body || {});
        const payload = networkPrintService.buildEscPosText(text);

        const result = await networkPrintService.sendToNetworkPrinter({
            ip: printer.ip,
            port: printer.port || 9100,
            payload,
        });

        return res.json({
            success: true,
            message: "Factura impresa correctamente",
            data: {
                printerId: printer._id,
                alias: printer.alias,
                ip: printer.ip,
                port: printer.port,
                result,
            },
        });
    } catch (error) {
        console.error("printNetworkInvoice error:", error);
        return res.status(500).json({
            success: false,
            message: "ERROR_PRINTING_NETWORK_INVOICE",
            error: error.message,
        });
    }
};