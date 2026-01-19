require("dotenv").config();

const config = Object.freeze({
    port: process.env.PORT || 8000,
    databaseURI: process.env.MONGODB_URI || "mongodb://localhost:27017/pos-db",
    nodeEnv: process.env.NODE_ENV || "development",

    // JWT
    accessTokenSecret: process.env.JWT_SECRET,

    // RAZORPAY
    razorpayKeyId: process.env.RAZORPAY_KEY_ID,
    razorpaySecretKey: process.env.RAZORPAY_KEY_SECRET,
    razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,

    // CORS
    corsOrigin: process.env.CORS_ORIGIN
});

module.exports = config;
