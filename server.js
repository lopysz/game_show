const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { TikTokLiveConnection, WebcastEvent } = require('tiktok-live-connector');

const HOST = '127.0.0.1';
const PORT = 21213;
const clients = new Set();
let connection = null;
let currentRound = 0;
let roundOpen = false;
let correctAnswer = '';
let eligible = new Map();
let answered = new Set();
let liveUsername = '';

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, `http://${HOST}:${PORT}`).pathname);
  const file = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.join(__dirname, file);
  if (!full.startsWith(__dirname) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404); return res.end('Not found');
  }
  const ext = path.extname(full);
  res.writeHead(200, { 'Content-Type': ext === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(full).pipe(res);
});
const wss = new WebSocketServer({ server });
function sendAll(data) { const msg = JSON.stringify(data); for (const c of clients) if (c.readyState === 1) c.send(msg); }
function status(message, live=false) { sendAll({ type: 'status', message, live }); }
function norm(v) { return String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function isCorrect(comment) {
  const candidates = correctAnswer.split(/[|;]/).map(norm).filter(Boolean);
  const value = norm(comment);
  return candidates.some(a => value === a || (a.length >= 5 && value.includes(a)));
}
function cleanName(v) { return String(v || 'Participante').replace(/[<>]/g, '').slice(0, 40); }
function userKey(data) {
  return String(data.userId || data.uniqueId || data.nickname || data.user?.userId || data.user?.uniqueId || data.user?.secUid || '').toLowerCase();
}
function onChat(data) {
  const uid = userKey(data); const nickname = cleanName(data.nickname || data.user?.nickname || data.uniqueId || data.user?.uniqueId);
  const comment = String(data.comment || data.message || '').slice(0, 300);
  if (!uid || !comment) return;
  sendAll({ type: 'chat', userId: uid, nickname, comment });
  if (!roundOpen || !eligible.has(uid) || answered.has(uid)) return;
  if (isCorrect(comment)) {
    answered.add(uid);
    sendAll({ type: 'correct', userId: uid, nickname, points: 10 });
  }
}
function onGift(data) {
  // O nome da Rosa pode variar conforme idioma/localização; o ID da Rosa é reconhecido junto do nome.
  const giftName = String(data.extendedGiftInfo?.name || data.giftDetails?.giftName || data.giftName || data.gift?.name || '').toLowerCase();
  const giftId = Number(data.extendedGiftInfo?.id || data.giftDetails?.giftId || data.giftId || data.gift?.id || 0);
  const isRose = giftId === 5655 || giftName === 'rose' || giftName === 'rosa';
  if (!isRose || !roundOpen) return;
  const uid = userKey(data); if (!uid || eligible.has(uid)) return;
  const nickname = cleanName(data.nickname || data.uniqueId || data.user?.nickname || data.user?.uniqueId);
  eligible.set(uid, nickname);
  sendAll({ type: 'giftQualified', userId: uid, nickname, count: eligible.size });
  sendAll({ type: 'roundStats', eligible: eligible.size, answered: answered.size });
}
async function connectTikTok(username) {
  try {
    if (connection) { try { await connection.disconnect(); } catch {} connection = null; }
    liveUsername = username.replace(/^@/, '');
    eligible.clear(); answered.clear(); roundOpen = false;
    // A versão atual espera que o objeto de opções seja informado.
    // Sem ele, ocorre o erro: reading 'processInitialData'.
    connection = new TikTokLiveConnection(liveUsername, {
      processInitialData: false,
      fetchRoomInfoOnConnect: true,
      enableExtendedGiftInfo: true
    });
    connection.on(WebcastEvent.CHAT, onChat);
    connection.on(WebcastEvent.GIFT, onGift);
    connection.on('connected', () => status(`Conectado à live de @${liveUsername}`, true));
    connection.on('disconnected', () => status('Conexão com TikTok encerrada.', false));
    connection.on('error', err => sendAll({ type: 'error', message: `TikTok: ${err?.message || err}` }));
    const state = await connection.connect();
    status(`Conectado à live de @${liveUsername}`, true);
    sendAll({ type: 'status', message: `Conectado à live de @${liveUsername} · sala ${state.roomId || 'ativa'}`, live: true });
  } catch (err) {
    status(`Não foi possível conectar: ${err?.message || err}`, false);
  }
}
wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'status', message: 'Conector local pronto. Informe o @ da live.', live: false }));
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'connect' && typeof m.username === 'string' && /^[a-zA-Z0-9._]{2,30}$/.test(m.username.replace(/^@/, ''))) connectTikTok(m.username);
    if (m.type === 'roundStart') {
      currentRound = Number(m.round) || currentRound + 1;
      correctAnswer = String(m.answer || '');
      eligible.clear(); answered.clear(); roundOpen = true;
      sendAll({ type: 'roundStats', eligible: 0, answered: 0, round: currentRound });
    }
    if (m.type === 'roundEnd') roundOpen = false;
  });
  ws.on('close', () => clients.delete(ws));
});
server.listen(PORT, HOST, () => console.log(`Roleta Musical em http://${HOST}:${PORT}`));
process.on('SIGINT', async () => { try { if (connection) await connection.disconnect(); } catch {} process.exit(0); });
