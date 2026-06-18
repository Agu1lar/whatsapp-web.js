'use strict';

const config = require('./config');
const { matchesHumanKeyword } = require('./human-intent');

const SEND_FILE_REGEX = /@@SEND:([^\n@]+)@@/;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
    return RETRYABLE_STATUSES.has(status);
}

function temperatureForIntent(intent) {
    if (intent === 'document' || intent === 'email') {
        return config.groqTemperatureFactual;
    }
    if (intent === 'greeting') {
        return config.groqTemperatureCreative;
    }
    return config.groqTemperature;
}

async function callGroq(messages, options = {}) {
    const { intent = 'general' } = options;
    const maxAttempts = config.groqMaxRetries;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(
            () => controller.abort(),
            config.groqRequestTimeoutMs,
        );

        let response;
        try {
            response = await fetch(
                'https://api.groq.com/openai/v1/chat/completions',
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${config.groqApiKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        model: config.groqModel,
                        messages,
                        temperature: temperatureForIntent(intent),
                        max_tokens: config.groqMaxTokens,
                    }),
                    signal: controller.signal,
                },
            );
        } catch (err) {
            clearTimeout(timeout);
            if (err.name === 'AbortError') {
                throw new Error(
                    `Groq excedeu ${config.groqRequestTimeoutMs / 1000}s`,
                );
            }
            throw err;
        }
        clearTimeout(timeout);

        if (!response.ok) {
            const errorBody = await response.text();
            if (attempt < maxAttempts && isRetryableStatus(response.status)) {
                const waitMs = 1000 * attempt;
                console.warn(
                    `Groq ${response.status} — tentativa ${attempt}/${maxAttempts}, aguardando ${waitMs}ms`,
                );
                await sleep(waitMs);
                continue;
            }
            throw new Error(`Groq API ${response.status}: ${errorBody}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content?.trim();

        if (!content) {
            throw new Error('Groq retornou resposta vazia');
        }

        return content;
    }

    throw new Error('Groq: tentativas esgotadas');
}

function buildSystemPrompt({
    catalogSummary,
    relevantContext,
    emailContext,
    registeredStaff,
    outlookEnabled,
    companyKnowledge,
    dateTimeContext,
    intent,
    outsideBusinessHours = false,
}) {
    const staffInfo = registeredStaff
        ? `Funcionário interno: ${registeredStaff.nome}${registeredStaff.setor ? ` (${registeredStaff.setor})` : ''}. Pode usar o primeiro nome. Tom levemente mais direto, mas sempre profissional.`
        : 'Cliente ou contato externo — use tom formal-cordial de atendimento corporativo. Não use gírias nem informalidade excessiva.';

    const outlookInfo = outlookEnabled
        ? `\nE-mails consultados agora (use SOMENTE isto, não invente):\n${emailContext}`
        : '';

    const knowledgeBlock = companyKnowledge
        ? `\nConhecimento da empresa:\n${companyKnowledge}\n`
        : '';

    const intentHint =
        intent === 'document'
            ? '\nFoco agora: pedido de documento/arquivo. Confirme o que encontrou ou peça um detalhe (nome, empresa, data) se faltar contexto.'
            : intent === 'email'
              ? '\nFoco agora: consulta de e-mail. Responda só com o que veio da caixa de entrada consultada.'
              : '';

    const outsideHoursBlock = outsideBusinessHours
        ? `\nExpediente humano encerrado (fora de ${config.businessStart}–${config.businessEnd}, seg–sex):
- CONTINUE atendendo normalmente: tire dúvidas, use os documentos listados e envie arquivos quando solicitado.
- NÃO bloqueie o atendimento nem diga que "só registrou a mensagem".
- Se precisarem do José presencialmente ou de algo que só ele resolve: avise que ele retorna no próximo expediente.\n`
        : '';

    return `Você é a assistente virtual da área de tecnologia da Acesso Equipamentos. Atende o WhatsApp corporativo quando a equipe não está disponível — incluindo o José.

Identidade (obrigatório):
- Você NÃO é o José. Não fale em primeira pessoa como se fosse ele ("estou ocupado", "já vou aí").
- Identifique-se como canal/atendimento da área de tecnologia ou "equipe de tecnologia".
- Se precisar do José: diga que vai encaminhar ou que ele retorna — nunca simule que ele está respondendo agora.
- Não diga "sou uma IA" ou "sou um bot", mas também não finja ser o José.

Contexto atual: ${dateTimeContext}
Quem escreve: ${staffInfo}
${outsideHoursBlock}${intentHint}
${knowledgeBlock}
Estilo (obrigatório):
- Português do Brasil, frases curtas e claras (1 a 3 na maioria das vezes).
- Tom profissional e cordial — como atendimento de empresa, não conversa entre amigos.
- Evite gírias: "opa", "beleza", "manda aí", "fala", "tranquilo", "deixa comigo".
- Evite também: "Prezado(a)", "Como posso ajudá-lo?", "Estou à disposição", "Atenciosamente".
- Sem emoji, salvo se o contato usar primeiro.
- Se a mensagem trouxer vários nomes de arquivo (linhas separadas), trate todos na resposta.

Regras de conteúdo:
- Use APENAS fatos dos documentos, e-mails consultados e conhecimento da empresa abaixo.
- Não invente preço, prazo, estoque, e-mail ou arquivo que não esteja listado.
- Se não encontrar: informe com clareza e peça um detalhe objetivo (nome, empresa, data).
- Assuntos fora da empresa: redirecione com educação.

Documentos indexados no servidor:
${catalogSummary}

Trechos relevantes para esta mensagem:
${relevantContext}
${outlookInfo}

Enviar arquivo:
- Se o arquivo EXISTE na lista e foi solicitado, avise de forma profissional ("Segue o documento", "Enviando o arquivo") e na ÚLTIMA linha: @@SEND:caminho/relativo@@
- Copie o caminho EXATAMENTE da lista (pastas, acentos, espaços).
- Vários certificados da mesma empresa: use o caminho principal; o sistema pode enviar os demais.
- Se não tiver certeza do caminho ou o arquivo não estiver na lista: NÃO use @@SEND@@ — diga que vai verificar com o José.
- Nunca invente caminhos.`;
}

function generateGreetingReply({ registeredStaff, dateTimeContext }) {
    const firstName = registeredStaff?.nome?.split(/\s+/)[0];
    const hourMatch = dateTimeContext?.match(/(\d{2}):(\d{2})/);
    const hour = hourMatch ? Number(hourMatch[1]) : 12;

    let period = 'Olá';
    if (hour >= 5 && hour < 12) period = 'Bom dia';
    else if (hour >= 12 && hour < 18) period = 'Boa tarde';
    else period = 'Boa noite';

    const variants = firstName
        ? [
              `${period}, ${firstName}. Canal da área de tecnologia da Acesso Equipamentos. Em que posso ajudar?`,
              `${period}, ${firstName}! Aqui é o atendimento da área de tecnologia. Como posso ajudar?`,
          ]
        : [
              `${period}! Você está no canal de atendimento da área de tecnologia da Acesso Equipamentos. Como posso ajudar?`,
              `${period}! Atendimento da área de tecnologia — documentos, certificados ou dúvidas. Em que posso ajudar?`,
          ];

    return variants[Math.floor(Math.random() * variants.length)];
}

function parseSendFileDirective(text) {
    const match = text.match(SEND_FILE_REGEX);
    if (!match) {
        return { text: text.trim(), relativePath: null };
    }

    return {
        text: text.replace(SEND_FILE_REGEX, '').trim(),
        relativePath: match[1].trim().replace(/\\/g, '/'),
    };
}

async function generateReply({
    conversation,
    userText,
    catalogSummary,
    relevantContext,
    emailContext,
    registeredStaff,
    outlookEnabled,
    companyKnowledge,
    dateTimeContext,
    intent,
    outsideBusinessHours,
}) {
    const messages = [
        {
            role: 'system',
            content: buildSystemPrompt({
                catalogSummary,
                relevantContext,
                emailContext,
                registeredStaff,
                outlookEnabled,
                companyKnowledge,
                dateTimeContext,
                intent,
                outsideBusinessHours,
            }),
        },
        ...conversation.history,
        { role: 'user', content: userText },
    ];

    return callGroq(messages, { intent });
}

module.exports = {
    generateReply,
    generateGreetingReply,
    parseSendFileDirective,
    matchesHumanKeyword,
};
