'use strict';

const config = require('./config');
const { getDateTimeContext } = require('./hours');
const { loadCompanyKnowledge } = require('./knowledge');
const { classifyIntent, INTENT } = require('./intent');
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
const { SYSTEM } = require('./messages');

let companyKnowledge = '';

function refreshCompanyKnowledge() {
    companyKnowledge = loadCompanyKnowledge(config.docsRoot);
    return companyKnowledge;
}

function extractMessageText(msg) {
    let text = msg.body?.trim() || '';

    if (!text && msg.hasMedia) {
        if (msg.filename) {
            text = msg.filename;
        } else if (msg.type === 'document') {
            text = 'documento anexado';
        } else if (msg.type === 'image') {
            text = 'imagem anexada';
        }
    }

    return text;
}

async function withTyping(chat, fn) {
    try {
        await chat.sendStateTyping();
    } catch {
        /* ignore */
    }
    return fn();
}

async function buildContext(userText, documentCatalog, options = {}) {
    const {
        hasMedia = false,
        outlookEnabled: forceOutlook = false,
        outsideBusinessHours = false,
    } = options;
    const intent = classifyIntent(userText, { hasMedia });

    let relevantDocs = [];
    if (intent !== INTENT.GREETING) {
        relevantDocs = await searchCatalog(
            documentCatalog,
            userText,
            config.docsRoot,
        );
    }

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
        intent,
        relevantDocs,
        catalogSummary,
        relevantContext,
        emailContext,
        outlookEnabled,
        outsideBusinessHours,
        companyKnowledge: companyKnowledge || refreshCompanyKnowledge(),
        dateTimeContext: getDateTimeContext(),
    };
}

async function produceReply({
    conversation,
    userText,
    context,
    registeredStaff,
}) {
    const {
        intent,
        catalogSummary,
        relevantContext,
        emailContext,
        outlookEnabled,
        companyKnowledge: knowledge,
        dateTimeContext,
    } = context;

    if (intent === INTENT.GREETING) {
        return {
            rawReply: generateGreetingReply({
                registeredStaff,
                dateTimeContext,
            }),
            intent,
        };
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
    });

    return { rawReply, intent };
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
    extractMessageText,
    withTyping,
    buildContext,
    produceReply,
    resolveOutgoingFiles,
    shouldAnnounceLookup,
    INTENT,
};
