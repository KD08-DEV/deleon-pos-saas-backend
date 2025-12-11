module.exports = function requireRole(...allowed) {
    return (req, res, next) => {
        // SUPERADMIN siempre permitido
        if (req.user?.role === "SuperAdmin") return next();

        // rol primario viene del JWT
        const primaryRole = req.user?.role;

        // si existe scope membership (solo usado en clientes), lo usa
        const scopedRole = req.scope?.membership?.role;

        const role = scopedRole || primaryRole;

        if (!role || !allowed.includes(role)) {
            return res.status(403).json({ message: "Insufficient role" });
        }

        next();
    };
};
