const AccountReceivable = require('../../models/accountReceivableModel');
const CashSession = require('../../models/cashSessionModel');
const { canCreateCreditSale } = require('./creditSaleAccess');
const { bad, round } = require('./orderCorrectionCalculator');

// Runs inside the order correction transaction. Receivable payments are the
// only cash source for this sale, including payments made before settlement.
module.exports = async function settleCreditPayment({req, order, tenant, session, method, correctionCode}) {
    if (!await canCreateCreditSale(req, tenant)) throw bad('CREDIT_SETTLEMENT_PERMISSION_DENIED', 403);
    if (req.body.creditPaymentConfirmed !== true) throw bad('CREDIT_PAYMENT_CONFIRMATION_REQUIRED', 409);
    const doc = await AccountReceivable.findOne({tenantId:req.tenantId, clientId:req.clientId, orderId:order._id}).session(session);
    if (!doc || !['pending','partial'].includes(doc.status)) throw bad('CREDIT_BALANCE_NOT_OPEN', 409);
    const balance = round(Number(doc.balance));
    const paid = round(Number(doc.paidAmount));
    const paymentsTotal = (doc.payments || []).reduce((sum,p)=>sum+Number(p.amount),0);
    if (![balance,paid,Number(doc.originalAmount),Number(order.bills?.totalWithTax),paymentsTotal].every(Number.isFinite) || balance <= 0 || paid < 0 ||
        Math.abs(round(paid + balance) - Number(doc.originalAmount)) > 0.009 ||
        Math.abs(Number(doc.originalAmount) - Number(order.bills?.totalWithTax)) > 0.009 ||
        Math.abs(paymentsTotal-paid)>0.009)
        throw bad('CREDIT_BALANCE_REQUIRES_REVIEW',409);
    const registerId = String(req.body.registerId || order.registerId || 'MAIN').trim().toUpperCase();
    if (['ALL','__ALL_REGISTERS__'].includes(registerId)) throw bad('CREDIT_REGISTER_REQUIRED',409);
    const now = new Date();
    // Writing the open session makes a concurrent close conflict and retry.
    const cash = await CashSession.findOneAndUpdate({tenantId:req.tenantId,clientId:req.clientId,registerId,status:'OPEN',closedAt:null},
        {$push:{movements:{type:'PAYMENT_CORRECTION',amount:0,by:req.user._id,at:now,note:`Cobro saldo crédito ${order._id}: ${balance} ${method} (${correctionCode})`}}}, {new:true,session});
    // A collection without an open session is recorded for reconciliation.
    doc.payments.push({amount:balance,method,registerId,cashSessionId:cash?._id || null,paidAt:now,receivedBy:req.user._id,note:`Cambio de método al facturar (${correctionCode})`});
    doc.paidAmount = round(paid + balance);
    doc.balance = 0;
    doc.status = 'paid';
    doc.closedAt = now;
    await doc.save({session});
    return {cashSession:cash,patch:{settledFromCredit:true,accountReceivableId:doc._id,creditStatus:'paid',paymentStatus:'Pagado',paidAt:now,paidBy:req.user._id},
        settlement:{direction:'collected',amount:balance,confirmed:true,reference:correctionCode,previouslyPaid:paid,receivableId:doc._id,cashSessionId:cash?._id || null,registerId}};
};
