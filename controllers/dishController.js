const Dish = require("../models/dish");
const createHttpError = require("http-errors");
const mongoose = require("mongoose");
const { supabase } = require("../config/supabaseClient");
const Tenant = require("../models/tenantModel");

const {
    getPlanFeatures,
    getPlanLimits,
    isUnlimited,
    normalizePlan,
} = require("../middlewares/requirePlan");

const VALID_PRODUCTION_AREAS = ["kitchen", "bar", "other"];
const { hasPermission } = require("../middlewares/requirePermission");

function getCurrentRole(req) {
    return (
        req.authzMembership?.role ||
        req.scope?.membership?.role ||
        req.user?.role ||
        ""
    );
}

function isAdminLike(req) {
    return ["SuperAdmin", "Owner", "Admin"].includes(getCurrentRole(req));
}

async function getTenantPlanContext(tenantId) {
    if (!tenantId) {
        throw createHttpError(401, "TENANT_NOT_FOUND");
    }

    const tenant = await Tenant.findOne({ tenantId }).select("plan status").lean();

    if (!tenant) {
        throw createHttpError(404, "TENANT_NOT_FOUND");
    }

    if (tenant.status && tenant.status !== "active") {
        throw createHttpError(403, "TENANT_SUSPENDED");
    }

    const plan = normalizePlan(tenant.plan);

    return {
        plan,
        features: getPlanFeatures(plan),
        limits: getPlanLimits(plan),
    };
}


const normalizeProductionArea = (value) => {
    const v = String(value || "kitchen").trim().toLowerCase();
    return VALID_PRODUCTION_AREAS.includes(v) ? v : "kitchen";
};

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
    try {
        const clientId = req.clientId || "default";
        const tenantId = req.user?.tenantId;

        if (!tenantId) {
            return next(createHttpError(401, "TENANT_NOT_FOUND"));
        }

        const planContext = await getTenantPlanContext(tenantId);
        const {
            name,
            price,

            category,
            inventoryCategoryId,
            productionArea,

            sellMode,
            weightUnit,
            pricePerLb,
            unit,
            avgCost,
            lastCost,
            isInventoryItem,
            allowCustomPrice,

            // NUEVO
            inventoryType,
            allowNegativeStock,
            stockMin,
        } = req.body;

        const normalizedProductionArea = normalizeProductionArea(productionArea);

        // inventoryCategoryId (si viene)
// Flags base (evita usar variables antes de declararlas)
        const isInv = String(isInventoryItem) === "true" || isInventoryItem === true;
        const requestedInventoryType = String(inventoryType || "none").trim().toLowerCase();

        const normalizedInventoryType = ["none", "direct", "recipe"].includes(requestedInventoryType)
            ? requestedInventoryType
            : "none";

        const isDirectStockProduct = normalizedInventoryType === "direct";
        const isRecipeProduct = normalizedInventoryType === "recipe";
        if (isInv && !isAdminLike(req)) {
            return next(createHttpError(
                403,
                "Tu permiso solo permite crear productos del menú. No puedes crear artículos directos de inventario."
            ));
        }
        const sm = sellMode !== undefined ? String(sellMode) : undefined;

        if ((isInv || isDirectStockProduct || isRecipeProduct) && !planContext.features.inventory) {
            return next(createHttpError(
                403,
                "Tu plan actual no incluye inventario. Mejora a Estándar, Premium o Pro para usar esta función."
            ));
        }

        if (inventoryCategoryId && !planContext.features.inventoryCategories) {
            return next(createHttpError(403, "Tu plan actual no incluye categorías de inventario."));
        }

        if (!isInv && !isUnlimited(planContext.limits.maxDishes)) {
            const currentDishes = await Dish.countDocuments({
                tenantId,
                clientId,
                isArchived: { $ne: true },
                isInventoryItem: { $ne: true },
                category: { $ne: "Inventario" },
            });

            if (currentDishes >= planContext.limits.maxDishes) {
                return next(createHttpError(
                    403,
                    `Límite de platos alcanzado para tu plan (${planContext.limits.maxDishes}). Mejora tu plan para agregar más productos.`
                ));
            }
        }

// inventoryCategoryId (si viene)
        const allowCP = String(allowCustomPrice) === "true" || allowCustomPrice === true;
        if (allowCP && isInv) {
            return next(createHttpError(400, "allowCustomPrice no aplica a inventario"));
        }
        if (allowCP && sm === "weight") {
            return next(createHttpError(400, "allowCustomPrice no aplica a venta por peso"));
        }
        let invCatId = null;

        if (
            (isInv || isDirectStockProduct) &&
            inventoryCategoryId !== undefined &&
            inventoryCategoryId !== null &&
            inventoryCategoryId !== ""
        ) {
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
    // (isInv ya fue calculado arriba)

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
// (sm ya fue calculado arriba)
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

        const directStockMin =
            stockMin !== undefined && stockMin !== null && stockMin !== ""
                ? Number(stockMin)
                : 0;

        const newDish = await Dish.create({
            name: String(name).trim(),
            price: finalPrice,
            category: String(finalCategory).trim(),
            productionArea: normalizedProductionArea,

            // Inventario desde Menú
            inventoryType: isInv ? "ingredient" : normalizedInventoryType,
            isInventoryItem: isInv,

            // Solo direct/ingredient tienen categoría de inventario
            inventoryCategoryId: isInv || isDirectStockProduct ? invCatId : null,

            // Solo direct/ingredient manejan stock propio
            stockCurrent: isInv || isDirectStockProduct ? 0 : null,
            stockMin: isInv || isDirectStockProduct ? directStockMin : null,

            allowNegativeStock:
                isInv || isDirectStockProduct
                    ? allowNegativeStock === undefined
                        ? true
                        : String(allowNegativeStock) === "true" || allowNegativeStock === true
                    : false,

            imageUrl,
            avgCost: isInv || isDirectStockProduct ? avg : null,
            lastCost: isInv || isDirectStockProduct ? last : null,
            allowCustomPrice: allowCP,

            ...(sm !== undefined ? { sellMode: sm } : {}),
            ...(wu !== undefined ? { weightUnit: wu } : {}),
            ...(pplb !== undefined ? { pricePerLb: pplb } : {}),
            ...(u !== undefined ? { unit: u } : {}),

            tenantId,
            clientId,
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
        const {
            includeInventory,
            page = 1,
            limit = 12,
            search = "",
            category = "",
        } = req.query;
        const tenantId = req.user?.tenantId;
        const planContext = await getTenantPlanContext(tenantId);

        if (String(includeInventory) === "true" && !planContext.features.inventory) {
            return res.status(403).json({
                success: false,
                code: "PLAN_FEATURE_NOT_ALLOWED",
                message: "Tu plan actual no incluye inventario.",
            });
        }

        const pageNum = Math.max(Number(page) || 1, 1);
        const limitNum = Math.max(Number(limit) || 12, 1);
        const skip = (pageNum - 1) * limitNum;

        const filter = {
            tenantId,
            isArchived: { $ne: true },
        };

        if (String(includeInventory) !== "true") {
            filter.category = { $ne: "Inventario" };
        }

        const searchTrimmed = String(search || "").trim();
        if (searchTrimmed) {
            filter.$or = [
                { name: { $regex: searchTrimmed, $options: "i" } },
                { category: { $regex: searchTrimmed, $options: "i" } },
            ];
        }

        const categoryTrimmed = String(category || "").trim();
        if (categoryTrimmed) {
            filter.category = categoryTrimmed;
        }

        const [items, total] = await Promise.all([
            Dish.find(filter)
                .sort({ updatedAt: -1 })
                .skip(skip)
                .limit(limitNum),
            Dish.countDocuments(filter),
        ]);

        const totalPages = Math.max(Math.ceil(total / limitNum), 1);

        res.status(200).json({
            success: true,
            data: {
                items,
                page: pageNum,
                limit: limitNum,
                total,
                totalPages,
            },
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
            productionArea,
            sellMode,
            weightUnit,
            pricePerLb,
            inventoryCategoryId,
            isInventoryItem,
            unit,

            // NUEVO
            inventoryType,
            allowNegativeStock,
            stockMin,
            avgCost,
            lastCost,
        } = req.body;

        const tenantId = req.user?.tenantId;

        if (!tenantId) {
            return next(createHttpError(401, "TENANT_NOT_FOUND"));
        }

        const planContext = await getTenantPlanContext(tenantId);

        const isTryingInventoryChange =
            isInventoryItem !== undefined ||
            inventoryCategoryId !== undefined ||
            inventoryType !== undefined ||
            allowNegativeStock !== undefined ||
            stockMin !== undefined ||
            avgCost !== undefined ||
            lastCost !== undefined;

        if (isTryingInventoryChange && !planContext.features.inventory) {
            return next(createHttpError(
                403,
                "Tu plan actual no incluye inventario. Mejora a Estándar, Premium o Pro para usar esta función."
            ));
        }

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return next(createHttpError(404, "Invalid dish ID!"));
        }
        const dish = await Dish.findOne({
            _id: id,
            tenantId,
        });

        if (!dish) return next(createHttpError(404, "Dish not found!"));

        const requestedInventoryType =
            inventoryType !== undefined
                ? String(inventoryType || "none").trim().toLowerCase()
                : String(dish.inventoryType || "none").trim().toLowerCase();

        const normalizedInventoryType = ["none", "direct", "recipe"].includes(requestedInventoryType)
            ? requestedInventoryType
            : "none";

        const isDirectStockProduct = normalizedInventoryType === "direct";
        const isRecipeProduct = normalizedInventoryType === "recipe";


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
        if (dish.isInventoryItem) {
            if (invCatId !== undefined) {
                dish.inventoryCategoryId = invCatId;
            }

            dish.inventoryType = "ingredient";
            dish.stockCurrent = Number.isFinite(Number(dish.stockCurrent)) ? Number(dish.stockCurrent) : 0;
            dish.stockMin = stockMin !== undefined ? Number(stockMin || 0) : Number(dish.stockMin || 0);
        } else {
            dish.inventoryType = normalizedInventoryType;

            if (isDirectStockProduct) {
                if (invCatId !== undefined) {
                    dish.inventoryCategoryId = invCatId;
                }

                dish.stockCurrent = Number.isFinite(Number(dish.stockCurrent)) ? Number(dish.stockCurrent) : 0;
                dish.stockMin = stockMin !== undefined ? Number(stockMin || 0) : Number(dish.stockMin || 0);

                dish.allowNegativeStock =
                    allowNegativeStock === undefined
                        ? dish.allowNegativeStock !== false
                        : String(allowNegativeStock) === "true" || allowNegativeStock === true;

                if (avgCost !== undefined) {
                    dish.avgCost = avgCost === "" || avgCost === null ? null : Number(avgCost);
                }

                if (lastCost !== undefined) {
                    dish.lastCost = lastCost === "" || lastCost === null ? null : Number(lastCost);
                }
            }

            if (isRecipeProduct) {
                dish.inventoryCategoryId = null;
                dish.stockCurrent = null;
                dish.stockMin = null;
                dish.allowNegativeStock = false;
                dish.avgCost = null;
                dish.lastCost = null;
            }

            if (normalizedInventoryType === "none") {
                dish.inventoryCategoryId = null;
                dish.stockCurrent = null;
                dish.stockMin = null;
                dish.allowNegativeStock = false;
                dish.avgCost = null;
                dish.lastCost = null;
            }
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
        if (productionArea !== undefined) {
            dish.productionArea = normalizeProductionArea(productionArea);
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

        // -----------------------------
        // Helpers
        const parseInvCatId = (v) => {
            if (v === undefined) return undefined; // no tocar
            if (v === "" || v === null) return null;
            if (!mongoose.Types.ObjectId.isValid(String(v))) return "__INVALID__";
            return String(v);
        };

        const sm = sellMode !== undefined ? String(sellMode) : "unit";
        if (!["unit", "weight"].includes(sm)) {
            return res.status(400).json({ success: false, message: "sellMode inválido" });
        }

        const wu = weightUnit !== undefined ? String(weightUnit) : "lb";
        if (!["lb", "kg"].includes(wu)) {
            return res.status(400).json({ success: false, message: "weightUnit inválido" });
        }

        const invCatId = parseInvCatId(inventoryCategoryId);
        if (invCatId === "__INVALID__") {
            return res.status(400).json({ success: false, message: "inventoryCategoryId inválido" });
        }

        // ----------------------------------------------------
        // MODO A: Basado en plato existente -> CONVERTIR A INGREDIENTE (sin duplicar)
        if (existingDishId) {
            if (!mongoose.Types.ObjectId.isValid(String(existingDishId))) {
                return res.status(400).json({ success: false, message: "existingDishId inválido" });
            }

            const dish = await Dish.findOne({ _id: existingDishId, tenantId, clientId });
            if (!dish) {
                return res.status(404).json({ success: false, message: "Plato base no encontrado" });
            }

            // Evitar colisión con otro ingrediente ya existente (mismo name en Inventario)
            const collision = await Dish.findOne({
                tenantId,
                clientId,
                _id: { $ne: dish._id },
                isArchived: { $ne: true },
                isInventoryItem: true,
                category: "Inventario",
                name: dish.name,
            }).select("_id name");

            if (collision) {
                return res.status(409).json({
                    success: false,
                    code: "INGREDIENT_ALREADY_EXISTS",
                    message: "Ya existe un ingrediente con ese nombre (colisión al convertir).",
                    data: collision,
                });
            }

            // Convertirlo a ingrediente/inventario
            dish.isInventoryItem = true;
            dish.category = "Inventario";
            dish.price = 0;
            dish.sellMode = sm;
            dish.weightUnit = wu;

            if (invCatId !== undefined) dish.inventoryCategoryId = invCatId;
            if (description !== undefined) dish.description = String(description);

            const updated = await dish.save();

            return res.status(200).json({
                success: true,
                message: "Plato existente convertido a ingrediente (sin duplicar).",
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

        // Evitar duplicados por tenant + client + (Inventario + isInventoryItem=true) + name
        const exists = await Dish.findOne({
            tenantId,
            clientId,
            isArchived: { $ne: true },
            isInventoryItem: true,
            category: "Inventario",
            name: trimmedName,
        }).select("_id name");

        if (exists) {
            return res.status(409).json({
                success: false,
                code: "INGREDIENT_ALREADY_EXISTS",
                message: "Ya existe un ingrediente con ese nombre",
                data: exists,
            });
        }

        const ingredient = await Dish.create({
            tenantId,
            clientId,
            name: trimmedName,
            description: description ? String(description) : "",
            category: "Inventario",
            isInventoryItem: true,
            inventoryCategoryId: invCatId === undefined ? null : invCatId,
            sellMode: sm,
            weightUnit: wu,
            price: 0,
            stockCurrent: 0,
            stockMin: 0,
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


