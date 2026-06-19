'use strict';

const config = require('./config');
const { getDateTimeContext } = require('./hours');
const { loadCompanyKnowledge } = require('./knowledge');
const { classifyIntent, INTENT, needsDocumentLookup } = require('./intent');
const { isSimpleGreeting } = require('./human-intent');
const {
    searchCatalog,
    buildCatalogSummary,
    buildRelevantContext,
    resolveSendPaths,
    userWantsFileSend,
    aiSuggestsSending,
} = require('./documents');
const {
    isConfigured: mailConfigured,
    searchEmails,
    buildEmailContext,
    parseEmailRequest,
} = require('./mail');
const {
    generateReply,
    generateGreetingReply,
    parseSendFileDirective,
} = require('./groq');
const {
    assessGrounding,
    sanitizeAssistantReply,
    getRagOnlyBypassReply,
} = require('./grounding');
const { SYSTEM } = require('./messages');

let companyKnowledge = '';

function refreshCompanyKnowledge() {
    companyKnowledge = loadCompanyKnowledge(config.docsRoot);
    return companyKnowledge;
}

async function withTyping(chat, fn) {
    try {
        await chat.sendStateTyping();
    } catch {
        /* ignore */
    }
    return fn();
}

function hasDocumentThread(history = [], userText = '') {
    const blob = [...history, { role: 'user', content: userText }]
        .filter((message) => message.role === 'user')
        .slice(-5)
        .map((message) => String(message.content || ''))
        .join('\n');

    return /documento|certificado|arquivo|carteirinha|procedimento|funcion[aá]rio|empresa|manual|anexo/i.test(
        blob,
    );
}

function buildSearchQuery(userText, history = []) {
    const current = String(userText || '').trim();
    const priorUser = history
        .filter((message) => message.role === 'user')
        .map((message) => String(message.content || '').trim())
        .filter((text) => {
            if (!text) return false;
            const firstLine = text.split('\n')[0].trim();
            return !isSimpleGreeting(firstLine);
        })
        .slice(-3);

    if (!current) {
        return priorUser.join(' ');
    }

    const wordCount = current.split(/\s+/).filter(Boolean).length;
    const isShortFollowUp =
        wordCount <= 5 &&
        current.length < 80 &&
        !needsDocumentLookup(current) &&
        !looksLikeFilename(current);

    if (isShortFollowUp && priorUser.length > 0 && hasDocumentThread(history)) {
        return `${priorUser.join(' ')} ${current}`.trim();
    }

    return current;
}

function looksLikeFilename(text) {
    return /\.(pdf|docx?|xlsx?|pptx?|txt|zip|png|jpe?g)$/i.test(
        String(text || '').trim(),
    );
}

function shouldSearchCatalog(intent, userText, history = []) {
    if (intent === INTENT.DOCUMENT) {
        return true;
    }

    if (
        intent === INTENT.GREETING ||
        intent === INTENT.HUMAN ||
        intent === INTENT.EMAIL
    ) {
        return false;
    }

    return hasDocumentThread(history, userText);
}

function resolveEffectiveIntent(intent, userText, history, relevantDocs) {
    if (intent === INTENT.DOCUMENT) {
        return INTENT.DOCUMENT;
    }

    if (
        shouldSearchCatalog(intent, userText, history) &&
        (relevantDocs.length > 0 || hasDocumentThread(history, userText))
    ) {
        return INTENT.DOCUMENT;
    }

    return intent;
}

async function buildContext(userText, documentCatalog, options = {}) {
    const {
        hasMedia = false,
        outlookEnabled: forceOutlook = false,
        outsideBusinessHours = false,
        conversationHistory = [],
    } = options;
    const intent = classifyIntent(userText, { hasMedia });
    const searchQuery = buildSearchQuery(userText, conversationHistory);

    let relevantDocs = [];
    if (shouldSearchCatalog(intent, userText, conversationHistory)) {
        relevantDocs = await searchCatalog(
            documentCatalog,
            searchQuery,
            config.docsRoot,
        );
    }

    const effectiveIntent = resolveEffectiveIntent(
        intent,
        userText,
        conversationHistory,
        relevantDocs,
    );

    const catalogSummary = buildCatalogSummary(documentCatalog, relevantDocs);
    const relevantContext = buildRelevantContext(relevantDocs);

    let emailContext = '';
    let outlookEnabled = false;

    if (mailConfigured() && (forceOutlook || intent === INTENT.EMAIL)) {
        const emailRequest = parseEmailRequest(userText);
        const emails = await searchEmails(emailRequest);
        emailContext = buildEmailContext(emails);
        outlookEnabled = true;
    }

    return {
        intent: effectiveIntent,
        rawIntent: intent,
        searchQuery,
        relevantDocs,
        catalogSummary,
        relevantContext,
        emailContext,
        outlookEnabled,
        outsideBusinessHours,
        companyKnowledge: companyKnowledge || refreshCompanyKnowledge(),
        dateTimeContext: getDateTimeContext(),
        groundingMeta: assessGrounding({
            intent: effectiveIntent,
            relevantDocs,
            emailContext,
            outlookEnabled,
        }),
    };
}

async function produceReply({
    conversation,
    userText,
    context,
    registeredStaff,
    documentCatalog = [],
}) {
    const {
        intent,
        catalogSummary,
        relevantContext,
        relevantDocs,
        emailContext,
        outlookEnabled,
        companyKnowledge: knowledge,
        dateTimeContext,
        groundingMeta,
    } = context;

    if (intent === INTENT.GREETING) {
        return {
            rawReply: generateGreetingReply({
                registeredStaff,
                dateTimeContext,
            }),
            intent,
            ragOnlyBypass: false,
        };
    }

    const ragOnlyReply = getRagOnlyBypassReply(
        context,
        userText,
        documentCatalog,
        config.docsRoot,
    );
    if (ragOnlyReply) {
        return { rawReply: ragOnlyReply, intent, ragOnlyBypass: true };
    }

    const rawReply = await generateReply({
        conversation,
        userText,
        catalogSummary,
        relevantContext,
        emailContext,
        registeredStaff,
        outlookEnabled,
        companyKnowledge: knowledge,
        dateTimeContext,
        outsideBusinessHours: context.outsideBusinessHours,
        intent,
        groundingMeta,
    });

    const sanitized = sanitizeAssistantReply(rawReply, {
        catalog: documentCatalog,
        relevantDocs,
        intent,
    });

    return { rawReply: sanitized, intent, ragOnlyBypass: false };
}

function resolveOutgoingFiles(
    rawReply,
    userText,
    documentCatalog,
    relevantDocs,
) {
    const { text: reply, relativePath } = parseSendFileDirective(rawReply);
    const allowAutoSend =
        Boolean(relativePath) ||
        (aiSuggestsSending(reply) &&
            (userWantsFileSend(userText) ||
                /certificados?|carteirinhas?/i.test(userText)));

    const sendPaths = resolveSendPaths(
        relativePath,
        documentCatalog,
        relevantDocs,
        userText,
        config.docsRoot,
        { allowAutoSend },
    );

    const outgoing =
        reply ||
        (sendPaths.length > 0
            ? sendPaths.length > 1
                ? SYSTEM.filesSendingMany(sendPaths.length)
                : SYSTEM.filesSending
            : SYSTEM.needMoreDetail);

    return { reply, relativePath, sendPaths, outgoing };
}

function shouldAnnounceLookup(intent, userText) {
    return (
        intent === INTENT.DOCUMENT &&
        /manda|envia|preciso|busca|procura|certificado|proposta|\.pdf|\.docx?/i.test(
            userText,
        )
    );
}

module.exports = {
    refreshCompanyKnowledge,
    withTyping,
    buildContext,
    produceReply,
    resolveOutgoingFiles,
    shouldAnnounceLookup,
    INTENT,
};
