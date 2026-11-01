const DEFAULT_LOCALIZATION = {
    locale: "es-DO",
    currency: "DOP",
    timezone:
        "America/Santo_Domingo",
    dateFormat:
        "DD/MM/YYYY",
    timeFormat:
        "12h",
};

function getTenantLocalization(
    tenant = {}
) {
    const raw =
        tenant?.localization ||
        {};

    return {
        locale:
            raw.locale ||
            DEFAULT_LOCALIZATION.locale,

        currency:
            raw.currency ||
            DEFAULT_LOCALIZATION.currency,

        timezone:
            raw.timezone ||
            DEFAULT_LOCALIZATION.timezone,

        dateFormat:
            raw.dateFormat ||
            DEFAULT_LOCALIZATION.dateFormat,

        timeFormat:
            raw.timeFormat ||
            DEFAULT_LOCALIZATION.timeFormat,
    };
}

function normalizeDate(
    value
) {
    if (!value) {
        return null;
    }

    const date =
        value instanceof Date
            ? value
            : new Date(value);

    return Number.isNaN(
        date.getTime()
    )
        ? null
        : date;
}

function getDateParts(
    value,
    localization = {}
) {
    const date =
        normalizeDate(value);

    if (!date) {
        return null;
    }

    try {
        const parts =
            new Intl.DateTimeFormat(
                "en-US",
                {
                    timeZone:
                        localization.timezone ||
                        DEFAULT_LOCALIZATION.timezone,

                    year:
                        "numeric",

                    month:
                        "2-digit",

                    day:
                        "2-digit",
                }
            ).formatToParts(
                date
            );

        const get =
            (type) =>
                parts.find(
                    (part) =>
                        part.type ===
                        type
                )?.value || "";

        return {
            year:
                get("year"),

            month:
                get("month"),

            day:
                get("day"),
        };
    } catch {
        return null;
    }
}

function formatDate(
    value,
    localization = {}
) {
    const parts =
        getDateParts(
            value,
            localization
        );

    if (!parts) {
        return "";
    }

    const {
        year,
        month,
        day,
    } = parts;

    switch (
        localization.dateFormat
        ) {
        case "MM/DD/YYYY":
            return `${month}/${day}/${year}`;

        case "YYYY-MM-DD":
            return `${year}-${month}-${day}`;

        default:
            return `${day}/${month}/${year}`;
    }
}

function formatTime(
    value,
    localization = {}
) {
    const date =
        normalizeDate(value);

    if (!date) {
        return "";
    }

    try {
        return new Intl.DateTimeFormat(
            localization.locale ||
            DEFAULT_LOCALIZATION.locale,
            {
                timeZone:
                    localization.timezone ||
                    DEFAULT_LOCALIZATION.timezone,

                hour:
                    "2-digit",

                minute:
                    "2-digit",

                second:
                    "2-digit",

                hour12:
                    localization.timeFormat !==
                    "24h",
            }
        ).format(
            date
        );
    } catch {
        return "";
    }
}

function formatDateTime(
    value,
    localization = {}
) {
    const date =
        formatDate(
            value,
            localization
        );

    const time =
        formatTime(
            value,
            localization
        );

    if (
        !date &&
        !time
    ) {
        return "";
    }

    return [
        date,
        time,
    ]
        .filter(Boolean)
        .join(" ");
}

function formatMoney(
    value,
    localization = {}
) {
    const number =
        Number(value);

    const amount =
        Number.isFinite(number)
            ? number
            : 0;

    try {
        return new Intl.NumberFormat(
            localization.locale ||
            DEFAULT_LOCALIZATION.locale,
            {
                style:
                    "currency",

                currency:
                    localization.currency ||
                    DEFAULT_LOCALIZATION.currency,
            }
        ).format(
            amount
        );
    } catch {
        return `${
            localization.currency ||
            DEFAULT_LOCALIZATION.currency
        } ${amount.toFixed(2)}`;
    }
}

module.exports = {
    DEFAULT_LOCALIZATION,
    getTenantLocalization,
    formatDate,
    formatTime,
    formatDateTime,
    formatMoney,
};