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
const customerRoute = require("./routes/customerRoute");
const printerRoute = require("./routes/printerRoute");



// ❌ ELIMINAR ESTO (ROMPE TODO): import orderRoute from "./routes/orderRoute.js";


const orderRoute = require("./routes/orderRoute"); // ✅ CommonJS correcto

const PORT = process.env.PORT || config.port || 8000;

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

// Authenticated realtime rooms. Client-provided tenantId is never trusted.
const jwt = require("jsonwebtoken");
const User = require("./models/userModel");
const Membership = require("./models/membershipModel");
const Tenant = require("./models/tenantModel");
io.use(async (socket, next) => {
    try {
        const token = socket.handshake.auth?.token;
        if (!token || !config.accessTokenSecret) return next(new Error("AUTH_REQUIRED"));
        const decoded = jwt.verify(token, config.accessTokenSecret);
        if (decoded.super || !decoded._id || !decoded.sid) return next(new Error("AUTH_REQUIRED"));
        const user = await User.findById(decoded._id).select("tenantId activeSessionId").lean();
        if (!user || !user.activeSessionId || user.activeSessionId !== decoded.sid) {
            return next(new Error("SESSION_EXPIRED"));
        }
        if (decoded.tenantId && String(decoded.tenantId) !== String(user.tenantId)) {
            return next(new Error("SESSION_TENANT_MISMATCH"));
        }
        const [tenant, membership] = await Promise.all([
            Tenant.findOne({ tenantId: user.tenantId, status: "active" }).select("tenantId").lean(),
            Membership.findOne({ tenantId: user.tenantId, user: user._id, status: "active" }).lean(),
        ]);
        if (!tenant || !membership) return next(new Error("ACCESS_DENIED"));
        const clientId = String(socket.handshake.auth?.clientId || "default");
        const adminLike = ["Owner", "Admin"].includes(membership.role);
        const allowedIds = (membership.clientIds || []).map(String);
        if (!adminLike && !(clientId === "default" && !allowedIds.length) && !allowedIds.includes(clientId)) {
            return next(new Error("BRANCH_DENIED"));
        }
        if (clientId !== "default") {
            const Client = require("./models/clientModel");
            if (!await Client.exists({ tenantId: user.tenantId, clientId, isActive: true })) {
                return next(new Error("BRANCH_DENIED"));
            }
        }
        socket.data.tenantId = user.tenantId;
        socket.data.clientId = clientId;
        socket.data.userId = String(user._id);
        socket.data.sid = decoded.sid;
        socket.data.expiresAt = Number(decoded.exp || 0);
        socket.data.memberRole = String(membership.role);
        socket.data.memberBranches = JSON.stringify(allowedIds.slice().sort());
        return next();
    } catch (error) { return next(new Error("INVALID_TOKEN")); }
});
io.on("connection", (socket) => {
    const { tenantId, clientId } = socket.data;
    socket.join(`tenant:${tenantId}`); // Existing controller server-side events remain supported.
    socket.join(`tenant:${tenantId}:branch:${clientId}`);
    socket.join(`tenant:${tenantId}:user:${socket.data.userId}`);

    // Revalidacion de sesiones persistentes.
    // Una revocacion externa se detecta en el siguiente ciclo.
    const SOCKET_REVALIDATE_MS = 15000;
    let revalidating = false;

    const revalidateSocket = async () => {
        if (!socket.connected || revalidating) return;
        revalidating = true;

        try {
            if (socket.data.expiresAt &&
                Date.now() >= socket.data.expiresAt * 1000) {
                socket.disconnect(true);
                return;
            }

            const [currentUser, currentTenant, currentMember] =
                await Promise.all([
                    User.findById(socket.data.userId)
                        .select("tenantId activeSessionId").lean(),
                    Tenant.findOne({
                        tenantId,
                        status: "active"
                    }).select("tenantId").lean(),
                    Membership.findOne({
                        tenantId,
                        user: socket.data.userId,
                        status: "active"
                    }).select("role clientIds").lean()
                ]);

            if (!currentUser || !currentTenant || !currentMember ||
                String(currentUser.tenantId) !== String(tenantId) ||
                currentUser.activeSessionId !== socket.data.sid ||
                String(currentMember.role) !== socket.data.memberRole) {
                socket.disconnect(true);
                return;
            }

            const currentBranches = (currentMember.clientIds || [])
                .map(String).sort();

            if (JSON.stringify(currentBranches) !==
                socket.data.memberBranches) {
                socket.disconnect(true);
                return;
            }

            const isAdmin = ["Owner", "Admin"]
                .includes(currentMember.role);

            if (!isAdmin &&
                !(clientId === "default" && currentBranches.length === 0) &&
                !currentBranches.includes(clientId)) {
                socket.disconnect(true);
                return;
            }

            if (clientId !== "default") {
                const Client = require("./models/clientModel");

                if (!await Client.exists({
                    tenantId, clientId, isActive: true
                })) {
                    socket.disconnect(true);
                }
            }
        } catch (error) {
            // Si falla la validacion, no conservar una
            // conexion cuyo acceso no puede verificarse.
            socket.disconnect(true);
        } finally {
            revalidating = false;
        }
    };

    const revalidateTimer = setInterval(
        () => { void revalidateSocket(); },
        SOCKET_REVALIDATE_MS
    );

    revalidateTimer.unref?.();

    socket.once("disconnect", () => {
        clearInterval(revalidateTimer);
    });
    // No client-supplied event payload is broadcast across other users/branches.
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
app.use("/api/customer", customerRoute);
app.use("/api/printers", printerRoute);// Global Error Handler
app.use(globalErrorHandler);

// Server
// Server bootstrap
(async () => {
    try {
        console.log("🚀 Starting POS backend...");
        console.log(`🌍 NODE_ENV: ${config.nodeEnv}`);
        console.log(`🔌 PORT: ${PORT}`);
        console.log("🗄️ Connecting to MongoDB...");

        await connectDB();

        console.log("✅ MongoDB ready. Starting HTTP server...");

        server.listen(PORT, "0.0.0.0", () => {
            console.log(`☑️ POS Server is listening on port ${PORT}`);
        });
    } catch (error) {
        console.error("❌ Failed to bootstrap app:", error);
        process.exit(1);
    }
})();
