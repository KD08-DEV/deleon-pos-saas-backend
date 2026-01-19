// pos-backend/config/planTiers.js

const TIERS = {
    emprendedor: {
        limits: {
            maxUsers: 3,
            maxAdmins: 1,
            maxCashiers: 1,
            maxWaiters: 1,
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

    premium: {
        limits: {
            maxUsers: 6,      // 1 admins + 1 cashiers + 4 waiters
            maxAdmins: 1,
            maxCashiers: 1,
            maxWaiters: 4,
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
            maxUsers: 15,      // 3 admins + 3 cashiers + 9 waiters
            maxAdmins: 3,
            maxCashiers: 3,
            maxWaiters: 9,
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
