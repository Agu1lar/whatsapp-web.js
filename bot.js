'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('./index');
const config = require('./lib/config');
const { isWithinBusinessHours } = require('./lib/hours');
const { SYSTEM, getWelcomeMessage } = require('./lib/messages');
const { isSimpleGreeting } = require('./lib/human-intent');
const {
    findRegisteredStaff,
    registerChatIdForStaff,
    normalizePhone,
    formatPhoneForAdmin,
} = require('./lib/funcionarios');
const {
    loadAllStates,
    saveAllStates,
    resolveConversationKey,
    withConversationState,
    readConversation,
    appendLog,
} = require('./lib/conversations');
const {
    refreshCompanyKnowledge,
    withTyping,
    buildContext,
    produceReply,
    resolveOutgoingFiles,
    shouldAnnounceLookup,
} = require('./lib/assistant');
const { resolveInboundText, extractMessageText } = require('./lib/media');
const { shouldIgnoreAsSpam } = require('./lib/spam-filter');
const { matchesHumanKeyword } = require('./lib/groq');
const {
    hasApiKey,
    getProviderLabel,
    getChatModel,
    resolveProviders,
    getPrimaryProvider,
    getProviderChain,
} = require('./lib/llm');
const { resolveDocument } = require('./lib/documents');
const { isConfigured: mailConfigured, getModeLabel } = require('./lib/mail');

const ESCALATION_REPLY = SYSTEM.escalation;

const messageQueues = new Map();
const emptyBodyCooldown = new Map();
const EMPTY_BODY_COOLDOWN_MS = 120000;
let documentCatalog = [];
let botPaused = false;
let waClient = null;
let reconnecting = false;
let catalogRefreshTimer = null;
let clientReady = false;

async function sendChatReply(chat, msg, content, options = {}) {
    const opts = { ...options };
    if (msg?.id?._serialized && opts.quote !== false) {
        opts.quotedMessageId = msg.id._serialized;
    } else {
        delete opts.quote;
    }
    return chat.sendMessage(content, opts);
}

function logIncoming(msg, chat, reason) {
    const chatId = chat?.id?._serialized || msg.from;
    const preview = (msg.body || '').slice(0, 80).replace(/\s+/g, ' ');
    const line = `[msg] ${chat?.name || chatId} | ${reason} | "${preview}"`;
    console.log(line);
    appendLog({
        type: 'incoming',
        chatId,
        contact: chat?.name,
        fromMe: msg.fromMe,
        reason,
        message: msg.body,
    });
}

function needsSlowLookup(text, intent) {
    return shouldAnnounceLookup(intent, text);
}

function getMessageQueue(chatId) {
    if (!messageQueues.has(chatId)) {
        messageQueues.set(chatId, {
            items: [],
            debounceTimer: null,
            processing: false,
            pendingDrain: false,
        });
    }
    return messageQueues.get(chatId);
}

function scheduleMessage(msg, chat) {
    const chatId = chat.id._serialized;
    const queue = getMessageQueue(chatId);
    queue.items.push({ msg, chat });

    const preview = extractMessageText(msg);
    const debounceMs = isSimpleGreeting(preview)
        ? config.messageDebounceGreetingMs
        : config.messageDebounceMs;

    if (queue.debounceTimer) {
        clearTimeout(queue.debounceTimer);
    }

    queue.debounceTimer = setTimeout(() => {
        queue.debounceTimer = null;
        drainMessageQueue(chatId).catch((err) => {
            console.error(
                `[${chatId}] Erro na fila de mensagens:`,
                err.message,
            );
        });
    }, debounceMs);
}

async function drainMessageQueue(chatId) {
    const queue = getMessageQueue(chatId);
    if (queue.items.length === 0) {
        return;
    }

    if (queue.processing) {
        queue.pendingDrain = true;
        return;
    }

    queue.processing = true;
    queue.pendingDrain = false;
    const batch = queue.items.splice(0);

    try {
        const texts = [];
        for (const entry of batch) {
            texts.push(await resolveInboundText(entry.msg));
        }
        const combinedText = texts.filter(Boolean).join('\n');
        if (!combinedText) {
            return;
        }
        const last = batch[batch.length - 1];
        await processMessage(last.msg, last.chat, combinedText);
    } finally {
        queue.processing = false;
        if (queue.items.length > 0 || queue.pendingDrain) {
            queue.pendingDrain = false;
            await drainMessageQueue(chatId);
        }
    }
}

async function refreshDocumentCatalog() {
    const { loadCatalog } = require('./lib/documents');
    const { syncEmbeddingIndex } = require('./lib/embeddings');
    documentCatalog = await loadCatalog(config.docsRoot);
    refreshCompanyKnowledge();
    const embeddingStats = await syncEmbeddingIndex(
        documentCatalog,
        config.docsRoot,
    );

    let semanticLabel = '';
    if (embeddingStats.skipped) {
        semanticLabel = ' | busca semântica: desativada';
    } else if (embeddingStats.error) {
        semanticLabel = ' | busca semântica: indisponível';
    } else if (embeddingStats.backend) {
        semanticLabel =
            embeddingStats.backend === 'local'
                ? ` | semântica local: ${embeddingStats.indexed}`
                : embeddingStats.backend === 'openai'
                  ? ` | semântica OpenAI: ${embeddingStats.indexed}`
                  : ` | semântica Groq: ${embeddingStats.indexed}`;
    }

    console.log(
        `Documentos indexados: ${documentCatalog.length} em ${config.docsRoot}${semanticLabel}`,
    );
}

function startCatalogRefreshTimer() {
    if (catalogRefreshTimer) clearInterval(catalogRefreshTimer);
    if (config.catalogRefreshMs <= 0) return;

    catalogRefreshTimer = setInterval(() => {
        refreshDocumentCatalog().catch((err) => {
            console.error('Erro ao reindexar documentos:', err.message);
        });
    }, config.catalogRefreshMs);
}

function isAdmin(msg) {
    if (!config.adminPhone) return false;
    const fromDigits = normalizePhone(msg.from.split('@')[0]);
    return (
        fromDigits.endsWith(config.adminPhone) ||
        config.adminPhone.endsWith(fromDigits.slice(-11))
    );
}

async function notifyAdmin(text) {
    if (!waClient || !config.adminPhone) return;
    const chatId = `${config.adminPhone}@c.us`;
    try {
        await waClient.sendMessage(chatId, text);
    } catch (err) {
        console.error('Erro ao notificar admin:', err.message);
    }
}

async function handleAdminCommand(msg) {
    const text = msg.body?.trim().toLowerCase();

    if (text === '!meunumero') {
        const digits = formatPhoneForAdmin(waClient.info?.wid);
        await msg.reply(
            `Número deste WhatsApp conectado ao bot:\n\n${digits}\n\nCopie e cole no .env como:\nADMIN_PHONE=${digits}`,
        );
        return true;
    }

    if (text === '!pausar') {
        botPaused = true;
        await msg.reply('Bot pausado. A IA não responderá até !ativar.');
        return true;
    }

    if (text === '!ativar') {
        botPaused = false;
        await msg.reply('Bot ativado.');
        return true;
    }

    if (text === '!status') {
        const {
            isIndexReady,
            isEnabled: semanticEnabled,
            getSearchBackend,
        } = require('./lib/embeddings');
        const outlook = mailConfigured() ? 'conectado' : 'não configurado';
        const semanticBackend = getSearchBackend();
        await msg.reply(
            `Status:\n` +
                `- Bot: ${botPaused ? 'pausado' : 'ativo'}\n` +
                `- IA: ${getProviderLabel(getPrimaryProvider())} / ${getChatModel()}${
                    getProviderChain().length > 1
                        ? ` (fallback: ${getProviderChain()
                              .slice(1)
                              .map((p) => getProviderLabel(p))
                              .join(', ')})`
                        : ''
                }\n` +
                `- Debounce: ${config.messageDebounceMs / 1000}s\n` +
                `- E-mail: ${getModeLabel()} (${outlook})\n` +
                `- Documentos: ${documentCatalog.length}\n` +
                `- Busca semântica: ${
                    semanticEnabled()
                        ? isIndexReady()
                            ? semanticBackend === 'openai'
                                ? 'ativa (OpenAI)'
                                : semanticBackend === 'groq'
                                  ? 'ativa (Groq)'
                                  : 'ativa (local TF-IDF)'
                            : 'indexando…'
                        : 'desativada'
                }`,
        );
        return true;
    }

    if (text === '!ajuda' || text === '!help') {
        await msg.reply(
            `Comandos admin:\n` +
                `!status — status do bot\n` +
                `!pausar / !ativar — pausar IA\n` +
                `!docs — reindexar documentos\n` +
                `!limpar — zerar histórico deste chat\n` +
                `!liberar [filtro] — liberar escalonamentos\n` +
                `!ping — teste rápido\n` +
                `!meunumero — número do WhatsApp conectado`,
        );
        return true;
    }

    if (text === '!docs') {
        await refreshDocumentCatalog();
        await msg.reply(
            `Documentos reindexados: ${documentCatalog.length} arquivo(s).`,
        );
        return true;
    }

    if (text.startsWith('!liberar')) {
        const states = loadAllStates();
        const target = text.replace('!liberar', '').trim();
        let cleared = 0;

        for (const key of Object.keys(states)) {
            if (!target || key.includes(target)) {
                states[key].escalated = false;
                cleared += 1;
            }
        }

        saveAllStates(states);
        await msg.reply(`Escalonamentos liberados: ${cleared}.`);
        return true;
    }

    if (text === '!ping') {
        await msg.reply(
            `Bot ativo.\n- WhatsApp: ${clientReady ? 'pronto' : 'sincronizando'}\n` +
                `- IA: ${botPaused ? 'pausada' : 'ativa'}\n` +
                `- Documentos: ${documentCatalog.length}`,
        );
        return true;
    }

    if (text === '!limpar') {
        const chat = await msg.getChat();
        const chatId = chat.id._serialized;
        const registeredStaff = findRegisteredStaff(chatId, chat.name);
        const key = await resolveConversationKey(
            waClient,
            chatId,
            registeredStaff,
        );

        await withConversationState(
            key,
            chatId,
            registeredStaff,
            async (conversation) => {
                conversation.history = [];
                conversation.escalated = false;
            },
        );

        await msg.reply(`Histórico desta conversa limpo (${key}).`);
        return true;
    }

    return false;
}

async function maybeSendDocuments(chat, msg, relativePaths) {
    if (relativePaths.length === 0) {
        return false;
    }

    let sent = 0;
    for (const relativePath of relativePaths) {
        const filePath = resolveDocument(
            config.docsRoot,
            documentCatalog,
            relativePath,
        );

        if (!filePath || !fs.existsSync(filePath)) {
            console.warn(`Arquivo não encontrado: ${relativePath}`);
            continue;
        }

        const media = MessageMedia.fromFilePath(filePath);
        const caption = path.basename(filePath);
        await sendChatReply(chat, msg, media, { caption });
        sent += 1;
    }

    if (sent === 0) {
        return false;
    }

    return true;
}

function isPrivateChat(chat) {
    return !chat.isGroup && !chat.isChannel;
}

function isMediaWithoutCaption(msg) {
    return msg.hasMedia && !msg.body?.trim();
}

async function isFirstContact(chat, registeredStaff) {
    const chatId = chat.id._serialized;
    const conversationKey = await resolveConversationKey(
        waClient,
        chatId,
        registeredStaff,
    );
    const conversation = await readConversation(
        conversationKey,
        chatId,
        registeredStaff,
    );
    return conversation.history.length === 0;
}

async function handleEscalation(
    msg,
    chat,
    chatId,
    registeredStaff,
    userText,
    conversationKey,
) {
    await withConversationState(
        conversationKey,
        chatId,
        registeredStaff,
        async (conversation) => {
            conversation.escalated = true;
        },
    );

    await sendChatReply(
        chat,
        msg,
        isWithinBusinessHours()
            ? ESCALATION_REPLY
            : SYSTEM.escalationOutsideHours,
        { quote: false },
    );

    const staffLabel = registeredStaff
        ? `${registeredStaff.nome} (${registeredStaff.telefone})`
        : chat.name || chatId;

    await notifyAdmin(
        `🔔 Atendimento humano solicitado\n` +
            `Contato: ${staffLabel}\n` +
            `Mensagem: ${userText}\n` +
            `Para retomar a IA: !liberar`,
    );

    appendLog({
        type: 'escalation',
        chatId,
        contact: registeredStaff?.nome || chat.name,
        message: userText,
    });
}

async function handleMessage(msg) {
    if (msg.isStatus || msg.broadcast) return;

    if (msg.fromMe) {
        const preview = (msg.body || '').slice(0, 60);
        console.log(
            `[msg] ignorado (fromMe) — teste de outro celular: "${preview}"`,
        );
        return;
    }

    let chat;
    try {
        chat = await msg.getChat();
    } catch (err) {
        console.error('Erro ao obter chat:', err.message);
        return;
    }

    if (!isPrivateChat(chat)) {
        logIncoming(msg, chat, 'ignored_group_or_channel');
        return;
    }

    if (!clientReady) {
        logIncoming(msg, chat, 'ignored_not_ready');
        try {
            await sendChatReply(chat, msg, SYSTEM.notReady, { quote: false });
        } catch {
            /* ignore */
        }
        return;
    }

    if (isAdmin(msg) || !config.adminPhone) {
        const handled = await handleAdminCommand(msg);
        if (handled) return;
    }

    const registeredStaff = findRegisteredStaff(chat.id._serialized, chat.name);

    if (isMediaWithoutCaption(msg)) {
        const firstContact = await isFirstContact(chat, registeredStaff);
        if (firstContact) {
            logIncoming(msg, chat, 'ignored_media_no_prior_chat');
            return;
        }
    }

    const userText = extractMessageText(msg);

    if (!userText && !msg.hasMedia) {
        const chatId = chat.id._serialized;
        const lastReply = emptyBodyCooldown.get(chatId) || 0;
        if (Date.now() - lastReply < EMPTY_BODY_COOLDOWN_MS) {
            logIncoming(msg, chat, 'ignored_empty_body_cooldown');
            return;
        }
        emptyBodyCooldown.set(chatId, Date.now());
        logIncoming(msg, chat, 'empty_body');
        await sendChatReply(chat, msg, SYSTEM.emptyBody, { quote: false });
        return;
    }

    if (userText) {
        const spam = await shouldIgnoreAsSpam(userText, { registeredStaff });
        if (spam.ignore) {
            logIncoming(msg, chat, `ignored_spam_${spam.reason}`);
            appendLog({
                type: 'spam_ignored',
                chatId: chat.id._serialized,
                contact: chat.name,
                reason: spam.reason,
                message: userText.slice(0, 240),
            });
            return;
        }
    }

    logIncoming(msg, chat, 'queued');
    scheduleMessage(msg, chat);
}

async function processMessage(msg, chat, userText) {
    const chatId = chat.id._serialized;
    logIncoming(msg, chat, 'processing');

    try {
        const registeredStaff = findRegisteredStaff(chatId, chat.name);
        if (registeredStaff) {
            registerChatIdForStaff(registeredStaff.telefone, chatId);
        }

        const conversationKey = await resolveConversationKey(
            waClient,
            chatId,
            registeredStaff,
        );
        console.log(`[${chat.name || chatId}] conversa: ${conversationKey}`);

        const conversation = await readConversation(
            conversationKey,
            chatId,
            registeredStaff,
        );

        if (conversation.escalated) {
            if (!matchesHumanKeyword(userText)) {
                await withConversationState(
                    conversationKey,
                    chatId,
                    registeredStaff,
                    async (state) => {
                        state.escalated = false;
                    },
                );
                console.log(
                    `[${chat.name || chatId}] escalonamento cancelado — nova solicitação`,
                );
            } else {
                await sendChatReply(chat, msg, SYSTEM.escalationWaiting, {
                    quote: false,
                });
                appendLog({
                    type: 'message_while_escalated',
                    chatId,
                    message: userText,
                });
                return;
            }
        }

        if (botPaused) {
            console.log(`[${chat.name || chatId}] bot pausado — ignorado`);
            appendLog({ type: 'bot_paused', chatId, message: userText });
            await sendChatReply(chat, msg, SYSTEM.botPaused, { quote: false });
            return;
        }

        const outsideBusinessHours = !isWithinBusinessHours();

        if (matchesHumanKeyword(userText)) {
            await handleEscalation(
                msg,
                chat,
                chatId,
                registeredStaff,
                userText,
                conversationKey,
            );
            return;
        }

        const shouldWelcome =
            conversation.history.length === 0 &&
            Boolean(msg.body?.trim()) &&
            !matchesHumanKeyword(userText);

        if (shouldWelcome) {
            await sendChatReply(chat, msg, getWelcomeMessage(registeredStaff), {
                quote: false,
            });
        }

        await withTyping(chat, async () => {
            const context = await buildContext(userText, documentCatalog, {
                hasMedia: msg.hasMedia,
                outsideBusinessHours,
                conversationHistory: conversation.history,
            });

            if (needsSlowLookup(userText, context.intent)) {
                console.log(
                    `[${chat.name || chatId}] busca — avisando contato`,
                );
                try {
                    await sendChatReply(chat, msg, SYSTEM.slowLookup, {
                        quote: false,
                    });
                } catch {
                    /* ignore */
                }
            }

            const { rawReply } = await produceReply({
                conversation,
                userText,
                context,
                registeredStaff,
                documentCatalog,
            });

            const { reply, relativePath, sendPaths, outgoing } =
                resolveOutgoingFiles(
                    rawReply,
                    context.searchQuery || userText,
                    documentCatalog,
                    context.relevantDocs,
                );

            const historyLimit = registeredStaff
                ? config.historyLimitRegistered
                : config.historyLimitGuest;

            await withConversationState(
                conversationKey,
                chatId,
                registeredStaff,
                async (state) => {
                    state.history.push(
                        { role: 'user', content: userText },
                        { role: 'assistant', content: reply || rawReply },
                    );

                    if (state.history.length > historyLimit) {
                        state.history = state.history.slice(-historyLimit);
                    }
                },
            );

            await sendChatReply(chat, msg, outgoing, { quote: false });

            const sentFiles =
                sendPaths.length > 0
                    ? await maybeSendDocuments(chat, msg, sendPaths)
                    : false;

            if (relativePath && !sentFiles) {
                await sendChatReply(chat, msg, SYSTEM.fileNotFound, {
                    quote: false,
                });
            }

            appendLog({
                type: 'reply',
                chatId,
                contact: registeredStaff?.nome || chat.name,
                registered: Boolean(registeredStaff),
                intent: context.intent,
                outsideBusinessHours,
                message: userText,
                reply: outgoing,
                file: sendPaths.length === 1 ? sendPaths[0] : sendPaths,
            });

            console.log(
                `[${registeredStaff?.nome || chat.name || chatId}] ` +
                    `[${context.intent}] resposta enviada` +
                    (sendPaths.length
                        ? ` + ${sendPaths.length} arquivo(s)`
                        : ''),
            );
        });
    } catch (err) {
        console.error(`[${chatId}] Erro ao processar mensagem:`, err.message);
        appendLog({
            type: 'error',
            chatId,
            error: err.message,
            stack: err.stack,
        });
        try {
            await sendChatReply(chat, msg, SYSTEM.error, { quote: false });
        } catch {
            /* ignore */
        }
    }
}

function ensureDataDirs() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.mkdirSync(config.logsDir, { recursive: true });

    if (!config.docsRoot.startsWith('\\\\')) {
        try {
            fs.mkdirSync(config.docsRoot, { recursive: true });
        } catch (err) {
            console.warn('Pasta de documentos local não criada:', err.message);
        }
    }
}

if (!hasApiKey()) {
    console.error(
        'Defina OPENAI_API_KEY, GROQ_API_KEY e/ou GEMINI_API_KEY no .env',
    );
    process.exit(1);
}

async function boot() {
    await resolveProviders();
    ensureDataDirs();

    statusLog('Iniciando WhatsApp Web…');
    try {
        await initializeClientWithRetry();
        statusLog(
            'Navegador aberto — aguardando sincronização (pode levar 1–2 min)…',
        );
        setTimeout(() => {
            if (!client.info) {
                statusLog(
                    'Ainda sincronizando… Se passar de 3 min sem "conectado", feche e rode npm run bot de novo.',
                );
            }
        }, 90000);
    } catch (err) {
        console.error('Falha ao iniciar:', err);
        if (isNetworkError(err)) {
            logNetworkHint();
        } else if (isSessionError(err)) {
            logSessionResetHint();
        }
        process.exit(1);
    }
}

boot().catch((err) => {
    console.error('Falha ao iniciar bot:', err.message);
    process.exit(1);
});

function buildClientOptions() {
    return {
        authStrategy: new LocalAuth({ clientId: 'acesso-bot' }),
        authTimeoutMs: config.authTimeoutMs,
        // Sem webVersion fixo — usa cache local e, se faltar, o WhatsApp Web ao vivo.
        webVersionCache: {
            type: 'local',
            strict: false,
        },
        puppeteer: {
            headless: config.puppeteerHeadless,
            defaultViewport: null,
            args: [
                '--disable-gpu',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--no-first-run',
                '--disable-extensions',
            ],
        },
    };
}

const client = new Client(buildClientOptions());

waClient = client;

function isSessionError(error) {
    const text = String(error?.message || error || '').toLowerCase();
    return (
        text.includes('target closed') ||
        text.includes('targetcloseerror') ||
        text.includes('execution context was destroyed') ||
        (text.includes('protocol error') &&
            !text.includes('err_name_not_resolved'))
    );
}

function isNetworkError(error) {
    const text = String(error?.message || error || '').toLowerCase();
    return (
        text.includes('err_name_not_resolved') ||
        text.includes('err_internet_disconnected') ||
        text.includes('err_connection_refused') ||
        text.includes('err_connection_reset') ||
        text.includes('err_connection_timed_out') ||
        text.includes('err_network_changed') ||
        text.includes('enotfound') ||
        text.includes('enetunreach') ||
        text.includes('econnrefused')
    );
}

function logSessionResetHint() {
    console.error(
        '\n>>> Sessão WhatsApp possivelmente corrompida.\n' +
            '    1. Feche todas as instâncias do bot\n' +
            '    2. Apague a pasta .wwebjs_auth/session-acesso-bot\n' +
            '    3. (Opcional) Apague .wwebjs_cache\n' +
            '    4. Rode npm run bot e escaneie o QR Code de novo\n',
    );
}

function logNetworkHint() {
    console.error(
        '\n>>> Sem acesso a web.whatsapp.com (erro de rede/DNS).\n' +
            '    1. Abra https://web.whatsapp.com no Chrome deste PC\n' +
            '    2. Confira internet, Wi-Fi e VPN\n' +
            '    3. Rede da empresa pode bloquear WhatsApp — fale com TI\n' +
            '    4. Tente outro DNS (ex.: 8.8.8.8) ou aguarde e rode npm run bot de novo\n',
    );
}

async function initializeClientWithRetry() {
    let lastError;

    for (let attempt = 1; attempt <= config.waInitRetries; attempt++) {
        try {
            if (attempt > 1) {
                await client.destroy().catch(() => {});
                statusLog(
                    `Tentativa ${attempt}/${config.waInitRetries} de conectar ao WhatsApp Web…`,
                );
            }
            await client.initialize();
            return;
        } catch (err) {
            lastError = err;
            const retryable = isNetworkError(err) || isSessionError(err);
            console.error(
                `Falha ao iniciar (tentativa ${attempt}/${config.waInitRetries}):`,
                err.message,
            );

            if (!retryable || attempt === config.waInitRetries) {
                break;
            }

            statusLog(
                `Aguardando ${config.waInitRetryDelayMs / 1000}s para tentar de novo…`,
            );
            await new Promise((resolve) =>
                setTimeout(resolve, config.waInitRetryDelayMs),
            );
        }
    }

    throw lastError;
}

async function reconnectClient(reason) {
    if (reconnecting) return;

    reconnecting = true;
    statusLog(
        `Reconectando em ${config.reconnectDelayMs / 1000}s (${reason})…`,
    );

    await new Promise((resolve) =>
        setTimeout(resolve, config.reconnectDelayMs),
    );

    try {
        await client.destroy().catch(() => {});
        await initializeClientWithRetry();
        statusLog('Reconexão iniciada.');
    } catch (err) {
        console.error('Falha ao reconectar:', err.message);
        if (isNetworkError(err)) {
            logNetworkHint();
        } else if (isSessionError(err)) {
            logSessionResetHint();
        }
    } finally {
        reconnecting = false;
    }
}

function statusLog(message) {
    const ts = new Date().toLocaleTimeString('pt-BR');
    console.log(`[${ts}] ${message}`);
}

client.on('qr', (qr) => {
    statusLog('QR Code gerado — escaneie com o celular:');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    statusLog('WhatsApp autenticado — sincronizando conversas…');
});

client.on('loading_screen', (percent, message) => {
    statusLog(`Carregando ${message || 'WhatsApp'}: ${percent}%`);
});

client.on('change_state', (state) => {
    statusLog(`Estado WhatsApp: ${state}`);
});

client.on('ready', async () => {
    clientReady = true;
    const adminDigits = formatPhoneForAdmin(client.info?.wid);
    statusLog('Assistente Acesso Equipamentos conectado e pronto.');
    console.log(
        '\n>>> Para testar: envie mensagem DE OUTRO celular para este WhatsApp.\n' +
            '    Mensagens enviadas por este próprio número são ignoradas.\n' +
            '    Admin: !ping | !status | !ativar | !pausar\n',
    );
    refreshDocumentCatalog().catch((err) => {
        console.error(
            'Erro ao indexar documentos (bot continua ativo):',
            err.message,
        );
    });
    startCatalogRefreshTimer();
    statusLog(
        `Modelo IA: ${getProviderLabel(getPrimaryProvider())} / ${getChatModel()}`,
    );
    statusLog(`Debounce mensagens: ${config.messageDebounceMs / 1000}s`);
    statusLog(
        `Expediente: ${config.businessStart}–${config.businessEnd} (${config.timezone})`,
    );
    statusLog(`E-mail: ${getModeLabel()}`);
    statusLog(`Pasta de documentos: ${config.docsRoot}`);
    if (!config.adminPhone && adminDigits) {
        console.log(`\n>>> Defina no .env: ADMIN_PHONE=${adminDigits}`);
        console.log('    (ou envie !meunumero para este WhatsApp)\n');
    }
});

client.on('message', (msg) => {
    handleMessage(msg).catch((err) => {
        console.error('Erro não tratado:', err.message);
        appendLog({ type: 'unhandled', error: err.message, from: msg.from });
    });
});

client.on('auth_failure', (msg) => {
    console.error('Falha de autenticação WhatsApp:', msg);
    if (isSessionError(msg)) {
        logSessionResetHint();
    } else {
        statusLog(
            'Não foi possível restaurar a sessão. Apague .wwebjs_auth/session-acesso-bot e escaneie o QR de novo.',
        );
    }
});

client.on('disconnected', (reason) => {
    clientReady = false;
    console.error('WhatsApp desconectado:', reason);
    reconnectClient(reason).catch((err) => {
        console.error('Erro ao reconectar:', err.message);
    });
});
