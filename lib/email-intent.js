'use strict';

function normalize(text) {
    return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

function shouldSearchOutlook(userText) {
    const text = normalize(userText);

    const patterns = [
        /\b(e-?)?mails?\b/,
        /\boutlook\b/,
        /\bcorreio\b/,
        /\binbox\b/,
        /\bcaixa de entrada\b/,
        /\b(tem|teve|chegou|ver|ler|consultar|buscar|procurar|mostrar|mostra|manda|mandar)\b.{0,30}\b(e-?)?mails?\b/,
        /\b(e-?)?mails?\b.{0,30}\b(novo|nova|novos|novas|recente|ultimo|ultima|nao lido|não lido)\b/,
        /\b(ultimos?|ultimas?|recentes?)\b.{0,20}\b(e-?)?mails?\b/,
    ];

    return patterns.some((pattern) => pattern.test(text));
}

function parseEmailRequest(userText, defaultLimit = 5) {
    const text = normalize(userText);

    const stopWords = new Set([
        'email',
        'emails',
        'mail',
        'outlook',
        'correio',
        'inbox',
        'caixa',
        'entrada',
        'tem',
        'algum',
        'alguma',
        'meu',
        'minha',
        'nos',
        'nas',
        'por',
        'para',
        'com',
        'sem',
        'ver',
        'ler',
        'buscar',
        'procurar',
        'consultar',
        'checar',
        'mostrar',
        'mostra',
        'manda',
        'mandar',
        'ultimo',
        'ultima',
        'ultimos',
        'ultimas',
        'recente',
        'recentes',
        'novo',
        'nova',
        'novos',
        'novas',
        'lido',
        'lida',
        'lidos',
        'lidas',
        'nao',
        'que',
        'qual',
        'quais',
        'sobre',
        'jose',
        'josé',
        'favor',
        'oi',
        'ola',
        'beleza',
        'voce',
        'você',
        'vc',
    ]);

    let mode = 'recent';

    if (/\b(n[aã]o lid[oa]s?|unread)\b/.test(text)) {
        mode = 'unread';
    }

    const terms = normalize(userText)
        .split(/\s+/)
        .map((word) => word.replace(/[^\w@.-]/g, ''))
        .filter((word) => word.length > 2 && !stopWords.has(word));

    if (terms.length > 0 && mode !== 'unread') {
        mode = 'search';
    }

    return {
        mode,
        query: terms.join(' '),
        limit: mode === 'search' ? Math.min(8, defaultLimit + 2) : defaultLimit,
    };
}

module.exports = {
    shouldSearchOutlook,
    parseEmailRequest,
};
