const createHttpError = require("http-errors");
const InventoryCategory = require("../models/inventoryCategoryModel");

// 🔹 Obtener todas las categorías
exports.getCategories = async (req, res, next) => {
    try {
        const tenantId = req.user.tenantId;
        const clientId = req.headers["x-client-id"] || "default";

        const categories = await InventoryCategory.find({ tenantId, clientId })
            .sort({ name: 1 });

        return res.status(200).json({
            success: true,
            data: categories,
        });
    } catch (error) {
        console.error("❌ Error al obtener categorías:", error);
        return next(createHttpError(500, "Error al obtener categorías"));
    }
};

// 🔹 Crear categoría
exports.createCategory = async (req, res, next) => {
    try {
        const tenantId = req.user.tenantId;
        const clientId = req.headers["x-client-id"] || "default";

        const { name, description, color, icon } = req.body;

        if (!name || !name.trim()) {
            return next(createHttpError(400, "El nombre de la categoría es requerido"));
        }

        // Verificar si ya existe
        const exists = await InventoryCategory.findOne({ tenantId, clientId, name: name.trim() });
        if (exists) {
            return next(createHttpError(400, "Ya existe una categoría con ese nombre"));
        }

        const category = new InventoryCategory({
            name: name.trim(),
            description: description?.trim() || "",
            color: color || "#f6b100",
            icon: icon || "Package",
            tenantId,
            clientId,
        });

        await category.save();

        return res.status(201).json({
            success: true,
            message: "Categoría creada exitosamente",
            data: category,
        });
    } catch (error) {
        console.error("❌ Error al crear categoría:", error);
        if (error.code === 11000) {
            return next(createHttpError(400, "Ya existe una categoría con ese nombre"));
        }
        return next(createHttpError(500, "Error al crear categoría"));
    }
};

// 🔹 Actualizar categoría
exports.updateCategory = async (req, res, next) => {
    try {
        const tenantId = req.user.tenantId;
        const { id } = req.params;
        const { name, description, color, icon } = req.body;

        const category = await InventoryCategory.findOne({ _id: id, tenantId });
        if (!category) {
            return next(createHttpError(404, "Categoría no encontrada"));
        }

        // Si cambia el nombre, verificar unicidad
        if (name && name.trim() !== category.name) {
            const exists = await InventoryCategory.findOne({
                tenantId,
                clientId: category.clientId,
                name: name.trim(),
                _id: { $ne: id },
            });
            if (exists) {
                return next(createHttpError(400, "Ya existe una categoría con ese nombre"));
            }
            category.name = name.trim();
        }

        if (description !== undefined) category.description = description?.trim() || "";
        if (color !== undefined) category.color = color;
        if (icon !== undefined) category.icon = icon;

        await category.save();

        return res.status(200).json({
            success: true,
            message: "Categoría actualizada exitosamente",
            data: category,
        });
    } catch (error) {
        console.error("❌ Error al actualizar categoría:", error);
        return next(createHttpError(500, "Error al actualizar categoría"));
    }
};

// 🔹 Eliminar categoría
exports.deleteCategory = async (req, res, next) => {
    try {
        const tenantId = req.user.tenantId;
        const { id } = req.params;

        const category = await InventoryCategory.findOneAndDelete({ _id: id, tenantId });
        if (!category) {
            return next(createHttpError(404, "Categoría no encontrada"));
        }

        return res.status(200).json({
            success: true,
            message: "Categoría eliminada exitosamente",
        });
    } catch (error) {
        console.error("❌ Error al eliminar categoría:", error);
        return next(createHttpError(500, "Error al eliminar categoría"));
    }
};
