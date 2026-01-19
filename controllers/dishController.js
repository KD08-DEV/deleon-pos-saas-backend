const Dish = require("../models/dish");
const createHttpError = require("http-errors");
const mongoose = require("mongoose");
const { supabase } = require("../config/supabaseClient");

const uploadToSupabase = async (tenantId, file) => {
    const ext = file.originalname.split(".").pop();
    const filename = `${Date.now()}.${ext}`;
    const fullPath = `${tenantId}/${filename}`;

    const { error } = await supabase.storage
        .from(process.env.SUPABASE_BUCKET)
        .upload(fullPath, file.buffer, {
            contentType: file.mimetype,
            upsert: false,
        });

    if (error) {
        console.error("Supabase upload error:", error);
        throw createHttpError(500, error.message || "Error uploading image");
    }

    const { data: publicData } = supabase.storage
        .from(process.env.SUPABASE_BUCKET)
        .getPublicUrl(fullPath);

    return { publicUrl: publicData.publicUrl, fullPath };
};

const extractSupabaseKeyFromPublicUrl = (imageUrl) => {
    try {
        const u = new URL(String(imageUrl));
        const parts = u.pathname.split("/").filter(Boolean);
        const i = parts.findIndex((p) => p === "public");
        if (i === -1) return null;

        const bucket = parts[i + 1];
        const key = parts.slice(i + 2).join("/");

        // Si el URL trae "public/<bucket>/<key>", remove() solo quiere <key>
        if (bucket && key) return key;

        return null;
    } catch (_) {
        return null;
    }
};

const deleteFromSupabase = async (imageUrl) => {
    try {
        const key = extractSupabaseKeyFromPublicUrl(imageUrl);
        if (!key) return;

        const { error } = await supabase.storage
            .from(process.env.SUPABASE_BUCKET)
            .remove([key]);

        if (error) {
            console.log("Error deleting Supabase image:", error.message);
        }
    } catch (error) {
        console.log("Error deleting Supabase image:", error.message);
    }
};

// --------------------------------------------
// CREATE
exports.addDish = async (req, res, next) => {
    const clientId = req.clientId || "default";
    try {
        const { name, price, category, inventoryCategoryId } = req.body;

        let invCatId = null;
        if (inventoryCategoryId) {
            if (!mongoose.Types.ObjectId.isValid(inventoryCategoryId)) {
                return next(createHttpError(400, "inventoryCategoryId inválido"));
            }
            invCatId = inventoryCategoryId;
        }

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
            inventoryCategoryId: invCatId,
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
        const {
            name,
            price,
            category,
            sellMode,
            weightUnit,
            pricePerLb,
        } = req.body;

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
            if (dish.imageUrl) await deleteFromSupabase(dish.imageUrl);
            const upload = await uploadToSupabase(req.user.tenantId, req.file);
            dish.imageUrl = upload.publicUrl;
        }

        if (name !== undefined) dish.name = String(name);
        if (category !== undefined) dish.category = String(category);

            // >>> AQUI MISMO PEGA ESTO (inventoryCategoryId) <<<
        const { inventoryCategoryId } = req.body;

        if (inventoryCategoryId !== undefined) {
            if (inventoryCategoryId === "" || inventoryCategoryId === null) {
                dish.inventoryCategoryId = null;
            } else {
                if (!mongoose.Types.ObjectId.isValid(inventoryCategoryId)) {
                    return next(createHttpError(400, "inventoryCategoryId inválido"));
                }
                dish.inventoryCategoryId = inventoryCategoryId;
            }
        }

        if (sellMode !== undefined) {
            const sm = String(sellMode);
            if (!["unit", "weight"].includes(sm)) {
                return next(createHttpError(400, "sellMode inválido"));
            }
            dish.sellMode = sm;
        }

        if (weightUnit !== undefined) {
            const wu = String(weightUnit);
            if (!["lb", "kg"].includes(wu)) {
                return next(createHttpError(400, "weightUnit inválido"));
            }
            dish.weightUnit = wu;
        }

        if (price !== undefined) {
            const p = Number(price);
            if (!Number.isFinite(p) || p < 0) {
                return next(createHttpError(400, "price inválido"));
            }
            dish.price = p;
        }

        if (pricePerLb !== undefined) {
            const pp = Number(pricePerLb);
            if (!Number.isFinite(pp) || pp < 0) {
                return next(createHttpError(400, "pricePerLb inválido"));
            }
            dish.pricePerLb = pp;
        } else if (dish.sellMode === "unit") {
            // si vuelve a unit, limpia pricePerLb para evitar confusión
            dish.pricePerLb = dish.pricePerLb ?? null;
        }

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

exports.getDishRecipe = async (req, res) => {
    try {
        const tenantId = req.tenantId || req.headers["x-tenant-id"];
        const dish = await Dish.findOne({ _id: req.params.id, tenantId });

        if (!dish) {
            return res.status(404).json({ success: false, message: "Dish no encontrado" });
        }

        return res.json({
            success: true,
            sellMode: dish.sellMode || "unit",
            weightUnit: dish.weightUnit || "lb",
            pricePerLb: dish.pricePerLb ?? null,
            recipe: dish.recipe || [],
        });
    } catch (err) {
        console.error("getDishRecipe error:", err);
        return res.status(500).json({ success: false, message: "Error interno" });
    }
};

exports.updateDishRecipe = async (req, res) => {
    try {
        const tenantId = req.tenantId || req.headers["x-tenant-id"];

        const { sellMode, weightUnit, pricePerLb, recipe } = req.body;

        if (sellMode && !["unit", "weight"].includes(sellMode)) {
            return res.status(400).json({ success: false, message: "sellMode inválido" });
        }
        if (weightUnit && !["lb", "kg"].includes(weightUnit)) {
            return res.status(400).json({ success: false, message: "weightUnit inválido" });
        }
        if (recipe && !Array.isArray(recipe)) {
            return res.status(400).json({ success: false, message: "recipe debe ser un array" });
        }

        // Validación mínima de receta
        // Ahora las recetas usan dishId en lugar de inventoryItemId
        if (Array.isArray(recipe)) {
            for (const r of recipe) {
                // Acepta dishId (nuevo) o inventoryItemId (legacy para compatibilidad)
                if (!r.dishId && !r.inventoryItemId) {
                    return res.status(400).json({ success: false, message: "Cada receta requiere dishId" });
                }
                const q = Number(r.qty);
                if (!Number.isFinite(q) || q <= 0) {
                    return res.status(400).json({ success: false, message: "Cada receta requiere qty > 0" });
                }
            }
        }

        const dish = await Dish.findOne({ _id: req.params.id, tenantId });
        if (!dish) {
            return res.status(404).json({ success: false, message: "Dish no encontrado" });
        }

        if (sellMode) dish.sellMode = sellMode;
        if (weightUnit) dish.weightUnit = weightUnit;

        // Si es weight, pricePerLb debe existir (o al menos permitirlo null si lo manejarás en front)
        if (sellMode === "weight" || dish.sellMode === "weight") {
            dish.pricePerLb = (pricePerLb === undefined ? dish.pricePerLb : Number(pricePerLb));
        }

        if (Array.isArray(recipe)) dish.recipe = recipe;

        await dish.save();

        return res.json({ success: true, dish });
    } catch (err) {
        console.error("updateDishRecipe error:", err);
        return res.status(500).json({ success: false, message: "Error interno" });
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
