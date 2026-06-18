'use strict';

const fs = require('fs');
const path = require('path');

const KNOWLEDGE_MAX_CHARS = 3500;

function loadCompanyKnowledge(docsRoot) {
    const sections = [];

    if (!fs.existsSync(docsRoot)) {
        return '';
    }

    let entries;
    try {
        entries = fs.readdirSync(docsRoot, { withFileTypes: true });
    } catch {
        return '';
    }

    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        if (entry.name.startsWith('.')) continue;

        const filePath = path.join(docsRoot, entry.name);
        try {
            const content = fs.readFileSync(filePath, 'utf8').trim();
            if (content) {
                sections.push(`## ${entry.name}\n${content}`);
            }
        } catch {
            /* ignore */
        }
    }

    if (sections.length === 0) {
        return '';
    }

    const combined = sections.join('\n\n');
    if (combined.length <= KNOWLEDGE_MAX_CHARS) {
        return combined;
    }

    return `${combined.slice(0, KNOWLEDGE_MAX_CHARS)}...`;
}

module.exports = {
    loadCompanyKnowledge,
};
