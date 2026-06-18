'use strict';

const { isSimpleGreeting, matchesHumanKeyword } = require('./human-intent');
const { shouldSearchOutlook } = require('./mail');
const { looksLikeFilename } = require('./documents');

const INTENT = {
    GREETING: 'greeting',
    HUMAN: 'human',
    DOCUMENT: 'document',
    EMAIL: 'email',
    GENERAL: 'general',
};

function needsDocumentLookup(text) {
    const n = text.toLowerCase();
    return (
        /certificado|documento|arquivo|pdf|anexo|manual|procedimento|proposta/.test(
            n,
        ) ||
        /manda|envia|preciso|busca|procura|localiza|achar|encontra/.test(n) ||
        looksLikeFilename(text)
    );
}

function classifyIntent(text, { hasMedia = false } = {}) {
    const trimmed = text.trim();
    if (!trimmed && hasMedia) {
        return INTENT.DOCUMENT;
    }

    if (matchesHumanKeyword(trimmed)) {
        return INTENT.HUMAN;
    }

    const lines = trimmed
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    if (lines.length === 1 && isSimpleGreeting(lines[0])) {
        return INTENT.GREETING;
    }

    if (shouldSearchOutlook(trimmed)) {
        return INTENT.EMAIL;
    }

    if (needsDocumentLookup(trimmed) || hasMedia) {
        return INTENT.DOCUMENT;
    }

    return INTENT.GENERAL;
}

module.exports = {
    INTENT,
    classifyIntent,
    needsDocumentLookup,
};
