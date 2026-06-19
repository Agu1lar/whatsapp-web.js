'use strict';

const config = require('./config');
const { INTENT } = require('./intent');
const {
    parseSendFileDirective,
    looksLikeFilename,
    resolveDocument,
} = require('./documents');
const { SYSTEM } = require('./messages');

const SEND_FILE_REGEX = /@@SEND:[^\n@]+@@/g;
const INBOUND_MEDIA_MARKERS = /\[(Conteúdo do anexo|Áudio transcrito)\]/i;
const OVERCONFIDENT_FILE_CLAIM =
    /\b(encontrei|segue o (documento|arquivo)|enviando (o |o arquivo|agora)|localizei)\b/i;

function assessGrounding(context) {
    const { intent, relevantDocs, emailContext, outlookEnabled } = context;
    const topDoc = relevantDocs[0];
    const topScore = topDoc?.score ?? 0;
    const topSemantic = topDoc?.semanticScore ?? 0;
    const hasDocs = relevantDocs.length > 0;
    const weakMatch =
        hasDocs &&
        topScore < 0.35 &&
        topSemantic < config.semanticSearchMinSimilarity &&
        (topDoc?.keywordScore || 0) < 2;
    const noDocEvidence =
        !hasDocs && (intent === INTENT.DOCUMENT || intent === INTENT.GENERAL);
    const emailSearched = Boolean(outlookEnabled);
    const emailEmpty =
        emailSearched && /nenhum e-mail encontrado/i.test(emailContext || '');

    return {
        intent,
        hasDocs,
        weakMatch,
        noDocEvidence,
        topScore,
        emailEmpty,
        emailSearched,
        strictFactual:
            intent === INTENT.DOCUMENT ||
            intent === INTENT.EMAIL ||
            noDocEvidence ||
            weakMatch ||
            emailEmpty,
    };
}

function buildGroundingPromptBlock(meta) {
    const lines = [
        'Anti-alucinação (obrigatório — violar é erro grave):',
        '- Use SOMENTE fatos que aparecem neste prompt: trechos relevantes, e-mails consultados, conhecimento da empresa e lista de documentos.',
        '- Se a informação não estiver explícita nessas seções, diga que não encontrou e peça um detalhe objetivo (nome, empresa, data ou arquivo).',
        '- PROIBIDO inventar: caminhos de arquivo, validades, valores, prazos, estoque, telefones, e-mails ou trechos de PDF não listados.',
        '- PROIBIDO dizer que encontrou ou vai enviar arquivo sem o caminho exato na lista ou nos trechos.',
        '- Em dúvida, prefira "não localizei" a chutar.',
    ];

    if (meta.noDocEvidence && meta.intent === INTENT.DOCUMENT) {
        lines.push(
            '- ALERTA: a busca não retornou documentos. Não afirme que encontrou arquivo.',
        );
    } else if (meta.noDocEvidence) {
        lines.push(
            '- ALERTA: nenhum trecho de documento foi recuperado para esta pergunta. Não cite conteúdo de arquivos.',
        );
    }

    if (meta.weakMatch) {
        lines.push(
            '- ALERTA: correspondência fraca na busca. Cite o candidato como possibilidade e peça confirmação antes de enviar.',
        );
    }

    if (meta.emailEmpty) {
        lines.push(
            '- ALERTA: a consulta de e-mail não retornou resultados. Não invente assunto, remetente ou corpo.',
        );
    }

    return lines.join('\n');
}

function catalogHasPath(catalog, relativePath) {
    if (!relativePath) {
        return false;
    }

    const norm = relativePath.replace(/\\/g, '/').trim();
    return catalog.some((doc) => doc.relativePath === norm);
}

function sanitizeAssistantReply(rawReply, { catalog, relevantDocs, intent }) {
    let text = String(rawReply || '').trim();
    const { relativePath } = parseSendFileDirective(text);

    if (relativePath && !catalogHasPath(catalog, relativePath)) {
        text = text.replace(SEND_FILE_REGEX, '').trim();
    }

    if (
        intent === INTENT.DOCUMENT &&
        relevantDocs.length === 0 &&
        OVERCONFIDENT_FILE_CLAIM.test(text)
    ) {
        text = text.replace(
            OVERCONFIDENT_FILE_CLAIM,
            'não localizei com segurança',
        );
        text = text.replace(SEND_FILE_REGEX, '').trim();
    }

    return text;
}

function userNamedFileInCatalog(userText, catalog, root) {
    const candidate = userText.trim().split('\n')[0].trim();
    if (!looksLikeFilename(candidate)) {
        return false;
    }

    return Boolean(resolveDocument(root, catalog, candidate));
}

function getRagOnlyBypassReply(context, userText, catalog, root) {
    if (!config.ragOnlyMode) {
        return null;
    }

    if (INBOUND_MEDIA_MARKERS.test(userText)) {
        return null;
    }

    const { intent, relevantDocs, emailContext, outlookEnabled } = context;

    if (
        intent === INTENT.EMAIL &&
        outlookEnabled &&
        /nenhum e-mail encontrado/i.test(emailContext || '')
    ) {
        return SYSTEM.emailNotFound;
    }

    if (intent !== INTENT.DOCUMENT) {
        return null;
    }

    if (relevantDocs.length > 0) {
        return null;
    }

    if (userNamedFileInCatalog(userText, catalog, root)) {
        return null;
    }

    return SYSTEM.documentNotFound;
}

module.exports = {
    assessGrounding,
    buildGroundingPromptBlock,
    sanitizeAssistantReply,
    getRagOnlyBypassReply,
};
