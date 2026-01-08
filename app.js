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


// ❌ ELIMINAR ESTO (ROMPE TODO): import orderRoute from "./routes/orderRoute.js";

const orderRoute = require("./routes/orderRoute"); // ✅ CommonJS correcto

const PORT = config.port;
connectDB();

// Middlewares
app.use(cors({
    origin: [
        "http://localhost:5173",
        "http://localhost:5174",
        "https://deleon-pos-saas-frontend.vercel.app"
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
        "Content-Type",
        "Authorization",
        "x-client-id",
        "x-tenant-id"
    ]
}));

app.options("*", cors());
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
app.listen(PORT, () => {
    console.log(`☑️ POS Server is listening on port ${PORT}`);
});
