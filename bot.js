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
const {
    findRegisteredStaff,
    registerChatIdForStaff,
    normalizePhone,
    formatPhoneForAdmin,
} = require('./lib/funcionarios');
const {
    loadAllStates,
    saveAllStates,
    getConversationKey,
    getConversation,
    appendLog,
} = require('./lib/conversations');
const {
    loadCatalog,
    searchCatalog,
    buildCatalogSummary,
    buildRelevantContext,
    resolveDocument,
} = require('./lib/documents');
const {
    isConfigured: mailConfigured,
    getModeLabel,
    searchEmails,
    buildEmailContext,
    shouldSearchOutlook,
    parseEmailRequest,
} = require('./lib/mail');
const {
    generateReply,
    parseSendFileDirective,
    matchesHumanKeyword,
} = require('./lib/groq');

const ESCALATION_REPLY =
    'Beleza, entendi! Vou avisar o José aqui e ele te retorna assim que puder 👍';

const processing = new Map();
const PROCESSING_STALE_MS = 3 * 60 * 1000;
let documentCatalog = [];
let botPaused = false;
let waClient = null;

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

function isProcessing(chatId) {
    const startedAt = processing.get(chatId);
    if (!startedAt) return false;

    if (Date.now() - startedAt > PROCESSING_STALE_MS) {
        console.warn(`[${chatId}] lock expirado — liberando`);
        processing.delete(chatId);
        return false;
    }

    return true;
}

function needsSlowLookup(text) {
    const n = text.toLowerCase();
    return (
        /certificado|documento|arquivo|pdf|anexo|manual|procedimento/.test(n) ||
        /manda|envia|preciso|busca|procura/.test(n)
    );
}

async function refreshDocumentCatalog() {
    documentCatalog = await loadCatalog(config.docsRoot);
    console.log(
        `Documentos indexados: ${documentCatalog.length} em ${config.docsRoot}`,
    );
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
            `Status:\n- Bot: ${botPaused ? 'pausado' : 'ativo'}\n- E-mail: ${getModeLabel()} (${outlook})\n- Modelo: ${config.groqModel}\n- Documentos: ${documentCatalog.length}`,
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

    return false;
}

async function maybeSendDocument(msg, relativePath) {
    const filePath = resolveDocument(
        config.docsRoot,
        documentCatalog,
        relativePath,
    );

    if (!filePath || !fs.existsSync(filePath)) {
        await msg.reply(
            'Não achei esse arquivo aqui. Me descreve melhor o que você precisa?',
        );
        return;
    }

    const media = MessageMedia.fromFilePath(filePath);
    const caption = path.basename(filePath);
    await msg.reply(media, undefined, { caption });
}

function isPrivateChat(chat) {
    return !chat.isGroup && !chat.isChannel;
}

async function handleEscalation(msg, chat, chatId, registeredStaff, userText) {
    const states = loadAllStates();
    const key = getConversationKey(chatId, registeredStaff);
    const conversation = getConversation(states, key);
    conversation.escalated = true;
    conversation.updatedAt = new Date().toISOString();
    saveAllStates(states);

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

    const chatId = chat.id._serialized;

    if (isAdmin(msg) || !config.adminPhone) {
        const handled = await handleAdminCommand(msg);
        if (handled) return;
    }

    const userText = msg.body?.trim();

    if (!userText) {
        logIncoming(msg, chat, 'empty_body');
        await msg.reply('Manda em texto que consigo te ajudar melhor 🙂');
        return;
    }

    if (isProcessing(chatId)) {
        logIncoming(msg, chat, 'ignored_busy');
        try {
            await msg.reply(
                'Recebi! Já tô vendo sua mensagem anterior, um instante 👍',
            );
        } catch {
            /* ignore */
        }
        return;
    }

    processing.set(chatId, Date.now());
    logIncoming(msg, chat, 'processing');

    try {
        const registeredStaff = findRegisteredStaff(chatId, chat.name);
        if (registeredStaff) {
            registerChatIdForStaff(registeredStaff.telefone, chatId);
        }

        const states = loadAllStates();
        const key = getConversationKey(chatId, registeredStaff);
        const conversation = getConversation(states, key);

        if (conversation.escalated) {
            if (!matchesHumanKeyword(userText)) {
                conversation.escalated = false;
                saveAllStates(states);
                console.log(
                    `[${chat.name || chatId}] escalonamento cancelado — nova solicitação`,
                );
            } else {
                await msg.reply(
                    'José já foi avisado. Se quiser, pode ir mandando sua dúvida que registro aqui.',
                );
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
            );
            return;
        }

        if (needsSlowLookup(userText)) {
            console.log(
                `[${chat.name || chatId}] busca lenta — avisando contato`,
            );
            try {
                await msg.reply('Deixa comigo, vou dar uma olhada aqui…');
            } catch {
                /* ignore */
            }
        }

        const relevantDocs = await searchCatalog(
            documentCatalog,
            userText,
            config.docsRoot,
        );
        const catalogSummary = buildCatalogSummary(
            documentCatalog,
            relevantDocs,
        );
        const relevantContext = buildRelevantContext(relevantDocs);

        let emailContext = '';
        let outlookEnabled = false;

        if (mailConfigured() && shouldSearchOutlook(userText)) {
            const emailRequest = parseEmailRequest(userText);
            const emails = await searchEmails(emailRequest);
            emailContext = buildEmailContext(emails);
            outlookEnabled = true;
        }

        const rawReply = await generateReply({
            conversation,
            userText,
            catalogSummary,
            relevantContext,
            emailContext,
            registeredStaff,
            outlookEnabled,
        });

        const { text: reply, relativePath } = parseSendFileDirective(rawReply);

        conversation.history.push(
            { role: 'user', content: userText },
            { role: 'assistant', content: reply || rawReply },
        );

        const historyLimit = config.historyLimitRegistered;

        if (conversation.history.length > historyLimit) {
            conversation.history = conversation.history.slice(-historyLimit);
        }

        conversation.updatedAt = new Date().toISOString();
        saveAllStates(states);

        const outgoing =
            reply ||
            'Beleza, já olhei aqui. Me fala um pouco mais do que você precisa?';

        await msg.reply(outgoing);

        if (relativePath) {
            await maybeSendDocument(msg, relativePath);
        }

        appendLog({
            type: 'reply',
            chatId,
            contact: registeredStaff?.nome || chat.name,
            registered: Boolean(registeredStaff),
            message: userText,
            reply: outgoing,
            file: relativePath,
        });

        console.log(
            `[${registeredStaff?.nome || chat.name || chatId}] resposta enviada` +
                (relativePath ? ` + arquivo: ${relativePath}` : ''),
        );
    } catch (err) {
        console.error(`[${chatId}] Erro ao processar mensagem:`, err.message);
        appendLog({
            type: 'error',
            chatId,
            error: err.message,
            stack: err.stack,
        });
        try {
            await msg.reply(
                'Opa, deu um probleminha aqui do meu lado. Tenta de novo daqui a pouco, ou fala com o José direto.',
            );
        } catch {
            /* ignore */
        }
    } finally {
        processing.delete(chatId);
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
    statusLog('Bot Acesso Equipamentos conectado e pronto.');
    refreshDocumentCatalog().catch((err) => {
        console.error(
            'Erro ao indexar documentos (bot continua ativo):',
            err.message,
        );
    });
    statusLog(`Modelo IA: ${config.groqModel}`);
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
