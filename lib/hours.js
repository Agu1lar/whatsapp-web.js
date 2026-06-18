'use strict';

const config = require('./config');

function parseTime(value) {
    const [hour, minute] = value.split(':').map(Number);
    return { hour, minute };
}

function getNowInTimezone() {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: config.timezone,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });

    const parts = formatter.formatToParts(new Date());
    const weekdayMap = {
        Sun: 0,
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6,
    };
    const weekday = weekdayMap[parts.find((p) => p.type === 'weekday').value];
    const hour = Number(parts.find((p) => p.type === 'hour').value);
    const minute = Number(parts.find((p) => p.type === 'minute').value);

    return { weekday, hour, minute };
}

function isWithinBusinessHours() {
    const { weekday, hour, minute } = getNowInTimezone();

    if (!config.businessDays.includes(weekday)) {
        return false;
    }

    const start = parseTime(config.businessStart);
    const end = parseTime(config.businessEnd);
    const currentMinutes = hour * 60 + minute;
    const startMinutes = start.hour * 60 + start.minute;
    const endMinutes = end.hour * 60 + end.minute;

    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

function getOutsideHoursMessage() {
    return (
        `Opa! Agora já passou do horário (seg a sex, ${config.businessStart} às ${config.businessEnd}). ` +
        'Deixa tua mensagem que a gente vê no próximo expediente, beleza?'
    );
}

module.exports = {
    isWithinBusinessHours,
    getOutsideHoursMessage,
};
