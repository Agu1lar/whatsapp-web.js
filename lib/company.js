'use strict';

const COMPANY = {
    name: 'Acesso Equipamentos',
    business:
        'empresa de locação de equipamentos elevatórios e equipamentos para construção civil',
    commercial: {
        email: 'comercial@acessoequipamentos.com.br',
        phone: '31 99470-0201',
        topics: 'vendas, orçamentos, locação, cotações, propostas comerciais e disponibilidade de equipamentos',
    },
    operational: {
        email: 'operacional@acessoequipamentos.com.br',
        phone: '31 9433-0315',
        topics: 'entrega, retirada, logística de obra, agendamento operacional e acompanhamento em campo',
    },
};

function buildCompanyContextBlock() {
    const { commercial, operational } = COMPANY;

    return `Sobre a empresa:
- A ${COMPANY.name} é uma ${COMPANY.business}.
- Você é assistente virtual com IA da ÁREA DE TECNOLOGIA — funcionária virtual desta empresa, mas NÃO atende comercial nem operacional diretamente.

Seu escopo (pode ajudar):
- Documentos, certificados, manuais e procedimentos internos
- Dúvidas de tecnologia, sistemas e encaminhamento ao José (área de TI)
- Consulta de e-mails da área de tecnologia (quando solicitado e disponível)

Fora do seu escopo — informe os contatos abaixo e NÃO tente resolver:
- Comercial (${commercial.topics}): ${commercial.email} ou ${commercial.phone}
- Operacional (${operational.topics}): ${operational.email} ou ${operational.phone}

Regras de encaminhamento:
- Pedidos comerciais ou de locação/orçamento → Comercial.
- Pedidos operacionais de entrega, retirada ou obra → Operacional.
- Tecnologia, documentos da empresa, certificados, TI → você ou o José.
- Não invente preço, prazo, estoque nem disponibilidade de equipamentos.`;
}

function getCommercialContactLine() {
    const { commercial } = COMPANY;
    return `Comercial: ${commercial.email} ou ${commercial.phone}`;
}

function getOperationalContactLine() {
    const { operational } = COMPANY;
    return `Operacional: ${operational.email} ou ${operational.phone}`;
}

module.exports = {
    COMPANY,
    buildCompanyContextBlock,
    getCommercialContactLine,
    getOperationalContactLine,
};
