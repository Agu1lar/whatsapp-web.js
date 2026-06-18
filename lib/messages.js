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
    escalationWaiting:
        'O José já foi notificado. Pode enviar os detalhes que registramos para quando ele retornar.',
    fileNotFound:
        'Não localizei esse arquivo aqui. Informe o nome da pessoa ou da empresa para uma nova busca.',
    filesSending: 'Encontrei o arquivo — enviando agora.',
    filesSendingMany: (n) => `Encontrei ${n} arquivos — enviando agora.`,
    needMoreDetail:
        'Pode me dar mais detalhes sobre o que precisa? Assim consigo ajudar melhor.',
};

function getOutsideHoursMessage() {
    return (
        `Canal de atendimento da área de tecnologia (Acesso Equipamentos), ` +
        `de segunda a sexta, das ${config.businessStart} às ${config.businessEnd}. ` +
        `Sua mensagem foi registrada e teremos retorno no próximo expediente.`
    );
}

module.exports = {
    SYSTEM,
    getOutsideHoursMessage,
};
