const express = require("express");
const { register, login, getUserData, logout } = require("../controllers/userController");
const verifyToken = require("../middlewares/tokenVerification");
const requireScope = require("../middlewares/scope");
const requireRole  = require("../middlewares/requireRole");

const router = express.Router();

// Auth
router.post("/login", login);
router.post("/logout", verifyToken , logout);
router.get("/", verifyToken , getUserData);

// Solo Owner/Admin pueden registrar empleados del tenant
router.post("/register",
    verifyToken ,
    requireScope({ level: "tenant" }),
    requireRole("Owner","Admin"),
    register
);
router.post("/register", verifyToken, register);

module.exports = router;
