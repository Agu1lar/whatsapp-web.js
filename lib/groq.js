'use strict';

const config = require('./config');
const { matchesHumanKeyword } = require('./human-intent');
const { buildCompanyContextBlock } = require('./company');
const { buildGroundingPromptBlock } = require('./grounding');
const { callChatCompletion } = require('./llm');

const SEND_FILE_REGEX = /@@SEND:([^\n@]+)@@/;

async function callGroq(messages, options = {}) {
    return callChatCompletion(messages, options);
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
    groundingMeta,
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

    const groundingBlock = groundingMeta
        ? `\n${buildGroundingPromptBlock(groundingMeta)}\n`
        : '';

    return `Você é a assistente virtual com IA da área de tecnologia da Acesso Equipamentos. Atende o WhatsApp corporativo quando a equipe humana não está disponível.

${buildCompanyContextBlock()}
${groundingBlock}
Identidade (obrigatório):
- Você é uma IA da equipe de tecnologia — pode e deve se identificar assim quando fizer sentido (ex.: "Sou a assistente virtual com IA da área de tecnologia").
- Você NÃO é o José. Não fale em primeira pessoa como se fosse ele ("estou ocupado", "já vou aí").
- Se precisar do José: diga que vai encaminhar ou que ele retorna — nunca simule que ele está respondendo agora.
- Seja transparente: atendimento automatizado da tecnologia, com encaminhamento humano quando necessário.

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
- Mensagens podem incluir "[Áudio transcrito]" ou "[Conteúdo do anexo (...)]" — use esse texto como parte da solicitação do contato.
- NUNCA responda a ofertas de refinanciamento, empréstimo, financiamento, consórcio ou cobrança de terceiros — isso é spam; ignore o assunto.

Regras de conteúdo:
- Use APENAS fatos dos documentos, e-mails consultados e conhecimento da empresa abaixo.
- Cite o caminho do arquivo quando mencionar um documento específico.
- Não invente preço, prazo, estoque, e-mail ou arquivo que não esteja listado.
- Se não encontrar: diga explicitamente "não localizei" e peça um detalhe objetivo (nome, empresa, data).
- Nunca complete lacunas com suposição — prefira pedir confirmação.
- Assuntos fora da empresa ou fora do seu escopo (comercial/operacional): redirecione com os contatos corretos acima.

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
              `${period}, ${firstName}. Sou a assistente virtual com IA da área de tecnologia da Acesso Equipamentos. Em que posso ajudar?`,
              `${period}, ${firstName}! Aqui é a IA da equipe de tecnologia. Como posso ajudar?`,
          ]
        : [
              `${period}! Sou a assistente virtual com IA da área de tecnologia da Acesso Equipamentos. Como posso ajudar?`,
              `${period}! Atendimento automatizado da área de tecnologia — documentos, certificados ou dúvidas. Em que posso ajudar?`,
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
    groundingMeta,
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
                groundingMeta,
            }),
        },
        ...conversation.history,
        { role: 'user', content: userText },
    ];

    return callGroq(messages, {
        intent,
        strictFactual: groundingMeta?.strictFactual,
    });
}

module.exports = {
    generateReply,
    generateGreetingReply,
    parseSendFileDirective,
    matchesHumanKeyword,
};
