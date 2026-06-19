'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const {
    embedTexts: apiEmbedTexts,
    getEmbeddingModel,
    getEmbeddingProviderLabel,
    getPrimaryProvider,
    getProviderChain,
    shouldTryFallback,
} = require('./llm');
const {
    buildLocalIndex,
    searchLocal,
    isLocalIndexReady,
    resetLocalIndex,
} = require('./local-semantic');

const DOCUMENT_PREFIX = 'search_document: ';
const QUERY_PREFIX = 'search_query: ';
const EMBED_BATCH_SIZE = 48;

let vectorIndex = [];
let indexReady = false;
let indexSyncPromise = null;
let searchBackend = null;

function embeddingsCacheFile() {
    return path.join(config.dataDir, 'doc-embeddings.json');
}

function docFingerprint(doc) {
    return crypto
        .createHash('sha256')
        .update(
            `${doc.relativePath}|${doc.sizeKb}|${(doc.excerpt || '').slice(0, 800)}`,
        )
        .digest('hex');
}

function buildEmbeddingText(doc) {
    const parts = [
        doc.name.replace(/[._-]+/g, ' '),
        doc.relativePath.replace(/[\\/._-]+/g, ' '),
    ];

    const excerpt = doc.excerpt || '';
    if (excerpt && !excerpt.startsWith('(')) {
        parts.push(excerpt.slice(0, 1500));
    }

    return parts.join('\n').trim();
}

function cosineSimilarity(a, b) {
    if (!a?.length || a.length !== b.length) {
        return 0;
    }

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) {
        return 0;
    }

    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function isModelNotFoundError(err) {
    const message = String(err?.message || err || '');
    return (
        message.includes('model_not_found') ||
        message.includes('does not exist') ||
        message.includes('Embeddings 404')
    );
}

function shouldFallbackToLocal(err) {
    return (
        isModelNotFoundError(err) ||
        String(err?.message || '').includes('insufficient_quota') ||
        shouldTryFallback(err)
    );
}

function resolveApiBackend() {
    if (config.semanticSearchMode === 'openai') {
        return 'openai';
    }
    if (config.semanticSearchMode === 'groq') {
        return 'groq';
    }

    const primary = getPrimaryProvider();
    if (primary === 'openai' || primary === 'groq') {
        return primary;
    }

    const chain = getProviderChain();
    if (chain.length > 0) {
        return chain[0];
    }

    return config.openaiApiKey ? 'openai' : 'groq';
}

function loadCache(backend) {
    const file = embeddingsCacheFile();
    try {
        if (fs.existsSync(file)) {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        }
    } catch (err) {
        console.warn('Cache de embeddings inválido:', err.message);
    }

    return {
        backend,
        model: getEmbeddingModel(backend),
        docsRoot: config.docsRoot,
        entries: {},
    };
}

function saveCache(cache) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(embeddingsCacheFile(), JSON.stringify(cache), 'utf8');
}

async function embedInBatches(texts, backend) {
    const batchSize = backend === 'openai' ? 100 : EMBED_BATCH_SIZE;
    const vectors = [];

    for (let i = 0; i < texts.length; i += batchSize) {
        const chunk = texts.slice(i, i + batchSize);
        const batchVectors = await apiEmbedTexts(chunk, backend);
        vectors.push(...batchVectors);
    }

    return vectors;
}

function isEnabled() {
    return config.semanticSearchEnabled;
}

function wantsLocalBackend() {
    return config.semanticSearchMode === 'local';
}

async function probeApiEmbeddings(backend) {
    const apiKey =
        backend === 'openai' ? config.openaiApiKey : config.groqApiKey;
    if (!apiKey) {
        return false;
    }

    try {
        await apiEmbedTexts(['probe'], backend);
        return true;
    } catch (err) {
        if (shouldFallbackToLocal(err)) {
            return false;
        }
        throw err;
    }
}

async function syncVectorIndex(catalog, enriched, docsByPath, backend) {
    const cache = loadCache(backend);
    const modelId = getEmbeddingModel(backend);
    const validPaths = new Set(catalog.map((doc) => doc.relativePath));

    if (cache.docsRoot !== config.docsRoot || cache.model !== modelId) {
        cache.entries = {};
    }

    cache.docsRoot = config.docsRoot;
    cache.backend = backend;
    cache.model = modelId;

    for (const key of Object.keys(cache.entries)) {
        if (!validPaths.has(key)) {
            delete cache.entries[key];
        }
    }

    const pending = [];
    for (const doc of catalog) {
        const enrichedDoc = docsByPath.get(doc.relativePath) || doc;
        const text = buildEmbeddingText(enrichedDoc);
        if (!text) continue;

        const hash = docFingerprint(enrichedDoc);
        const cached = cache.entries[doc.relativePath];
        if (cached?.hash === hash && Array.isArray(cached.vector)) {
            continue;
        }

        pending.push({
            relativePath: doc.relativePath,
            hash,
            text: `${DOCUMENT_PREFIX}${text}`,
        });
    }

    if (pending.length > 0) {
        const label = getEmbeddingProviderLabel(backend);
        console.log(
            `Embeddings ${label}: gerando ${pending.length} vetor(es) novos ou atualizados…`,
        );
        const vectors = await embedInBatches(
            pending.map((item) => item.text),
            backend,
        );

        for (let i = 0; i < pending.length; i++) {
            cache.entries[pending[i].relativePath] = {
                hash: pending[i].hash,
                vector: vectors[i],
            };
        }

        saveCache(cache);
    }

    vectorIndex = catalog
        .map((doc) => {
            const entry = cache.entries[doc.relativePath];
            if (!entry?.vector) {
                return null;
            }

            return {
                relativePath: doc.relativePath,
                vector: entry.vector,
                doc: docsByPath.get(doc.relativePath) || doc,
            };
        })
        .filter(Boolean);

    indexReady = vectorIndex.length > 0;
    cache.updatedAt = new Date().toISOString();
    saveCache(cache);

    return {
        indexed: vectorIndex.length,
        updated: pending.length,
        backend,
    };
}

function syncLocalIndex(enriched) {
    resetLocalIndex();
    vectorIndex = [];
    indexReady = false;

    const indexed = buildLocalIndex(enriched);
    indexReady = isLocalIndexReady();

    return {
        indexed,
        updated: indexed,
        backend: 'local',
    };
}

async function syncEmbeddingIndex(catalog, root) {
    void root;
    if (!isEnabled()) {
        vectorIndex = [];
        indexReady = false;
        searchBackend = null;
        resetLocalIndex();
        return { indexed: 0, skipped: true };
    }

    if (indexSyncPromise) {
        return indexSyncPromise;
    }

    indexSyncPromise = (async () => {
        const docsByPath = new Map(
            catalog.map((doc) => [doc.relativePath, doc]),
        );

        if (wantsLocalBackend()) {
            searchBackend = 'local';
            const result = syncLocalIndex(catalog);
            console.log(
                `Busca semântica local: ${result.indexed} documento(s) indexados (TF-IDF).`,
            );
            return result;
        }

        const preferredBackend = resolveApiBackend();
        let apiBackend = preferredBackend;

        if (config.semanticSearchMode === 'auto') {
            const chain = getProviderChain();
            let apiAvailable = false;

            for (const provider of chain.length ? chain : [apiBackend]) {
                if (await probeApiEmbeddings(provider)) {
                    apiBackend = provider;
                    apiAvailable = true;
                    break;
                }
            }

            if (!apiAvailable) {
                console.warn(
                    'Embeddings por API indisponíveis — usando busca local TF-IDF.',
                );
                searchBackend = 'local';
                const result = syncLocalIndex(catalog);
                console.log(
                    `Busca semântica local: ${result.indexed} documento(s) indexados (TF-IDF).`,
                );
                return result;
            }
        }

        try {
            const result = await syncVectorIndex(
                catalog,
                catalog,
                docsByPath,
                apiBackend,
            );
            searchBackend = apiBackend;
            console.log(
                `Embeddings ${getEmbeddingProviderLabel(apiBackend)}: ${result.indexed} documento(s) indexados.`,
            );
            return result;
        } catch (err) {
            if (!shouldFallbackToLocal(err)) {
                throw err;
            }
            console.warn(
                `Embeddings ${getEmbeddingProviderLabel(apiBackend)} falhou — usando busca local TF-IDF.`,
            );
        }

        searchBackend = 'local';
        const result = syncLocalIndex(catalog);
        console.log(
            `Busca semântica local: ${result.indexed} documento(s) indexados (TF-IDF).`,
        );
        return result;
    })()
        .catch((err) => {
            console.error('Erro ao indexar busca semântica:', err.message);
            indexReady = false;
            resetLocalIndex();
            return { indexed: 0, error: err.message, backend: searchBackend };
        })
        .finally(() => {
            indexSyncPromise = null;
        });

    return indexSyncPromise;
}

async function searchSemantic(query, catalog) {
    if (!isEnabled() || !indexReady) {
        return [];
    }

    const trimmed = String(query || '').trim();
    if (!trimmed) {
        return [];
    }

    const searchPromise =
        searchBackend === 'local'
            ? Promise.resolve(
                  searchLocal(query, catalog, {
                      minScore: config.semanticSearchLocalMinScore,
                      topK: config.semanticSearchTopK,
                  }),
              )
            : searchSemanticVectors(trimmed, catalog, query);

    try {
        return await Promise.race([
            searchPromise,
            new Promise((_, reject) =>
                setTimeout(
                    () => reject(new Error('semantic search timeout')),
                    config.semanticSearchTimeoutMs,
                ),
            ),
        ]);
    } catch (err) {
        if (searchBackend === 'local') {
            return [];
        }
        console.warn(
            'Busca semântica lenta — usando só palavras-chave:',
            err.message,
        );
        return searchLocal(query, catalog, {
            minScore: config.semanticSearchLocalMinScore,
            topK: config.semanticSearchTopK,
        });
    }
}

async function searchSemanticVectors(trimmed, catalog, query) {
    if (vectorIndex.length === 0) {
        return [];
    }

    try {
        const backend =
            searchBackend === 'openai' || searchBackend === 'groq'
                ? searchBackend
                : resolveApiBackend();
        const [queryVector] = await apiEmbedTexts(
            [`${QUERY_PREFIX}${trimmed}`],
            backend,
        );
        if (!queryVector) {
            return [];
        }

        const catalogByPath = new Map(
            catalog.map((doc) => [doc.relativePath, doc]),
        );

        return vectorIndex
            .map((entry) => ({
                doc: catalogByPath.get(entry.relativePath) || entry.doc,
                score: cosineSimilarity(queryVector, entry.vector),
            }))
            .filter((item) => item.score >= config.semanticSearchMinSimilarity)
            .sort((a, b) => b.score - a.score)
            .slice(0, config.semanticSearchTopK);
    } catch (err) {
        console.error('Busca semântica por vetores falhou:', err.message);
        return searchLocal(query, catalog, {
            minScore: config.semanticSearchLocalMinScore,
            topK: config.semanticSearchTopK,
        });
    }
}

function isIndexReady() {
    return indexReady;
}

function getSearchBackend() {
    return searchBackend;
}

module.exports = {
    syncEmbeddingIndex,
    searchSemantic,
    isIndexReady,
    isEnabled,
    getSearchBackend,
};
