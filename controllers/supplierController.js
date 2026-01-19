const createHttpError = require("http-errors");
const Supplier = require("../models/supplierModel");

// 🔹 Obtener todos los proveedores
exports.getSuppliers = async (req, res, next) => {
    try {
        const tenantId = req.user.tenantId;
        const clientId = req.headers["x-client-id"] || "default";

        const suppliers = await Supplier.find({ tenantId, clientId })
            .sort({ name: 1 });

        return res.status(200).json({
            success: true,
            data: suppliers,
        });
    } catch (error) {
        console.error("❌ Error al obtener proveedores:", error);
        return next(createHttpError(500, "Error al obtener proveedores"));
    }
};

// 🔹 Crear proveedor
exports.createSupplier = async (req, res, next) => {
    try {
        const tenantId = req.user.tenantId;
        const clientId = req.headers["x-client-id"] || "default";

        const { name, rnc, phone, email, address, contactPerson, notes, status } = req.body;

        if (!name || !name.trim()) {
            return next(createHttpError(400, "El nombre del proveedor es requerido"));
        }

        // Verificar si ya existe
        const exists = await Supplier.findOne({ tenantId, clientId, name: name.trim() });
        if (exists) {
            return next(createHttpError(400, "Ya existe un proveedor con ese nombre"));
        }

        const supplier = new Supplier({
            name: name.trim(),
            rnc: rnc?.trim() || "",
            phone: phone?.trim() || "",
            email: email?.trim() || "",
            address: address?.trim() || "",
            contactPerson: contactPerson?.trim() || "",
            notes: notes?.trim() || "",
            status: status || "active",
            tenantId,
            clientId,
        });

        await supplier.save();

        return res.status(201).json({
            success: true,
            message: "Proveedor creado exitosamente",
            data: supplier,
        });
    } catch (error) {
        console.error("❌ Error al crear proveedor:", error);
        if (error.code === 11000) {
            return next(createHttpError(400, "Ya existe un proveedor con ese nombre"));
        }
        return next(createHttpError(500, "Error al crear proveedor"));
    }
};

// 🔹 Actualizar proveedor
exports.updateSupplier = async (req, res, next) => {
    try {
        const tenantId = req.user.tenantId;
        const { id } = req.params;
        const { name, rnc, phone, email, address, contactPerson, notes, status } = req.body;

        const supplier = await Supplier.findOne({ _id: id, tenantId });
        if (!supplier) {
            return next(createHttpError(404, "Proveedor no encontrado"));
        }

        // Si cambia el nombre, verificar unicidad
        if (name && name.trim() !== supplier.name) {
            const exists = await Supplier.findOne({
                tenantId,
                clientId: supplier.clientId,
                name: name.trim(),
                _id: { $ne: id },
            });
            if (exists) {
                return next(createHttpError(400, "Ya existe un proveedor con ese nombre"));
            }
            supplier.name = name.trim();
        }

        if (rnc !== undefined) supplier.rnc = rnc?.trim() || "";
        if (phone !== undefined) supplier.phone = phone?.trim() || "";
        if (email !== undefined) supplier.email = email?.trim() || "";
        if (address !== undefined) supplier.address = address?.trim() || "";
        if (contactPerson !== undefined) supplier.contactPerson = contactPerson?.trim() || "";
        if (notes !== undefined) supplier.notes = notes?.trim() || "";
        if (status !== undefined) supplier.status = status;

        await supplier.save();

        return res.status(200).json({
            success: true,
            message: "Proveedor actualizado exitosamente",
            data: supplier,
        });
    } catch (error) {
        console.error("❌ Error al actualizar proveedor:", error);
        return next(createHttpError(500, "Error al actualizar proveedor"));
    }
};

// 🔹 Eliminar proveedor
exports.deleteSupplier = async (req, res, next) => {
    try {
        const tenantId = req.user.tenantId;
        const { id } = req.params;

        const supplier = await Supplier.findOneAndDelete({ _id: id, tenantId });
        if (!supplier) {
            return next(createHttpError(404, "Proveedor no encontrado"));
        }

        return res.status(200).json({
            success: true,
            message: "Proveedor eliminado exitosamente",
        });
    } catch (error) {
        console.error("❌ Error al eliminar proveedor:", error);
        return next(createHttpError(500, "Error al eliminar proveedor"));
    }
};
