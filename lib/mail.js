'use strict';

const config = require('./config');
const graphMail = require('./outlook');
const comMail = require('./outlook-com');
const emailIntent = require('./email-intent');

function getProvider() {
    const mode = (config.outlookMode || 'auto').toLowerCase();

    if (mode === 'com') {
        return comMail.isConfigured() ? comMail : null;
    }

    if (mode === 'graph') {
        return graphMail.isConfigured() ? graphMail : null;
    }

    if (process.platform === 'win32' && comMail.isConfigured()) {
        return comMail;
    }

    if (graphMail.isConfigured()) {
        return graphMail;
    }

    return null;
}

function isConfigured() {
    return Boolean(getProvider());
}

function getModeLabel() {
    const provider = getProvider();
    if (provider === comMail) {
        const account = comMail.getAccountEmail();
        return account ? `Outlook COM (${account})` : 'Outlook COM (app local)';
    }
    if (provider === graphMail) return 'Microsoft Graph API';
    return 'não configurado';
}

async function searchEmails(request) {
    const provider = getProvider();
    if (!provider) {
        return [];
    }

    if (provider === graphMail) {
        const query = request.mode === 'search' ? request.query : '';
        return provider.searchEmails(query, request.limit || 5);
    }

    return provider.searchEmails(request);
}

function buildEmailContext(emails) {
    const provider = getProvider() || comMail;
    return provider.buildEmailContext(emails);
}

function shouldSearchOutlook(userText) {
    return emailIntent.shouldSearchOutlook(userText);
}

function parseEmailRequest(userText) {
    return emailIntent.parseEmailRequest(userText, config.outlook.maxEmails);
}

module.exports = {
    isConfigured,
    getModeLabel,
    searchEmails,
    buildEmailContext,
    shouldSearchOutlook,
    parseEmailRequest,
};
