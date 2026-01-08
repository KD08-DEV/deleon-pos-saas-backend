/* eslint-disable no-console */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const RncRegistry = require("../models/rncRegistryModel");

const DEFAULT_FILE = path.join(__dirname, "..", "data", "dgii", "rnc_registry.txt");

// Detecta el delimitador más probable (|, tab, ;, ,)
function detectDelimiter(line) {
    const candidates = ["|", "\t", ";", ","];
    let best = { d: "|", score: -1 };

    for (const d of candidates) {
        const parts = line.split(d);
        if (parts.length > best.score) best = { d, score: parts.length };
    }
    return best.d;
}

// Limpieza mínima
function clean(v) {
    if (v == null) return "";
    return String(v).replace(/\s+/g, " ").trim();
}

// Asegura RNC solo dígitos
function normalizeRnc(v) {
    const digits = String(v || "").replace(/\D/g, "");
    return digits;
}

// Mapea columnas si el TXT trae encabezado (header) o si no trae.
// Si el TXT no tiene header, ajusta aquí según el orden real del archivo.
function parseLineToDoc(cols, headerMap) {
    // Si hay header detectado:
    if (headerMap) {
        const rnc = normalizeRnc(cols[headerMap.rnc]);
        if (!rnc) return null;

        return {
            rnc,
            nombre: clean(cols[headerMap.nombre]),
            categoria: clean(cols[headerMap.categoria]),
            regimen: clean(cols[headerMap.regimen]),
            estatus: clean(cols[headerMap.estatus]),
            actividad_economica: clean(cols[headerMap.actividad_economica]),
            provincia: clean(cols[headerMap.provincia]),
            municipio: clean(cols[headerMap.municipio]),
            sourceUpdatedAt: new Date(),
        };
    }

    // Si NO hay header, asumimos un orden común:
    // 0:rnc, 1:nombre, 2:categoria, 3:regimen, 4:estatus, 5:actividad, 6:provincia, 7:municipio
    const rnc = normalizeRnc(cols[0]);
    if (!rnc) return null;

    return {
        rnc,
        nombre: clean(cols[1]),
        categoria: clean(cols[2]),
        regimen: clean(cols[3]),
        estatus: clean(cols[4]),
        actividad_economica: clean(cols[5]),
        provincia: clean(cols[6]),
        municipio: clean(cols[7]),
        sourceUpdatedAt: new Date(),
    };
}

// Intenta construir un map de headers si la primera línea parece encabezado.
function buildHeaderMap(firstLineCols) {
    const headers = firstLineCols.map((h) => clean(h).toLowerCase());

    const idx = (names) => {
        for (const n of names) {
            const i = headers.findIndex((h) => h === n || h.includes(n));
            if (i >= 0) return i;
        }
        return -1;
    };

    const rncI = idx(["rnc", "cedula", "cédula", "documento"]);
    const nombreI = idx(["nombre", "razon", "razón social", "razon social"]);
    if (rncI === -1 || nombreI === -1) return null;

    return {
        rnc: rncI,
        nombre: nombreI,
        categoria: idx(["categoria"]),
        regimen: idx(["regimen", "régimen"]),
        estatus: idx(["estatus", "estado"]),
        actividad_economica: idx(["actividad", "actividad economica", "actividad económica"]),
        provincia: idx(["provincia"]),
        municipio: idx(["municipio"]),
    };
}

async function run() {
    const filePath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_FILE;

    if (!fs.existsSync(filePath)) {
        console.error("No se encontró el archivo:", filePath);
        process.exit(1);
    }

    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) {
        console.error("Falta MONGO_URI/MONGODB_URI en .env");
        process.exit(1);
    }

    await mongoose.connect(mongoUri);
    console.log("Mongo conectado");


    const iconv = require("iconv-lite");
    const buf = fs.readFileSync(filePath);
    const raw = iconv.decode(buf, "win1252"); // o "latin1" si el proveedor lo confirma
    const normalized = raw
        .replace(/\uFEFF/g, "") // BOM
        .replace(/\r\n/g, "\n")
        .trim();

    const lines = normalized.split("\n").filter((l) => l.trim().length);


    if (!lines.length) {
        console.log("Archivo vacío");
        process.exit(0);
    }

    const delimiter = detectDelimiter(lines[0]);
    console.log("Delimitador detectado:", JSON.stringify(delimiter));

    const firstCols = lines[0].split(delimiter);
    const headerMap = buildHeaderMap(firstCols);

    let startIndex = 0;
    if (headerMap) {
        console.log("Header detectado. Se omite la primera línea.");
        startIndex = 1;
    } else {
        console.log("No se detectó header. Se asume orden fijo de columnas.");
    }

    const batchSize = 2000;
    let ops = [];
    let processed = 0;
    let upserted = 0;

    for (let i = startIndex; i < lines.length; i++) {
        const cols = lines[i].split(delimiter);
        const doc = parseLineToDoc(cols, headerMap);

        if (!doc || !doc.rnc) continue;

        ops.push({
            updateOne: {
                filter: { rnc: doc.rnc },
                update: { $set: doc },
                upsert: true,
            },
        });

        if (ops.length >= batchSize) {
            const res = await RncRegistry.bulkWrite(ops, { ordered: false });
            processed += ops.length;
            upserted += (res.upsertedCount || 0);
            console.log(`Procesados: ${processed}, Upserts nuevos: ${upserted}`);
            ops = [];
        }
    }

    if (ops.length) {
        const res = await RncRegistry.bulkWrite(ops, { ordered: false });
        processed += ops.length;
        upserted += (res.upsertedCount || 0);
        console.log(`Procesados: ${processed}, Upserts nuevos: ${upserted}`);
    }

    console.log("Import finalizado.");
    await mongoose.disconnect();
}

run().catch((err) => {
    console.error("Error importando:", err);
    process.exit(1);
});
