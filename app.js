const express = require("express");
const connectDB = require("./config/database");
const config = require("./config/config");
const globalErrorHandler = require("./middlewares/globalErrorHandler");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const app = express();
const dishRoutes  = require("./routes/dishRoute");
const path = require("path");
const dgiiRoute = require("./routes/dgiiRoute");
const http = require("http");
const { Server } = require("socket.io");
const server = http.createServer(app);


// ❌ ELIMINAR ESTO (ROMPE TODO): import orderRoute from "./routes/orderRoute.js";


const orderRoute = require("./routes/orderRoute"); // ✅ CommonJS correcto

const PORT = config.port;
connectDB();
const allowedOrigins = (process.env.CORS_ORIGIN || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        credentials: true,
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    },
});

// 🔹 Guardar io para usarlo en controllers sin circular imports
app.set("io", io);

// 🔹 Auth/tenant room
io.on("connection", (socket) => {


    // 1) Recibe tenantId desde el cliente (handshake)
    const tenantId =
        socket.handshake.auth?.tenantId ||
        socket.handshake.headers["x-tenant-id"];



    if (!tenantId) {

        socket.disconnect(true);
        return;
    }

    // 2) Room por tenant
    const room = `tenant:${tenantId}`;
    socket.join(room);


    // ✅ Forward: cuando un cliente emite, el server lo rebroadcastea al tenant
    // (Así funciona "al instante" sin navegar/refresh)
    socket.on("tenant:tablesUpdated", (payload = {}) => {
        io.to(room).emit("tenant:tablesUpdated", { tenantId, ...payload });
    });

    socket.on("tenant:orderUpdated", (payload = {}) => {
        io.to(room).emit("tenant:orderUpdated", { tenantId, ...payload });
    });

    // (Opcional) fiscal config también, si algún cliente lo emite
    socket.on("tenant:configUpdated", (payload = {}) => {
        io.to(room).emit("tenant:configUpdated", { tenantId, ...payload });
    });

    socket.on("disconnect", () => {
        // opcional log
    });
});

// Middlewares
app.use(cors({
    origin: (origin, cb) => {
        // Permite requests sin Origin (Postman, server-to-server)
        if (!origin) return cb(null, true);

        // Permite solo lo que está en allowedOrigins
        if (allowedOrigins.includes(origin)) return cb(null, true);

        return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-client-id", "x-tenant-id"],
}));

app.options("*", cors({
    origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (allowedOrigins.includes(origin)) return cb(null, true);
        return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
}));

app.use(express.json());
app.use(cookieParser());

// Root Endpoint
app.get("/", (req, res) => {
    res.json({ message: "Hello from POS Server!" });
});

app.get("/health", (req, res) => {
    res.status(200).send("OK");
});
// Routes
app.use("/api/user", require("./routes/userRoute"));
app.use("/api/order", orderRoute); // ⬅️ SOLO ESTA (NO DUPLICADA)
app.use("/api/table", require("./routes/tableRoute"));
app.use("/api/payment", require("./routes/paymentRoute"));
app.use("/api/admin", require("./routes/adminRoute"));
app.use("/api/dishes", dishRoutes);
app.use("/api/clients", require("./routes/clientRoute"));
app.use("/api/superadmin", require("./routes/superAdminRoute"));
app.use("/api/tenant", require("./routes/tenantRoute"));
app.use("/api/invoice", require("./routes/invoiceRoute"));
app.use("/api/dgii", dgiiRoute);
app.use("/api/inventory", require("./routes/inventoryRoute"));
// Global Error Handler
app.use(globalErrorHandler);

// Server
server.listen(PORT, () => {
    console.log(`☑️ POS Server is listening on port ${PORT}`);
});
