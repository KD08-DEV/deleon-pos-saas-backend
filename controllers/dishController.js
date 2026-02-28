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
// --------------------------------------------
// CREATE
exports.addDish = async (req, res, next) => {
    const clientId = req.clientId || "default";
    const { allowCustomPrice } = req.body;
    try {
        const {
            name,
            price,

            category,
            inventoryCategoryId,

            sellMode,
            weightUnit,
            pricePerLb,
            unit,
            avgCost,
            lastCost,
            isInventoryItem,
        } = req.body;

        // inventoryCategoryId (si viene)
        const allowCP = String(allowCustomPrice) === "true" || allowCustomPrice === true;
        if (allowCP && isInv) {
            return next(createHttpError(400, "allowCustomPrice no aplica a inventario"));
        }
        if (allowCP && sm === "weight") {
            return next(createHttpError(400, "allowCustomPrice no aplica a venta por peso"));
        }
        let invCatId = null;
        if (inventoryCategoryId !== undefined && inventoryCategoryId !== null && inventoryCategoryId !== "") {
            if (!mongoose.Types.ObjectId.isValid(inventoryCategoryId)) {
                return next(createHttpError(400, "inventoryCategoryId inválido"));
            }
            invCatId = inventoryCategoryId;
        }

        // ✅ Validaciones robustas (ojo: price=0 no debe fallar)
        if (!name || !String(name).trim()) {
            return next(createHttpError(400, "Please provide name!"));
        }

        // Si es inventario, permitimos no mandar category y la fijamos.
        const isInv = String(isInventoryItem) === "true" || isInventoryItem === true;

        // category solo obligatoria para platos de menú
        const finalCategory = isInv ? "Inventario" : category;

        if (!finalCategory || !String(finalCategory).trim()) {
            return next(createHttpError(400, "Please provide category!"));
        }

        // price obligatorio para platos; para inventario lo dejamos en 0
        const finalPrice = isInv ? 0 : Number(price);
        if (!isInv) {
            if (price === undefined || price === null || Number.isNaN(finalPrice) || finalPrice < 0) {
                return next(createHttpError(400, "Please provide a valid price!"));
            }
        }

        // ✅ sellMode / weightUnit / pricePerLb
        const sm = sellMode !== undefined ? String(sellMode) : undefined;
        if (sm !== undefined && !["unit", "weight"].includes(sm)) {
            return next(createHttpError(400, "sellMode inválido"));
        }

        const wu = weightUnit !== undefined ? String(weightUnit) : undefined;
        if (wu !== undefined && !["lb", "kg"].includes(wu)) {
            return next(createHttpError(400, "weightUnit inválido"));
        }

        // Si es por peso, pricePerLb debe venir válido
        let pplb = pricePerLb;
        if ((sm === "weight") || (sm === undefined && false)) {
            const n = Number(pplb);
            if (!Number.isFinite(n) || n <= 0) {
                return next(createHttpError(400, "pricePerLb inválido (requerido cuando sellMode=weight)"));
            }
            pplb = n;
        } else if (pplb !== undefined) {
            const n = Number(pplb);
            if (!Number.isFinite(n) || n < 0) {
                return next(createHttpError(400, "pricePerLb inválido"));
            }
            pplb = n;
        }

        // ✅ unit (si tu UI lo manda para inventario)
        const u = unit !== undefined ? String(unit) : undefined;
        if (u !== undefined && !["unidad", "lb", "kg"].includes(u)) {
            return next(createHttpError(400, "unit inválido"));
        }

        let imageUrl = null;
        if (req.file) {
            const upload = await uploadToSupabase(req.user.tenantId, req.file);
            imageUrl = upload.publicUrl;
        }
        let avg = null;
        if (avgCost !== undefined && avgCost !== null && avgCost !== "") {
            const n = Number(avgCost);
            if (!Number.isFinite(n) || n < 0) return next(createHttpError(400, "avgCost inválido"));
            avg = n;
        }

        let last = null;
        if (lastCost !== undefined && lastCost !== null && lastCost !== "") {
            const n = Number(lastCost);
            if (!Number.isFinite(n) || n < 0) return next(createHttpError(400, "lastCost inválido"));
            last = n;
        }

        const newDish = await Dish.create({
            name: String(name).trim(),
            price: finalPrice,
            category: String(finalCategory).trim(),
            inventoryCategoryId: invCatId,
            isInventoryItem: isInv,
            imageUrl,
            avgCost: avg,
            allowCustomPrice: allowCP,
            lastCost: last,
            // ✅ guardamos venta por peso desde creación
            ...(sm !== undefined ? { sellMode: sm } : {}),
            ...(wu !== undefined ? { weightUnit: wu } : {}),
            ...(pplb !== undefined ? { pricePerLb: pplb } : {}),
            ...(u !== undefined ? { unit: u } : {}),
            tenantId: req.user.tenantId,
            clientId: clientId,
        });


        res.status(201).json({
            success: true,
            message: "Dish added successfully!",
            data: newDish,
        });
    } catch (error) {
        if (error?.code === 11000) {
            return res.status(409).json({
                success: false,
                code: "DISH_ALREADY_EXISTS",
                message: "Ya existe un plato con ese nombre en esa categoría.",
            });
        }
        next(error);
    }
};

// --------------------------------------------
// READ
exports.getDishes = async (req, res, next) => {
    try {
        const { includeInventory } = req.query;

        const filter = {
            tenantId: req.user.tenantId,
            isArchived: { $ne: true },
        };


        // Por defecto NO incluye ingredientes/inventario puros
        // (los platos del POS pueden ser inventario y deben seguir saliendo)
        if (String(includeInventory) !== "true") {
            filter.category = { $ne: "Inventario" };
        }


        const dishes = await Dish.find(filter).sort({ updatedAt: -1 });

        res.status(200).json({
            success: true,
            data: dishes,
        });
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
            inventoryCategoryId,
            isInventoryItem,
            unit,
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

        if (name !== undefined) dish.name = String(name).trim();

        // -----------------------------
        // INVENTARIO (stock/control) VS INVENTARIO DIRECTO (isInventoryItem)

        // 1) inventoryCategoryId: undefined = no tocar; null = limpiar; ObjectId = setear
        let invCatId = undefined;
        if (inventoryCategoryId !== undefined) {
            if (inventoryCategoryId === "" || inventoryCategoryId === null) {
                invCatId = null;
            } else {
                if (!mongoose.Types.ObjectId.isValid(inventoryCategoryId)) {
                    return next(createHttpError(400, "inventoryCategoryId inválido"));
                }
                invCatId = inventoryCategoryId;
            }
        }

        // 2) Si el request manda isInventoryItem, lo aplicamos (esto define inventario directo)
        if (isInventoryItem !== undefined) {
            dish.isInventoryItem =
                String(isInventoryItem) === "true" || isInventoryItem === true;
        }

        // 3) inventoryCategoryId SOLO afecta stock/control (NO cambia isInventoryItem)
        if (invCatId !== undefined) {
            dish.inventoryCategoryId = invCatId; // null o ObjectId
        }

        // 4) category del MENÚ:
        // - Si NO es inventario directo, permitimos actualizar category.
        // - Si es inventario directo, la forzamos a "Inventario" (si esa es tu convención)
        if (dish.isInventoryItem) {
            dish.category = "Inventario";
        } else if (category !== undefined) {
            dish.category = String(category).trim();
        }

        // 5) unit (opcional)
        if (unit !== undefined) {
            const u = String(unit);
            if (!["unidad", "lb", "kg"].includes(u)) {
                return next(createHttpError(400, "unit inválido"));
            }
            dish.unit = u;
        }

        // 6) price:
        // - Si es inventario directo => forzamos price = 0
        // - Si NO es inventario directo => actualizamos si viene
        if (dish.isInventoryItem) {
            dish.price = 0;
        } else if (price !== undefined) {
            const p = Number(price);
            if (!Number.isFinite(p) || p < 0) {
                return next(createHttpError(400, "price inválido"));
            }
            dish.price = p;
        }

        // -----------------------------
        // VENTA POR PESO
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

        // Si es weight, pricePerLb debe ser válido (si lo mandan o si ya está en weight)
        if (dish.sellMode === "weight") {
            if (pricePerLb === undefined) {
                if (dish.pricePerLb === null || dish.pricePerLb === undefined) {
                    return next(createHttpError(400, "pricePerLb requerido cuando sellMode=weight"));
                }
            } else {
                const pp = Number(pricePerLb);
                if (!Number.isFinite(pp) || pp <= 0) {
                    return next(createHttpError(400, "pricePerLb inválido"));
                }
                dish.pricePerLb = pp;
            }
        } else {
            // si vuelve a unit, limpiamos pricePerLb
            dish.pricePerLb = null;
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
        if (Array.isArray(recipe)) {
            for (const r of recipe) {
                const id = r.ingredientDishId || r.dishId || r.inventoryItemId;
                if (!id) {
                    return res.status(400).json({ success: false, message: "Cada receta requiere dishId (o ingredientDishId)" });
                }
                const q = Number(r.qty);
                if (!Number.isFinite(q) || q <= 0) {
                    return res.status(400).json({ success: false, message: "Cada receta requiere qty > 0" });
                }
            }
        }

        if (Array.isArray(recipe)) {
            dish.recipe = recipe.map((r) => ({
                ingredientDishId: r.ingredientDishId || r.dishId || r.inventoryItemId,
                qty: Number(r.qty),
                unit: r.unit || "unidad",
            }));
        }

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
// ✅ Ingredientes (inventario simple usando Dish)
exports.createIngredient = async (req, res) => {
    try {
        const tenantId = req.user?.tenantId;
        const clientId = req.clientId || "default";

        const {
            // modo "crear nuevo ingrediente"
            name,
            description,

            // modo "basado en plato existente"
            existingDishId,

            // inventario
            inventoryCategoryId,

            // venta
            sellMode,
            weightUnit,
        } = req.body;

        if (!tenantId) {
            return res.status(401).json({ success: false, message: "TenantId no encontrado" });
        }

        // ----------------------------------------------------
        // MODO A: Basado en plato existente -> NO CREAR OTRO
        if (existingDishId) {
            if (!mongoose.Types.ObjectId.isValid(existingDishId)) {
                return res.status(400).json({ success: false, message: "existingDishId inválido" });
            }

            const dish = await Dish.findOne({
                _id: existingDishId,
                tenantId,
                clientId,
            });

            if (!dish) {
                return res.status(404).json({ success: false, message: "Plato base no encontrado" });
            }

            // Asignar categoría de inventario (opcional pero recomendado)
            if (inventoryCategoryId !== undefined) {
                if (inventoryCategoryId === "" || inventoryCategoryId === null) {
                    dish.inventoryCategoryId = null;
                } else {
                    if (!mongoose.Types.ObjectId.isValid(inventoryCategoryId)) {
                        return res.status(400).json({ success: false, message: "inventoryCategoryId inválido" });
                    }
                    dish.inventoryCategoryId = inventoryCategoryId;
                }
            }

            // IMPORTANTE: si tú quieres que este mismo dish sea “inventario”, márcalo.
            // Si NO quieres que desaparezca del menú, entonces NO uses isInventoryItem para filtrar menú.
            dish.isInventoryItem = dish.isInventoryItem ?? false; // o simplemente NO tocarlo
            dish.category = "Inventario"; // según tu regla “solo categoría inventario”

            // Mantener su precio (NO tocar dish.price)
            // Actualizar sellMode/weightUnit si llega
            if (sellMode !== undefined) {
                const sm = String(sellMode);
                if (!["unit", "weight"].includes(sm)) {
                    return res.status(400).json({ success: false, message: "sellMode inválido" });
                }
                dish.sellMode = sm;
            }

            if (weightUnit !== undefined) {
                const wu = String(weightUnit);
                if (!["lb", "kg"].includes(wu)) {
                    return res.status(400).json({ success: false, message: "weightUnit inválido" });
                }
                dish.weightUnit = wu;
            }

            if (description !== undefined) dish.description = String(description);

            const updated = await dish.save();

            return res.status(200).json({
                success: true,
                message: "Plato existente actualizado como artículo de inventario (sin duplicar).",
                data: updated,
                updatedExisting: true,
            });
        }

        // ----------------------------------------------------
        // MODO B: Crear ingrediente nuevo -> crear Dish inventario
        if (!name || !String(name).trim()) {
            return res.status(400).json({ success: false, message: "El nombre es requerido" });
        }
        const trimmedName = String(name).trim();

// 1) Si ya existe un Dish con ese nombre (aunque no sea inventario), ACTUALÍZALO
        const existingAny = await Dish.findOne({
            tenantId,
            clientId,
            name: trimmedName,
            isArchived: { $ne: true },
        });

        if (existingAny) {
            // Asignar inventoryCategoryId si llega
            const { inventoryCategoryId } = req.body;

            if (inventoryCategoryId !== undefined) {
                if (inventoryCategoryId === "" || inventoryCategoryId === null) {
                    existingAny.inventoryCategoryId = null;
                } else {
                    if (!mongoose.Types.ObjectId.isValid(inventoryCategoryId)) {
                        return res.status(400).json({ success: false, message: "inventoryCategoryId inválido" });
                    }
                    existingAny.inventoryCategoryId = inventoryCategoryId;
                }
            }

            // NO cambies su precio si es plato de menú
            // Y NO lo marques como isInventoryItem=true (para no esconderlo del menú)
            existingAny.isInventoryItem = existingAny.isInventoryItem ?? false;

            await existingAny.save();

            return res.status(200).json({
                success: true,
                message: "Se usó el Dish existente (no se creó duplicado).",
                data: existingAny,
                updatedExistingByName: true,
            });
        }


        // Evitar duplicados por tenant + client + name (solo inventario)
        const exists = await Dish.findOne({
            tenantId,
            clientId,
            isInventoryItem: true,
            name: String(name).trim(),
        });

        if (exists) {
            return res.status(409).json({
                success: false,
                code: "INGREDIENT_ALREADY_EXISTS",
                message: "Ya existe un ingrediente con ese nombre",
                data: exists,
            });
        }

        // Validación inventoryCategoryId
// -----------------------------
// INVENTORY CATEGORY (esto es SOLO la categoría para agrupar el plato)
// NO debe decidir si el dish es inventario o no.
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

// isInventoryItem = único flag que decide si es inventario
        if (isInventoryItem !== undefined) {
            dish.isInventoryItem = (String(isInventoryItem) === "true" || isInventoryItem === true);
        }

        const isInv = Boolean(dish.isInventoryItem);

        if (isInv) {
            dish.category = "Inventario";
            dish.price = 0;
        } else {
            // si NO es inventario:
            // - NO forzar category
            // - permitir update de price
            if (price !== undefined) {
                const p = Number(price);
                if (!Number.isFinite(p) || p < 0) {
                    return next(createHttpError(400, "price inválido"));
                }
                dish.price = p;
            }
        }

        // sellMode / weightUnit defaults
        const sm = sellMode ? String(sellMode) : "unit";
        if (!["unit", "weight"].includes(sm)) {
            return res.status(400).json({ success: false, message: "sellMode inválido" });
        }

        const wu = weightUnit ? String(weightUnit) : "lb";
        if (!["lb", "kg"].includes(wu)) {
            return res.status(400).json({ success: false, message: "weightUnit inválido" });
        }

        const ingredient = await Dish.create({
            tenantId,
            clientId,
            name: String(name).trim(),
            description: description ? String(description) : "",
            category: "Inventario",
            isInventoryItem: true,
            inventoryCategoryId: invCatId,
            sellMode: sm,
            weightUnit: wu,
            price: 0, // inventario no es precio de venta
        });

        return res.status(201).json({
            success: true,
            message: "Ingrediente creado",
            data: ingredient,
            createdNew: true,
        });
    } catch (error) {
        console.error("createIngredient error", error);
        return res.status(500).json({ success: false, message: "Error interno creando ingrediente" });
    }
};


exports.listIngredients = async (req, res) => {
    try {
        const tenantId = req.user?.tenantId;
        const clientId = req.clientId || "default";

        if (!tenantId) {
            return res.status(401).json({ success: false, message: "TenantId no encontrado" });
        }

        const items = await Dish.find({
            tenantId,
            clientId,
            isArchived: { $ne: true },
            isInventoryItem: true,
            category: "Inventario",
        })
            .sort({ name: 1 })
            .select("_id name category sellMode weightUnit inventoryCategoryId isInventoryItem");


        return res.json({ success: true, data: items });
    } catch (err) {
        console.error("[listIngredients]", err);
        return res.status(500).json({ success: false, message: "Error listando ingredientes" });
    }
};


