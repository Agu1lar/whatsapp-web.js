'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

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

function getConversationKey(chatId, registeredStaff) {
    if (registeredStaff) {
        return `funcionario:${normalizePhone(registeredStaff.telefone)}`;
    }
    return `guest:${chatId}`;
}

function normalizePhone(value) {
    return String(value || '').replace(/\D/g, '');
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

function appendLog(entry) {
    fs.mkdirSync(config.logsDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const line = `[${new Date().toISOString()}] ${JSON.stringify(entry)}\n`;
    fs.appendFileSync(path.join(config.logsDir, `${date}.log`), line, 'utf8');
}

module.exports = {
    loadAllStates,
    saveAllStates,
    getConversationKey,
    getConversation,
    appendLog,
};
