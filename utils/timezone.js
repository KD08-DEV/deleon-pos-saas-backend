const DEFAULT_TIMEZONE =
    "America/Santo_Domingo";

function normalizeTimeZone(
    value
) {
    const timezone =
        String(
            value ||
            DEFAULT_TIMEZONE
        ).trim() ||
        DEFAULT_TIMEZONE;

    try {
        new Intl.DateTimeFormat(
            "en-US",
            {
                timeZone:
                timezone,
            }
        ).format(
            new Date()
        );

        return timezone;
    } catch {
        return DEFAULT_TIMEZONE;
    }
}

function normalizeYMD(
    value
) {
    const match =
        String(value || "")
            .trim()
            .match(
                /^(\d{4})-(\d{2})-(\d{2})/
            );

    if (!match) {
        return null;
    }

    const year =
        Number(match[1]);

    const month =
        Number(match[2]);

    const day =
        Number(match[3]);

    const probe =
        new Date(
            Date.UTC(
                year,
                month - 1,
                day
            )
        );

    if (
        probe.getUTCFullYear() !==
        year ||
        probe.getUTCMonth() !==
        month - 1 ||
        probe.getUTCDate() !==
        day
    ) {
        return null;
    }

    return `${String(
        year
    ).padStart(
        4,
        "0"
    )}-${String(
        month
    ).padStart(
        2,
        "0"
    )}-${String(
        day
    ).padStart(
        2,
        "0"
    )}`;
}

function parseYMD(
    value
) {
    const ymd =
        normalizeYMD(value);

    if (!ymd) {
        return null;
    }

    const [
        year,
        month,
        day,
    ] =
        ymd
            .split("-")
            .map(Number);

    return {
        year,
        month,
        day,
    };
}

function addDaysYMD(
    value,
    days = 0
) {
    const parts =
        parseYMD(value);

    if (!parts) {
        return null;
    }

    const date =
        new Date(
            Date.UTC(
                parts.year,
                parts.month - 1,
                parts.day
            )
        );

    date.setUTCDate(
        date.getUTCDate() +
        Number(days || 0)
    );

    return date
        .toISOString()
        .slice(0, 10);
}

function getZonedParts(
    value,
    timeZone
) {
    const date =
        value instanceof Date
            ? value
            : new Date(value);

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        return null;
    }

    const timezone =
        normalizeTimeZone(
            timeZone
        );

    const parts =
        new Intl.DateTimeFormat(
            "en-US",
            {
                timeZone:
                timezone,

                year:
                    "numeric",

                month:
                    "2-digit",

                day:
                    "2-digit",

                hour:
                    "2-digit",

                minute:
                    "2-digit",

                second:
                    "2-digit",

                hourCycle:
                    "h23",
            }
        ).formatToParts(
            date
        );

    const get =
        (type) =>
            Number(
                parts.find(
                    (part) =>
                        part.type ===
                        type
                )?.value
            );

    return {
        year:
            get("year"),

        month:
            get("month"),

        day:
            get("day"),

        hour:
            get("hour"),

        minute:
            get("minute"),

        second:
            get("second"),
    };
}

function getTimeZoneOffsetMs(
    date,
    timeZone
) {
    const parts =
        getZonedParts(
            date,
            timeZone
        );

    if (!parts) {
        return 0;
    }

    const representedAsUtc =
        Date.UTC(
            parts.year,
            parts.month - 1,
            parts.day,
            parts.hour,
            parts.minute,
            parts.second
        );

    const originalWithoutMs =
        Math.floor(
            date.getTime() /
            1000
        ) * 1000;

    return (
        representedAsUtc -
        originalWithoutMs
    );
}

function zonedDateTimeToUtc(
    {
        year,
        month,
        day,
        hour = 0,
        minute = 0,
        second = 0,
        millisecond = 0,
    },
    timeZone
) {
    const timezone =
        normalizeTimeZone(
            timeZone
        );

    const target =
        Date.UTC(
            year,
            month - 1,
            day,
            hour,
            minute,
            second,
            millisecond
        );

    let candidate =
        new Date(target);

    let offset =
        getTimeZoneOffsetMs(
            candidate,
            timezone
        );

    let utcTime =
        target - offset;

    const refinedOffset =
        getTimeZoneOffsetMs(
            new Date(utcTime),
            timezone
        );

    if (
        refinedOffset !==
        offset
    ) {
        utcTime =
            target -
            refinedOffset;
    }

    return new Date(
        utcTime
    );
}

function getUtcRangeForYMDRange(
    fromValue,
    toValue,
    timeZone
) {
    let fromYMD =
        normalizeYMD(
            fromValue ||
            toValue
        );

    let toYMD =
        normalizeYMD(
            toValue ||
            fromValue
        );

    if (
        !fromYMD ||
        !toYMD
    ) {
        return null;
    }

    if (
        toYMD < fromYMD
    ) {
        [
            fromYMD,
            toYMD,
        ] = [
            toYMD,
            fromYMD,
        ];
    }

    const fromParts =
        parseYMD(
            fromYMD
        );

    const nextDayYMD =
        addDaysYMD(
            toYMD,
            1
        );

    const nextDayParts =
        parseYMD(
            nextDayYMD
        );

    const timezone =
        normalizeTimeZone(
            timeZone
        );

    const start =
        zonedDateTimeToUtc(
            fromParts,
            timezone
        );

    const endExclusive =
        zonedDateTimeToUtc(
            nextDayParts,
            timezone
        );

    const end =
        new Date(
            endExclusive.getTime() -
            1
        );

    return {
        start,
        end,
        endExclusive,
        fromYMD,
        toYMD,
        timezone,
    };
}

function getYMDInTimeZone(
    value,
    timeZone
) {
    if (!value) {
        return null;
    }

    const date =
        value instanceof Date
            ? value
            : new Date(value);

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        return null;
    }

    const parts =
        getZonedParts(
            date,
            timeZone
        );

    if (!parts) {
        return null;
    }

    return `${String(
        parts.year
    ).padStart(
        4,
        "0"
    )}-${String(
        parts.month
    ).padStart(
        2,
        "0"
    )}-${String(
        parts.day
    ).padStart(
        2,
        "0"
    )}`;
}

function getTodayYMDInTimeZone(
    timeZone
) {
    return getYMDInTimeZone(
        new Date(),
        timeZone
    );
}

function getTenantTimezone(
    tenant = {}
) {
    return normalizeTimeZone(
        tenant?.localization
            ?.timezone ||
        DEFAULT_TIMEZONE
    );
}

module.exports = {
    DEFAULT_TIMEZONE,
    normalizeTimeZone,
    normalizeYMD,
    addDaysYMD,
    getUtcRangeForYMDRange,
    getYMDInTimeZone,
    getTodayYMDInTimeZone,
    getTenantTimezone,
};