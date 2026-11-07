const httpError = require('http-errors');
const id = value => String(value?._id || value || '');

// Removal applies only to the base recipe, never to separately selected extras.
function customizedRecipe(dish, line) {
    const recipe = Array.isArray(dish.recipe) ? dish.recipe : [];
    const removed = new Set();
    for (const selected of line?.modifiers || []) {
        if (selected.type !== 'remove') continue;
        const definition = (dish.customization?.removableIngredients || []).find(option =>
            option.active !== false && (selected.modifierId
                ? id(option._id) === id(selected.modifierId)
                : selected.ingredientDishId && id(option.ingredientDishId) === id(selected.ingredientDishId)));
        if (!definition) throw httpError(409, 'REMOVAL_NOT_DEFINED_FOR_DISH');
        const ref = id(definition.ingredientDishId);
        if (!ref) continue; // Legacy text-only kitchen instruction has no stock effect.
        if (selected.ingredientDishId && id(selected.ingredientDishId) !== ref) throw httpError(409, 'INVALID_REMOVAL_REFERENCE');
        if (!recipe.some(ing => id(ing.ingredientDishId || ing.dishId || ing.inventoryItemId) === ref)) throw httpError(409, 'REMOVAL_NOT_IN_BASE_RECIPE');
        removed.add(ref);
    }
    return recipe.filter(ing => !removed.has(id(ing.ingredientDishId || ing.dishId || ing.inventoryItemId)));
}
module.exports = { customizedRecipe };
