'use strict';

const config = require('./config');
const { isSimpleGreeting } = require('./human-intent');
const { callChatCompletion, getSpamModel } = require('./llm');

const OBVIOUS_SPAM_PATTERNS = [
    /\b2a?\s*via\b|\bsegunda\s+via\b/i,
    /\bfatura\b.{0,40}\b(dispon[ií]vel|emitid|venc|aberto|fechad)/i,
    /\b(dispon[ií]vel|emitid).{0,40}\bfatura\b/i,
    /\bboleto\b.{0,40}\b(dispon[ií]vel|emitid|venc|pagar|aberto)/i,
    /\bpagar\s+(sua\s+)?(fatura|boleto|conta)\b/i,
    /\blinha\s+digit[aá]vel\b/i,
    /\bc[oó]digo\s+de\s+barras\b/i,
    /\bd[eé]bito\s+autom[aá]tico\b/i,
    /\bconta\s+de\s+(luz|agua|água|internet|telefone|g[aá]s)\b/i,
    /\bregularize\s+(sua\s+)?situa[cç][aã]o\b/i,
    /\binadimpl[eê]ncia\b/i,
    /\bcobran[cç]a\s+autom[aá]tica\b/i,
    /\bmensagem\s+autom[aá]tica\b/i,
    /\b(nao|não)\s+responda\b.{0,20}\b(email|e-mail|mensagem)\b/i,
    /\bnoreply@/i,
    /\boferta\s+(imperd[ií]vel|exclusiva|limitada)\b/i,
    /\bpromo[cç][aã]o\s+(imperd[ií]vel|exclusiva|rel[aâ]mpago)\b/i,
    /\bparceria\s+comercial\b/i,
    /\boportunidade\s+de\s+(neg[oó]cio|renda|trabalho)\b/i,
    /\bganhe\s+dinheiro\b/i,
    /\b(empr[eé]stimo|cons[oó]rcio)\s+(pr[eé]|aprova|liberad)/i,
    /\b(cripto|bitcoin|forex|investimento)\s+(garantid|lucro|renda)/i,
    /\bcurso\s+gratuito\b.{0,30}\b(clique|acesse|inscrev)/i,
    /\btrabalhamos\s+com\s+(marketing|divulga|vendas|leads)\b/i,
    /\boferecemos\s+(servi[cç]os|solu[cç][oõ]es)\s+de\b/i,
    /\b(divulga[cç][aã]o|prospec[cç][aã]o)\s+comercial\b/i,
    /\bclique\s+(no\s+link|aqui)\s+para\s+(pagar|emitir|baixar)\b/i,
    /\bacesse\s+o\s+link\b.{0,30}\b(pagar|fatura|boleto)\b/i,
    /\bcompartilhe\s+com\s+\d+\s+contatos\b/i,
    /\bvoc[eê]\s+foi\s+selecionad[oa]\b/i,
    /\b(cart[aã]o|limite)\s+pr[eé]\s+aprovad/i,
    /\brefinanciamento\s+dispon[ií]vel\b/i,
    /\bfinanciamento\s+dispon[ií]vel\b/i,
    /\bresponda\s+sim\s+para\s+receber\b/i,
    /\bresponda\s+sim\b.{0,30}\bboleto\b/i,
    /\b\d+x\s+de\s+r\$\s*[\d.,]+/i,
    /\bentrada\s*:\s*r?\$?\s*[\d.,]+/i,
    /\bcr[eé]dito\s+(pr[eé]|liberad|dispon[ií]vel)/i,
    /\b(empr[eé]stimo|financiamento)\s+dispon[ií]vel\b/i,
    /\bparcelas?\s+de\s+r\$\s*[\d.,]+/i,
    /\bsim\s+para\s+(receber|emitir)\s+o\s+boleto\b/i,
];

const WEAK_SPAM_SIGNALS = [
    /\bfatura\b/i,
    /\bboleto\b/i,
    /\bvencimento\b/i,
    /\bcobran[cç]a\b/i,
    /\bpromo[cç][aã]o\b/i,
    /\boferta\b/i,
    /\bmarketing\b/i,
    /\bparceria\b/i,
    /\bclique\s+aqui\b/i,
    /\bacesse\s+o\s+link\b/i,
    /\bhttp[s]?:\/\//i,
    /\bwww\./i,
    /\bpre[cç]o\s+especial\b/i,
    /\bconsultor(?:ia)?\s+gratuita\b/i,
    /\brefinanciamento\b/i,
    /\bfinanciamento\b/i,
    /\bempr[eé]stimo\b/i,
    /\bcons[oó]rcio\b/i,
    /\bresponda\s+sim\b/i,
    /\bentrada\s*:/i,
    /\b\d+x\s+de\s+r\$/i,
];

function normalize(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function countUrls(text) {
    const matches = text.match(/https?:\/\/\S+|www\.\S+/gi);
    return matches ? matches.length : 0;
}

function hasFinancialSpamSignals(text) {
    const sample = String(text || '').slice(0, 1200);
    return (
        /\b(refinanciamento|financiamento|emprestimo|empr[eé]stimo|consorcio|cons[oó]rcio)\b/i.test(
            sample,
        ) ||
        /\bresponda\s+sim\b/i.test(sample) ||
        /\b\d+x\s+de\s+r\$/i.test(sample) ||
        /\bentrada\s*:\s*[\d.,]+/i.test(sample)
    );
}

function matchesObviousSpam(text) {
    const sample = String(text || '').slice(0, 1200);
    if (OBVIOUS_SPAM_PATTERNS.some((pattern) => pattern.test(sample))) {
        return true;
    }

    const normalized = normalize(sample);
    if (/\brefinanciamento\b/.test(normalized) && /\bdispon/.test(normalized)) {
        return true;
    }

    if (
        /\bresponda\s+sim\b/.test(normalized) &&
        /\bboleto\b/.test(normalized)
    ) {
        return true;
    }

    if (
        /\b\d+x\s+de\s+r\$/.test(normalized) &&
        /\bentrada\s*:/.test(normalized)
    ) {
        return true;
    }

    return false;
}

function weakSpamScore(text) {
    const normalized = normalize(text);
    if (!normalized) {
        return 0;
    }

    let score = 0;
    for (const pattern of WEAK_SPAM_SIGNALS) {
        if (pattern.test(normalized)) {
            score += 1;
        }
    }

    if (countUrls(text) >= 2) {
        score += 2;
    }

    if (normalized.length > 280 && countUrls(text) >= 1) {
        score += 1;
    }

    return score;
}

function shouldUseAiClassifier(text, registeredStaff) {
    if (!config.spamFilterAi || registeredStaff) {
        return false;
    }

    if (isSimpleGreeting(text)) {
        return false;
    }

    if (hasFinancialSpamSignals(text)) {
        return true;
    }

    return weakSpamScore(text) >= config.spamFilterAiMinScore;
}

async function classifyWithGroq(text) {
    try {
        const answer = await callChatCompletion(
            [
                {
                    role: 'system',
                    content:
                        'Você classifica mensagens recebidas no WhatsApp corporativo da área de TI da Acesso Equipamentos. ' +
                        'Responda SPAM se for: cobrança/fatura/boleto automático, refinanciamento ou empréstimo não solicitado, ' +
                        'oferta financeira com parcelas/entrada, propaganda, marketing, golpe ou bot comercial. ' +
                        'Responda OK se for: dúvida legítima sobre documentos, certificados, TI, e-mail ou pedido para falar com o José. ' +
                        'Responda só uma palavra: SPAM ou OK.',
                },
                {
                    role: 'user',
                    content: String(text).slice(0, 900),
                },
            ],
            {
                model: getSpamModel(),
                temperature: 0,
                maxTokens: 4,
                maxAttempts: 1,
            },
        );

        return answer.toUpperCase() === 'SPAM';
    } catch (err) {
        console.warn('Classificação de spam falhou:', err.message);
        return false;
    }
}

async function shouldIgnoreAsSpam(text, options = {}) {
    const { registeredStaff = null } = options;

    if (!config.spamFilterEnabled) {
        return { ignore: false };
    }

    if (registeredStaff || !text?.trim()) {
        return { ignore: false };
    }

    if (isSimpleGreeting(text)) {
        return { ignore: false };
    }

    if (matchesObviousSpam(text)) {
        return { ignore: true, reason: 'obvious' };
    }

    if (shouldUseAiClassifier(text, registeredStaff)) {
        const isSpam = await classifyWithGroq(text);
        if (isSpam) {
            return { ignore: true, reason: 'ai' };
        }
    }

    return { ignore: false };
}

module.exports = {
    shouldIgnoreAsSpam,
    matchesObviousSpam,
    weakSpamScore,
};
