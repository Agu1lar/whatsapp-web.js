'use strict';

const fs = require('fs');
const path = require('path');

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.json', '.csv', '.log']);
const SENDABLE_EXTENSIONS = new Set([
    '.pdf',
    '.doc',
    '.docx',
    '.xls',
    '.xlsx',
    '.ppt',
    '.pptx',
    '.txt',
    '.md',
    '.json',
    '.csv',
    '.png',
    '.jpg',
    '.jpeg',
    '.zip',
]);

const SEND_FILE_REGEX = /@@SEND:([^\n@]+)@@/;
const CATALOG_SUMMARY_LIMIT = 80;
const PDF_EXCERPT_MAX = 2000;
const PDF_READ_TIMEOUT_MS = 20000;

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            setTimeout(
                () => reject(new Error(`${label} excedeu ${ms / 1000}s`)),
                ms,
            );
        }),
    ]);
}

function normalizeRoot(root) {
    return path.resolve(root).replace(/[\\/]+$/, '');
}

function safeResolve(root, relativePath) {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized || normalized.includes('..')) {
        return null;
    }

    const rootNorm = normalizeRoot(root);
    const resolved = path.normalize(
        path.join(rootNorm, ...normalized.split('/')),
    );

    if (resolved !== rootNorm && !resolved.startsWith(rootNorm + path.sep)) {
        return null;
    }

    return resolved;
}

function normalizeForMatch(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '');
}

const SEARCH_STOPWORDS = new Set([
    'preciso',
    'precisa',
    'precisamos',
    'empresa',
    'certificado',
    'certificados',
    'carteirinha',
    'carteirinhas',
    'documento',
    'documentos',
    'arquivo',
    'arquivos',
    'envia',
    'enviar',
    'manda',
    'mandar',
    'lista',
    'geral',
    'algum',
    'alguma',
    'todo',
    'toda',
    'todos',
    'todas',
]);

function extractSearchTerms(query) {
    const normalized = normalizeForMatch(query);
    const terms = normalized
        .split(/\s+/)
        .filter((t) => t.length > 2 && !SEARCH_STOPWORDS.has(t));

    const phrases = [];
    if (/via\s+shopping/.test(normalized)) phrases.push('via shopping');
    if (/del\s+rey/.test(normalized)) phrases.push('del rey');

    return { terms, phrases, normalized };
}

function readTextExcerpt(filePath, maxChars = 1200) {
    const content = fs.readFileSync(filePath, 'utf8');
    const normalized = content.replace(/\s+/g, ' ').trim();
    return normalized.length > maxChars
        ? `${normalized.slice(0, maxChars)}...`
        : normalized;
}

async function readPdfExcerpt(filePath, maxChars = PDF_EXCERPT_MAX) {
    let parser;
    try {
        const { PDFParse } = require('pdf-parse');
        const buffer = fs.readFileSync(filePath);
        parser = new PDFParse({ data: buffer });
        const result = await withTimeout(
            parser.getText(),
            PDF_READ_TIMEOUT_MS,
            `Leitura PDF ${path.basename(filePath)}`,
        );
        const normalized = (result.text || '').replace(/\s+/g, ' ').trim();

        if (!normalized) {
            return '(PDF sem texto extraível — ainda pode ser enviado se solicitado.)';
        }

        return normalized.length > maxChars
            ? `${normalized.slice(0, maxChars)}...`
            : normalized;
    } catch (err) {
        console.error(`Erro ao ler PDF ${filePath}:`, err.message);
        return '(Não foi possível extrair texto — o arquivo ainda pode ser enviado.)';
    } finally {
        if (parser) {
            await parser.destroy().catch(() => {});
        }
    }
}

async function walkDir(dir, root, results = []) {
    if (!fs.existsSync(dir)) return results;

    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        console.error(`Erro ao listar pasta ${dir}:`, err.message);
        return results;
    }

    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (entry.name.endsWith('.meta.json')) continue;

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            await walkDir(fullPath, root, results);
            continue;
        }

        if (!entry.isFile()) continue;

        const ext = path.extname(entry.name).toLowerCase();
        if (!SENDABLE_EXTENSIONS.has(ext) && !TEXT_EXTENSIONS.has(ext)) {
            continue;
        }

        const relativePath = path
            .relative(root, fullPath)
            .split(path.sep)
            .join('/');

        const doc = {
            name: entry.name,
            relativePath,
            extension: ext,
            fullPath,
            sizeKb: Math.round(fs.statSync(fullPath).size / 1024),
            excerpt: null,
        };

        if (TEXT_EXTENSIONS.has(ext)) {
            try {
                doc.excerpt = readTextExcerpt(fullPath, 1200);
            } catch {
                doc.excerpt = '';
            }
        }

        results.push(doc);
    }

    return results;
}

async function loadCatalog(root) {
    const docs = await walkDir(root, root);
    return docs.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function enrichPdfExcerpts(docs, root) {
    for (const doc of docs) {
        if (doc.extension !== '.pdf' || doc.excerpt) continue;

        const filePath = safeResolve(root, doc.relativePath);
        if (!filePath) continue;

        doc.excerpt = await readPdfExcerpt(filePath);
    }

    return docs;
}

function scoreDocument(doc, terms, phrases = []) {
    const haystack = normalizeForMatch(
        `${doc.name} ${doc.relativePath} ${doc.excerpt || ''}`,
    );
    const pathNorm = normalizeForMatch(doc.relativePath);

    let score = 0;
    for (const term of terms) {
        if (normalizeForMatch(doc.name).includes(term)) score += 3;
        if (pathNorm.includes(term)) score += 2;
        if (haystack.includes(term)) score += 1;
    }

    for (const phrase of phrases) {
        if (pathNorm.includes(normalizeForMatch(phrase))) score += 8;
    }

    if (doc.extension === '.pdf') score += 1;
    if (normalizeForMatch(doc.name).includes('certificado')) score += 2;

    return score;
}

async function searchCatalog(catalog, query, root) {
    const { terms, phrases } = extractSearchTerms(query);

    if (terms.length === 0 && phrases.length === 0) return [];

    const ranked = catalog
        .map((doc) => ({
            ...doc,
            score: scoreDocument(doc, terms, phrases),
        }))
        .filter((doc) => doc.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 12);

    return enrichPdfExcerpts(ranked, root);
}

function buildCatalogSummary(catalog, matchedDocs = []) {
    if (catalog.length === 0) {
        return 'Nenhum documento indexado no servidor no momento.';
    }

    if (catalog.length > CATALOG_SUMMARY_LIMIT) {
        const sample = (matchedDocs.length ? matchedDocs : catalog.slice(0, 20))
            .map(
                (doc) =>
                    `- ${doc.relativePath} (${doc.extension}, ~${doc.sizeKb} KB)`,
            )
            .join('\n');

        return (
            `${catalog.length} documentos indexados na pasta de rede.\n` +
            'Lista parcial (priorizando os relacionados à pergunta):\n' +
            sample
        );
    }

    return catalog
        .map(
            (doc) =>
                `- ${doc.relativePath} (${doc.extension}, ~${doc.sizeKb} KB)`,
        )
        .join('\n');
}

function buildRelevantContext(relevantDocs) {
    if (relevantDocs.length === 0) {
        return 'Nenhum documento encontrado pelo nome/caminho para esta pergunta.';
    }

    return relevantDocs
        .map((doc) => {
            const excerpt = doc.excerpt
                ? `\nTrecho: ${doc.excerpt}`
                : '\n(PDF — conteúdo será lido se necessário; pode ser enviado se solicitado.)';
            return `### ${doc.relativePath}${excerpt}`;
        })
        .join('\n\n');
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

function resolveDocument(root, catalog, relativePath) {
    if (!relativePath) return null;

    const target = relativePath.replace(/\\/g, '/').trim();
    const targetNorm = normalizeForMatch(target);

    const exact = catalog.find((doc) => doc.relativePath === target);
    if (exact) {
        return safeResolve(root, exact.relativePath);
    }

    const byName = catalog.filter(
        (doc) => normalizeForMatch(doc.name) === targetNorm,
    );
    if (byName.length === 1) {
        return safeResolve(root, byName[0].relativePath);
    }

    const byPathEnd = catalog.filter((doc) =>
        normalizeForMatch(doc.relativePath).endsWith(targetNorm),
    );
    if (byPathEnd.length === 1) {
        return safeResolve(root, byPathEnd[0].relativePath);
    }

    const byIncludes = catalog.filter((doc) =>
        normalizeForMatch(doc.relativePath).includes(targetNorm),
    );
    if (byIncludes.length === 1) {
        return safeResolve(root, byIncludes[0].relativePath);
    }

    const direct = safeResolve(root, target);
    if (direct) return direct;

    return null;
}

function getFolderKey(relativePath) {
    const parts = relativePath.replace(/\\/g, '/').split('/');
    return parts.slice(0, -1).join('/').toLowerCase();
}

function wantsMultipleCertificates(query) {
    return /certificados?|carteirinhas?/i.test(query);
}

function userWantsFileSend(query) {
    return /manda|envia|preciso|busca|procura|quero|me\s+passa|segue|cadê|cade/i.test(
        query,
    );
}

function looksLikeFilename(text) {
    return /\.(pdf|docx?|xlsx?|pptx?|txt|zip|png|jpe?g)$/i.test(text.trim());
}

function aiSuggestsSending(reply) {
    return /enviando o arquivo|segue o documento|segue o arquivo|encontrei o arquivo|envio agora/i.test(
        reply || '',
    );
}

function resolveSendPaths(
    aiPath,
    catalog,
    relevantDocs,
    userText,
    root,
    options = {},
) {
    const { allowAutoSend = false } = options;
    const paths = [];
    const seen = new Set();

    function add(relativePath) {
        const filePath = resolveDocument(root, catalog, relativePath);
        if (!filePath || seen.has(relativePath)) return;
        if (!fs.existsSync(filePath)) return;
        seen.add(relativePath);
        paths.push(relativePath);
    }

    if (aiPath) {
        add(aiPath);
    }

    if (paths.length === 0 && looksLikeFilename(userText)) {
        add(userText.trim());
    }

    if (paths.length === 0 && allowAutoSend && relevantDocs.length > 0) {
        const { phrases } = extractSearchTerms(userText);
        let pool = relevantDocs;

        if (phrases.length > 0) {
            const phraseNorm = normalizeForMatch(phrases[0]);
            const byPhrase = relevantDocs.filter((doc) =>
                normalizeForMatch(doc.relativePath).includes(phraseNorm),
            );
            if (byPhrase.length > 0) pool = byPhrase;
        }

        const topFolder = getFolderKey(pool[0].relativePath);
        const sameFolder = pool.filter(
            (doc) => getFolderKey(doc.relativePath) === topFolder,
        );
        const batch =
            wantsMultipleCertificates(userText) && sameFolder.length > 1
                ? sameFolder
                : wantsMultipleCertificates(userText) && pool.length > 1
                  ? pool
                  : [pool[0]];

        for (const doc of batch.slice(0, 10)) {
            add(doc.relativePath);
        }
    }

    return paths;
}

module.exports = {
    loadCatalog,
    searchCatalog,
    buildCatalogSummary,
    buildRelevantContext,
    parseSendFileDirective,
    resolveDocument,
    resolveSendPaths,
    safeResolve,
    userWantsFileSend,
    aiSuggestsSending,
    looksLikeFilename,
};
