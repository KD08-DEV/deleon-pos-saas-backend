/**
 * Importador streaming del TXT oficial DGII_RNC.TXT, descargado de dgii.gov.do.
 * Uso: node scripts/importRncRegistry.js "ruta/a/DGII_RNC.TXT"
 * No elimina datos históricos y no imprime nombres ni números de contribuyentes.
 * La fuente DGII_RNC.TXT es pipe-separated (|), SIN encabezado, con 11 columnas:
 *   0 = RNC o cédula, 1 = razón social, 3 = actividad, 8 = fecha alta,
 *   9 = estado, 10 = régimen. El anterior importador confundía esos índices.
 */
"use strict";
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const mongoose = require("mongoose");
const iconv = require("iconv-lite");
const RncRegistry = require("../models/rncRegistryModel");

const clean = (v) => String(v ?? "").trim().replace(/\s+/g, " ");
function parseDgiiLine(line, timestamp) {
    const cols = line.split("|");
    if (cols.length !== 11) return null;
    const rnc = clean(cols[0]).replace(/\D/g, "");
    if (!/^\d{9}(?:\d{2})?$/.test(rnc)) return null;
    const nombre = clean(cols[1]);
    if (!nombre) return null;
    return { rnc, nombre, actividad_economica: clean(cols[3]),
        estatus: clean(cols[9]), regimen: clean(cols[10]),
        source: "DGII_TXT", sourceUpdatedAt: timestamp };
}

async function main() {
    const txt = process.argv[2] ? path.resolve(process.argv[2])
        : path.join(__dirname, "..", "data", "dgii", "rnc_registry.txt");
    if (path.extname(txt).toLowerCase() !== ".txt") {
        throw new Error("Extrae DGII_RNC.TXT del ZIP. No pases el archivo ZIP directamente.");
    }
    if (!fs.existsSync(txt)) throw new Error("Archivo TXT no encontrado: " + txt);
    const mongo = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongo) throw new Error("Configura MONGO_URI o MONGODB_URI en el servidor.");
    const timestamp = new Date();
    let parsed = 0, skipped = 0, created = 0, updated = 0, batch = [];
    await mongoose.connect(mongo);
    try {
        const flush = async () => {
            if (!batch.length) return;
            const result = await RncRegistry.bulkWrite(batch, { ordered: false });
            created += result.upsertedCount || 0;
            updated += result.modifiedCount || 0;
            batch = [];
        };
        const input = fs.createReadStream(txt).pipe(iconv.decodeStream("win1252"));
        const lines = readline.createInterface({ input, crlfDelay: Infinity });
        for await (const raw of lines) {
            const doc = parseDgiiLine(raw.replace(/^\uFEFF/, ""), timestamp);
            if (!doc) { skipped++; continue; }
            parsed++;
            batch.push({updateOne:{filter:{rnc:doc.rnc}, update:{$set:doc}, upsert:true}});
            if (batch.length >= 1500) await flush();
        }
        // Si el archivo estuviera dañado o con delimitador diferente, no declarar éxito.
        if (parsed < 100 || skipped > parsed / 4) {
            throw new Error(`Archivo no parece padrón oficial válido: válidas=${parsed} inválidas=${skipped}`);
        }
        await flush();
        console.log(`DGII importación terminada. Válidas=${parsed}, inválidas=${skipped}, nuevas=${created}, actualizadas=${updated}, fecha=${timestamp.toISOString()}`);
        console.log("No se eliminan RNC anteriores automáticamente. Revisa fuente y fecha antes de purgar datos antiguos.");
    } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(e => {console.error("Error importando padrón:", e.message);process.exitCode = 1;});
module.exports = { parseDgiiLine };
