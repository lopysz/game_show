import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
loadEnv();
const PORT = Number(process.env.PORT || 21213);
const API_KEY = process.env.TIKTOOLS_API_KEY || '';
const API = 'https://api.tik.tools';
let liveSocket = null, liveUser = '', currentAnswer = '', round = 0;
const eligible = new Map(), answered = new Set();
const clients = new Set();

const server = http.createServer((req, res) => {
  const file = req.url === '/' ? 'index.html' : path.basename(decodeURIComponent(req.url.split('?')[0]));
  const allowed = new Set(['index.html']);
  if (!allowed.has(file)) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(__dirname, file), (err, data) => {
    if (err) { res.writeHead(500); return res.end('Não foi possível abrir o jogo.'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server, path: '/ws' });
function send(client, data) { if (client?.readyState === WebSocket.OPEN) client.send(JSON.stringify(data)); }
function broadcast(data) { for (const c of clients) send(c, data); }
function status(message, live=false) { broadcast({type:'status', message, live}); }
function norm(s) { return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,''); }
function uidOf(d) { return String(d?.user?.uniqueId ?? d?.user?.id ?? d?.user_unique_id ?? d?.userId ?? ''); }
function nameOf(d) { return String(d?.user?.nickname ?? d?.user?.uniqueId ?? d?.user_unique_id ?? 'Participante'); }
function giftIsRose(d) { const n=norm(d?.giftName ?? d?.gift?.name ?? ''); return n==='rose' || n==='rosa'; }
function closeLive() { if (liveSocket) { try { liveSocket.close(); } catch {} liveSocket=null; } }
async function connectLive(username) {
  if (!API_KEY) throw new Error('Falta configurar TIKTOOLS_API_KEY no arquivo .env. Consulte o LEIA-ME.');
  closeLive(); liveUser=username; currentAnswer=''; eligible.clear(); answered.clear(); round=0;
  status(`Solicitando acesso temporário ao serviço de conexão para @${username}…`);
  const response = await fetch(`${API}/authentication/jwt?apiKey=${encodeURIComponent(API_KEY)}`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({allowed_creators:[username], expire_after:600, max_websockets:1})
  });
  const payload = await response.json().catch(()=>({}));
  const token = payload?.data?.token;
  if (!response.ok || !token) throw new Error(payload?.message || payload?.error || `TikTools não autorizou a conexão (HTTP ${response.status}). Confira a chave e os limites da conta.`);
  const ws = new WebSocket(`wss://api.tik.tools/?uniqueId=${encodeURIComponent(username)}&jwtKey=${encodeURIComponent(token)}`);
  liveSocket=ws;
  ws.addEventListener('open',()=>status(`Conectado à live de @${username}.`,true));
  ws.addEventListener('message',ev=>{
    let msg; try { msg=JSON.parse(String(ev.data)); } catch { return; }
    const d=msg?.data || {}, event=String(msg?.event || '').toLowerCase();
    if (event==='chat') {
      const id=uidOf(d), nickname=nameOf(d), comment=String(d.comment ?? '');
      broadcast({type:'chat',userId:id,nickname,comment});
      if (id && eligible.has(id) && currentAnswer && !answered.has(id) && norm(comment)===norm(currentAnswer)) {
        answered.add(id); broadcast({type:'correct',userId:id,nickname,points:10});
        broadcast({type:'roundStats',eligible:eligible.size,answered:answered.size});
      }
    } else if (event==='gift' && giftIsRose(d)) {
      const id=uidOf(d); if (!id || eligible.has(id)) return;
      const nickname=nameOf(d); eligible.set(id,nickname);
      broadcast({type:'giftQualified',userId:id,nickname,count:eligible.size});
      broadcast({type:'roundStats',eligible:eligible.size,answered:answered.size});
    } else if (event==='like') {
      broadcast({type:'like',nickname:nameOf(d),count:Number(d.likeCount||1)});
    } else if (event==='member' || event==='join') {
      broadcast({type:'member',nickname:nameOf(d)});
    }
  });
  ws.addEventListener('error',()=>broadcast({type:'error',message:'Falha no WebSocket do provedor TikTools.'}));
  ws.addEventListener('close',ev=>{ if(liveSocket===ws){liveSocket=null;status(`Conexão encerrada (${ev.code}). Confira se a avaliação/chave ainda está ativa.`); } });
}
wss.on('connection',client=>{
  clients.add(client);
  send(client,{type:'status',message:'Conector local pronto. Informe o usuário da live.',live:false});
  client.on('message',async raw=>{
    let m; try {m=JSON.parse(raw.toString())} catch {return;}
    if(m.type==='connect') {
      const username=String(m.username||'').trim().replace(/^@/,'');
      if(!/^[a-zA-Z0-9._]{2,30}$/.test(username)){send(client,{type:'error',message:'Nome de usuário inválido.'});return;}
      try { await connectLive(username); }
      catch(e){ status(e.message,false); send(client,{type:'error',message:e.message}); }
    }
    if(m.type==='roundStart') {
      round=Number(m.round||round+1); currentAnswer=String(m.answer||''); eligible.clear(); answered.clear();
      broadcast({type:'roundStats',eligible:0,answered:0});
    }
    if(m.type==='roundEnd') { currentAnswer=''; }
    if(m.type==='disconnect') { closeLive(); status('Desconectado.',false); }
  });
  client.on('close',()=>clients.delete(client));
});
server.listen(PORT,'127.0.0.1',()=>console.log(`Roleta Musical em http://127.0.0.1:${PORT}`));
