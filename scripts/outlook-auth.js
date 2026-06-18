'use strict';

require('dotenv').config();

const readline = require('readline');
const config = require('../lib/config');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

function ask(question) {
    return new Promise((resolve) => rl.question(question, resolve));
}

async function main() {
    console.log('Autenticação Outlook / Microsoft Graph\n');

    const clientId =
        config.outlook.clientId || (await ask('OUTLOOK_CLIENT_ID: '));
    const tenantId = config.outlook.tenantId || 'common';

    const authUrl = new URL(
        `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/devicecode`,
    );

    const deviceResponse = await fetch(authUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            scope: 'https://graph.microsoft.com/Mail.Read offline_access',
        }),
    });

    if (!deviceResponse.ok) {
        console.error(await deviceResponse.text());
        process.exit(1);
    }

    const device = await deviceResponse.json();
    console.log('\n1. Abra:', device.verification_uri);
    console.log('2. Digite o código:', device.user_code);
    console.log('\nAguardando autenticação...\n');

    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    const started = Date.now();

    while (Date.now() - started < device.expires_in * 1000) {
        await new Promise((r) => setTimeout(r, device.interval * 1000));

        const tokenResponse = await fetch(tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                client_id: clientId,
                device_code: device.device_code,
            }),
        });

        const tokenData = await tokenResponse.json();

        if (tokenData.access_token) {
            console.log('Autenticado com sucesso!\n');
            console.log('Adicione ao .env:\n');
            console.log(`OUTLOOK_REFRESH_TOKEN=${tokenData.refresh_token}`);
            rl.close();
            return;
        }

        if (tokenData.error && tokenData.error !== 'authorization_pending') {
            console.error(
                'Erro:',
                tokenData.error_description || tokenData.error,
            );
            rl.close();
            process.exit(1);
        }
    }

    console.error('Tempo esgotado.');
    rl.close();
    process.exit(1);
}

main().catch((err) => {
    console.error(err.message);
    rl.close();
    process.exit(1);
});
