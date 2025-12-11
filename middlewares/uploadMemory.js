const multer = require("multer");

// Guardar archivo en memoria (buffer)
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
    const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"];
    allowed.includes(file.mimetype)
        ? cb(null, true)
        : cb(new Error("Only image files (jpg, png, webp, gif) allowed!"));
};

module.exports = multer({
    storage,
    fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});
