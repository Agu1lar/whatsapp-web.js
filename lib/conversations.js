'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

const conversationLocks = new Map();

function loadAllStates() {
    try {
        if (fs.existsSync(config.stateFile)) {
            return JSON.parse(fs.readFileSync(config.stateFile, 'utf8'));
        }
    } catch (err) {
        console.error('Erro ao ler conversas:', err.message);
    }
    return {};
}

function saveAllStates(states) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(config.stateFile, JSON.stringify(states, null, 2), 'utf8');
}

function normalizePhone(value) {
    return String(value || '').replace(/\D/g, '');
}

function legacyKeysForChat(chatId, registeredStaff) {
    const keys = [`guest:${chatId}`, `chat:${chatId}`];
    if (registeredStaff) {
        const staffPhone = normalizePhone(registeredStaff.telefone);
        if (staffPhone) {
            keys.push(`funcionario:${staffPhone}`, `contact:${staffPhone}`);
        }
    }
    return keys;
}

function adoptLegacyConversation(states, key, chatId, registeredStaff) {
    if (states[key]) {
        return;
    }

    for (const legacyKey of legacyKeysForChat(chatId, registeredStaff)) {
        if (legacyKey === key || !states[legacyKey]) {
            continue;
        }
        states[key] = states[legacyKey];
        delete states[legacyKey];
        return;
    }
}

async function resolveConversationKey(client, chatId, registeredStaff) {
    const staffPhone = normalizePhone(registeredStaff?.telefone);

    if (client?.getContactLidAndPhone) {
        try {
            const lookup = client.getContactLidAndPhone([chatId]);
            const timeout = new Promise((_, reject) => {
                setTimeout(
                    () => reject(new Error('timeout ao resolver telefone')),
                    config.contactLookupTimeoutMs,
                );
            });
            const [mapping] = await Promise.race([lookup, timeout]);
            const phoneDigits = normalizePhone(mapping?.pn?.split('@')[0]);
            if (phoneDigits.length >= 10) {
                return `contact:${phoneDigits}`;
            }
        } catch (err) {
            console.warn(
                `Não foi possível resolver telefone de ${chatId}:`,
                err.message,
            );
        }
    }

    if (staffPhone.length >= 10) {
        return `contact:${staffPhone}`;
    }

    return `chat:${chatId}`;
}

function getConversation(states, key) {
    if (!states[key]) {
        states[key] = {
            history: [],
            escalated: false,
            updatedAt: new Date().toISOString(),
        };
    }
    return states[key];
}

async function withConversationLock(key, fn) {
    const previous = conversationLocks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
        release = resolve;
    });
    conversationLocks.set(
        key,
        previous.then(() => current),
    );

    await previous;
    try {
        return await fn();
    } finally {
        release();
        if (conversationLocks.get(key) === current) {
            conversationLocks.delete(key);
        }
    }
}

async function withConversationState(key, chatId, registeredStaff, updater) {
    return withConversationLock(key, async () => {
        const states = loadAllStates();
        adoptLegacyConversation(states, key, chatId, registeredStaff);
        const conversation = getConversation(states, key);
        const result = await updater(conversation, states);
        conversation.updatedAt = new Date().toISOString();
        saveAllStates(states);
        return result !== undefined ? result : conversation;
    });
}

async function readConversation(key, chatId, registeredStaff) {
    return withConversationState(
        key,
        chatId,
        registeredStaff,
        async (conversation) => ({
            history: [...conversation.history],
            escalated: conversation.escalated,
            updatedAt: conversation.updatedAt,
        }),
    );
}

function appendLog(entry) {
    fs.mkdirSync(config.logsDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const line = `[${new Date().toISOString()}] ${JSON.stringify(entry)}\n`;
    fs.appendFileSync(path.join(config.logsDir, `${date}.log`), line, 'utf8');
}

module.exports = {
    loadAllStates,
    saveAllStates,
    resolveConversationKey,
    withConversationState,
    readConversation,
    appendLog,
};
