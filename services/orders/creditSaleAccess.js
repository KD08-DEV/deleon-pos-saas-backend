const {hasPermission}=require('../../middlewares/requirePermission');
const {normalizePlan,getPlanFeatures}=require('../../middlewares/requirePlan');
async function canCreateCreditSale(req,tenant){
 return Boolean(getPlanFeatures(normalizePlan(tenant?.plan)).accountsReceivable) &&
     await hasPermission(req,'accountsReceivable.view');
}
module.exports={canCreateCreditSale};
