// Analytical allocation by the original item subtotal, before category filters.
// Cumulative cents keep the sum equal to the order charge without duplicating tips.
const serviceChargeAmount={
 $cond:[{$gt:[{$size:{$ifNull:['$bills.serviceChargeBreakdown',[]]}},0]},
  {$sum:{$map:{input:{$filter:{input:'$bills.serviceChargeBreakdown',as:'charge',cond:{$ne:['$$charge.addToTotal',false]}}},as:'charge',in:{$ifNull:['$$charge.amount',0]}}}},
  {$ifNull:['$bills.serviceChargeTotal',{$ifNull:['$bills.legalTip',{$ifNull:['$bills.propinaLegal',0]}]}]}
 ]
};
const manualTipAmount={$ifNull:['$bills.tipAmount',{$ifNull:['$bills.tip',0]}]};
function allocateCents(amount){
 const before={$sum:{$slice:['$_itemPrices','$_itemIndex']}};
 const after={$add:[before,{$ifNull:['$items.price',0]}]};
 const cumulative=base=>({$round:[{$multiply:[amount,100,{$divide:[base,'$_orderItemsSubtotal']}]},0]});
 return {$cond:[{$gt:['$_orderItemsSubtotal',0]},{$divide:[{$subtract:[cumulative(after),cumulative(before)]},100]},0]};
}
module.exports={serviceChargeAmount,manualTipAmount,allocateCents};
