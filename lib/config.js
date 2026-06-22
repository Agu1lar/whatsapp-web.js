'use strict';

const path = require('path');

require('dotenv').config();

function resolveDocsRoot(value) {
    if (!value) {
        return path.join(__dirname, '..', 'documentos');
    }

    const trimmed = value.trim();
    if (trimmed.startsWith('\\\\')) {
        return trimmed.replace(/[\\/]+$/, '');
    }

    return path.resolve(trimmed);
}

const config = {
    aiProvider: (process.env.AI_PROVIDER || 'auto').toLowerCase(),
    aiProbeRetries: Number(process.env.AI_PROBE_RETRIES) || 3,
    aiProbeTimeoutMs: Number(process.env.AI_PROBE_TIMEOUT_MS) || 35000,
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    openaiSpamModel: process.env.OPENAI_SPAM_MODEL || 'gpt-4o-mini',
    openaiWhisperModel: process.env.OPENAI_WHISPER_MODEL || 'whisper-1',
    openaiVisionModel: process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini',
    openaiEmbeddingModel:
        process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
    groqApiKey: process.env.GROQ_API_KEY,
    groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    groqMaxTokens: Number(process.env.GROQ_MAX_TOKENS) || 700,
    groqTemperature: Number(process.env.GROQ_TEMPERATURE) || 0.45,
    groqTemperatureFactual: Number(process.env.GROQ_TEMPERATURE_FACTUAL) || 0.2,
    groqTemperatureCreative:
        Number(process.env.GROQ_TEMPERATURE_CREATIVE) || 0.8,
    groqMaxRetries: Number(process.env.GROQ_MAX_RETRIES) || 3,
    groqRequestTimeoutMs: Number(process.env.GROQ_REQUEST_TIMEOUT_MS) || 45000,
    groqWhisperModel:
        process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo',
    groqVisionModel:
        process.env.GROQ_VISION_MODEL || 'llama-3.2-11b-vision-preview',
    mediaMaxBytes: Number(process.env.MEDIA_MAX_BYTES) || 25 * 1024 * 1024,
    groqEmbeddingModel:
        process.env.GROQ_EMBEDDING_MODEL || 'nomic-embed-text-v1_5',
    semanticSearchMode: process.env.SEMANTIC_SEARCH_MODE || 'auto',
    semanticSearchEnabled: process.env.SEMANTIC_SEARCH_ENABLED !== 'false',
    semanticSearchMinSimilarity:
        Number(process.env.SEMANTIC_SEARCH_MIN_SIMILARITY) || 0.42,
    semanticSearchLocalMinScore:
        Number(process.env.SEMANTIC_SEARCH_LOCAL_MIN_SCORE) || 0.08,
    semanticSearchTopK: Number(process.env.SEMANTIC_SEARCH_TOP_K) || 12,
    semanticSearchKeywordWeight:
        Number(process.env.SEMANTIC_SEARCH_KEYWORD_WEIGHT) || 0.4,
    semanticSearchSemanticWeight:
        Number(process.env.SEMANTIC_SEARCH_SEMANTIC_WEIGHT) || 0.6,
    spamFilterEnabled: process.env.SPAM_FILTER_ENABLED !== 'false',
    spamFilterAi: process.env.SPAM_FILTER_AI !== 'false',
    spamFilterAiMinScore: Number(process.env.SPAM_FILTER_AI_MIN_SCORE) || 2,
    ragOnlyMode: process.env.RAG_ONLY_MODE !== 'false',
    pdfEnrichMaxOnSearch: Number(process.env.PDF_ENRICH_MAX_ON_SEARCH) || 2,
    pdfReadTimeoutMs: Number(process.env.PDF_READ_TIMEOUT_MS) || 8000,
    searchSkipSemanticMinKeywordScore:
        Number(process.env.SEARCH_SKIP_SEMANTIC_MIN_KEYWORD_SCORE) || 6,
    semanticSearchTimeoutMs:
        Number(process.env.SEMANTIC_SEARCH_TIMEOUT_MS) || 8000,
    groqSpamModel: process.env.GROQ_SPAM_MODEL || 'llama-3.1-8b-instant',
    geminiApiKey: process.env.GEMINI_API_KEY,
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    geminiSpamModel: process.env.GEMINI_SPAM_MODEL || 'gemini-2.5-flash',
    geminiVisionModel: process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash',
    docsRoot: resolveDocsRoot(process.env.DOCS_ROOT),
    conversationTtlMs:
        Number(process.env.CONVERSATION_TTL_MS) || 30 * 60 * 1000,
    conversationPruneIntervalMs:
        Number(process.env.CONVERSATION_PRUNE_INTERVAL_MS) || 10 * 60 * 1000,
    dataDir: path.join(__dirname, '..', 'data'),
    staffFile: path.join(__dirname, '..', 'data', 'funcionarios.json'),
    stateFile: path.join(__dirname, '..', 'data', 'conversations.json'),
    logsDir: path.join(__dirname, '..', 'data', 'logs'),
    historyLimitRegistered: Number(process.env.HISTORY_LIMIT_REGISTERED) || 40,
    historyLimitGuest: Number(process.env.HISTORY_LIMIT_GUEST) || 12,
    messageDebounceMs: Number(process.env.MESSAGE_DEBOUNCE_MS) || 2000,
    messageDebounceGreetingMs:
        Number(process.env.MESSAGE_DEBOUNCE_GREETING_MS) || 800,
    contactLookupTimeoutMs:
        Number(process.env.CONTACT_LOOKUP_TIMEOUT_MS) || 5000,
    catalogRefreshMs: Number(process.env.CATALOG_REFRESH_MS) || 60 * 60 * 1000,
    reconnectDelayMs: Number(process.env.RECONNECT_DELAY_MS) || 15000,
    puppeteerHeadless: process.env.PUPPETEER_HEADLESS === 'true',
    authTimeoutMs: Number(process.env.WA_AUTH_TIMEOUT_MS) || 120000,
    waInitRetries: Number(process.env.WA_INIT_RETRIES) || 4,
    waInitRetryDelayMs: Number(process.env.WA_INIT_RETRY_DELAY_MS) || 8000,
    timezone: process.env.TIMEZONE || 'America/Sao_Paulo',
    businessStart: process.env.BUSINESS_START || '07:30',
    businessEnd: process.env.BUSINESS_END || '17:15',
    businessDays: (process.env.BUSINESS_DAYS || '1,2,3,4,5')
        .split(',')
        .map((d) => Number(d.trim())),
    adminPhone: (process.env.ADMIN_PHONE || '').replace(/\D/g, ''),
    outlook: {
        mode: process.env.OUTLOOK_MODE || 'com',
        maxEmails: Number(process.env.OUTLOOK_MAX_EMAILS) || 8,
        clientId: process.env.OUTLOOK_CLIENT_ID || '',
        clientSecret: process.env.OUTLOOK_CLIENT_SECRET || '',
        tenantId: process.env.OUTLOOK_TENANT_ID || 'common',
        refreshToken: process.env.OUTLOOK_REFRESH_TOKEN || '',
        userEmail: process.env.OUTLOOK_USER_EMAIL || '',
    },
};

config.outlookMode = config.outlook.mode;

module.exports = config;
