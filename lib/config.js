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
    docsRoot: resolveDocsRoot(process.env.DOCS_ROOT),
    dataDir: path.join(__dirname, '..', 'data'),
    staffFile: path.join(__dirname, '..', 'data', 'funcionarios.json'),
    stateFile: path.join(__dirname, '..', 'data', 'conversations.json'),
    logsDir: path.join(__dirname, '..', 'data', 'logs'),
    historyLimitRegistered: Number(process.env.HISTORY_LIMIT_REGISTERED) || 40,
    historyLimitGuest: Number(process.env.HISTORY_LIMIT_GUEST) || 8,
    timezone: process.env.TIMEZONE || 'America/Sao_Paulo',
    businessStart: process.env.BUSINESS_START || '07:30',
    businessEnd: process.env.BUSINESS_END || '15:15',
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
