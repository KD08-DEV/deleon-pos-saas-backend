// pos-backend/routes/orderRoute.js
const express = require("express");
const router = express.Router();
const Order = require("../models/orderModel");
const { supabase } = require("../config/supabaseClient");
const { signStoredInvoice } = require("../utils/invoiceStorageAccess");
// Middlewares
const verifyToken = require("../middlewares/tokenVerification");
const requirePermission = require("../middlewares/requirePermission");
const { getAllTimePopularDishes } = require("../controllers/popularDishesController");
const { correctNormalOrder, previewNormalOrderCorrection, getCorrectionCatalog, listFinancialCorrections, fiscalLocked } = require("../controllers/orderCorrectionController");
const ElectronicTaxDocument = require("../models/electronicTaxDocumentModel");
const { tenantMiddleware } = require("../middlewares/tenantMiddleware");
const requireDominicanFiscal = require("../middlewares/requireDominicanFiscal");
const {getCapabilities,requireEcfPermission,requireEcfAdjustmentPermission,requireAutomaticEcfPermission} = require("../middlewares/requireEcfPermission");
const {
    issueOrderAsEcf,
    issueEcfAdjustment,
    reconcileExistingEcf,
    listOrderEcfAdjustments,
} = require("../controllers/ecfIssueController");
// Controllers
const {
    getOrders,
    getOrderById,
    getOrderEcfStatus,
    getTenantEcfStatus,
    addOrder,
    updateOrder,
    deleteOrder,
    updatePaymentMethod,
    getSalesByProductReport,
    sendOrderToProduction,
    previewOrderTaxes,
} = require("../controllers/orderController");

router.get('/credit-access',verifyToken,tenantMiddleware,async(req,res,next)=>{try{
 const tenant=await require('../models/tenantModel').findOne({tenantId:req.tenantId}).select('plan').lean();
 const {canCreateCreditSale}=require('../services/orders/creditSaleAccess');
 res.json({canCreateCredit:!!tenant&&await canCreateCreditSale(req,tenant)});
}catch(error){next(error);}});
// Historial completo (no depende del filtro diario del reporte de ventas).
router.get("/report/popular-dishes-all-time", verifyToken, tenantMiddleware, getAllTimePopularDishes);

router.get(
    "/report/sales-by-product",
    verifyToken,
    tenantMiddleware,
    getSalesByProductReport
);
/**
 * GET /api/order
 */

router.post(
    "/:id/issue-ecf",
    verifyToken,
    tenantMiddleware,
    requireDominicanFiscal({ issuance: true }),
    requireEcfPermission("issue"),
    issueOrderAsEcf
);
router.post("/:id/ecf/reconcile", verifyToken, tenantMiddleware,
    // Recovery only queries an existing document; controller must re-check order,
    // tenant, branch, fiscal permission and original environment.
    requireDominicanFiscal({ issuance: false, branchReconcile: true }), reconcileExistingEcf);

router.get(
    "/:id/ecf/adjustments",
    verifyToken,
    tenantMiddleware,
    requireDominicanFiscal({ issuance: false, branchRead: true }),
    listOrderEcfAdjustments
);

router.post(
    "/:id/ecf/adjustment",
    verifyToken,
    tenantMiddleware,
    requireDominicanFiscal({ issuance: true }),
    requireEcfAdjustmentPermission,
    issueEcfAdjustment
);
// El cierre posterior a facturar es independiente de la edición financiera y del e-CF.
router.post("/:id/close-and-vacate", verifyToken, tenantMiddleware,
    require("../controllers/closeAndVacateController").closeAndVacateOrder);

// Métricas reales independientes del límite y rango del listado de órdenes.
router.get("/summary/home", verifyToken, tenantMiddleware, async (req, res, next) => {
    try {
        const scope = req.clientId === "default"
            ? { $or: [ {clientId:"default"}, {clientId:{$exists:false}}, {clientId:null}, {clientId:""} ] }
            : { clientId: req.clientId };
        const base = { tenantId: req.tenantId, isDraft: {$ne: true}, "items.0": {$exists: true}, ...scope };
        const [activeOrdersCount,totalCompleted] = await Promise.all([
            Order.countDocuments({...base, orderStatus: {$in: ["En Progreso", "Listo", "Pendiente"]}}),
            Order.countDocuments({...base, orderStatus: {$in: ["Completado", "Completed"]}}),
        ]);
        res.set("Cache-Control", "no-store");
        res.json({success:true,data:{activeOrdersCount,totalCompleted}});
    } catch(err) { next(err); }
});

router.get(
    "/",
    verifyToken,
    tenantMiddleware,
    getOrders
);
router.post(
    "/:id/send-to-production",
    verifyToken,
    tenantMiddleware,
    sendOrderToProduction
);
// A resource must match the authenticated tenant AND selected branch.
const mongoose = require("mongoose");
function orderScopeQuery(req, id) {
    return {
        _id: id,
        tenantId: req.tenantId,
        ...(req.clientId === "default"
            ? { $or: [{ clientId: "default" }, { clientId: { $exists: false } }] }
            : { clientId: req.clientId }),
    };
}
function invoiceAccess(req, res, next) {
    if (!mongoose.isValidObjectId(req.params.orderId || req.params.id)) {
        return res.status(404).json({ message: "Order not found" });
    }
    next();
}
async function signedStoredInvoice(req, orderId, expiresIn, download = false) {
    const result = await signStoredInvoice({
        storage: supabase.storage,
        tenantId: req.tenantId,
        orderId,
        ttlSeconds: expiresIn,
        download,
    });
    return result?.url || null;
}
router.get("/:orderId/invoice", verifyToken, tenantMiddleware, invoiceAccess, async (req, res, next) => {
    try {
        const order = await Order.findOne(orderScopeQuery(req, req.params.orderId)).select("_id invoiceUrl invoicePath").lean();
        if (!order || (!order.invoicePath && !order.invoiceUrl)) return res.status(404).json({ success: false, message: "Invoice not found" });
        // ?download=1 produce un enlace firmado con Content-Disposition: attachment.
        // Nunca se recibe una ruta de archivo desde el navegador.
        const download = req.query.download === "1";
        const url = await signedStoredInvoice(req, order._id, download ? 120 : 600, download);
        if (!url) return res.status(404).json({ success: false, message: "Invoice not found" });
        res.set("Cache-Control", "no-store");
        res.json({ success: true, url });
    } catch (e) { next(e); }
});
router.get("/:id/invoice/download", verifyToken, tenantMiddleware, invoiceAccess, async (req, res, next) => {
    try {
        const order = await Order.findOne(orderScopeQuery(req, req.params.id)).select("_id invoiceUrl invoicePath").lean();
        if (!order || (!order.invoicePath && !order.invoiceUrl)) return res.status(404).json({ success: false, message: "Invoice not found" });
        const url = await signedStoredInvoice(req, order._id, 120, true);
        if (!url) return res.status(404).json({ success: false, message: "Invoice not found" });
        res.set("Cache-Control", "no-store");
        res.redirect(url);
    } catch (e) { next(e); }
});

/**
 * GET /api/order/:id
 */
/**
 * GET /api/order/ecf/status
 */
// Capabilities are read-only; they never override country/plan/branch controls.
router.get("/ecf/permissions", verifyToken, tenantMiddleware,
    requireDominicanFiscal({ branchRead: true }), async (req,res,next) => {
        try {
            const caps = getCapabilities(req);
            const {getSecondaryBranchStatus,assertSecondarySandboxIssue} = require("../services/ecf/ecfBranchAccess");
            const branch = await getSecondaryBranchStatus(req.scope);
            try { await assertSecondarySandboxIssue(req.scope); }
            catch (_error) { caps.issue = false; caps.credit = false; caps.debit = false; }
            res.set("Cache-Control","no-store");
            return res.json({success:true,data:{...caps,branch}});
        } catch(error) {next(error);}
    });

router.get(
    "/ecf/status",
    verifyToken,
    tenantMiddleware,
    requireDominicanFiscal({ branchRead: true }),
    getTenantEcfStatus
);

router.post(
    "/tax-preview",
    verifyToken,
    tenantMiddleware,
    previewOrderTaxes
);
/**
 * GET /api/order/:id/ecf
 */
router.get(
    "/:id/ecf",
    verifyToken,
    tenantMiddleware,
    requireDominicanFiscal({ branchRead: true }),
    getOrderEcfStatus
);

/**
 * GET /api/order/:id
 */
router.get(
    "/:id",
    verifyToken,
    tenantMiddleware,
    getOrderById
);

/**
 * POST /api/order
 */
router.post(
    "/",
    verifyToken,
    tenantMiddleware,
    requireAutomaticEcfPermission,
    addOrder
);

/**
 * PUT /api/order/:id
 */
async function protectIssuedElectronicOrder(req, res, next) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, code: "ORDER_NOT_FOUND" });
        const issued = await ElectronicTaxDocument.exists({ tenantId: req.tenantId, clientId: req.clientId, orderId: req.params.id });
        if (issued) return res.status(409).json({ success: false, code: "ECF_DOCUMENT_EXISTS" });
        next();
    } catch (error) { next(error); }
}
async function guardPaidOrderFinancialChanges(req,res,next){
    try{
        if(!mongoose.isValidObjectId(req.params.id))return res.status(404).json({success:false,code:"ORDER_NOT_FOUND"});
        const current=await Order.findOne(orderScopeQuery(req,req.params.id)).select("paymentStatus").lean();
        if(!current)return res.status(404).json({success:false,code:"ORDER_NOT_FOUND"});
        if(current.paymentStatus==="Pagado"&&["items","bills","paymentMethod","orderNote"].some(k=>Object.prototype.hasOwnProperty.call(req.body||{},k))){
            return res.status(409).json({success:false,code:"USE_AUDITED_ORDER_CORRECTION"});
        }
        next();
    }catch(error){next(error);}
}
router.put(
    "/:id",
    verifyToken,
    tenantMiddleware,
    protectIssuedElectronicOrder,
    guardPaidOrderFinancialChanges,
    requireAutomaticEcfPermission,
    updateOrder
);

/**
 * DELETE /api/order/:id
 */
router.delete(
    "/:id",
    verifyToken,
    tenantMiddleware,
    deleteOrder
);
// Correcciones financieras y de inventario: autorización estricta según membership activa.
// La opción de Empleados -> Corregir órdenes es individual, no heredada por todas las cajeras.
const Membership = require("../models/membershipModel");
async function correctionAccess(req) {
    if (req.user?.role === "SuperAdmin") return true;
    const membership = await Membership.findOne({
        tenantId: req.tenantId,
        user: req.user?._id,
        status: "active",
    }).select("role permissions.orders.edit clientIds").lean();
    if (!membership) return false;
    if (!["Owner", "Admin", "Cajera"].includes(membership.role)) return false;
    if (membership.role === "Cajera" && membership.permissions?.orders?.edit !== true) return false;
    if (membership.role === "Cajera" && Array.isArray(membership.clientIds) &&
        membership.clientIds.length > 0 && !membership.clientIds.includes(req.clientId)) return false;
    return true;
}
async function requireCorrectionAccess(req, res, next) {
    try {
        if (!(await correctionAccess(req))) return res.status(403).json({ success: false, code: "ORDER_CORRECTION_PERMISSION_DENIED" });
        return next();
    } catch (error) { return next(error); }
}
router.get("/correction/access", verifyToken, tenantMiddleware, async (req, res, next) => {
    try { res.set("Cache-Control", "no-store"); res.json({success:true,data:{canEdit:await correctionAccess(req)}}); }
    catch (error) { next(error); }
});
router.get("/correction/financial-adjustments", verifyToken, tenantMiddleware, async (req,res,next)=>{
    try {
      const membership = await Membership.findOne({tenantId:req.tenantId,user:req.user?._id,status:"active"}).select("role").lean();
      if(req.user?.role!=="SuperAdmin" && !["Owner","Admin"].includes(membership?.role)) return res.status(403).json({success:false,code:"PERMISSION_DENIED"});
      return listFinancialCorrections(req,res,next);
    }catch(error){next(error);}
});
// La ruta global se declara ANTES de /:id para no confundirse con un ID de orden.
router.get("/correction/history", verifyToken, tenantMiddleware, requireCorrectionAccess,
    require("../controllers/orderCorrectionController").listOrderCorrectionHistory);
router.get("/correction/catalog", verifyToken, tenantMiddleware, requireCorrectionAccess, getCorrectionCatalog);
router.get("/:id/correction/history", verifyToken, tenantMiddleware, requireCorrectionAccess,
    require("../controllers/orderCorrectionController").getOrderCorrectionHistory);
router.post("/:id/correction/preview", verifyToken, tenantMiddleware, requireCorrectionAccess, previewNormalOrderCorrection);
router.patch("/:id/correction", verifyToken, tenantMiddleware, requireCorrectionAccess, correctNormalOrder);
// Compatibilidad con Bill.jsx: admite cambios ANTES del cobro.
// Los pagos ya confirmados deben corregirse mediante la ruta auditada.
async function guardLegacyPaymentMethod(req, res, next) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, code: "ORDER_NOT_FOUND" });
        const order = await Order.findOne(orderScopeQuery(req, req.params.id)).lean();
        if (!order) return res.status(404).json({ success: false, code: "ORDER_NOT_FOUND" });
        if (fiscalLocked(order) || order.paymentMethod === "Credito" || order.accountReceivableId) {
            return res.status(409).json({ success: false, code: "FISCAL_OR_CREDIT_ORDER_LOCKED" });
        }
        const ecf = await ElectronicTaxDocument.exists({ tenantId: req.tenantId, clientId: req.clientId, orderId: order._id });
        if (ecf) return res.status(409).json({ success: false, code: "ECF_DOCUMENT_EXISTS" });
        if (order.paymentStatus === "Pagado" || order.orderStatus === "Cancelado") {
            return res.status(409).json({ success: false, code: "ORDER_REQUIRES_ADMIN_CORRECTION" });
        }
        next();
    } catch (error) { next(error); }
}
router.patch("/:id/payment-method", verifyToken, tenantMiddleware, guardLegacyPaymentMethod, updatePaymentMethod);



module.exports = router;
