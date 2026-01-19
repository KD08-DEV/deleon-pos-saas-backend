const createHttpError = require("http-errors");
// DEPRECATED: Ya no se usa InventoryItem, solo Dish
// const InventoryItem = require("../models/inventoryItemModel");
// const InventoryMovement = require("../models/inventoryMovementModel");

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
// DEPRECATED: Ya no se usa InventoryItem
exports.exportItemsCSV = async (req, res, next) => {
    try {
        return next(createHttpError(410, "Este endpoint está deprecado. Ya no se usa InventoryItem."));
        // DEPRECATED CODE REMOVED
    } catch (e) {
        next(e);
    }
};

// GET /api/inventory/export/movements.csv?from=&to=&itemId=
// DEPRECATED: Ya no se usa InventoryMovement
exports.exportMovementsCSV = async (req, res, next) => {
    try {
        return next(createHttpError(410, "Este endpoint está deprecado. Ya no se usa InventoryMovement."));
        // DEPRECATED CODE REMOVED
    } catch (e) {
        next(e);
    }
};
