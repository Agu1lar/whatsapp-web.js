'use strict';

const config = require('./config');
const emailIntent = require('./email-intent');

let cachedToken = null;
let tokenExpiresAt = 0;

function isConfigured() {
    return Boolean(
        config.outlook.clientId &&
        config.outlook.clientSecret &&
        config.outlook.refreshToken &&
        config.outlook.userEmail,
    );
}

async function getAccessToken() {
    if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
        return cachedToken;
    }

    const url = `https://login.microsoftonline.com/${config.outlook.tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
        client_id: config.outlook.clientId,
        client_secret: config.outlook.clientSecret,
        refresh_token: config.outlook.refreshToken,
        grant_type: 'refresh_token',
        scope: 'https://graph.microsoft.com/Mail.Read offline_access',
    });

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Outlook auth ${response.status}: ${errorBody}`);
    }

    const data = await response.json();
    cachedToken = data.access_token;
    tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    return cachedToken;
}

async function searchEmails(query, top = 5) {
    if (!isConfigured()) {
        return [];
    }

    const token = await getAccessToken();
    const safeQuery = query.replace(/"/g, '').trim();
    const url = new URL(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.outlook.userEmail)}/messages`,
    );
    url.searchParams.set('$top', String(top));
    url.searchParams.set('$orderby', 'receivedDateTime desc');
    url.searchParams.set(
        '$select',
        'subject,from,receivedDateTime,bodyPreview,isRead',
    );

    if (safeQuery) {
        url.searchParams.set('$search', `"${safeQuery}"`);
    }

    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${token}`,
            ConsistencyLevel: 'eventual',
        },
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Outlook search ${response.status}: ${errorBody}`);
    }

    const data = await response.json();
    return (data.value || []).map(formatEmail);
}

function formatEmail(email) {
    const from = email.from?.emailAddress;
    return {
        subject: email.subject || '(sem assunto)',
        from: from
            ? `${from.name || ''} <${from.address}>`.trim()
            : 'Desconhecido',
        date: email.receivedDateTime,
        preview: (email.bodyPreview || '').replace(/\s+/g, ' ').trim(),
        isRead: email.isRead,
    };
}

function buildEmailContext(emails) {
    if (!emails.length) {
        return 'Nenhum e-mail encontrado no Outlook para esta consulta.';
    }

    return emails
        .map(
            (email, index) =>
                `${index + 1}. Assunto: ${email.subject}\n   De: ${email.from}\n   Data: ${email.date}\n   Resumo: ${email.preview}`,
        )
        .join('\n\n');
}

function shouldSearchOutlook(userText) {
    return emailIntent.shouldSearchOutlook(userText);
}

function parseEmailRequest(userText) {
    return emailIntent.parseEmailRequest(userText, config.outlook.maxEmails);
}

module.exports = {
    isConfigured,
    searchEmails,
    buildEmailContext,
    shouldSearchOutlook,
    parseEmailRequest,
};
