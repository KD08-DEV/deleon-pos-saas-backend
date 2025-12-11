const mongoose = require("mongoose");
const config = require("./config");

const connectDB = async () => {
    try {
        const conn = await mongoose.connect(config.databaseURI, {
            serverSelectionTimeoutMS: 5000, // Recomendado para Render + Atlas
        });

        console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
        console.log("📡 Connected to MongoDB Atlas successfully");

    } catch (error) {
        console.log(`❌ Database connection failed: ${error.message}`);
        process.exit(1); // usa código 1 para errores
    }
};

module.exports = connectDB;
