import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { makeMatcher } from './matcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
(function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
})();

const PORT = Number(process.env.PORT || 3210);
const EULER_KEY = String(process.env.EULER_API_KEY || '').trim();       // opcional (aumenta limites do modo grátis)
const TIKTOOLS_KEY = String(process.env.TIKTOOLS_API_KEY || '').trim(); // opcional (provedor pago/teste)
const TIKFINITY_URL = process.env.TIKFINITY_URL || 'ws://127.0.0.1:21213/';

let closer = null, connId = 0, matcher = null, currentAnswer = '', lastCats = '', lastSync = '';
let lastStatus = { message: 'Conector local pronto. Escolha o modo e clique em Conectar.', live: false };
const eligible = new Map(), answered = new Set(), clients = new Map(); // clients: ws -> 'controller' | 'overlay'

/* ---------- HTTP: / (painel) e /overlay (tela limpa para OBS) ---------- */
const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0].replace(/\/+$/, '') || '/';
  if (!['/', '/overlay', '/index.html'].includes(p)) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
    if (err) { res.writeHead(500); return res.end('Não foi possível abrir o jogo.'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});
// Só aceita WebSocket vindo desta própria máquina (impede que sites externos controlem o jogo).
const wss = new WebSocketServer({
  server, path: '/ws',
  verifyClient: ({ origin }) => !origin || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)
});
const send = (c, d) => { if (c?.readyState === WebSocket.OPEN) c.send(typeof d === 'string' ? d : JSON.stringify(d)); };
const broadcast = d => { for (const [c, role] of clients) if (role === 'controller') send(c, d); }; // overlay só recebe sync/cats
const relay = txt => { for (const [c, role] of clients) if (role === 'overlay') send(c, txt); };
const status = (message, live = false) => { lastStatus = { message, live }; broadcast({ type: 'status', message, live }); };

/* ---------- Normalização de eventos (aceita formatos de vários provedores) ---------- */
const first = (...v) => v.find(x => x !== undefined && x !== null && x !== '');
const uidOf = d => String(first(d?.user?.uniqueId, d?.uniqueId, d?.user?.userId, d?.userId, d?.user?.id, d?.user_unique_id) ?? '');
const nameOf = d => String(first(d?.user?.nickname, d?.nickname, d?.user?.uniqueId, d?.uniqueId, d?.user_unique_id) ?? 'Participante');
function giftIsRose(d) {
  const n = String(first(d?.giftName, d?.giftDetails?.giftName, d?.gift?.name, d?.extendedGiftInfo?.name) ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
  return n === 'rose' || n === 'rosa' || Number(first(d?.giftId, d?.gift?.id) ?? 0) === 5655; // 5655 = Rosa
}
const stats = () => broadcast({ type: 'roundStats', eligible: eligible.size, answered: answered.size });

function handle(event, d = {}) {
  event = String(event || '').toLowerCase();
  if (event === 'chat') {
    const id = uidOf(d), nickname = nameOf(d), comment = String(d.comment ?? '');
    broadcast({ type: 'chat', userId: id, nickname, comment });
    if (id && matcher && eligible.has(id) && !answered.has(id) && matcher(comment)) {
      answered.add(id); broadcast({ type: 'correct', userId: id, nickname }); stats();
    }
  } else if (event === 'gift') {
    const id = uidOf(d);
    if (!id || !giftIsRose(d) || eligible.has(id)) return;
    const nickname = nameOf(d); eligible.set(id, nickname);
    broadcast({ type: 'giftQualified', userId: id, nickname, count: eligible.size }); stats();
  } else if (event === 'like') broadcast({ type: 'like', nickname: nameOf(d), count: Number(d.likeCount || 1) });
  else if (event === 'member' || event === 'join') broadcast({ type: 'member', nickname: nameOf(d) });
}

/* ---------- Provedores de conexão ---------- */
function closeLive() { connId++; try { closer?.(); } catch {} closer = null; }
function friendly(e) {
  const t = String(e?.message || e || '');
  if (/offline|not.*(live|online)|has ended|UserOffline/i.test(t)) return 'Essa conta não está ao vivo agora. Inicie a live e tente de novo.';
  if (/429|rate.?limit|too many/i.test(t)) return 'Limite do serviço gratuito atingido. Espere alguns minutos, use o modo TikFinity ou coloque uma chave gratuita do eulerstream.com em EULER_API_KEY no .env.';
  return t || 'Falha ao conectar.';
}

// 1) GRÁTIS: biblioteca open-source tiktok-live-connector (sem chave)
async function connectFree(username, my) {
  let lib;
  try { lib = await import('tiktok-live-connector'); }
  catch { throw new Error('Biblioteca não instalada. Feche e abra o iniciar.bat (ele roda npm install).'); }
  const { TikTokLiveConnection, WebcastEvent, ControlEvent } = lib;
  const conn = new TikTokLiveConnection(username, EULER_KEY ? { signApiKey: EULER_KEY } : {});
  const ev = (k, f) => WebcastEvent?.[k] ?? f;
  for (const [k, f, name] of [['CHAT', 'chat', 'chat'], ['GIFT', 'gift', 'gift'], ['LIKE', 'like', 'like'], ['MEMBER', 'member', 'member']])
    conn.on(ev(k, f), d => { if (my === connId) handle(name, d); });
  conn.on(ControlEvent?.DISCONNECTED ?? 'disconnected', () => { if (my === connId) status('Live desconectada. Clique em Conectar para tentar de novo.'); });
  conn.on(ControlEvent?.ERROR ?? 'error', e => { if (my === connId) broadcast({ type: 'error', message: friendly(e) }); });
  closer = () => { try { conn.disconnect(); } catch {} };
  status(`Conectando à live de @${username}…`);
  const st = await conn.connect();
  if (my !== connId) return closer();
  status(`Conectado à live de @${username}${st?.roomId ? ` (sala ${st.roomId})` : ''}.`, true);
}

// 2) GRÁTIS: app TikFinity (você conecta a live nele; a roleta lê os eventos pela porta local)
async function connectTikFinity(my) {
  const ws = new WebSocket(TIKFINITY_URL);
  closer = () => { try { ws.close(); } catch {} };
  await new Promise((ok, bad) => {
    ws.addEventListener('open', ok, { once: true });
    ws.addEventListener('error', () => bad(new Error(`Não encontrei o TikFinity em ${TIKFINITY_URL}. Abra o app TikFinity, conecte na sua live e tente de novo.`)), { once: true });
  });
  ws.addEventListener('message', e => { let m; try { m = JSON.parse(String(e.data)); } catch { return; } if (my === connId) handle(m.event, m.data || {}); });
  ws.addEventListener('close', () => { if (my === connId) status('TikFinity desconectado.'); });
  status('Conectado ao TikFinity.', true);
}

// 3) Opcional: TikTools (precisa de chave)
async function connectTikTools(username, my) {
  if (!TIKTOOLS_KEY || TIKTOOLS_KEY.includes('COLE_')) throw new Error('Falta TIKTOOLS_API_KEY no .env.');
  status(`Solicitando acesso ao TikTools para @${username}…`);
  const r = await fetch(`https://api.tik.tools/authentication/jwt?apiKey=${encodeURIComponent(TIKTOOLS_KEY)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowed_creators: [username], expire_after: 600, max_websockets: 1 })
  });
  const p = await r.json().catch(() => ({}));
  const token = p?.data?.token;
  if (!r.ok || !token) throw new Error(p?.message || p?.error || `TikTools recusou (HTTP ${r.status}).`);
  const ws = new WebSocket(`wss://api.tik.tools/?uniqueId=${encodeURIComponent(username)}&jwtKey=${encodeURIComponent(token)}`);
  closer = () => { try { ws.close(); } catch {} };
  ws.addEventListener('open', () => my === connId && status(`Conectado à live de @${username} (TikTools).`, true));
  ws.addEventListener('message', e => { let m; try { m = JSON.parse(String(e.data)); } catch { return; } if (my === connId) handle(m?.event, m?.data || {}); });
  ws.addEventListener('close', ev => { if (my === connId) status(`Conexão encerrada (${ev.code}).`); });
}

// 4) Demonstração: eventos falsos para testar o jogo sem estar ao vivo
function connectDemo() {
  const nomes = ['Ana', 'Bruno', 'Carla', 'Diego', 'Elisa', 'Fábio', 'Gabi', 'Hugo'];
  const iv = setInterval(() => {
    const i = Math.floor(Math.random() * nomes.length), d = { user: { uniqueId: 'demo' + i, nickname: nomes[i] } }, r = Math.random();
    if (r < .35) handle('gift', { ...d, giftName: 'Rose' });
    else if (r < .65 && currentAnswer) handle('chat', { ...d, comment: Math.random() < .5 ? currentAnswer.replace(/\(.*?\)/g, '').trim() : 'não sei' });
    else if (r < .8) handle('like', { ...d, likeCount: 3 });
    else handle('chat', { ...d, comment: 'oi pessoal!' });
  }, 1200);
  closer = () => clearInterval(iv);
  status('MODO DEMONSTRAÇÃO: eventos simulados, sem conexão com o TikTok.', true);
}

async function connectLive(provider, username) {
  closeLive(); const my = connId;
  if (provider === 'demo') return connectDemo();
  if (provider === 'tikfinity') return connectTikFinity(my);
  if (provider === 'tiktools') return connectTikTools(username, my);
  return connectFree(username, my);
}

/* ---------- WebSocket com o painel e o overlay ---------- */
wss.on('connection', client => {
  clients.set(client, 'controller');
  send(client, { type: 'status', ...lastStatus });
  client.on('message', async raw => {
    const text = raw.toString(); let m; try { m = JSON.parse(text); } catch { return; }
    switch (m.type) {
      case 'hello':
        clients.set(client, m.role === 'overlay' ? 'overlay' : 'controller');
        if (lastCats) send(client, lastCats); if (lastSync) send(client, lastSync); break;
      case 'cats': lastCats = text; relay(text); break;
      case 'sync': lastSync = text; relay(text); break;
      case 'connect': {
        const provider = String(m.provider || 'free'), username = String(m.username || '').trim().replace(/^@/, '');
        if (['free', 'tiktools'].includes(provider) && !/^[a-zA-Z0-9._]{2,30}$/.test(username)) { send(client, { type: 'error', message: 'Nome de usuário inválido.' }); break; }
        try { await connectLive(provider, username); }
        catch (e) { const msg = friendly(e); closeLive(); status(msg); send(client, { type: 'error', message: msg }); }
        break;
      }
      case 'roundStart':
        currentAnswer = String(m.answer || ''); matcher = makeMatcher(currentAnswer);
        eligible.clear(); answered.clear(); stats(); break;
      case 'roundEnd': currentAnswer = ''; matcher = null; break;
      case 'disconnect': closeLive(); status('Desconectado.'); break;
    }
  });
  client.on('close', () => clients.delete(client));
});

process.on('unhandledRejection', e => console.error('Erro não tratado:', e?.message || e));
server.listen(PORT, '127.0.0.1', () => {
  console.log('ROLETA MUSICAL v1.3');
  console.log(`Painel de controle : http://127.0.0.1:${PORT}`);
  console.log(`Overlay (OBS)      : http://127.0.0.1:${PORT}/overlay`);
});
