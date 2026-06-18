'use strict';

const path = require('path');

require('dotenv').config();

function resolveDocsRoot(value) {
    if (!value) {
        return path.join(__dirname, '..', 'documentos');
    }

    const trimmed = value.trim();
    if (trimmed.startsWith('\\\\')) {
        return trimmed.replace(/[\\/]+$/, '');
    }

    return path.resolve(trimmed);
}

const config = {
    groqApiKey: process.env.GROQ_API_KEY,
    groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    groqMaxTokens: Number(process.env.GROQ_MAX_TOKENS) || 700,
    groqTemperature: Number(process.env.GROQ_TEMPERATURE) || 0.65,
    groqTemperatureFactual:
        Number(process.env.GROQ_TEMPERATURE_FACTUAL) || 0.35,
    groqTemperatureCreative:
        Number(process.env.GROQ_TEMPERATURE_CREATIVE) || 0.8,
    groqMaxRetries: Number(process.env.GROQ_MAX_RETRIES) || 3,
    groqRequestTimeoutMs: Number(process.env.GROQ_REQUEST_TIMEOUT_MS) || 45000,
    docsRoot: resolveDocsRoot(process.env.DOCS_ROOT),
    dataDir: path.join(__dirname, '..', 'data'),
    staffFile: path.join(__dirname, '..', 'data', 'funcionarios.json'),
    stateFile: path.join(__dirname, '..', 'data', 'conversations.json'),
    logsDir: path.join(__dirname, '..', 'data', 'logs'),
    historyLimitRegistered: Number(process.env.HISTORY_LIMIT_REGISTERED) || 40,
    historyLimitGuest: Number(process.env.HISTORY_LIMIT_GUEST) || 12,
    messageDebounceMs: Number(process.env.MESSAGE_DEBOUNCE_MS) || 3000,
    messageDebounceGreetingMs:
        Number(process.env.MESSAGE_DEBOUNCE_GREETING_MS) || 800,
    contactLookupTimeoutMs:
        Number(process.env.CONTACT_LOOKUP_TIMEOUT_MS) || 5000,
    catalogRefreshMs: Number(process.env.CATALOG_REFRESH_MS) || 60 * 60 * 1000,
    reconnectDelayMs: Number(process.env.RECONNECT_DELAY_MS) || 15000,
    puppeteerHeadless: process.env.PUPPETEER_HEADLESS === 'true',
    authTimeoutMs: Number(process.env.WA_AUTH_TIMEOUT_MS) || 120000,
    waInitRetries: Number(process.env.WA_INIT_RETRIES) || 4,
    waInitRetryDelayMs: Number(process.env.WA_INIT_RETRY_DELAY_MS) || 8000,
    timezone: process.env.TIMEZONE || 'America/Sao_Paulo',
    businessStart: process.env.BUSINESS_START || '07:30',
    businessEnd: process.env.BUSINESS_END || '17:15',
    businessDays: (process.env.BUSINESS_DAYS || '1,2,3,4,5')
        .split(',')
        .map((d) => Number(d.trim())),
    adminPhone: (process.env.ADMIN_PHONE || '').replace(/\D/g, ''),
    outlook: {
        mode: process.env.OUTLOOK_MODE || 'com',
        maxEmails: Number(process.env.OUTLOOK_MAX_EMAILS) || 8,
        clientId: process.env.OUTLOOK_CLIENT_ID || '',
        clientSecret: process.env.OUTLOOK_CLIENT_SECRET || '',
        tenantId: process.env.OUTLOOK_TENANT_ID || 'common',
        refreshToken: process.env.OUTLOOK_REFRESH_TOKEN || '',
        userEmail: process.env.OUTLOOK_USER_EMAIL || '',
    },
};

config.outlookMode = config.outlook.mode;

module.exports = config;
