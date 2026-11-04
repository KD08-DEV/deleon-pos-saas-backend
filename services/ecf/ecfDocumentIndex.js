"use strict";
/**
 * Instala/verifica índices Mongoose ANTES de reclamar una emisión o reservar e-NCF.
 * Es necesario cuando Mongo/Mongoose ejecuta con autoIndex=false.
 * El índice parcial solo afecta documentos nuevos con environment capturado.
 * Si MongoDB falla, NO se emite ningún e-CF sin esta garantía.
 */
const perModel = new WeakMap();
async function ensureEcfDocumentIndex(Model) {
  if (!Model || typeof Model.createIndexes !== "function") return; // dobles en pruebas unitarias
  let task = perModel.get(Model);
  if (!task) {
    task = Promise.resolve().then(() => Model.createIndexes()).catch(error => {
      perModel.delete(Model); // permitir reintento tras reparar la incidencia
      throw Object.assign(new Error("ECF_UNIQUE_INDEX_NOT_READY"), {statusCode:503, cause:error});
    });
    perModel.set(Model, task);
  }
  await task;
}
module.exports = { ensureEcfDocumentIndex };
