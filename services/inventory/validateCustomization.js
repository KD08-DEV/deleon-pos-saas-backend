const Dish = require('../../models/dish');
const httpError = require('http-errors');
const ref = value => String(value?._id || value || '');
async function validateCustomization(customization, { tenantId, clientId, dishId }) {
    const options = [...(customization?.extras || []).map(x=>({id:ref(x.extraDishId),removal:false})),
        ...(customization?.removableIngredients || []).map(x=>({id:ref(x.ingredientDishId),removal:true}))].filter(x=>x.id);
    if (!options.length) return;
    const branch = clientId === 'default' ? {$or:[{clientId:'default'},{clientId:{$exists:false}},{clientId:null}]} : {clientId};
    const rows = await Dish.find({tenantId,...branch,_id:{$in:options.map(x=>x.id)},isArchived:{$ne:true}}).select('_id inventoryType isInventoryItem').lean();
    for (const option of options) {
        const item=rows.find(row=>ref(row._id)===option.id);
        if (!item || option.id===ref(dishId)) throw httpError(409,'CUSTOMIZATION_REFERENCE_NOT_AVAILABLE');
        if (option.removal && !['direct','ingredient'].includes(item.inventoryType) && !item.isInventoryItem) throw httpError(409,'REMOVAL_REQUIRES_STOCK_ITEM');
    }
}
module.exports={validateCustomization};
