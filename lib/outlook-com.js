'use strict';

const { execFile } = require('child_process');
const path = require('path');
const { promisify } = require('util');
const config = require('./config');

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = path.join(
    __dirname,
    '..',
    'scripts',
    'outlook-com-read.ps1',
);

function isConfigured() {
    return process.platform === 'win32';
}

function getAccountEmail() {
    return config.outlook.userEmail || '';
}

async function searchEmails(request = {}) {
    if (!isConfigured()) {
        throw new Error('Outlook COM só funciona no Windows.');
    }

    const mode = request.mode || 'recent';
    const query = request.query || '';
    const top = request.limit || 5;

    const args = [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        SCRIPT_PATH,
        '-Top',
        String(top),
        '-Mode',
        mode,
        '-Query',
        query,
    ];

    const account = getAccountEmail();
    if (account) {
        args.push('-Account', account);
    }

    const { stdout, stderr } = await execFileAsync('powershell.exe', args, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 45_000,
        windowsHide: true,
    });

    if (stderr?.trim()) {
        console.warn('Outlook COM stderr:', stderr.trim());
    }

    const trimmed = stdout.trim();
    if (!trimmed) {
        return [];
    }

    const parsed = JSON.parse(trimmed);

    if (parsed.account) {
        console.log(
            `Outlook COM: ${parsed.mode || mode}, caixa "${parsed.account}", lidos ${parsed.scanned || '?'} itens`,
        );
    }

    const emails = parsed.emails ?? parsed;
    if (Array.isArray(emails)) {
        return emails.map(normalizeEmail);
    }

    return emails ? [normalizeEmail(emails)] : [];
}

function normalizeEmail(email) {
    return {
        subject: email.subject || '(sem assunto)',
        from: email.from || 'Desconhecido',
        date: email.date || '',
        preview: (email.preview || '').replace(/\s+/g, ' ').trim(),
        isRead: Boolean(email.isRead),
    };
}

function buildEmailContext(emails) {
    if (!emails.length) {
        return 'Nenhum e-mail encontrado para esta consulta.';
    }

    return emails
        .map(
            (email, index) =>
                `${index + 1}. Assunto: ${email.subject}\n   De: ${email.from}\n   Data: ${email.date}\n   Resumo: ${email.preview}`,
        )
        .join('\n\n');
}

module.exports = {
    isConfigured,
    getAccountEmail,
    searchEmails,
    buildEmailContext,
};
