'use strict';

const config = require('./config');

/**
 * Mensagens fixas do sistema — tom profissional e transparente.
 * Evitar gírias e informalidade que possam parecer o José respondendo pessoalmente.
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
    filesSending: 'Encontrei o arquivo — enviando agora.',
    filesSendingMany: (n) => `Encontrei ${n} arquivos — enviando agora.`,
    needMoreDetail:
        'Pode me dar mais detalhes sobre o que precisa? Assim consigo ajudar melhor.',
    botPaused:
        'O atendimento automático está pausado no momento. Aguarde retorno da equipe.',
    notReady:
        'Canal em sincronização. Envie sua mensagem novamente em instantes.',
};

function getOutsideHoursNote() {
    return (
        `Fora do expediente humano (segunda a sexta, ${config.businessStart} às ${config.businessEnd}). ` +
        'O José retorna no próximo horário comercial. A assistente continua atendendo: ' +
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
};
