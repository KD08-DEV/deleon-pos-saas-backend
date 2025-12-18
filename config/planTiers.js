// pos-backend/config/planTiers.js

const TIERS = {
    emprendedor: {
        limits: {
            maxUsers: 3,
            maxAdmins: 1,
            maxCashiers: 1,
            maxWaiters: 2,
            maxDishes: 15,
            maxTables: 8,
            maxClients: 1,
        },
        features: {
            multiClient: false,
            advancedReports: false,
            offlineMode: false,
        },
    },

    pro: {
        limits: {
            maxUsers: 10,      // 2 admins + 3 cashiers + 5 waiters
            maxAdmins: 3,
            maxCashiers: 3,
            maxWaiters: 5,
            maxDishes: 28,
            maxTables: 25,
            maxClients: 2,
        },
        features: {
            multiClient: true,
            advancedReports: true,
            offlineMode: false,
        },
    },

    vip: {
        limits: {
            maxUsers: 36,      // 5 admins + 8 cashiers + 12 waiters
            maxAdmins: 8,
            maxCashiers: 12,
            maxWaiters: 16,
            maxDishes: null,   // null = ilimitado
            maxTables: null,
            maxClients: null,
        },
        features: {
            multiClient: true,
            advancedReports: true,
            offlineMode: true,
        },
    },
};

module.exports = TIERS;
