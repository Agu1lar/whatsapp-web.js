<div align="center">
    <p>
        <a href="https://wwebjs.dev">
            <img src="https://github.com/wwebjs/Assets/blob/main/Collection/GitHub/whatsapp-web.js.png?raw=true"
                title="whatsapp-web.js" alt="WWebJS Website" />
        </a>
    </p>
    <p>
        <a href="https://www.npmjs.com/package/whatsapp-web.js"><img
                src="https://img.shields.io/npm/v/whatsapp-web.js.svg" alt="npm" /></a>
        <a href="https://www.npmjs.com/package/whatsapp-web.js"><img alt="NPM Downloads"
                src="https://img.shields.io/npm/d18m/whatsapp-web.js" /></a>
        <a href="https://github.com/wwebjs/whatsapp-web.js/graphs/contributors"><img alt="GitHub contributors"
                src="https://img.shields.io/github/contributors-anon/wwebjs/whatsapp-web.js" /></a>
        <a href="https://depfu.com/github/wwebjs/whatsapp-web.js?project_id=9765"><img
                src="https://badges.depfu.com/badges/4a65a0de96ece65fdf39e294e0c8dcba/overview.svg" alt="Depfu" /></a>
        <a href="https://discord.wwebjs.dev"><img
                src="https://img.shields.io/discord/698610475432411196.svg?logo=discord" alt="Discord server" /></a>
    </p>
</div>

---

## Fork — Acesso Equipamentos

> **Este repositório é um fork** de [wwebjs/whatsapp-web.js](https://github.com/wwebjs/whatsapp-web.js) ([upstream](https://github.com/wwebjs/whatsapp-web.js)).  
> Repositório deste fork: [Agu1lar/whatsapp-web.js](https://github.com/Agu1lar/whatsapp-web.js)

Mantido para o **bot de atendimento da Acesso Equipamentos** (área de tecnologia): assistente com IA no WhatsApp, consulta de documentos e e-mail via Outlook no Windows.

### Recursos do bot

| Recurso              | Descrição                                                                |
| -------------------- | ------------------------------------------------------------------------ |
| **Groq (Llama 3.3)** | Respostas em português, tom natural de WhatsApp                          |
| **Documentos**       | Indexa pasta local ou de rede (`DOCS_ROOT`) e envia arquivos sob demanda |
| **Outlook COM**      | Lê e-mails quando pedido explicitamente (Outlook aberto no Windows)      |
| **Expediente**       | Responde só em horário comercial configurável                            |
| **Escalonamento**    | Encaminha para o José em pedidos explícitos de atendimento humano        |
| **Comandos admin**   | `!pausar`, `!ativar`, `!status`, `!docs`, `!liberar`, `!meunumero`       |

### Início rápido

Requisitos: **Node.js 18+**, **Windows** (para Outlook COM), conta [Groq](https://console.groq.com/) com API key.

```powershell
git clone https://github.com/Agu1lar/whatsapp-web.js.git
cd whatsapp-web.js
npm install
copy .env.example .env
# Edite .env: GROQ_API_KEY, ADMIN_PHONE, DOCS_ROOT, etc.
copy data\funcionarios.example.json data\funcionarios.json
npm run bot
```

Na primeira execução, escaneie o QR Code no terminal. A sessão fica salva em `.wwebjs_auth/` (não versionada).

### Configuração (`.env`)

Copie `.env.example` para `.env`. Principais variáveis:

| Variável                          | Descrição                                                        |
| --------------------------------- | ---------------------------------------------------------------- |
| `GROQ_API_KEY`                    | Chave da API Groq                                                |
| `GROQ_MODEL`                      | Modelo (padrão: `llama-3.3-70b-versatile`)                       |
| `DOCS_ROOT`                       | Pasta com documentos (ex.: `\\servidor\pasta` ou `./documentos`) |
| `ADMIN_PHONE`                     | Seu número com DDI (55…) — comandos admin e alertas              |
| `BUSINESS_START` / `BUSINESS_END` | Expediente (padrão: 07:30–15:15, seg–sex)                        |
| `OUTLOOK_MODE`                    | `com` (Outlook desktop) ou `graph` (Azure)                       |
| `OUTLOOK_USER_EMAIL`              | Caixa de e-mail consultada                                       |

Arquivos **não versionados** (ver `.gitignore`): `.env`, `data/`, `.wwebjs_auth/`, `.wwebjs_cache/`.

### Estrutura do bot

```
bot.js              # Orquestrador principal
lib/
  groq.js           # Prompt e chamadas à IA
  documents.js      # Indexação, busca e envio de arquivos
  mail.js           # E-mail (Outlook COM / Graph)
  hours.js          # Expediente
  human-intent.js   # Detecção de pedido de atendente
  conversations.js  # Histórico e logs em data/
scripts/
  outlook-com-read.ps1
  outlook-auth.js   # npm run outlook-auth (modo Graph)
```

### Alterações em relação ao upstream

Além do bot e das libs em `lib/`, este fork inclui ajustes em `src/Client.js`:

- Correção de **race condition** no evento `ready` (sessão restaurada com `hasSynced` já true)
- Proteção contra emissão duplicada de `ready`
- Tratamento de erro em `onAppStateHasSyncedEvent`

Para usar **apenas a biblioteca** original, consulte a documentação abaixo ou o repositório [upstream](https://github.com/wwebjs/whatsapp-web.js).

---

## About

whatsapp‑web.js is a powerful [Node.js][nodejs] library that lets you interact with WhatsApp Web, making it easy to build a dynamic WhatsApp API with nearly all features of the web client. It uses [Puppeteer][puppeteer] to access WhatsApp Web’s internal functions and runs them in a managed browser instance to reduce the risk of being blocked.

## Links

- [GitHub][gitHub]
- [Guide][guide] ([source][guide-source])
- [Documentation][documentation] ([source][documentation-source])
- [Discord Server][discord]
- [npm][npm]

## Installation

**Node.js `v18.0.0` or higher, is required.**

```sh
npm install whatsapp-web.js
yarn add whatsapp-web.js
pnpm add whatsapp-web.js
```

Having trouble installing? Take a peak at the [Guide][guide] for more detailed instructions.

## Example usage

```js
const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client();

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Client is ready!');
});

client.on('message', (msg) => {
    if (msg.body == '!ping') {
        msg.reply('pong');
    }
});

client.initialize();
```

Take a look at [example.js][examples] for additional examples and use cases.  
For more details on saving and restoring sessions, check out the [Authentication Strategies][auth-strategies].

## Supported features

| Feature                                          | Status                                       |
| ------------------------------------------------ | -------------------------------------------- |
| Multi Device                                     | ✅                                           |
| Send messages                                    | ✅                                           |
| Receive messages                                 | ✅                                           |
| Send media (images/audio/documents)              | ✅                                           |
| Send media (video)                               | ✅ [(requires Google Chrome)][google-chrome] |
| Send stickers                                    | ✅                                           |
| Receive media (images/audio/video/documents)     | ✅                                           |
| Send contact cards                               | ✅                                           |
| Send location                                    | ✅                                           |
| Send buttons                                     | ❌ [(DEPRECATED)][deprecated-video]          |
| Send lists                                       | ❌ [(DEPRECATED)][deprecated-video]          |
| Receive location                                 | ✅                                           |
| Message replies                                  | ✅                                           |
| Join groups by invite                            | ✅                                           |
| Get invite for group                             | ✅                                           |
| Modify group info (subject, description)         | ✅                                           |
| Modify group settings (send messages, edit info) | ✅                                           |
| Add group participants                           | ✅                                           |
| Kick group participants                          | ✅                                           |
| Promote/demote group participants                | ✅                                           |
| Mention users                                    | ✅                                           |
| Mention groups                                   | ✅                                           |
| Mute/unmute chats                                | ✅                                           |
| Block/unblock contacts                           | ✅                                           |
| Get contact info                                 | ✅                                           |
| Get profile pictures                             | ✅                                           |
| Set user status message                          | ✅                                           |
| React to messages                                | ✅                                           |
| Create polls                                     | ✅                                           |
| Channels                                         | ✅                                           |
| Vote in polls                                    | ✅                                           |
| Communities                                      | 🔜                                           |

Something missing? Make an issue and let us know!

## Supporting the project

You can support the maintainer of this project through the links below:

- [Support via GitHub Sponsors][gitHub-sponsors]
- [Support via PayPal][support-payPal]

## Contributing

Feel free to open pull requests; we welcome contributions! However, for significant changes, it's best to open an issue beforehand. Make sure to review our [contribution guidelines][contributing] before creating a pull request. Before creating your own issue or pull request, always check to see if one already exists!

## Disclaimer

This project is not affiliated, associated, authorized, endorsed by, or in any way officially connected with WhatsApp or any of its subsidiaries or its affiliates. The official WhatsApp website can be found at [whatsapp.com][whatsapp]. "WhatsApp" as well as related names, marks, emblems and images are registered trademarks of their respective owners. Also it is not guaranteed you will not be blocked by using this method. WhatsApp does not allow bots or unofficial clients on their platform, so this shouldn't be considered totally safe.

## License

Copyright 2019 Pedro S Lopez

Licensed under the Apache License, Version 2.0 (the "License");  
you may not use this project except in compliance with the License.  
You may obtain a copy of the License at <https://www.apache.org/licenses/LICENSE-2.0>.

Unless required by applicable law or agreed to in writing, software  
distributed under the License is distributed on an "AS IS" BASIS,  
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.  
See the License for the specific language governing permissions and  
limitations under the License.

[guide]: https://guide.wwebjs.dev/guide
[guide-source]: https://github.com/wwebjs/wwebjs.dev/tree/main
[documentation]: https://docs.wwebjs.dev/
[documentation-source]: https://github.com/wwebjs/whatsapp-web.js/tree/main/docs
[discord]: https://discord.wwebjs.dev
[gitHub]: https://github.com/wwebjs/whatsapp-web.js
[npm]: https://npmjs.org/package/whatsapp-web.js
[nodejs]: https://nodejs.org/en/download/
[examples]: https://github.com/wwebjs/whatsapp-web.js/blob/main/example.js
[auth-strategies]: https://wwebjs.dev/guide/creating-your-bot/authentication.html
[google-chrome]: https://wwebjs.dev/guide/creating-your-bot/handling-attachments.html#caveat-for-sending-videos-and-gifs
[deprecated-video]: https://www.youtube.com/watch?v=hv1R1rLeVVE
[gitHub-sponsors]: https://github.com/sponsors/wwebjs
[support-payPal]: https://www.paypal.me/psla/
[contributing]: .github/CONTRIBUTING.md
[whatsapp]: https://whatsapp.com
[puppeteer]: https://pptr.dev/
