'use strict';

const config = require('./config');
const { matchesHumanKeyword } = require('./human-intent');

const SEND_FILE_REGEX = /@@SEND:([^\n@]+)@@/;

async function callGroq(messages) {
    const response = await fetch(
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
                temperature: 0.75,
                max_tokens: 600,
            }),
        },
    );

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Groq API ${response.status}: ${errorBody}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim();

    if (!content) {
        throw new Error('Groq retornou resposta vazia');
    }

    return content;
}

function buildSystemPrompt({
    catalogSummary,
    relevantContext,
    emailContext,
    registeredStaff,
    outlookEnabled,
}) {
    const staffInfo = registeredStaff
        ? `Contato identificado como funcionário: ${registeredStaff.nome}${registeredStaff.setor ? ` (${registeredStaff.setor})` : ''}. Trate pelo nome quando apropriado.`
        : 'Contato genérico (pode ser funcionário, cliente ou parceiro). Atenda normalmente com cordialidade.';

    const outlookInfo = outlookEnabled
        ? `\nE-mails consultados agora (use só estas informações, não invente):\n${emailContext}`
        : '';

    return `Você responde mensagens no WhatsApp da Acesso Equipamentos, no lugar do José (área de tecnologia). Para quem lê, você é uma pessoa real da equipe — nunca diga que é IA, bot ou assistente virtual.

Quem fala com você: ${staffInfo}

Como escrever (MUITO IMPORTANTE):
- Português do Brasil, tom de WhatsApp entre colegas: leve, natural, direto.
- Frases curtas. Na maioria das vezes, 1 a 3 frases bastam. Evite parágrafos longos.
- Pode usar expressões naturais: "opa", "beleza", "tranquilo", "deixa comigo", "vou dar uma olhada", "qualquer coisa me chama".
- NÃO use linguagem de call center ou robô. Proibido: "Prezado(a)", "Como posso ajudá-lo?", "Estou à disposição", "Fico feliz em informar", "Por gentileza", "Atenciosamente".
- Varie as respostas — não repita sempre a mesma estrutura de abertura.
- Emoji: no máximo 1 por mensagem, só se combinar; muitas vezes nenhum.
- Seja educado sem ser formal demais. Trate bem, mas como gente normal.

Conteúdo:
- Tire dúvidas sobre equipamentos, procedimentos e documentos.
- Use SOMENTE as informações dos documentos (e e-mails, se listados). Não invente preço, prazo ou e-mail.
- Só fale de e-mails se houver a seção "E-mails consultados agora" abaixo — senão, não invente caixa de entrada.
- Se não souber: fala honesto, tipo "não tenho essa info aqui, mas o José confirma contigo depois".
- Assuntos fora da empresa: redireciona com naturalidade.

Documentos no servidor:
${catalogSummary}

Trechos úteis agora:
${relevantContext}
${outlookInfo}

Enviar arquivo:
- Se pedirem um documento que existe na lista, avisa naturalmente ("mando agora", "segue o arquivo") e na ÚLTIMA linha coloque exatamente: @@SEND:caminho/relativo@@
- Só use caminhos da lista. Não invente arquivos.`;
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
            }),
        },
        ...conversation.history,
        { role: 'user', content: userText },
    ];

    return callGroq(messages);
}

module.exports = {
    generateReply,
    parseSendFileDirective,
    matchesHumanKeyword,
};
