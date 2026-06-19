'use strict';

const LOCAL_STOPWORDS = new Set([
    'preciso',
    'precisa',
    'empresa',
    'certificado',
    'documento',
    'documentos',
    'arquivo',
    'arquivos',
    'envia',
    'enviar',
    'manda',
    'mandar',
    'para',
    'como',
    'qual',
    'quais',
    'onde',
    'esse',
    'essa',
    'este',
    'esta',
    'aos',
    'das',
    'dos',
]);

function normalize(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildDocumentText(doc) {
    const parts = [
        doc.name.replace(/[._-]+/g, ' '),
        doc.relativePath.replace(/[\\/._-]+/g, ' '),
    ];

    const excerpt = doc.excerpt || '';
    if (excerpt && !excerpt.startsWith('(')) {
        parts.push(excerpt.slice(0, 1500));
    }

    return parts.join(' ').trim();
}

function tokenize(text) {
    const terms = normalize(text)
        .split(/\s+/)
        .filter((term) => term.length > 2 && !LOCAL_STOPWORDS.has(term));

    return [...new Set(terms)];
}

function sparseCosine(a, b) {
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (const [term, weight] of a) {
        normA += weight * weight;
        if (b.has(term)) {
            dot += weight * b.get(term);
        }
    }

    for (const weight of b.values()) {
        normB += weight * weight;
    }

    if (normA === 0 || normB === 0) {
        return 0;
    }

    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

let localIndex = [];
let localReady = false;

function buildLocalIndex(enrichedCatalog) {
    const docs = enrichedCatalog
        .map((doc) => ({
            doc,
            tokens: tokenize(buildDocumentText(doc)),
        }))
        .filter((entry) => entry.tokens.length > 0);

    const documentFrequency = new Map();
    for (const { tokens } of docs) {
        for (const term of tokens) {
            documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
        }
    }

    const totalDocs = docs.length;
    localIndex = docs.map(({ doc, tokens }) => {
        const termFrequency = new Map();
        for (const term of tokens) {
            termFrequency.set(term, (termFrequency.get(term) || 0) + 1);
        }

        const vector = new Map();
        for (const [term, count] of termFrequency) {
            const idf =
                Math.log(
                    (totalDocs + 1) / ((documentFrequency.get(term) || 0) + 1),
                ) + 1;
            vector.set(term, (count / tokens.length) * idf);
        }

        return { doc, vector };
    });

    localReady = localIndex.length > 0;
    return localIndex.length;
}

function searchLocal(query, catalog, options = {}) {
    const { minScore = 0.08, topK = 12 } = options;

    if (!localReady || localIndex.length === 0) {
        return [];
    }

    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) {
        return [];
    }

    const queryFrequency = new Map();
    for (const term of queryTerms) {
        queryFrequency.set(term, (queryFrequency.get(term) || 0) + 1);
    }

    const queryVector = new Map();
    for (const [term, count] of queryFrequency) {
        queryVector.set(term, count / queryTerms.length);
    }

    const catalogByPath = new Map(
        catalog.map((doc) => [doc.relativePath, doc]),
    );

    return localIndex
        .map((entry) => ({
            doc: catalogByPath.get(entry.doc.relativePath) || entry.doc,
            score: sparseCosine(queryVector, entry.vector),
        }))
        .filter((item) => item.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
}

function isLocalIndexReady() {
    return localReady;
}

function resetLocalIndex() {
    localIndex = [];
    localReady = false;
}

module.exports = {
    buildLocalIndex,
    searchLocal,
    isLocalIndexReady,
    resetLocalIndex,
};
