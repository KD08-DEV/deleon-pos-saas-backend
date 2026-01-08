const router = require("express").Router();
const { lookupRncLocal, autocompleteLocal } = require("../controllers/dgiiController");

// GET /api/dgii/rnc/:rnc
router.get("/rnc/:rnc", lookupRncLocal);

// GET /api/dgii/autocomplete?q=...
router.get("/autocomplete", autocompleteLocal);

module.exports = router;
