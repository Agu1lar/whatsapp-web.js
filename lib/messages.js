'use strict';

const config = require('./config');
const {
    getCommercialContactLine,
    getOperationalContactLine,
} = require('./company');

/**
 * Mensagens fixas do sistema — tom profissional e transparente.
 * Evitar gírias e informalidade que possam parecer o José respondendo pessoalmente.
 * A assistente se identifica como IA da equipe de tecnologia.
 */
const SYSTEM = {
    slowLookup: 'Um momento, estou verificando a solicitação.',
    emptyBody:
        'Por favor, envie sua solicitação em texto para que possamos ajudar.',
    error:
        'Não foi possível concluir o atendimento no momento. ' +
        'Tente novamente em instantes ou aguarde retorno da equipe.',
    escalation:
        'Certo. Encaminhei sua solicitação ao José; ele retorna assim que possível.',
    escalationOutsideHours:
        'Registrei sua solicitação. O expediente humano é de segunda a sexta, ' +
        `das ${config.businessStart} às ${config.businessEnd} — o José retorna no próximo horário comercial. ` +
        'Enquanto isso, posso ajudar com dúvidas e documentos disponíveis aqui.',
    escalationWaiting:
        'O José já foi notificado. Pode enviar os detalhes que registramos para quando ele retornar.',
    fileNotFound:
        'Não localizei esse arquivo aqui. Informe o nome da pessoa ou da empresa para uma nova busca.',
    documentNotFound:
        'Não localizei nenhum documento com essas informações no servidor. ' +
        'Informe o nome da pessoa, da empresa ou parte do nome do arquivo para uma nova busca.',
    emailNotFound:
        'Não encontrei e-mails com esses critérios na caixa consultada. ' +
        'Pode detalhar o assunto, remetente ou período?',
    filesSending: 'Encontrei o arquivo — enviando agora.',
    filesSendingMany: (n) => `Encontrei ${n} arquivos — enviando agora.`,
    needMoreDetail:
        'Pode me dar mais detalhes sobre o que precisa? Assim consigo ajudar melhor.',
    botPaused:
        'O atendimento automático está pausado no momento. Aguarde retorno da equipe.',
    notReady:
        'Canal em sincronização. Envie sua mensagem novamente em instantes.',
    audioTranscriptionFailed:
        'Recebi o áudio, mas não consegui transcrever. Pode repetir em texto?',
};

function getWelcomeMessage(registeredStaff) {
    const name = registeredStaff?.nome?.split(/\s+/)[0];
    const greeting = name ? `${name}, ` : '';

    return (
        `${greeting}bem-vindo(a). Sou a assistente virtual com IA da área de tecnologia da Acesso Equipamentos — locação de equipamentos elevatórios e para construção civil.\n\n` +
        'Meu escopo:\n' +
        '• documentos, certificados e procedimentos\n' +
        '• suporte de tecnologia e encaminhamento ao José\n\n' +
        `Fora do meu escopo:\n` +
        `• ${getCommercialContactLine()}\n` +
        `• ${getOperationalContactLine()}\n\n` +
        `Tecnologia (José): segunda a sexta, ${config.businessStart} às ${config.businessEnd} — escreva "falar com o José".\n\n` +
        'Como posso ajudar?'
    );
}

function getOutsideHoursNote() {
    return (
        `Fora do expediente humano (segunda a sexta, ${config.businessStart} às ${config.businessEnd}). ` +
        'O José retorna no próximo horário comercial. A assistente virtual com IA continua atendendo: ' +
        'dúvidas, busca em documentos e envio de arquivos disponíveis no servidor.'
    );
}

function getOutsideHoursMessage() {
    return getOutsideHoursNote();
}

module.exports = {
    SYSTEM,
    getOutsideHoursMessage,
    getOutsideHoursNote,
    getWelcomeMessage,
};
