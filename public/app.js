/**
 * Mini Discord — cliente
 *
 * Arquitetura: malha P2P (mesh). Cada participante abre uma RTCPeerConnection
 * com TODOS os outros da sala. O Socket.io serve apenas para sinalização
 * (trocar offer/answer/ICE) e para o chat.
 *
 * A negociação segue o padrão "perfect negotiation" da especificação WebRTC,
 * o que permite adicionar/remover tracks (ex.: compartilhar tela) a qualquer
 * momento, mesmo se os dois lados renegociarem ao mesmo tempo.
 */
(() => {
  'use strict';

  // -------------------------------------------------------------------------
  // Referências do DOM
  // -------------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const ui = {
    joinScreen: $('#join-screen'), joinForm: $('#join-form'), joinBtn: $('#join-btn'), joinError: $('#join-error'),
    nameInput: $('#name-input'), roomInput: $('#room-input'), randomRoom: $('#random-room'),
    app: $('#app'), roomTitle: $('#room-title'), count: $('#count'), copyLink: $('#copy-link'),
    grid: $('#grid'),
    chat: $('#chat'), messages: $('#messages'), chatForm: $('#chat-form'), chatInput: $('#chat-input'),
    btnMic: $('#btn-mic'), btnCam: $('#btn-cam'), btnScreen: $('#btn-screen'),
    btnChat: $('#btn-chat'), btnLeave: $('#btn-leave'), badge: $('#chat-badge'),
    toast: $('#toast'),
  };

  // -------------------------------------------------------------------------
  // Estado global
  // -------------------------------------------------------------------------
  const state = {
    socket: null,
    joined: false,
    myId: null,
    name: '',
    room: '',
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun.stunprotocol.org:3478' },
      { urls: 'stun:openrelay.metered.ca:80' }
    ],
    localStream: null,   // webcam + microfone
    screenStream: null,  // compartilhamento de tela (quando ativo)
    unread: 0,
  };

  /** Map<socketId, peer> — uma conexão por participante remoto. */
  const peers = new Map();
  /** Map<chave, tile> — chaves: "local", "local:screen", "<id>", "<id>:screen". */
  const tiles = new Map();

  // -------------------------------------------------------------------------
  // Utilidades
  // -------------------------------------------------------------------------
  const normalizeRoom = (s) =>
    String(s || '').trim().toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);

  const randomRoomName = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    return 'sala-' + [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 6);
  };

  /** Cor estável do avatar a partir do nome. */
  const colorFor = (name) => {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${h} 55% 45%)`;
  };

  let toastTimer;
  function toast(msg, ms = 3500) {
    ui.toast.textContent = msg;
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), ms);
  }

  const setError = (msg) => { ui.joinError.textContent = msg || ''; };

  // -------------------------------------------------------------------------
  // Tela inicial
  // -------------------------------------------------------------------------
  const params = new URLSearchParams(location.search);
  ui.nameInput.value = localStorage.getItem('md:name') || '';
  ui.roomInput.value = normalizeRoom(params.get('sala') || localStorage.getItem('md:room') || '');
  (ui.nameInput.value ? ui.roomInput : ui.nameInput).focus();

  ui.randomRoom.addEventListener('click', () => { ui.roomInput.value = randomRoomName(); });

  ui.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = ui.nameInput.value.trim();
    const room = normalizeRoom(ui.roomInput.value);
    if (!name || !room) return setError('Informe seu nome e o nome da sala.');
    join(name, room);
  });

  // -------------------------------------------------------------------------
  // Mídia local
  // -------------------------------------------------------------------------
  /** Tenta vídeo+áudio; se falhar, só áudio; depois só vídeo; senão entra como espectador. */
  async function getLocalMedia() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Câmera/microfone indisponíveis: use https:// ou localhost. Entrando como espectador.', 6000);
      return null;
    }
    const attempts = [
      { audio: { echoCancellation: true, noiseSuppression: true }, video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } },
      { audio: true, video: false },
      { audio: false, video: true },
    ];
    for (const constraints of attempts) {
      try { return await navigator.mediaDevices.getUserMedia(constraints); }
      catch (err) { console.warn('getUserMedia falhou:', constraints, err); }
    }
    toast('Não consegui acessar câmera/microfone. Você entrou como espectador.', 6000);
    return null;
  }

  const audioTrack = () => (state.localStream && state.localStream.getAudioTracks()[0]) || null;
  const videoTrack = () => (state.localStream && state.localStream.getVideoTracks()[0]) || null;
  const micOn = () => !!(audioTrack() && audioTrack().enabled);
  const camOn = () => !!(videoTrack() && videoTrack().enabled);

  // -------------------------------------------------------------------------
  // Tiles (cada vídeo na grade)
  // -------------------------------------------------------------------------
  let audioCtx = null;

  function createTile(key, label, { local = false, screen = false } = {}) {
    if (tiles.has(key)) return tiles.get(key);

    const el = document.createElement('div');
    el.className = 'tile' + (local ? ' local' : '') + (screen ? ' screen' : '');
    el.innerHTML = `
      <video autoplay playsinline></video>
      <div class="avatar"><span></span></div>
      <div class="tile-label">
        <span class="mic-icon" hidden>🔇</span>
        <span class="tile-name"></span>
        ${!local ? '<input type="range" class="volume-slider" min="0" max="1" step="0.05" value="1" title="Ajustar volume" style="width: 60px; margin-left: 8px; cursor: pointer;">' : ''}
      </div>`;

    const tile = {
      key, el,
      video: el.querySelector('video'),
      micIcon: el.querySelector('.mic-icon'),
      speakTimer: null,
      watching: false,
    };
    tile.video.muted = local; // nunca reproduzir o próprio áudio (evita eco)
    
    // Vincula o controle de volume se for um participante remoto
    if (!local) {
      const volSlider = el.querySelector('.volume-slider');
      if (volSlider) {
        volSlider.addEventListener('input', (e) => {
          tile.video.volume = e.target.value;
        });
      }
    }

    el.querySelector('.tile-name').textContent = label;
    const avatar = el.querySelector('.avatar span');
    avatar.textContent = (label.trim()[0] || '?').toUpperCase();
    avatar.style.setProperty('--av', colorFor(label));

    // Duplo clique = tela cheia
    el.addEventListener('dblclick', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (el.requestFullscreen) el.requestFullscreen();
    });

    tiles.set(key, tile);
    ui.grid.appendChild(el);
    updateGrid();
    return tile;
  }

  function removeTile(key) {
    const tile = tiles.get(key);
    if (!tile) return;
    clearInterval(tile.speakTimer);
    tile.video.srcObject = null;
    tile.el.remove();
    tiles.delete(key);
    updateGrid();
  }

  /** Atualiza avatar (câmera off) e ícone de microfone mutado de um tile. */
  function setTileState(key, { mic, cam }) {
    const tile = tiles.get(key);
    if (!tile) return;
    tile.el.classList.toggle('cam-off', !cam);
    tile.micIcon.hidden = !!mic;
  }

  /** Destaca quem está falando (anel verde) analisando o volume do áudio. */
  function watchSpeaking(tile, stream) {
    if (tile.watching || !stream.getAudioTracks().length) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const source = audioCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser); // não conecta ao destination: só mede, não toca
      const data = new Uint8Array(analyser.frequencyBinCount);
      tile.watching = true;
      tile.speakTimer = setInterval(() => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        tile.el.classList.toggle('speaking', avg > 18);
      }, 150);
    } catch (err) { console.warn('Detecção de fala indisponível:', err); }
  }

  /** Calcula colunas/linhas para a grade se ajustar sozinha ao número de vídeos. */
  function updateGrid() {
    const n = Math.max(tiles.size, 1);
    const narrow = window.innerWidth < 720;
    let cols;
    if (narrow) cols = n <= 2 ? 1 : 2;
    else if (n === 1) cols = 1;
    else if (n <= 4) cols = 2;
    else if (n <= 6) cols = 3;
    else cols = Math.ceil(Math.sqrt(n));
    ui.grid.style.setProperty('--cols', cols);
    ui.grid.style.setProperty('--rows', Math.ceil(n / cols));
    ui.count.textContent = `${peers.size + 1} na sala`;
  }
  window.addEventListener('resize', updateGrid);

  // -------------------------------------------------------------------------
  // Sinalização (via Socket.io)
  // -------------------------------------------------------------------------
  const sendSignal = (to, data) => state.socket && state.socket.emit('signal', { to, data });

  const currentState = () => ({ kind: 'state', mic: micOn(), cam: camOn() });

  function broadcastState() {
    for (const peer of peers.values()) sendSignal(peer.id, currentState());
  }

  // -------------------------------------------------------------------------
  // Conexões WebRTC (uma por participante remoto)
  // -------------------------------------------------------------------------
  function createPeer(id, name) {
    if (peers.has(id)) return peers.get(id);

    const pc = new RTCPeerConnection({ iceServers: state.iceServers });
    const peer = {
      id, name, pc,
      // Em colisão de ofertas, o lado "educado" (polite) cede. Os IDs são diferentes,
      // então exatamente um dos dois lados será polite.
      polite: state.myId > id,
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswer: false,
      screenStreamId: null,   // id do stream que o outro lado declarou ser tela
      screenSenders: [],      // senders da MINHA tela nessa conexão
      mic: true, cam: true,
    };
    peers.set(id, peer);

    // Tile aparece já (com avatar), mesmo antes da mídia chegar
    createTile(id, name);
    setTileState(id, { mic: peer.mic, cam: peer.cam });
    updateGrid();

    // Informa meu estado e, se estiver compartilhando, que aquele stream é tela.
    // (A ordem do socket é preservada, então isso chega ANTES da oferta.)
    sendSignal(id, currentState());
    if (state.screenStream) sendSignal(id, { kind: 'screen-start', streamId: state.screenStream.id });

    // Adiciona minhas tracks (isso dispara onnegotiationneeded)
    if (state.localStream) state.localStream.getTracks().forEach((t) => pc.addTrack(t, state.localStream));
    if (state.screenStream) {
      peer.screenSenders = state.screenStream.getTracks().map((t) => pc.addTrack(t, state.screenStream));
    }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) sendSignal(id, { kind: 'candidate', candidate: candidate.toJSON ? candidate.toJSON() : candidate });
    };

    pc.ontrack = ({ streams }) => {
      if (streams[0]) attachRemoteStream(peer, streams[0]);
    };

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription(); // cria a oferta implicitamente
        sendSignal(id, { kind: 'description', description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
      } catch (err) {
        console.error('Erro ao negociar:', err);
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') pc.restartIce();
    };

    return peer;
  }

  /** Mostra o stream recebido: câmera/mic do participante ou a tela dele. */
  function attachRemoteStream(peer, stream) {
    const isScreen = stream.id === peer.screenStreamId;
    const key = isScreen ? `${peer.id}:screen` : peer.id;
    const tile = tiles.get(key) || createTile(key, isScreen ? `${peer.name} (tela)` : peer.name, { screen: isScreen });
    if (tile.video.srcObject !== stream) tile.video.srcObject = stream;
    tile.video.play().catch(() => {});
    if (!isScreen) watchSpeaking(tile, stream);
  }

  /** Processa mensagens de sinalização recebidas de outro participante. */
  async function handleSignal(from, data) {
    const peer = peers.get(from);
    if (!peer) return;
    const pc = peer.pc;

    try {
      switch (data.kind) {
        case 'description': {
          const { description } = data;
          const readyForOffer = !peer.makingOffer && (pc.signalingState === 'stable' || peer.settingRemoteAnswer);
          const collision = description.type === 'offer' && !readyForOffer;
          peer.ignoreOffer = !peer.polite && collision;
          if (peer.ignoreOffer) return; // lado "impolite" ignora a oferta concorrente

          peer.settingRemoteAnswer = description.type === 'answer';
          await pc.setRemoteDescription(description); // lado polite faz rollback implícito
          peer.settingRemoteAnswer = false;

          if (description.type === 'offer') {
            await pc.setLocalDescription();
            sendSignal(from, { kind: 'description', description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
          }
          break;
        }
        case 'candidate':
          try { await pc.addIceCandidate(data.candidate); }
          catch (err) { if (!peer.ignoreOffer) console.warn('ICE ignorado:', err); }
          break;

        case 'state':
          peer.mic = !!data.mic;
          peer.cam = !!data.cam;
          setTileState(peer.id, peer);
          break;

        case 'screen-start':
          peer.screenStreamId = data.streamId;
          break;

        case 'screen-stop':
          peer.screenStreamId = null;
          removeTile(`${peer.id}:screen`);
          break;
      }
    } catch (err) {
      console.error('Erro na sinalização:', err);
    }
  }

  function removePeer(id) {
    const peer = peers.get(id);
    if (!peer) return;
    peer.pc.onnegotiationneeded = null;
    peer.pc.close();
    peers.delete(id);
    removeTile(id);
    removeTile(`${id}:screen`);
    addSystemMessage(`${peer.name} saiu da sala.`);
    updateGrid();
  }

  // -------------------------------------------------------------------------
  // Entrar na sala
  // -------------------------------------------------------------------------
  async function loadIceServers() {
    try {
      const res = await fetch('/api/ice');
      const json = await res.json();
      if (Array.isArray(json.iceServers)) return json.iceServers;
    } catch (err) { console.warn('Usando STUN padrão:', err); }
    return state.iceServers;
  }

  function releaseLocalMedia() {
    if (state.localStream) state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
  }

  async function join(name, room) {
    ui.joinBtn.disabled = true;
    setError('');

    state.iceServers = await loadIceServers();
    state.localStream = await getLocalMedia(); // pode ser null (espectador)

    const socket = io();
    state.socket = socket;

    socket.on('connect_error', () => {
      if (state.joined) return;
      setError('Não foi possível conectar ao servidor.');
      cancelJoin();
    });

    socket.on('connect', () => {
      // Se reconectou depois de já estar na sala, os IDs mudaram: recomeça do zero.
      if (state.joined) return location.reload();

      socket.emit('join', { name, room }, (res) => {
        if (!res || !res.ok) {
          setError((res && res.error) || 'Não foi possível entrar na sala.');
          return cancelJoin();
        }
        onJoined(res, name);
      });
    });

    socket.on('user-joined', ({ id, name: peerName }) => {
      createPeer(id, peerName);
      addSystemMessage(`${peerName} entrou na sala.`);
    });
    socket.on('user-left', ({ id }) => removePeer(id));
    socket.on('signal', ({ from, data }) => handleSignal(from, data));
    socket.on('chat', onChatMessage);
    socket.on('disconnect', () => { if (state.joined) toast('Conexão com o servidor perdida. Tentando reconectar…'); });
  }

  function cancelJoin() {
    if (state.socket) state.socket.disconnect();
    state.socket = null;
    releaseLocalMedia();
    ui.joinBtn.disabled = false;
  }

  function onJoined(res, name) {
    state.joined = true;
    state.myId = res.id;
    state.name = name;
    state.room = res.room;
    localStorage.setItem('md:name', name);
    localStorage.setItem('md:room', res.room);
    history.replaceState(null, '', `?sala=${encodeURIComponent(res.room)}`);

    ui.joinScreen.classList.add('hidden');
    ui.app.classList.remove('hidden');
    ui.roomTitle.textContent = res.room;
    document.title = `#${res.room} — Mini Discord`;
    if (window.innerWidth < 720) ui.chat.classList.add('collapsed');

    // Meu próprio tile (sempre mudo localmente)
    const me = createTile('local', `${name} (você)`, { local: true });
    if (state.localStream) {
      me.video.srcObject = state.localStream;
      watchSpeaking(me, state.localStream);
    }
    if (!screenSupported()) ui.btnScreen.classList.add('hidden');
    refreshControls();

    // Conecta com todo mundo que já estava na sala
    res.peers.forEach((p) => createPeer(p.id, p.name));
    addSystemMessage(res.peers.length ? `Você entrou em #${res.room}.` : `Você entrou em #${res.room}. Mande o link para seus amigos!`);
    updateGrid();
  }

  // -------------------------------------------------------------------------
  // Controles: microfone, câmera, tela, chat, sair
  // -------------------------------------------------------------------------
  function refreshControls() {
    ui.btnMic.classList.toggle('off', !micOn());
    ui.btnMic.firstChild.textContent = micOn() ? '🎙️' : '🔇';
    ui.btnCam.classList.toggle('off', !camOn());
    ui.btnCam.firstChild.textContent = camOn() ? '📷' : '🚫';
    ui.btnScreen.classList.toggle('active', !!state.screenStream);
    setTileState('local', { mic: micOn(), cam: camOn() });
  }

  ui.btnMic.addEventListener('click', () => {
    const track = audioTrack();
    if (!track) return toast('Nenhum microfone disponível.');
    track.enabled = !track.enabled;
    refreshControls();
    broadcastState();
  });

  ui.btnCam.addEventListener('click', () => {
    const track = videoTrack();
    if (!track) return toast('Nenhuma câmera disponível.');
    track.enabled = !track.enabled;
    refreshControls();
    broadcastState();
  });

  const screenSupported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

  async function startScreenShare() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true });
    } catch (err) {
      if (err.name !== 'NotAllowedError') toast('Não foi possível compartilhar a tela.');
      return; // usuário cancelou
    }
    state.screenStream = stream;

    const vTrack = stream.getVideoTracks()[0];
    if ('contentHint' in vTrack) vTrack.contentHint = 'detail'; // prioriza nitidez do texto
    vTrack.addEventListener('ended', stopScreenShare); // botão "Parar compartilhamento" do navegador

    const tile = createTile('local:screen', 'Sua tela', { local: true, screen: true });
    tile.video.srcObject = stream;

    for (const peer of peers.values()) {
      sendSignal(peer.id, { kind: 'screen-start', streamId: stream.id });
      peer.screenSenders = stream.getTracks().map((t) => peer.pc.addTrack(t, stream));
    }
    refreshControls();
  }

  function stopScreenShare() {
    const stream = state.screenStream;
    if (!stream) return;
    state.screenStream = null;
    stream.getTracks().forEach((t) => t.stop());

    for (const peer of peers.values()) {
      peer.screenSenders.forEach((s) => { try { peer.pc.removeTrack(s); } catch (_) { /* conexão já fechada */ } });
      peer.screenSenders = [];
      sendSignal(peer.id, { kind: 'screen-stop' });
    }
    removeTile('local:screen');
    refreshControls();
  }

  ui.btnScreen.addEventListener('click', () => (state.screenStream ? stopScreenShare() : startScreenShare()));

  ui.btnLeave.addEventListener('click', () => {
    stopScreenShare();
    if (state.socket) state.socket.disconnect();
    peers.forEach((p) => p.pc.close());
    releaseLocalMedia();
    location.href = location.pathname; // volta para a tela inicial
  });

  ui.copyLink.addEventListener('click', async () => {
    const link = `${location.origin}/?sala=${encodeURIComponent(state.room)}`;
    try {
      await navigator.clipboard.writeText(link);
      toast('Link copiado! Mande para seus amigos.');
    } catch (_) {
      window.prompt('Copie o link da sala:', link);
    }
  });

  // -------------------------------------------------------------------------
  // Chat
  // -------------------------------------------------------------------------
  const chatOpen = () => !ui.chat.classList.contains('collapsed');

  function setUnread(n) {
    state.unread = n;
    ui.badge.textContent = n > 99 ? '99+' : String(n);
    ui.badge.classList.toggle('hidden', n === 0);
  }

  ui.btnChat.addEventListener('click', () => {
    ui.chat.classList.toggle('collapsed');
    if (chatOpen()) { setUnread(0); ui.chatInput.focus(); ui.messages.scrollTop = ui.messages.scrollHeight; }
  });

  ui.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = ui.chatInput.value.trim();
    if (!text || !state.socket) return;
    state.socket.emit('chat', text);
    ui.chatInput.value = '';
  });

  function appendMessage(node) {
    const atBottom = ui.messages.scrollHeight - ui.messages.scrollTop - ui.messages.clientHeight < 60;
    ui.messages.appendChild(node);
    if (atBottom) ui.messages.scrollTop = ui.messages.scrollHeight;
  }

  function addSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'msg sys';
    div.textContent = text; // textContent: nunca interpreta HTML
    appendMessage(div);
  }

  function onChatMessage({ id, name, text, ts }) {
    const div = document.createElement('div');
    div.className = 'msg';
    const head = document.createElement('div');
    head.className = 'msg-head';
    const nameEl = document.createElement('span');
    nameEl.className = 'msg-name';
    nameEl.textContent = name;
    nameEl.style.color = colorFor(name);
    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    head.append(nameEl, time);
    const body = document.createElement('div');
    body.className = 'msg-text';
    body.textContent = text;
    div.append(head, body);
    appendMessage(div);

    if (id !== state.myId && !chatOpen()) setUnread(state.unread + 1);
  }
})();
