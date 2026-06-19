'use strict';

const config = require('./config');

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const WHISPER_PROVIDERS = new Set(['openai', 'groq']);
const EMBEDDING_PROVIDERS = new Set(['openai', 'groq']);

let providerChain = [];
let providersResolved = false;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
    return RETRYABLE_STATUSES.has(status);
}

function providerLabel(provider) {
    if (provider === 'openai') return 'OpenAI';
    if (provider === 'gemini') return 'Gemini';
    return 'Groq';
}

function getApiKeyFor(provider) {
    if (provider === 'openai') return config.openaiApiKey;
    if (provider === 'gemini') return config.geminiApiKey;
    return config.groqApiKey;
}

function hasConfiguredKey(provider) {
    return Boolean(getApiKeyFor(provider));
}

function getProbeOrder() {
    const preference = config.aiProvider;
    const order = [];

    if (preference === 'groq') {
        if (hasConfiguredKey('groq')) order.push('groq');
        if (hasConfiguredKey('openai')) order.push('openai');
    } else if (preference === 'gemini') {
        if (hasConfiguredKey('gemini')) order.push('gemini');
        if (hasConfiguredKey('groq')) order.push('groq');
        if (hasConfiguredKey('openai')) order.push('openai');
    } else {
        if (hasConfiguredKey('openai')) order.push('openai');
        if (hasConfiguredKey('groq')) order.push('groq');
    }

    return [...new Set(order)];
}

function chatUrl(provider) {
    if (provider === 'openai') {
        return 'https://api.openai.com/v1/chat/completions';
    }
    if (provider === 'gemini') {
        return `https://generativelanguage.googleapis.com/v1beta/models/${chatModel('gemini')}:generateContent`;
    }
    return 'https://api.groq.com/openai/v1/chat/completions';
}

function audioUrl(provider) {
    return provider === 'openai'
        ? 'https://api.openai.com/v1/audio/transcriptions'
        : 'https://api.groq.com/openai/v1/audio/transcriptions';
}

function embeddingsUrl(provider) {
    return provider === 'openai'
        ? 'https://api.openai.com/v1/embeddings'
        : 'https://api.groq.com/openai/v1/embeddings';
}

function chatModel(provider) {
    if (provider === 'openai') return config.openaiModel;
    if (provider === 'gemini') return config.geminiModel;
    return config.groqModel;
}

function spamModel(provider) {
    if (provider === 'openai') return config.openaiSpamModel;
    if (provider === 'gemini') return config.geminiSpamModel;
    return config.groqSpamModel;
}

function whisperModel(provider) {
    return provider === 'openai'
        ? config.openaiWhisperModel
        : config.groqWhisperModel;
}

function visionModel(provider) {
    if (provider === 'openai') return config.openaiVisionModel;
    if (provider === 'gemini') return config.geminiVisionModel;
    return config.groqVisionModel;
}

function embeddingModel(provider) {
    return provider === 'openai'
        ? config.openaiEmbeddingModel
        : config.groqEmbeddingModel;
}

function isProviderUsable(status, body) {
    if (status === 200) {
        return true;
    }

    const text = String(body || '').toLowerCase();
    if (status === 401 || status === 403) {
        return false;
    }
    if (status === 404 || text.includes('model_not_found')) {
        return false;
    }
    if (status === 429 && text.includes('insufficient_quota')) {
        return false;
    }
    if (status === 429 && text.includes('quota')) {
        return false;
    }

    return false;
}

function openAiContentToGeminiParts(content) {
    if (typeof content === 'string') {
        return content ? [{ text: content }] : [];
    }
    if (!Array.isArray(content)) {
        return [];
    }

    return content.flatMap((part) => {
        if (part.type === 'text') {
            return [{ text: part.text }];
        }
        if (part.type === 'image_url') {
            const url = part.image_url?.url || '';
            const match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
                return [
                    {
                        inlineData: {
                            mimeType: match[1],
                            data: match[2],
                        },
                    },
                ];
            }
        }
        return [];
    });
}

function openAiMessagesToGemini(messages) {
    let systemInstruction;
    const contents = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            const text =
                typeof msg.content === 'string'
                    ? msg.content
                    : String(msg.content);
            systemInstruction = { parts: [{ text }] };
            continue;
        }

        const role = msg.role === 'assistant' ? 'model' : 'user';
        const parts = openAiContentToGeminiParts(msg.content);
        if (!parts.length) {
            continue;
        }

        const last = contents[contents.length - 1];
        if (last && last.role === role) {
            last.parts.push(...parts);
        } else {
            contents.push({ role, parts });
        }
    }

    return { systemInstruction, contents };
}

function resolveGeminiModel(options = {}, kind = 'chat') {
    const requested = options.model;
    if (requested && String(requested).startsWith('gemini')) {
        return requested;
    }
    if (kind === 'vision') {
        return visionModel('gemini');
    }
    if (kind === 'spam') {
        return spamModel('gemini');
    }
    return chatModel('gemini');
}

function extractGeminiText(data) {
    const parts = data.candidates?.[0]?.content?.parts || [];
    return parts
        .map((part) => part.text || '')
        .join('')
        .trim();
}

function isProbeRetryable(status, body, err) {
    if (err) {
        return true;
    }
    if (status === 401 || status === 403 || status === 404) {
        return false;
    }
    const text = String(body || '').toLowerCase();
    if (status === 429 && text.includes('insufficient_quota')) {
        return false;
    }
    return isRetryableStatus(status) || status === 429;
}

async function probeChatProviderOnce(provider) {
    if (!hasConfiguredKey(provider)) {
        return { ok: false, reason: 'chave não configurada' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(
        () => controller.abort(),
        config.aiProbeTimeoutMs,
    );

    try {
        if (provider === 'gemini') {
            const model = chatModel('gemini');
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${getApiKeyFor('gemini')}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
                        generationConfig: {
                            maxOutputTokens: 32,
                            temperature: 0,
                        },
                    }),
                    signal: controller.signal,
                },
            );
            const body = await response.text();
            if (!isProviderUsable(response.status, body)) {
                return {
                    ok: false,
                    status: response.status,
                    reason: body.slice(0, 180),
                };
            }
            return { ok: true, status: response.status };
        }

        const response = await fetch(chatUrl(provider), {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${getApiKeyFor(provider)}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: chatModel(provider),
                messages: [{ role: 'user', content: 'ping' }],
                max_tokens: 8,
                temperature: 0,
            }),
            signal: controller.signal,
        });

        const body = await response.text();
        return {
            ok: isProviderUsable(response.status, body),
            status: response.status,
            reason: isProviderUsable(response.status, body)
                ? ''
                : body.slice(0, 180),
        };
    } catch (err) {
        const reason =
            err.name === 'AbortError'
                ? `timeout ${config.aiProbeTimeoutMs / 1000}s`
                : err.message;
        return { ok: false, reason };
    } finally {
        clearTimeout(timeout);
    }
}

async function probeChatProvider(provider) {
    let lastResult = { ok: false, reason: 'sem tentativas' };

    for (let attempt = 1; attempt <= config.aiProbeRetries; attempt++) {
        lastResult = await probeChatProviderOnce(provider);
        if (lastResult.ok) {
            return true;
        }

        const retryable = isProbeRetryable(
            lastResult.status,
            lastResult.reason,
            !lastResult.status &&
                String(lastResult.reason || '').includes('timeout')
                ? new Error('timeout')
                : null,
        );

        if (!retryable || attempt >= config.aiProbeRetries) {
            break;
        }

        const waitMs = 1500 * attempt;
        console.warn(
            `  ${providerLabel(provider)} tentativa ${attempt}/${config.aiProbeRetries} falhou — nova em ${waitMs}ms`,
        );
        await sleep(waitMs);
    }

    if (lastResult.reason) {
        console.warn(
            `  ${providerLabel(provider)}: ${lastResult.status || 'erro'} — ${lastResult.reason}`,
        );
    }

    return false;
}

function buildConfiguredProviderChain() {
    const chain = [];
    const preference = config.aiProvider;

    if (preference === 'groq') {
        if (hasConfiguredKey('groq')) chain.push('groq');
        if (hasConfiguredKey('openai')) chain.push('openai');
    } else if (preference === 'gemini') {
        if (hasConfiguredKey('gemini')) chain.push('gemini');
        if (hasConfiguredKey('groq')) chain.push('groq');
        if (hasConfiguredKey('openai')) chain.push('openai');
    } else {
        if (hasConfiguredKey('groq')) chain.push('groq');
        if (hasConfiguredKey('openai')) chain.push('openai');
    }

    if (hasConfiguredKey('gemini') && !chain.includes('gemini')) {
        chain.push('gemini');
    }

    return [...new Set(chain)];
}

async function resolveProviders() {
    if (providersResolved) {
        return {
            primary: providerChain[0],
            fallback: providerChain[1] || null,
            chain: providerChain,
        };
    }

    const order = getProbeOrder();
    if (order.length === 0 && !hasConfiguredKey('gemini')) {
        throw new Error(
            'Defina OPENAI_API_KEY, GROQ_API_KEY e/ou GEMINI_API_KEY no .env',
        );
    }

    console.log('Verificando APIs de IA disponíveis…');

    const chain = [];

    for (const provider of order) {
        if (provider === 'gemini') {
            continue;
        }

        const ok = await probeChatProvider(provider);
        console.log(
            ok
                ? `  ${providerLabel(provider)}: disponível`
                : `  ${providerLabel(provider)}: indisponível`,
        );

        if (ok) {
            chain.push(provider);
        }
    }

    if (hasConfiguredKey('gemini')) {
        const geminiOk = await probeChatProvider('gemini');
        console.log(
            geminiOk
                ? '  Gemini: disponível (fallback)'
                : '  Gemini: indisponível',
        );
        if (geminiOk && !chain.includes('gemini')) {
            chain.push('gemini');
        }
    }

    if (chain.length === 0) {
        const configured = buildConfiguredProviderChain();
        if (configured.length === 0) {
            throw new Error(
                'Nenhuma API de IA respondeu. Verifique chaves, modelos, rede e saldo (OpenAI/Groq/Gemini).',
            );
        }

        providerChain = configured;
        providersResolved = true;

        console.warn(
            'Aviso: teste inicial das APIs falhou (rede ou rate limit). ' +
                `Iniciando com chaves configuradas: ${configured.map(providerLabel).join(' → ')}`,
        );
        console.log(
            `IA principal: ${providerLabel(configured[0])} | fallback: ${
                configured.length > 1
                    ? configured.slice(1).map(providerLabel).join(', ')
                    : 'nenhum (teste falhou)'
            }`,
        );

        return {
            primary: configured[0],
            fallback: configured[1] || null,
            chain: configured,
        };
    }

    providerChain = chain;
    providersResolved = true;

    const fallbacks = chain.slice(1).map(providerLabel);
    const summary = fallbacks.length
        ? `IA principal: ${providerLabel(chain[0])} | fallback: ${fallbacks.join(', ')}`
        : `IA principal: ${providerLabel(chain[0])} (sem fallback)`;
    console.log(summary);

    return {
        primary: chain[0],
        fallback: chain[1] || null,
        chain,
    };
}

function getProviderChain() {
    return [...providerChain];
}

function getChatProviderChain() {
    return getProviderChain();
}

function getPrimaryProvider() {
    return providerChain[0] || null;
}

function getFallbackProvider() {
    return providerChain[1] || null;
}

function isOpenAI(provider) {
    const active = provider || getPrimaryProvider() || config.aiProvider;
    return active === 'openai';
}

function getProviderLabel(provider) {
    return providerLabel(provider || getPrimaryProvider() || 'groq');
}

function getApiKey(provider) {
    return getApiKeyFor(provider || getPrimaryProvider());
}

function hasApiKey() {
    return (
        hasConfiguredKey('openai') ||
        hasConfiguredKey('groq') ||
        hasConfiguredKey('gemini')
    );
}

function getChatModel(provider) {
    return chatModel(provider || getPrimaryProvider());
}

function getSpamModel(provider) {
    return spamModel(provider || getPrimaryProvider());
}

function getWhisperModel(provider) {
    return whisperModel(provider || getPrimaryProvider());
}

function getVisionModel(provider) {
    return visionModel(provider || getPrimaryProvider());
}

function getEmbeddingModel(provider) {
    return embeddingModel(provider || getPrimaryProvider());
}

function getEmbeddingProviderLabel(provider) {
    return providerLabel(provider || getPrimaryProvider());
}

function shouldTryFallback(err) {
    const message = String(err?.message || err || '').toLowerCase();
    return (
        message.includes('insufficient_quota') ||
        message.includes('model_not_found') ||
        message.includes('does not exist') ||
        message.includes('resource_exhausted') ||
        message.includes('401') ||
        message.includes('403') ||
        message.includes('404') ||
        message.includes('429') ||
        message.includes('excedeu')
    );
}

function temperatureForIntent(intent, options = {}) {
    if (options.strictFactual || intent === 'document' || intent === 'email') {
        return config.groqTemperatureFactual;
    }
    if (intent === 'greeting') {
        return config.groqTemperatureCreative;
    }
    return config.groqTemperature;
}

async function callGeminiChatCompletion(messages, options = {}) {
    const {
        intent = 'general',
        model = resolveGeminiModel(options),
        temperature,
        maxTokens = config.groqMaxTokens,
        maxAttempts = config.groqMaxRetries,
        strictFactual = false,
    } = options;

    const apiKey = getApiKeyFor('gemini');
    if (!apiKey) {
        throw new Error('Chave da API Gemini não configurada');
    }

    const resolvedTemperature =
        temperature !== undefined
            ? temperature
            : temperatureForIntent(intent, { strictFactual });
    const { systemInstruction, contents } = openAiMessagesToGemini(messages);

    const body = {
        contents,
        generationConfig: {
            temperature: resolvedTemperature,
            maxOutputTokens: maxTokens,
        },
    };
    if (systemInstruction) {
        body.systemInstruction = systemInstruction;
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(
            () => controller.abort(),
            config.groqRequestTimeoutMs,
        );

        let response;
        try {
            response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                },
            );
        } catch (err) {
            clearTimeout(timeout);
            if (err.name === 'AbortError') {
                throw new Error(
                    `Gemini excedeu ${config.groqRequestTimeoutMs / 1000}s`,
                );
            }
            throw err;
        }
        clearTimeout(timeout);

        const responseBody = await response.text();
        if (!response.ok) {
            if (attempt < maxAttempts && isRetryableStatus(response.status)) {
                const waitMs = 1000 * attempt;
                console.warn(
                    `Gemini ${response.status} — tentativa ${attempt}/${maxAttempts}, aguardando ${waitMs}ms`,
                );
                await sleep(waitMs);
                continue;
            }
            throw new Error(`Gemini API ${response.status}: ${responseBody}`);
        }

        const data = JSON.parse(responseBody);
        const content = extractGeminiText(data);
        if (!content) {
            throw new Error('Gemini retornou resposta vazia');
        }

        return content;
    }

    throw new Error('Gemini: tentativas esgotadas');
}

async function callChatCompletionOnProvider(provider, messages, options = {}) {
    if (provider === 'gemini') {
        return callGeminiChatCompletion(messages, options);
    }

    const {
        intent = 'general',
        model = chatModel(provider),
        temperature,
        maxTokens = config.groqMaxTokens,
        maxAttempts = config.groqMaxRetries,
        strictFactual = false,
    } = options;

    const apiKey = getApiKeyFor(provider);
    if (!apiKey) {
        throw new Error(
            `Chave da API ${providerLabel(provider)} não configurada`,
        );
    }

    const resolvedTemperature =
        temperature !== undefined
            ? temperature
            : temperatureForIntent(intent, { strictFactual });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(
            () => controller.abort(),
            config.groqRequestTimeoutMs,
        );

        let response;
        try {
            response = await fetch(chatUrl(provider), {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model,
                    messages,
                    temperature: resolvedTemperature,
                    max_tokens: maxTokens,
                }),
                signal: controller.signal,
            });
        } catch (err) {
            clearTimeout(timeout);
            if (err.name === 'AbortError') {
                throw new Error(
                    `${providerLabel(provider)} excedeu ${config.groqRequestTimeoutMs / 1000}s`,
                );
            }
            throw err;
        }
        clearTimeout(timeout);

        if (!response.ok) {
            const errorBody = await response.text();
            if (attempt < maxAttempts && isRetryableStatus(response.status)) {
                const waitMs = 1000 * attempt;
                console.warn(
                    `${providerLabel(provider)} ${response.status} — tentativa ${attempt}/${maxAttempts}, aguardando ${waitMs}ms`,
                );
                await sleep(waitMs);
                continue;
            }
            throw new Error(
                `${providerLabel(provider)} API ${response.status}: ${errorBody}`,
            );
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content?.trim();

        if (!content) {
            throw new Error(
                `${providerLabel(provider)} retornou resposta vazia`,
            );
        }

        return content;
    }

    throw new Error(`${providerLabel(provider)}: tentativas esgotadas`);
}

async function callChatCompletion(messages, options = {}) {
    const chain = getChatProviderChain();
    if (chain.length === 0) {
        throw new Error(
            'Provedor de IA não inicializado — chame resolveProviders()',
        );
    }

    let lastError;
    for (let i = 0; i < chain.length; i++) {
        const provider = chain[i];
        try {
            return await callChatCompletionOnProvider(
                provider,
                messages,
                options,
            );
        } catch (err) {
            lastError = err;
            if (i < chain.length - 1 && shouldTryFallback(err)) {
                console.warn(
                    `${providerLabel(provider)} falhou — tentando ${providerLabel(chain[i + 1])}…`,
                );
                continue;
            }
            throw err;
        }
    }

    throw lastError;
}

async function embedTextsOnProvider(texts, provider) {
    if (!texts.length) {
        return [];
    }

    const apiKey = getApiKeyFor(provider);
    const model = embeddingModel(provider);
    const label = providerLabel(provider);

    if (!apiKey) {
        throw new Error(
            `Chave da API ${label} não configurada para embeddings`,
        );
    }

    const controller = new AbortController();
    const timeout = setTimeout(
        () => controller.abort(),
        config.groqRequestTimeoutMs,
    );

    try {
        const response = await fetch(embeddingsUrl(provider), {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model,
                input: texts,
                encoding_format: 'float',
            }),
            signal: controller.signal,
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(
                `${label} Embeddings ${response.status}: ${errorBody}`,
            );
        }

        const data = await response.json();
        return (data.data || [])
            .sort((a, b) => a.index - b.index)
            .map((item) => item.embedding);
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error(
                `Embeddings excederam ${config.groqRequestTimeoutMs / 1000}s`,
            );
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}

function getEmbeddingProviderChain() {
    return getProviderChain().filter((provider) =>
        EMBEDDING_PROVIDERS.has(provider),
    );
}

async function embedTexts(texts, provider) {
    const chain = provider
        ? [provider]
        : getEmbeddingProviderChain().length > 0
          ? getEmbeddingProviderChain()
          : getProbeOrder().filter((p) => EMBEDDING_PROVIDERS.has(p));

    let lastError;
    for (let i = 0; i < chain.length; i++) {
        try {
            return await embedTextsOnProvider(texts, chain[i]);
        } catch (err) {
            lastError = err;
            if (i < chain.length - 1 && shouldTryFallback(err)) {
                continue;
            }
            throw err;
        }
    }

    throw lastError;
}

async function transcribeAudioOnProvider(buffer, filename, mimetype, provider) {
    const apiKey = getApiKeyFor(provider);
    if (!apiKey) {
        throw new Error(
            `Chave da API ${providerLabel(provider)} não configurada`,
        );
    }

    const form = new FormData();
    const blob = new Blob([buffer], {
        type: mimetype || 'application/octet-stream',
    });
    form.append('file', blob, filename);
    form.append('model', whisperModel(provider));
    form.append('language', 'pt');
    form.append('response_format', 'json');
    if (provider !== 'openai') {
        form.append('temperature', '0');
    }

    const controller = new AbortController();
    const timeout = setTimeout(
        () => controller.abort(),
        config.groqRequestTimeoutMs,
    );

    try {
        const response = await fetch(audioUrl(provider), {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
            },
            body: form,
            signal: controller.signal,
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(
                `${providerLabel(provider)} Whisper ${response.status}: ${errorBody}`,
            );
        }

        const data = await response.json();
        return String(data.text || '').trim();
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error(
                `Whisper excedeu ${config.groqRequestTimeoutMs / 1000}s`,
            );
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}

async function transcribeAudio(buffer, filename, mimetype) {
    const chain = getProviderChain().filter((provider) =>
        WHISPER_PROVIDERS.has(provider),
    );
    let lastError;

    for (let i = 0; i < chain.length; i++) {
        try {
            return await transcribeAudioOnProvider(
                buffer,
                filename,
                mimetype,
                chain[i],
            );
        } catch (err) {
            lastError = err;
            if (i < chain.length - 1 && shouldTryFallback(err)) {
                console.warn(
                    `Whisper ${providerLabel(chain[i])} falhou — tentando ${providerLabel(chain[i + 1])}…`,
                );
                continue;
            }
            throw err;
        }
    }

    throw lastError;
}

async function extractImageContext(buffer, mimetype) {
    const base64 = buffer.toString('base64');

    return callChatCompletion(
        [
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text:
                            'Transcreva todo o texto visível nesta imagem em português. ' +
                            'Se não houver texto legível, descreva o conteúdo em uma frase objetiva.',
                    },
                    {
                        type: 'image_url',
                        image_url: {
                            url: `data:${mimetype};base64,${base64}`,
                        },
                    },
                ],
            },
        ],
        {
            model: getVisionModel(),
            temperature: 0.2,
            maxTokens: 600,
            maxAttempts: 1,
        },
    );
}

module.exports = {
    resolveProviders,
    getProviderChain,
    getPrimaryProvider,
    getFallbackProvider,
    isOpenAI,
    getProviderLabel,
    getApiKey,
    hasApiKey,
    getChatModel,
    getSpamModel,
    getWhisperModel,
    getEmbeddingModel,
    getEmbeddingProviderLabel,
    callChatCompletion,
    embedTexts,
    transcribeAudio,
    extractImageContext,
    probeChatProvider,
    shouldTryFallback,
};
