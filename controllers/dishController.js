const Dish = require("../models/dish");
const createHttpError = require("http-errors");
const mongoose = require("mongoose");
const supabase = require("../config/supabaseClient");

const uploadToSupabase = async (tenantId, file) => {
    const ext = file.originalname.split(".").pop();

    // Guardamos en carpetas por tenant: ejemplo /tenant_123/file.png
    const filename = `${Date.now()}.${ext}`;
    const fullPath = `${tenantId}/${filename}`;

    // --- SUBIR ARCHIVO ---
    const { data, error } = await supabase.storage
        .from(process.env.SUPABASE_BUCKET)
        .upload(fullPath, file.buffer, {
            contentType: file.mimetype,
            upsert: false,
        });

    if (error) {
        console.error("Supabase upload error:", error);
        throw createHttpError(500, error.message || "Error uploading image");
    }

    // --- GENERAR URL PÚBLICA CORRECTA ---
    const { data: publicData } = supabase.storage
        .from(process.env.SUPABASE_BUCKET)
        .getPublicUrl(fullPath);

    const publicUrl = publicData.publicUrl;

    return { publicUrl, fullPath };
};

const deleteFromSupabase = async (imageUrl) => {
    try {
        const relativePath = imageUrl.split("/public/")[1];
        await supabase.storage.from(process.env.SUPABASE_BUCKET).remove([relativePath]);
    } catch (error) {
        console.log("Error deleting Supabase image:", error.message);
    }
};

// --------------------------------------------
// CREATE
exports.addDish = async (req, res, next) => {
    const clientId = req.clientId || "default";
    try {
        const { name, price, category } = req.body;

        if (!name || !price || !category) {
            return next(createHttpError(400, "Please provide name, price and category!"));
        }

        let imageUrl = null;

        if (req.file) {
            const upload = await uploadToSupabase(req.user.tenantId, req.file);
            imageUrl = upload.publicUrl;
        }

        const newDish = await Dish.create({
            name,
            price,
            category,
            imageUrl,
            tenantId: req.user.tenantId,
            clientId: clientId,
        });

        res.status(201).json({
            success: true,
            message: "Dish added successfully!",
            data: newDish,
        });
    } catch (error) {
        next(error);
    }
};

// --------------------------------------------
// READ
exports.getDishes = async (req, res, next) => {
    try {
        const dishes = await Dish.find({ tenantId: req.user.tenantId });
        res.status(200).json({ success: true, data: dishes });
    } catch (error) {
        next(error);
    }
};

// --------------------------------------------
// UPDATE
exports.updateDish = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { name, price, category } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return next(createHttpError(404, "Invalid dish ID!"));
        }

        const dish = await Dish.findOne({
            _id: id,
            tenantId: req.user.tenantId,
        });

        if (!dish) return next(createHttpError(404, "Dish not found!"));

        // Nueva imagen
        if (req.file) {
            // Eliminar la imagen anterior
            if (dish.imageUrl) await deleteFromSupabase(dish.imageUrl);

            const upload = await uploadToSupabase(req.user.tenantId, req.file);
            dish.imageUrl = upload.publicUrl;
        }

        dish.name = name || dish.name;
        dish.price = price || dish.price;
        dish.category = category || dish.category;

        const updated = await dish.save();

        res.status(200).json({
            success: true,
            message: "Dish updated successfully!",
            data: updated,
        });

    } catch (error) {
        next(error);
    }
};

// --------------------------------------------
// DELETE
exports.deleteDish = async (req, res, next) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return next(createHttpError(404, "Invalid dish ID!"));
        }

        const dish = await Dish.findOne({
            _id: id,
            tenantId: req.user.tenantId,
        });

        if (!dish) return next(createHttpError(404, "Dish not found!"));

        // borrar imagen en Supabase
        if (dish.imageUrl) {
            await deleteFromSupabase(dish.imageUrl);
        }

        await Dish.deleteOne({ _id: id });

        res.status(200).json({
            success: true,
            message: "Dish deleted successfully!",
        });

    } catch (error) {
        next(error);
    }
};
