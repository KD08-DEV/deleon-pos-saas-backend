const createHttpError = require("http-errors");
const InventoryItem = require("../models/inventoryItemModel");
const InventoryMovement = require("../models/inventoryMovementModel");

function getTenantId(req) {
    return req.scope?.tenantId || req.user?.tenantId || req.headers["x-tenant-id"];
}

function csvEscape(value) {
    if (value === null || value === undefined) return "";
    const s = String(value);
    // si contiene coma, comillas o salto de linea => wrap en ""
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

function toCSV(rows, headers) {
    const head = headers.map(csvEscape).join(",");
    const body = rows.map(r => headers.map(h => csvEscape(r[h])).join(",")).join("\n");
    return `${head}\n${body}\n`;
}

// GET /api/inventory/export/items.csv
exports.exportItemsCSV = async (req, res, next) => {
    try {
        const tenantId = getTenantId(req);
        if (!tenantId) return next(createHttpError(400, "Missing tenantId"));

        const items = await InventoryItem.find({ tenantId, isArchived: false }).sort({ name: 1 }).lean();

        const headers = ["name", "category", "unit", "cost", "stockCurrent", "stockMin", "createdAt"];
        const rows = items.map(i => ({
            name: i.name,
            category: i.category,
            unit: i.unit,
            cost: i.cost,
            stockCurrent: i.stockCurrent,
            stockMin: i.stockMin,
            createdAt: i.createdAt,
        }));

        const csv = toCSV(rows, headers);

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="inventory-items.csv"`);
        res.send(csv);
    } catch (e) {
        next(e);
    }
};

// GET /api/inventory/export/movements.csv?from=&to=&itemId=
exports.exportMovementsCSV = async (req, res, next) => {
    try {
        const tenantId = getTenantId(req);
        if (!tenantId) return next(createHttpError(400, "Missing tenantId"));

        const { from, to, itemId } = req.query;

        const filter = { tenantId };
        if (itemId) filter.itemId = itemId;
        if (from || to) {
            filter.createdAt = {};
            if (from) filter.createdAt.$gte = new Date(from);
            if (to) filter.createdAt.$lte = new Date(to);
        }

        const movements = await InventoryMovement.find(filter)
            .populate("itemId", "name category unit")
            .sort({ createdAt: -1 })
            .lean();

        const headers = [
            "createdAt",
            "itemName",
            "category",
            "unit",
            "type",
            "qty",
            "unitCost",
            "beforeStock",
            "afterStock",
            "note",
        ];

        const rows = movements.map(m => ({
            createdAt: m.createdAt,
            itemName: m.itemId?.name || "",
            category: m.itemId?.category || "",
            unit: m.itemId?.unit || "",
            type: m.type,
            qty: m.qty,
            unitCost: m.unitCost ?? "",
            beforeStock: m.beforeStock,
            afterStock: m.afterStock,
            note: m.note || "",
        }));

        const csv = toCSV(rows, headers);

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="inventory-movements.csv"`);
        res.send(csv);
    } catch (e) {
        next(e);
    }
};
