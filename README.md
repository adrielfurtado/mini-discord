# Mini Discord 🎙️📷🖥️

Um "mini-Discord" para você e seus amigos: **vídeo, áudio, compartilhamento de tela e chat de texto**, direto no navegador. Sem cadastro, sem banco de dados.

- **Servidor:** Node.js + Express + Socket.io (só faz a *sinalização* e o chat)
- **Cliente:** HTML/CSS/JavaScript puro com a API nativa **WebRTC**
- **Mídia:** trafega direto entre os navegadores (P2P em malha) — o servidor não vê seu vídeo

## Estrutura de pastas

```
mini-discord/
├── package.json        # dependências (express, socket.io)
├── server.js           # servidor de sinalização + chat
├── .gitignore
├── README.md
└── public/             # tudo que o navegador baixa
    ├── index.html      # tela inicial + sala
    ├── style.css       # tema escuro estilo Discord
    └── app.js          # lógica WebRTC, controles e chat
```

---

## 1. Instalar o Node.js

Você precisa do **Node.js 18 ou mais novo** (recomendo a versão LTS).

**Windows / macOS:** baixe o instalador em <https://nodejs.org> (botão "LTS"), execute e avance até o fim.

**Linux (via nvm):**
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# feche e reabra o terminal, depois:
nvm install --lts
```

Confira a instalação:
```bash
node -v   # deve mostrar v18 ou superior
npm -v
```

## 2. Rodar o projeto

No terminal, entre na pasta do projeto:

```bash
cd mini-discord
npm install      # baixa as dependências (só na primeira vez)
npm start        # sobe o servidor
```

Você verá algo como:
```
Mini Discord rodando (HTTP, até 8 pessoas por sala)
  Local:  http://localhost:3000
  Rede:   http://192.168.0.10:3000
```

## 3. Testar sozinho

1. Abra <http://localhost:3000> em uma aba, digite um nome e uma sala (ex.: `teste`) e entre. Permita câmera e microfone.
2. Abra **outra aba** (ou janela anônima), entre na **mesma sala** com outro nome.
3. Você deve ver os dois vídeos. Teste mutar, desligar a câmera, compartilhar tela e o chat.

> Dica: use fones de ouvido ao testar com duas abas, senão haverá microfonia.

## 4. Jogar com amigos

### ⚠️ Regra importante: câmera e microfone exigem HTTPS

Os navegadores só liberam câmera, microfone e compartilhamento de tela em **`localhost`** ou em **HTTPS**.
Isso significa que abrir `http://192.168.0.10:3000` em *outro* computador **não vai conseguir usar câmera/microfone**. Há três soluções:

### Opção A — Túnel com ngrok (mais fácil, funciona pela internet)

1. Crie uma conta grátis em <https://ngrok.com> e instale o ngrok seguindo as instruções do painel.
2. Configure seu token (uma vez só): `ngrok config add-authtoken SEU_TOKEN`
3. Com o servidor rodando (`npm start`), abra **outro terminal** e execute:
   ```bash
   ngrok http 3000
   ```
4. O ngrok mostra um endereço `https://alguma-coisa.ngrok-free.app`. Abra-o, entre numa sala, clique em **🔗 Copiar link** e mande para os amigos.

*(Na primeira visita o ngrok pode mostrar uma página de aviso — é só clicar em "Visit Site".)*

### Opção B — Túnel com Cloudflare (sem conta)

Instale o [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) e rode:
```bash
cloudflared tunnel --url http://localhost:3000
```
Ele imprime um endereço `https://….trycloudflare.com` para compartilhar.

### Opção C — Mesma rede Wi‑Fi (só para testes)

Para testar entre dispositivos da mesma rede sem túnel, você precisa de HTTPS local:

1. Instale o [mkcert](https://github.com/FiloSottile/mkcert) e gere um certificado:
   ```bash
   mkcert -install
   mkdir certs
   mkcert -key-file certs/key.pem -cert-file certs/cert.pem localhost 192.168.0.10
   ```
   (troque `192.168.0.10` pelo IP que o servidor mostrou em "Rede").
2. Reinicie com `npm start` — ao achar os arquivos em `certs/`, o servidor sobe em **HTTPS** automaticamente.
3. Os outros dispositivos precisarão confiar na CA do mkcert (ou aceitar o aviso de certificado). Por isso a Opção A/B costuma ser bem mais simples.

## Como usar

| Controle | O que faz |
|---|---|
| 🎙️ | Muta/desmuta o microfone |
| 📷 | Liga/desliga a câmera (aparece seu avatar) |
| 🖥️ | Compartilha a tela (clique de novo para parar). Webcam e tela funcionam ao mesmo tempo |
| 💬 | Abre/fecha o chat (o contador vermelho mostra mensagens não lidas) |
| 📞 | Sai da sala |
| Duplo clique num vídeo | Tela cheia |

Um anel verde aparece em volta de quem está falando.

## Configurações opcionais (variáveis de ambiente)

| Variável | Padrão | Para que serve |
|---|---|---|
| `PORT` | `3000` | Porta do servidor |
| `MAX_PER_ROOM` | `8` | Máximo de pessoas por sala |
| `TURN_URL` | — | Servidor TURN (ex.: `turn:meu-servidor:3478`) |
| `TURN_USER` / `TURN_PASS` | — | Credenciais do TURN |

Exemplo: `PORT=8080 MAX_PER_ROOM=5 npm start` (no Windows PowerShell: `$env:PORT=8080; npm start`).

## Limitações e dicas

- **Malha P2P:** cada pessoa envia seu vídeo para *todas* as outras. Funciona muito bem com **2 a 5 pessoas**; acima disso, o upload de quem está na chamada vira gargalo. Para grupos grandes seria necessário um SFU (ex.: mediasoup, LiveKit).
- **Redes restritas:** o projeto usa servidores STUN públicos do Google. Em algumas redes (4G de certas operadoras, redes corporativas) a conexão direta falha e é preciso um servidor **TURN** (configure `TURN_URL`, `TURN_USER`, `TURN_PASS`).
- **Salas:** não têm senha — quem souber o nome entra. Use nomes difíceis de adivinhar (o botão 🎲 gera um).
- **Celular:** funciona para câmera, áudio e chat; navegadores de celular geralmente **não** permitem compartilhar tela (o botão some).
- **Áudio da tela:** só é compartilhado se o navegador oferecer (Chrome/Edge, ao compartilhar uma aba ou a tela inteira no Windows).

## Problemas comuns

- **"Câmera/microfone indisponíveis":** você está acessando por `http://` num endereço que não é `localhost`. Use um túnel (Opção A/B).
- **Vejo o vídeo mas não ouço:** verifique se o outro lado não está mutado (ícone 🔇 no nome) e se o volume do sistema está ok.
- **Fico preso em "conectando" / vídeo preto:** provavelmente rede restritiva; configure um TURN.
- **A porta 3000 está em uso:** rode com outra porta, ex.: `PORT=3001 npm start`.
