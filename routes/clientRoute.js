const router = require("express").Router();
const { getBranchPolicy, createBranch } = require("../services/branchPlanAccess");
const verifyToken = require("../middlewares/tokenVerification");
const requireScope = require("../middlewares/scope");
const requireRole = require("../middlewares/requireRole");
const Client = require("../models/clientModel");
const Tenant = require("../models/tenantModel");
const TenantEcfProfile = require("../models/tenantEcfProfileModel");
const TIERS = require("../config/planTiers");

router.use(verifyToken);
router.use(requireScope({ level: "tenant", ignoreRouteClientId: true }));
// The legacy default branch exists virtually so old orders remain compatible.
router.get("/", requireRole("Owner", "Admin", "Cajera", "Camarero", "Cocina"), async (req, res, next) => {
    try {
        const tenantId = req.scope.tenantId;
        const membership = req.scope.membership;
        const adminLike = ["Owner", "Admin"].includes(membership.role);
        const branchFilter = adminLike ? {} : { clientId: { $in: membership.clientIds?.length ? membership.clientIds : ["default"] } };
        const branches = await Client.find({ tenantId, ...branchFilter }).sort({ createdAt: 1 }).lean();
        const canSeeDefault = adminLike || !membership.clientIds?.length || membership.clientIds.includes("default");
        // Principal real o virtual: un único interruptor por emisor, sin segundo certificado.
        if (canSeeDefault) {
            const globalProfile = await TenantEcfProfile.findOne({tenantId})
                .select("enabled branchActivation.primaryEnabled").lean();
            let main = branches.find((b) => b.clientId === "default");
            if (!main) {
                main = {tenantId,clientId:"default",name:"Sucursal principal",isActive:true,
                    menuMode:"independent",legacy:true};
                branches.unshift(main);
            }
            main.ecf = {enabled:globalProfile?.branchActivation?.primaryEnabled !== false};
            main.ecfConfigurationStage = "shared_emitter_branch_toggle";
        }
        for (const branch of branches) {
            if (branch.clientId !== "default") {
                branch.ecf = {
                    enabled: branch.ecf?.enabled === true,
                    updatedAt: branch.ecf?.updatedAt || null,
                    updatedBy: branch.ecf?.updatedBy || null,
                };
                // Habilitar la preferencia NO habilita emisión desde esta sede.
                branch.ecfConfigurationStage = "preparation_only";
            }
        }
        const policy = adminLike ? await getBranchPolicy(tenantId) : undefined;
        return res.json({ success: true, data: branches, policy });
    } catch (e) { next(e); }
});

// Strict plan limit. Never allow client to choose an existing/foreign branch ID.
router.post("/", requireRole("Owner", "Admin"), async (req, res, next) => {
    try {
        const tenantId = req.scope.tenantId;
        const doc = await createBranch(tenantId, req.body);
        return res.status(201).json({ success: true, data: doc });
    } catch (e) {
        if (e.code === 11000) return res.status(409).json({ code: "BRANCH_DUPLICATE" });
        if (e.status && e.expose) return res.status(e.status).json({ code: e.message });
        next(e);
    }
});


// El dueño gestiona cada sede. La sede default representa registros legacy.
router.patch("/:clientId", requireRole("Owner", "Admin"), async (req, res, next) => {
    try {
        const tenantId = req.scope.tenantId;
        const clientId = String(req.params.clientId || "");
        if (!clientId || clientId === "default") return res.status(400).json({ code: "DEFAULT_BRANCH_READ_ONLY" });
        const branch = await Client.findOne({ tenantId, clientId });
        if (!branch) return res.status(404).json({ code: "BRANCH_NOT_FOUND" });
        const { name, address, phone, isActive } = req.body || {};
        // Jamás aceptar configuración fiscal a través del PATCH genérico.
        if (["ecf", "ecfEnabled", "fiscal", "issuer", "certificate", "documentTypes"]
            .some((key) => Object.prototype.hasOwnProperty.call(req.body || {}, key))) {
            return res.status(400).json({ code: "BRANCH_ECF_DEDICATED_ROUTE_REQUIRED" });
        }
        if (name !== undefined) {
            const trimmed = String(name).trim();
            if (!trimmed || trimmed.length > 120) return res.status(400).json({ code: "INVALID_BRANCH_NAME" });
            branch.name = trimmed;
        }
        if (address !== undefined) branch.address = String(address).slice(0, 200);
        if (phone !== undefined) branch.phone = String(phone).slice(0, 40);
        if (typeof isActive === "boolean") branch.isActive = isActive;
        if (req.body?.menuMode !== undefined || req.body?.menuSourceClientId !== undefined) {
            return res.status(409).json({ code: "CHANGE_MENU_MODE_WITH_DEDICATED_ROUTE" });
        }
        await branch.save();
        return res.json({ success: true, data: branch });
    } catch (error) { next(error); }
});


// Fase 12.6.1. Guardar PREFERENCIA fiscal de una sucursal secundaria.
// IMPORTANTE: NO elimina los bloqueos de emisión de requireDominicanFiscal/orderController.
// El RNC, certificado, aprobaciones y secuencias continúan en TenantEcfProfile.
router.patch("/:clientId/ecf-config", requireRole("Owner", "Admin"), async (req, res, next) => {
    try {
        const scope = req.scope;
        const member = scope?.membership;
        const actorId = String(req.user?._id || "");
        if (!scope?.tenantId || !member || member.status !== "active" ||
            !["Owner", "Admin"].includes(member.role) ||
            String(member.tenantId) !== String(scope.tenantId) ||
            String(member.user?._id || member.user) !== actorId || !actorId) {
            return res.status(403).json({ code: "BRANCH_ECF_MANAGEMENT_DENIED" });
        }
        const tenantId = scope.tenantId;
        const clientId = String(req.params.clientId || "");
        if (!clientId) return res.status(400).json({ code: "BRANCH_NOT_FOUND" });
        // Whitelist estricta: no admitir RNC, certificados, ambiente ni secuencias.
        const body = req.body;
        if (!body || typeof body !== "object" || Array.isArray(body) ||
            Object.keys(body).some((key) => key !== "enabled") || typeof body.enabled !== "boolean") {
            return res.status(400).json({ code: "BRANCH_ECF_INVALID_CONFIGURATION" });
        }
        const tenant = await Tenant.findOne({ tenantId })
            .select("plan status localization.countryCode fiscal.enabled features.fiscal.enabled").lean();
        if (!tenant || tenant.status !== "active") {
            return res.status(403).json({ code: "TENANT_UNAVAILABLE" });
        }
        if (String(tenant.localization?.countryCode || "DO").toUpperCase() !== "DO") {
            return res.status(403).json({ code: "DGII_ONLY_DOMINICAN_REPUBLIC" });
        }
        const tier = TIERS[String(tenant.plan || "emprendedor").toLowerCase()] || TIERS.emprendedor;
        if (clientId !== "default" && tier.features.multiClient !== true) {
            return res.status(403).json({ code: "PLAN_MULTI_BRANCH_DENIED" });
        }
        if (body.enabled && (tier.features.fiscal !== true ||
            tenant.fiscal?.enabled !== true || tenant.features?.fiscal?.enabled === false)) {
            return res.status(403).json({ code: "BRANCH_ECF_TENANT_FISCAL_DISABLED" });
        }
        if (clientId === "default") {
            const profile = await TenantEcfProfile.findOne({ tenantId });
            if (!profile) return res.status(409).json({code:"BRANCH_ECF_ISSUER_NOT_CONFIGURED"});
            if (body.enabled && !String(profile.issuer?.rnc || "").trim())
                return res.status(409).json({code:"BRANCH_ECF_ISSUER_NOT_CONFIGURED"});
            if (body.enabled && profile.environment !== "internal_sandbox")
                return res.status(409).json({code:"BRANCH_ECF_ONLY_INTERNAL_SANDBOX"});
            // Esta acción solo cambia un permiso local de sede, NO profile.enabled ni environment.
            await TenantEcfProfile.updateOne({tenantId}, {$set: {
                "branchActivation.primaryEnabled":body.enabled,
                "branchActivation.updatedAt":new Date(),
                "branchActivation.updatedBy":actorId,
            }});
            return res.json({success:true, data:{clientId:"default",ecf:{enabled:body.enabled}},
                message:body.enabled ? "e-CF preparado en sucursal principal (sujeto a controles)" : "e-CF desactivado en sucursal principal"});
        }
        const branch = await Client.findOne({ tenantId, clientId }).lean();
        if (!branch) return res.status(404).json({ code: "BRANCH_NOT_FOUND" });
        if (!branch.isActive) return res.status(409).json({ code: "BRANCH_INACTIVE" });
        if (body.enabled) {
            // Solo se prepara esta sucursal respecto al mismo emisor del tenant.
            // No admitimos perfiles independientes, ni ambientes productivos.
            const profile = await TenantEcfProfile.findOne({ tenantId,
                $or: [{ clientId: "default" }, { clientId: { $exists: false } },
                    { clientId: null }, { clientId: "" }],
            }).select("environment issuer.rnc").lean();
            if (!profile || !String(profile.issuer?.rnc || "").trim()) {
                return res.status(409).json({ code: "BRANCH_ECF_ISSUER_NOT_CONFIGURED" });
            }
            if (profile.environment === "dgii_production") {
                return res.status(409).json({ code: "BRANCH_ECF_PRODUCTION_NOT_IMPLEMENTED" });
            }
        }
        const now = new Date();
        // Condición atómica; dos solicitudes simultáneas no reescriben innecesariamente
        // el autor/fecha si la configuración ya alcanzó el estado solicitado.
        const updated = await Client.findOneAndUpdate(
            { tenantId, clientId, isActive: true, "ecf.enabled": { $ne: body.enabled } },
            { $set: { "ecf.enabled": body.enabled, "ecf.updatedAt": now, "ecf.updatedBy": actorId } },
            { new: true, runValidators: true }
        ).lean();
        const result = updated || await Client.findOne({ tenantId, clientId, isActive: true }).lean();
        if (!result) return res.status(409).json({ code: "BRANCH_INACTIVE" });
        return res.json({
            success: true,
            data: { clientId: result.clientId, ecf: {
                enabled: result.ecf?.enabled === true,
                updatedAt: result.ecf?.updatedAt || null,
                updatedBy: result.ecf?.updatedBy || null,
            }, ecfConfigurationStage: "preparation_only" },
            productionEnabled: false,
            message: "Configuración guardada. Esta sucursal aún NO puede emitir e-CF hasta completar la fase de seguridad de emisión.",
        });
    } catch (error) { next(error); }
});

// Compartir el CATÁLOGO no equivale a compartir stock ni recetas.
// Para evitar mezclar inventarios, la sincronización solo acepta platos sin inventario.
router.post("/:clientId/menu/sync", requireRole("Owner", "Admin"), async (req, res, next) => {
    try {
        const tenantId = req.scope.tenantId;
        const branchId = String(req.params.clientId || "");
        if (!branchId || branchId === "default") return res.status(400).json({ code: "INVALID_TARGET_BRANCH" });
        const tenant = await Tenant.findOne({ tenantId }).select("plan").lean();
        const tier = TIERS[String(tenant?.plan || "emprendedor").toLowerCase()] || TIERS.emprendedor;
        if (!tier.features.multiClient) return res.status(403).json({ code: "PLAN_MULTI_BRANCH_DENIED" });
        const branch = await Client.findOne({ tenantId, clientId: branchId, isActive: true });
        if (!branch) return res.status(404).json({ code: "BRANCH_NOT_FOUND" });
        const sourceId = String(branch.menuSourceClientId || "default");
        if (branch.menuMode !== "shared") return res.status(409).json({ code: "BRANCH_MENU_NOT_SHARED" });
        if (sourceId !== "default") return res.status(409).json({ code: "UNSUPPORTED_MENU_SOURCE" });
        const Dish = require("../models/dish");
        const originals = await Dish.find({ tenantId, $or: [
            { clientId: "default" }, { clientId: { $exists: false } }, { clientId: null }
        ], isArchived: { $ne: true }, category: { $ne: "Inventario" } }).lean();
        const unsupported = originals.filter(d => (d.inventoryType || "none") !== "none" || d.isInventoryItem ||
            (Array.isArray(d.recipe) && d.recipe.length > 0) ||
            d.customization?.extras?.some(e => e.extraDishId) ||
            d.customization?.removableIngredients?.some(e => e.ingredientDishId));
        if (unsupported.length) return res.status(409).json({
            code: "SHARED_MENU_INVENTORY_REQUIRES_MAPPING",
            count: unsupported.length,
            message: "Hay platos con stock, recetas o referencias entre productos. Deben mapearse al inventario de la sede antes de compartirlos."
        });
        // La sincronización no borra platos existentes ni toca stock/ventas/caja de la sede destino.
        let created = 0, updated = 0;
        for (const source of originals) {
            const selector = { tenantId, clientId: branchId, menuSourceDishId: source._id };
            const current = await Dish.findOne(selector);
            const safeCustomization = {
                enabled: Boolean(source.customization?.enabled),
                extras: (source.customization?.extras || []).map(e => ({
                    name: e.name, price: e.price, maxQuantity: e.maxQuantity,
                    active: e.active !== false, extraDishId: null
                })),
                removableIngredients: (source.customization?.removableIngredients || []).map(e => ({
                    name: e.name, active: e.active !== false, ingredientDishId: null
                }))
            };
            const sharedFields = {
                name: source.name, category: source.category, imageUrl: source.imageUrl || "",
                productionArea: source.productionArea || "kitchen", customization: safeCustomization,
                taxId: source.taxId ?? null, taxIncludedOverride: source.taxIncludedOverride ?? null
            };
            if (current) {
                await Dish.updateOne(selector, { $set: sharedFields });
                updated++;
            } else {
                await Dish.create({
                    ...sharedFields, tenantId, clientId: branchId, menuSourceDishId: source._id,
                    price: source.price, inventoryType: "none", isInventoryItem: false,
                    stockCurrent: null, recipe: [], isArchived: false,
                    sellMode: source.sellMode || "unit", weightUnit: source.weightUnit || "lb",
                    pricePerLb: source.pricePerLb ?? null
                });
                created++;
            }
        }
        return res.json({ success: true, created, updated, sourceCount: originals.length,
            note: "Los precios de platos ya sincronizados se conservan por sucursal. Las bajas de origen no se eliminan automáticamente." });
    } catch (error) { next(error); }
});

router.patch("/:clientId/menu", requireRole("Owner", "Admin"), async (req, res, next) => {
    try {
        const tenantId = req.scope.tenantId;
        const branchId = String(req.params.clientId || "");
        if (!branchId || branchId === "default") return res.status(400).json({ code: "INVALID_TARGET_BRANCH" });
        const tenant = await Tenant.findOne({ tenantId }).select("plan").lean();
        const tier = TIERS[String(tenant?.plan || "emprendedor").toLowerCase()] || TIERS.emprendedor;
        if (!tier.features.multiClient) return res.status(403).json({ code: "PLAN_MULTI_BRANCH_DENIED" });
        const branch = await Client.findOne({ tenantId, clientId: branchId });
        if (!branch) return res.status(404).json({ code: "BRANCH_NOT_FOUND" });
        const mode = String(req.body?.menuMode || "");
        if (!["independent", "shared"].includes(mode)) return res.status(400).json({ code: "INVALID_MENU_MODE" });
        if (mode === "shared" && req.body?.menuSourceClientId && req.body.menuSourceClientId !== "default")
            return res.status(400).json({ code: "ONLY_MAIN_BRANCH_CAN_BE_MENU_SOURCE" });
        if (mode === "independent" && branch.menuMode === "shared") {
            // No convertir silenciosamente platos sincronizados en catálogo independiente:
            // conservar los platos y su trazabilidad, solo detener futuras sincronizaciones.
            branch.menuSourceClientId = null;
        } else if (mode === "shared") {
            branch.menuSourceClientId = "default";
        }
        branch.menuMode = mode;
        await branch.save();
        return res.json({ success: true, data: branch });
    } catch (error) { next(error); }
});

module.exports = router;
