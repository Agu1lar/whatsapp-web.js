'use strict';

function normalize(text) {
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/[,!?.]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isSimpleGreeting(text) {
    const n = normalize(text);

    const greetingPatterns = [
        /^(oi|ola|hey|salve|eai|e ai|fala|opa)$/,
        /^(bom dia|boa tarde|boa noite)$/,
        /^(bom dia|boa tarde|boa noite)\s+\w+$/,
        /^\w+\s+(bom dia|boa tarde|boa noite)$/,
        /^(oi|ola|opa|fala)\s+\w+$/,
        /^\w+\s+(oi|ola)$/,
        /^(bom dia|boa tarde|boa noite)\s+(jose|josé)$/,
        /^(jose|josé)\s+(bom dia|boa tarde|boa noite)$/,
    ];

    return greetingPatterns.some((pattern) => pattern.test(n));
}

function matchesHumanKeyword(text) {
    const n = normalize(text);

    if (!n || isSimpleGreeting(n)) {
        return false;
    }

    const patterns = [
        /\batendente\b/,
        /\b(humano|pessoa real|gente de verdade)\b/,
        /\b(falar|fala|quero|preciso|chama|chamar|passa|passar|transferir)\b.{0,30}\b(jose|josé)\b/,
        /\b(jose|josé)\b.{0,20}\b(por favor|pfv|pf|urgente)\b/,
        /\b(quero|preciso)\b.{0,20}\b(atendente|humano)\b/,
        /\bme passa\b.{0,20}\b(jose|josé)\b/,
    ];

    return patterns.some((pattern) => pattern.test(n));
}

module.exports = {
    matchesHumanKeyword,
    isSimpleGreeting,
};
