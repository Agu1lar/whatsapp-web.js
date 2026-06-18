'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('./index');
const config = require('./lib/config');
const {
    isWithinBusinessHours,
    getOutsideHoursMessage,
} = require('./lib/hours');
const { SYSTEM } = require('./lib/messages');
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
    extractMessageText,
    withTyping,
    buildContext,
    produceReply,
    resolveOutgoingFiles,
    shouldAnnounceLookup,
} = require('./lib/assistant');
const { matchesHumanKeyword } = require('./lib/groq');
const { resolveDocument } = require('./lib/documents');
const { isConfigured: mailConfigured, getModeLabel } = require('./lib/mail');

const ESCALATION_REPLY = SYSTEM.escalation;

const messageQueues = new Map();
let documentCatalog = [];
let botPaused = false;
let waClient = null;
let reconnecting = false;
let catalogRefreshTimer = null;

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
    if (queue.processing || queue.items.length === 0) {
        return;
    }

    queue.processing = true;
    const batch = queue.items.splice(0);

    try {
        const combinedText = batch
            .map((entry) => extractMessageText(entry.msg))
            .filter(Boolean)
            .join('\n');
        const last = batch[batch.length - 1];
        await processMessage(last.msg, last.chat, combinedText);
    } finally {
        queue.processing = false;
        if (queue.items.length > 0) {
            await drainMessageQueue(chatId);
        }
    }
}

async function refreshDocumentCatalog() {
    const { loadCatalog } = require('./lib/documents');
    documentCatalog = await loadCatalog(config.docsRoot);
    refreshCompanyKnowledge();
    console.log(
        `Documentos indexados: ${documentCatalog.length} em ${config.docsRoot}`,
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
        const outlook = mailConfigured() ? 'conectado' : 'não configurado';
        await msg.reply(
            `Status:\n` +
                `- Bot: ${botPaused ? 'pausado' : 'ativo'}\n` +
                `- IA: ${config.groqModel}\n` +
                `- Debounce: ${config.messageDebounceMs / 1000}s\n` +
                `- E-mail: ${getModeLabel()} (${outlook})\n` +
                `- Documentos: ${documentCatalog.length}`,
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

async function maybeSendDocuments(msg, relativePaths) {
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
        await msg.reply(media, undefined, { caption });
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

    await msg.reply(ESCALATION_REPLY);

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
    if (msg.fromMe || msg.isStatus || msg.broadcast) return;

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

    if (isAdmin(msg) || !config.adminPhone) {
        const handled = await handleAdminCommand(msg);
        if (handled) return;
    }

    const userText = extractMessageText(msg);

    if (!userText) {
        logIncoming(msg, chat, 'empty_body');
        await msg.reply(SYSTEM.emptyBody);
        return;
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
                await msg.reply(SYSTEM.escalationWaiting);
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
            if (isAdmin(msg)) {
                await msg.reply(
                    'Bot pausado. Envie !ativar para retomar o atendimento automático.',
                );
            }
            return;
        }

        if (!isWithinBusinessHours()) {
            await msg.reply(getOutsideHoursMessage());
            appendLog({ type: 'outside_hours', chatId, message: userText });
            return;
        }

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

        await withTyping(chat, async () => {
            const context = await buildContext(userText, documentCatalog, {
                hasMedia: msg.hasMedia,
            });

            if (needsSlowLookup(userText, context.intent)) {
                console.log(
                    `[${chat.name || chatId}] busca — avisando contato`,
                );
                try {
                    await msg.reply(SYSTEM.slowLookup);
                } catch {
                    /* ignore */
                }
            }

            const { rawReply } = await produceReply({
                conversation,
                userText,
                context,
                registeredStaff,
            });

            const { reply, relativePath, sendPaths, outgoing } =
                resolveOutgoingFiles(
                    rawReply,
                    userText,
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

            await msg.reply(outgoing);

            const sentFiles =
                sendPaths.length > 0
                    ? await maybeSendDocuments(msg, sendPaths)
                    : false;

            if (relativePath && !sentFiles) {
                await msg.reply(SYSTEM.fileNotFound);
            }

            appendLog({
                type: 'reply',
                chatId,
                contact: registeredStaff?.nome || chat.name,
                registered: Boolean(registeredStaff),
                intent: context.intent,
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
            await msg.reply(SYSTEM.error);
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

if (!config.groqApiKey) {
    console.error('Defina GROQ_API_KEY no arquivo .env');
    process.exit(1);
}

ensureDataDirs();

const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'acesso-bot' }),
    authTimeoutMs: 120000,
    webVersion: '2.3000.1041720460',
    puppeteer: {
        headless: false,
        args: ['--disable-gpu', '--no-sandbox'],
    },
});

waClient = client;

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
    const adminDigits = formatPhoneForAdmin(client.info?.wid);
    statusLog('Assistente Acesso Equipamentos conectado e pronto.');
    refreshDocumentCatalog().catch((err) => {
        console.error(
            'Erro ao indexar documentos (bot continua ativo):',
            err.message,
        );
    });
    startCatalogRefreshTimer();
    statusLog(`Modelo IA: ${config.groqModel}`);
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
});

client.on('disconnected', (reason) => {
    console.error('WhatsApp desconectado:', reason);
    if (reconnecting) return;

    reconnecting = true;
    statusLog(`Reconectando em ${config.reconnectDelayMs / 1000}s…`);

    setTimeout(() => {
        client
            .initialize()
            .then(() => {
                statusLog('Reconexão iniciada.');
            })
            .catch((err) => {
                console.error('Falha ao reconectar:', err.message);
            })
            .finally(() => {
                reconnecting = false;
            });
    }, config.reconnectDelayMs);
});

statusLog('Iniciando WhatsApp Web…');
client
    .initialize()
    .then(() => {
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
    })
    .catch((err) => {
        console.error('Falha ao iniciar:', err);
        process.exit(1);
    });
