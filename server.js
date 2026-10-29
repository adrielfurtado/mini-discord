/**
 * Mini Discord — servidor de sinalização
 *
 * O servidor NÃO processa vídeo nem áudio. Ele só:
 *   1. serve os arquivos estáticos da pasta /public;
 *   2. mantém a lista de quem está em cada sala;
 *   3. repassa mensagens de sinalização WebRTC (offer/answer/ICE) entre os participantes;
 *   4. retransmite as mensagens do chat de texto.
 *
 * A mídia trafega diretamente entre os navegadores (P2P).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');
const { Server } = require('socket.io');

// ---------------------------------------------------------------------------
// Configuração (pode ser alterada por variáveis de ambiente)
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const MAX_PER_ROOM = Number(process.env.MAX_PER_ROOM) || 8; // malha P2P: acima de ~6 pessoas pesa muito

// ---------------------------------------------------------------------------
// Express + (opcional) HTTPS
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));

// Servidores ICE (STUN/TURN) entregues ao cliente.
// Para redes mais restritas, configure um TURN via variáveis de ambiente:
//   TURN_URL="turn:meu-servidor:3478" TURN_USER="usuario" TURN_PASS="senha"
app.get('/api/ice', (_req, res) => {
  const iceServers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()),
      username: process.env.TURN_USER || '',
      credential: process.env.TURN_PASS || '',
    });
  }
  res.json({ iceServers });
});

// Se existirem certs/key.pem e certs/cert.pem, sobe em HTTPS (necessário para
// usar câmera/microfone por IP da rede local). Caso contrário, HTTP simples.
const keyPath = path.join(__dirname, 'certs', 'key.pem');
const certPath = path.join(__dirname, 'certs', 'cert.pem');
const useHttps = fs.existsSync(keyPath) && fs.existsSync(certPath);

const server = useHttps
  ? https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app)
  : http.createServer(app);

const io = new Server(server);

// ---------------------------------------------------------------------------
// Estado das salas: Map<nomeDaSala, Map<socketId, { name }>>
// ---------------------------------------------------------------------------
const rooms = new Map();

/** Normaliza o nome da sala: minúsculas, sem espaços/símbolos, até 40 caracteres. */
const slug = (s) =>
  String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/** Limpa o nome de usuário: espaços normalizados, até 24 caracteres. */
const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 24);

io.on('connection', (socket) => {
  // ---- Entrar em uma sala -------------------------------------------------
  // O cliente envia { name, room } e recebe de volta, via callback (ack),
  // seu id e a lista de quem já está na sala.
  socket.on('join', (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (socket.data.room) return ack({ ok: false, error: 'Você já está em uma sala.' });

    const room = slug(payload && payload.room);
    const name = cleanName(payload && payload.name);
    if (!room || !name) return ack({ ok: false, error: 'Informe seu nome e o nome da sala.' });

    const members = rooms.get(room) || new Map();
    if (members.size >= MAX_PER_ROOM) {
      return ack({ ok: false, error: `Sala cheia (máximo de ${MAX_PER_ROOM} pessoas).` });
    }

    const peers = [...members].map(([id, m]) => ({ id, name: m.name }));

    members.set(socket.id, { name });
    rooms.set(room, members);
    socket.data.room = room;
    socket.data.name = name;
    socket.join(room);

    // Avisa os que já estavam na sala e responde ao novo participante.
    socket.to(room).emit('user-joined', { id: socket.id, name });
    ack({ ok: true, id: socket.id, room, peers });
  });

  // ---- Sinalização WebRTC (repasse ponto a ponto) -------------------------
  // `data` é opaco para o servidor: pode ser offer/answer/candidate/estado etc.
  socket.on('signal', (msg) => {
    const { to, data } = msg || {};
    const room = socket.data.room;
    if (!room || !to || !data) return;
    const members = rooms.get(room);
    if (!members || !members.has(to)) return; // só repassa para quem está na MESMA sala
    io.to(to).emit('signal', { from: socket.id, data });
  });

  // ---- Chat de texto ------------------------------------------------------
  socket.on('chat', (text) => {
    const room = socket.data.room;
    if (!room || typeof text !== 'string') return;
    const clean = text.trim().slice(0, 1000);
    if (!clean) return;
    io.to(room).emit('chat', {
      id: socket.id,
      name: socket.data.name,
      text: clean,
      ts: Date.now(),
    });
  });

  // ---- Saída --------------------------------------------------------------
  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (!room) return;
    const members = rooms.get(room);
    if (!members) return;
    members.delete(socket.id);
    if (members.size === 0) rooms.delete(room);
    else socket.to(room).emit('user-left', { id: socket.id });
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(PORT, () => {
  const proto = useHttps ? 'https' : 'http';
  console.log(`\nMini Discord rodando (${proto.toUpperCase()}, até ${MAX_PER_ROOM} pessoas por sala)`);
  console.log(`  Local:  ${proto}://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) console.log(`  Rede:   ${proto}://${i.address}:${PORT}`);
    }
  }
  if (!useHttps) {
    console.log('\nAviso: câmera/microfone só funcionam em localhost ou HTTPS.');
    console.log('Para amigos fora do seu PC, use um túnel (ngrok/cloudflared) — veja o README.\n');
  }
});
