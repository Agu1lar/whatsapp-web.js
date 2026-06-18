'use strict';

const config = require('./config');
const { getOutsideHoursMessage } = require('./messages');

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

function getDateTimeContext() {
    const formatter = new Intl.DateTimeFormat('pt-BR', {
        timeZone: config.timezone,
        weekday: 'long',
        day: '2-digit',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });

    const parts = formatter.formatToParts(new Date());
    const get = (type) => parts.find((p) => p.type === type)?.value || '';

    const weekday = get('weekday');
    const day = get('day');
    const month = get('month');
    const year = get('year');
    const hour = get('hour');
    const minute = get('minute');
    const withinHours = isWithinBusinessHours();

    return (
        `${weekday}, ${day} de ${month} de ${year}, ${hour}:${minute} ` +
        `(${config.timezone}) — expediente ${withinHours ? 'aberto' : 'fechado'}`
    );
}

module.exports = {
    isWithinBusinessHours,
    getOutsideHoursMessage,
    getDateTimeContext,
};
