'use strict';

const fs = require('fs');
const config = require('./config');

function normalizePhone(value) {
    return String(value || '').replace(/\D/g, '');
}

function loadStaff() {
    try {
        if (fs.existsSync(config.staffFile)) {
            return JSON.parse(fs.readFileSync(config.staffFile, 'utf8'));
        }
    } catch (err) {
        console.error('Erro ao ler funcionários:', err.message);
    }
    return { funcionarios: [] };
}

function saveStaff(data) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(config.staffFile, JSON.stringify(data, null, 2), 'utf8');
}

function findRegisteredStaff(chatId, contactName = '') {
    const data = loadStaff();
    const chatDigits = normalizePhone(chatId.split('@')[0]);
    const contactDigits = normalizePhone(contactName);

    for (const person of data.funcionarios) {
        const registeredDigits = normalizePhone(person.telefone);
        const altIds = (person.chatIds || []).map((id) =>
            normalizePhone(id.split('@')[0]),
        );

        const matchesPhone =
            registeredDigits &&
            (chatDigits.endsWith(registeredDigits) ||
                registeredDigits.endsWith(chatDigits.slice(-11)) ||
                altIds.some(
                    (id) =>
                        chatDigits.endsWith(id) ||
                        id.endsWith(chatDigits.slice(-11)),
                ));

        if (matchesPhone) {
            return person;
        }

        if (
            contactDigits &&
            registeredDigits &&
            contactDigits.endsWith(registeredDigits.slice(-11))
        ) {
            return person;
        }
    }

    return null;
}

function registerChatIdForStaff(staffPhone, chatId) {
    const data = loadStaff();
    const digits = normalizePhone(staffPhone);

    const person = data.funcionarios.find(
        (f) => normalizePhone(f.telefone) === digits,
    );
    if (!person) return false;

    person.chatIds = person.chatIds || [];
    if (!person.chatIds.includes(chatId)) {
        person.chatIds.push(chatId);
        saveStaff(data);
    }
    return true;
}

function formatPhoneForAdmin(wid) {
    const serialized = wid?._serialized || wid || '';
    const digits = normalizePhone(serialized.split('@')[0]);
    return digits;
}

module.exports = {
    loadStaff,
    saveStaff,
    findRegisteredStaff,
    registerChatIdForStaff,
    normalizePhone,
    formatPhoneForAdmin,
};
