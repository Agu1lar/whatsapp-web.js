'use strict';

const config = require('./config');
const { readPdfFromBuffer } = require('./documents');
const { transcribeAudio, extractImageContext } = require('./llm');

const ATTACHMENT_CONTEXT_MAX = 2500;

function isVoiceMessage(msg) {
    return msg.type === 'ptt' || msg.type === 'audio';
}

function isPdfAttachment(msg, media) {
    const mimetype = media?.mimetype || '';
    const name = media?.filename || msg.filename || '';
    return (
        mimetype === 'application/pdf' ||
        /\.pdf$/i.test(name) ||
        (msg.type === 'document' && /\.pdf$/i.test(name))
    );
}

function isImageAttachment(msg, media) {
    const mimetype = media?.mimetype || '';
    return msg.type === 'image' || mimetype.startsWith('image/');
}

function extensionFromMimetype(mimetype, fallback = 'bin') {
    const map = {
        'audio/ogg': 'ogg',
        'audio/ogg; codecs=opus': 'ogg',
        'audio/mpeg': 'mp3',
        'audio/mp4': 'm4a',
        'audio/wav': 'wav',
        'audio/webm': 'webm',
        'application/pdf': 'pdf',
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
    };

    const normalized = String(mimetype || '')
        .toLowerCase()
        .split(';')[0]
        .trim();
    return map[mimetype] || map[normalized] || fallback;
}

function bufferFromMedia(media) {
    if (!media?.data) {
        return null;
    }
    return Buffer.from(media.data, 'base64');
}

async function downloadMessageMedia(msg) {
    if (!msg.hasMedia) {
        return null;
    }

    const media = await msg.downloadMedia();
    if (!media?.data) {
        return null;
    }

    const buffer = bufferFromMedia(media);
    if (!buffer || buffer.length === 0) {
        return null;
    }

    if (buffer.length > config.mediaMaxBytes) {
        throw new Error(
            `Arquivo excede ${Math.round(config.mediaMaxBytes / 1024 / 1024)} MB`,
        );
    }

    const filename =
        media.filename ||
        msg.filename ||
        `anexo.${extensionFromMimetype(media.mimetype)}`;

    return { media, buffer, filename };
}

function clipAttachmentContext(text, label) {
    const normalized = String(text || '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!normalized) {
        return '';
    }

    const clipped =
        normalized.length > ATTACHMENT_CONTEXT_MAX
            ? `${normalized.slice(0, ATTACHMENT_CONTEXT_MAX)}...`
            : normalized;

    return `[Conteúdo do anexo (${label})]:\n${clipped}`;
}

async function enrichMediaMessage(msg) {
    const downloaded = await downloadMessageMedia(msg);
    if (!downloaded) {
        return '';
    }

    const { media, buffer, filename } = downloaded;

    if (isVoiceMessage(msg)) {
        const transcript = await transcribeAudio(
            buffer,
            filename,
            media.mimetype,
        );
        if (transcript) {
            return `[Áudio transcrito]: ${transcript}`;
        }
        return '[Áudio recebido — não foi possível transcrever]';
    }

    if (isPdfAttachment(msg, media)) {
        const pdfText = await readPdfFromBuffer(buffer);
        return clipAttachmentContext(pdfText, filename);
    }

    if (isImageAttachment(msg, media)) {
        const imageText = await extractImageContext(buffer, media.mimetype);
        return clipAttachmentContext(imageText, filename);
    }

    if (filename) {
        return `[Anexo recebido: ${filename}]`;
    }

    return '';
}

function extractMessageText(msg) {
    return msg.body?.trim() || '';
}

async function resolveInboundText(msg) {
    const caption = extractMessageText(msg);
    let mediaPart = '';

    if (msg.hasMedia) {
        try {
            mediaPart = await enrichMediaMessage(msg);
        } catch (err) {
            console.error('Erro ao processar mídia:', err.message);
            if (isVoiceMessage(msg)) {
                mediaPart = '[Áudio recebido — não foi possível transcrever]';
            } else if (msg.filename) {
                mediaPart = `[Anexo recebido: ${msg.filename}]`;
            } else {
                mediaPart =
                    '[Anexo recebido — não foi possível ler o conteúdo]';
            }
        }
    }

    if (caption && mediaPart) {
        return `${caption}\n\n${mediaPart}`;
    }

    return caption || mediaPart;
}

module.exports = {
    isVoiceMessage,
    extractMessageText,
    resolveInboundText,
};
