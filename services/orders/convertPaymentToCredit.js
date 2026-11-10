const AccountReceivable = require('../../models/accountReceivableModel');
const Customer = require('../../models/customerModel');
const CashSession = require('../../models/cashSessionModel');
const {canCreateCreditSale} = require('./creditSaleAccess');
const {bad, money} = require('./orderCorrectionCalculator');

// The order update, receivable and cash audit share one transaction.
module.exports = async function convertPaymentToCredit({req,order,tenant,session,correctionCode}) {
    if (!await canCreateCreditSale(req,tenant)) throw bad('CREDIT_SETTLEMENT_PERMISSION_DENIED',403);
    if (req.body.creditConversionConfirmed !== true) throw bad('CREDIT_CONVERSION_CONFIRMATION_REQUIRED',409);
    if (!order.customerId) throw bad('CUSTOMER_REQUIRED_FOR_CREDIT_SALE',409);
    const customer = await Customer.findOne({_id:order.customerId,tenantId:req.tenantId,clientId:req.clientId,isActive:{$ne:false}}).session(session);
    if (!customer) throw bad('CUSTOMER_REQUIRED_FOR_CREDIT_SALE',409);
    const existing = await AccountReceivable.findOne({tenantId:req.tenantId,clientId:req.clientId,orderId:order._id}).session(session);
    // Prior collections must be reversed explicitly; never erase their ledger.
    if (existing || order.accountReceivableId || order.settledFromCredit) throw bad('CREDIT_HISTORY_REQUIRES_REVIEW',409);
    const total = money(order.bills?.totalWithTax,'TOTAL');
    if (total <= 0) throw bad('INVALID_RECEIVABLE_AMOUNT',409);
    const registerId = String(order.registerId || 'MAIN').trim().toUpperCase();
    const now = new Date();
    let cashSession = null;
    if (order.paymentStatus === 'Pagado') {
        const original = order.cashSessionId ? {_id:order.cashSessionId} : {
            registerId, openedBy:order.paidBy || order.user,
            openedAt:{$lte:order.paidAt},
        };
        const canLocate = Boolean(order.cashSessionId || (order.paidAt && (order.paidBy || order.user)));
        cashSession = canLocate ? await CashSession.findOneAndUpdate({tenantId:req.tenantId,clientId:req.clientId,...original,status:'OPEN',closedAt:null},
            {$push:{movements:{type:'PAYMENT_CORRECTION',amount:0,by:req.user._id,at:now,note:`Venta ${order._id} reclasificada a crédito: ${total} (${correctionCode})`}}},
            {new:true,session,sort:{openedAt:-1}}) : null;
        if (!cashSession && order.cashSessionId) cashSession = await CashSession.findOne({_id:order.cashSessionId,tenantId:req.tenantId,clientId:req.clientId}).session(session);
    }
    const [receivable] = await AccountReceivable.create([{
        tenantId:req.tenantId,clientId:req.clientId,customerId:customer._id,orderId:order._id,registerId,
        invoiceNumber:order.invoiceNumber || order.facturaNo || '',facturaNo:order.facturaNo || order.invoiceNumber || '',
        customerSnapshot:{name:customer.name || order.customerDetails?.name || '',phone:customer.phone || '',address:customer.address || '',rnc:order.customerDetails?.rnc || '',rncCedula:order.customerDetails?.rncCedula || ''},
        originalAmount:total,paidAmount:0,balance:total,status:'pending',createdBy:req.user._id,
    }],{session});
    return {cashSession,patch:{accountReceivableId:receivable._id,creditStatus:'pending',paymentStatus:'Pendiente',paidAt:null,paidBy:null,settledFromCredit:false},
        settlement:{direction:'reclassified_to_credit',amount:total,confirmed:true,reference:correctionCode,receivableId:receivable._id,previousPaidAt:order.paidAt || null,previousPaidBy:order.paidBy || null}};
};
