// server.js — Servidor de matchmaking + relay para a Arena de Luta 3D
//
// COMO RODAR NO TERMUX:
//   pkg update && pkg install nodejs
//   npm init -y
//   npm install ws
//   node server.js
//
// O servidor escuta em UMA porta só (8080 por padrão) e tem um ÚNICO servidor
// de jogo: todo mundo entra na mesma fila e nas mesmas salas, então quem está
// online sempre aparece pra todo mundo, e convites entre amigos sempre
// funcionam (não existe mais "convite de outro servidor").
// Isso também combina com o túnel (cloudflared), que só expõe UMA porta.
//
// Para expor pra fora da sua rede Wi-Fi:
//   pkg install cloudflared
//   cloudflared tunnel --url http://localhost:8080
// Copie a URL "https://algo-aleatorio.trycloudflare.com" que aparecer e abra
// ela no navegador de quem for jogar. Esse tipo de link (gratuito, sem conta)
// é temporário: ele MORRE se o cloudflared parar (Termux fechado, celular
// matou o processo em segundo plano, sem internet etc.) — quando isso
// acontece o navegador mostra ERR_NAME_NOT_RESOLVED, e rodar o comando de
// novo gera um link NOVO (o antigo nunca mais volta a funcionar).

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
// Aceita tanto ArenaCraft.html quanto o nome antigo arena_3d.html.
const HTML_CANDIDATES = ['ArenaCraft.html', 'arena_3d.html'].map((f) => path.join(__dirname, f));
const HTML_PATH = HTML_CANDIDATES.find((f) => fs.existsSync(f)) || HTML_CANDIDATES[0];
// Servidor único: todo mundo cai no mesmo "state" (mesma fila, mesmas salas).
const NUM_VIRTUAL_SERVERS = 1;

// ---------- Contas Phanix Games + perfil salvo entre navegadores ----------
const PROFILES_PATH = path.join(__dirname, 'profiles.json');
let profiles = {}; // email (minúsculo) -> { name, kills, accessibility }
try {
  profiles = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
} catch (e) {
  profiles = {};
}
let profilesSaveTimer = null;
// Grava o JSON num arquivo temporário e só então troca pelo definitivo — se o
// Termux/servidor for fechado bem no meio da gravação, o arquivo antigo continua
// inteiro (nada de accounts.json/profiles.json cortado pela metade).
function writeJsonAtomic(file, data, pretty) {
  const tmp = file + '.tmp';
  fs.writeFile(tmp, JSON.stringify(data, null, pretty ? 2 : 0), (err) => {
    if (err) return;
    fs.rename(tmp, file, () => {});
  });
}
function writeJsonSync(file, data, pretty) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, pretty ? 2 : 0));
  fs.renameSync(tmp, file);
}
function saveProfiles() {
  // Debounced: se vários "saveProfile" chegarem em sequência (ex: nome e
  // vitórias mudando perto um do outro), grava só uma vez pouco depois,
  // em vez de reescrever o arquivo em disco a cada mensagem.
  clearTimeout(profilesSaveTimer);
  profilesSaveTimer = setTimeout(() => {
    writeJsonAtomic(PROFILES_PATH, profiles, true);
  }, 500);
}

// ---------- Feed público: notícias, atualizações e novidades (valem pra TODO mundo, até sem conta) ----------
const NEWS_PATH = path.join(__dirname, 'news.json');
const MEDIA_DIR = path.join(__dirname, 'media');
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch (e) {}
let newsFeed = []; // [{ id, type:'news'|'upd'|'novidade', title, text, from, ts, media:{ kind:'image'|'video', file }|null }]
try { newsFeed = JSON.parse(fs.readFileSync(NEWS_PATH, 'utf8')); if (!Array.isArray(newsFeed)) newsFeed = []; } catch (e) { newsFeed = []; }
let newsSaveTimer = null;
function saveNews() {
  clearTimeout(newsSaveTimer);
  newsSaveTimer = setTimeout(() => writeJsonAtomic(NEWS_PATH, newsFeed, true), 300);
}
const MEDIA_TYPES = {
  'image/jpeg': { ext: 'jpg', kind: 'image', max: 8 * 1024 * 1024 },
  'image/png': { ext: 'png', kind: 'image', max: 8 * 1024 * 1024 },
  'image/webp': { ext: 'webp', kind: 'image', max: 8 * 1024 * 1024 },
  'image/gif': { ext: 'gif', kind: 'image', max: 8 * 1024 * 1024 },
  'video/mp4': { ext: 'mp4', kind: 'video', max: 25 * 1024 * 1024 },
  'video/webm': { ext: 'webm', kind: 'video', max: 25 * 1024 * 1024 },
  'video/quicktime': { ext: 'mov', kind: 'video', max: 25 * 1024 * 1024 },
};
const MEDIA_MIME_BY_EXT = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
function newsPublicItem(it) {
  return { id: it.id, type: it.type, title: it.title, text: it.text, from: it.from, ts: it.ts, media: it.media ? { kind: it.media.kind, url: '/media/' + it.media.file } : null };
}
function newsFeedPublic() { return newsFeed.map(newsPublicItem); }

const ACCOUNTS_PATH = path.join(__dirname, 'accounts.json');
// email (minúsculo) -> { firstName, lastName, email, username, passwordHash, salt, sessionToken }
let accounts = {};
try {
  accounts = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
} catch (e) {
  accounts = {};
}
// Usado só pra checar rápido se um nome de usuário já existe (não deixamos
// trocar depois — o nome de usuário é o jeito de identificar a conta caso
// precise, por exemplo, banir ela mais tarde).
const usedUsernames = new Set(
  Object.values(accounts).map((a) => (a.username || '').toLowerCase())
);
let accountsSaveTimer = null;
function saveAccounts() {
  clearTimeout(accountsSaveTimer);
  accountsSaveTimer = setTimeout(() => {
    writeJsonAtomic(ACCOUNTS_PATH, accounts, true);
  }, 500);
}

// ---------- Banimentos (Painel ADM) ----------
const BANS_PATH = path.join(__dirname, 'bans.json');
// email (minúsculo) -> { until, days, reason, bannedAt, bannedBy }
let bans = {};
try {
  bans = JSON.parse(fs.readFileSync(BANS_PATH, 'utf8'));
} catch (e) {
  bans = {};
}
let bansSaveTimer = null;
function saveBans() {
  clearTimeout(bansSaveTimer);
  bansSaveTimer = setTimeout(() => {
    writeJsonAtomic(BANS_PATH, bans, true);
  }, 500);
}
// Devolve o banimento ativo (ou null se nunca foi banido / já expirou). Um
// banimento vencido é removido na hora que alguém tenta usar essa conta de
// novo, em vez de ficar acumulando lixo pra sempre no bans.json.
function getActiveBan(emailLower) {
  const b = bans[emailLower];
  if (!b) return null;
  if (!b.until || b.until <= Date.now()) {
    delete bans[emailLower];
    saveBans();
    return null;
  }
  return b;
}
function formatBanUntil(ts) {
  try {
    return new Date(ts).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  } catch (e) {
    return new Date(ts).toISOString();
  }
}
function banErrorMessage(b) {
  const when = formatBanUntil(b.until);
  return 'Você está banido até ' + when + (b.reason ? ('. Motivo: ' + b.reason) : '.');
}
// Desbanir pelo que o ADM digitou. Antes só olhava a conta cujo nome de
// usuário batia EXATAMENTE e, se a conta achada não tivesse banimento na
// chave dela, dizia "não está banido" mesmo com a pessoa banida (nome com
// "@", maiúscula/minúscula diferente, e-mail digitado, apelido da partida
// em vez do nome da conta...). Agora junta todos os jeitos de achar a mesma
// pessoa — nome de usuário, e-mail, e o nome/apelido guardado dentro do
// próprio registro de banimento — e remove o banimento de todos eles.
function unbanByName(raw) {
  const q = String(raw || '').trim().replace(/^@+/, '').toLowerCase();
  const out = { removed: [], accountFound: false, activeNames: [] };
  if (!q) return out;
  const emails = new Set();
  for (const [key, acc] of Object.entries(accounts)) {
    if (!acc) continue;
    const uname = String(acc.username || '').trim().toLowerCase();
    const em = String(acc.email || key).trim().toLowerCase();
    if (uname === q || em === q || key.toLowerCase() === q) {
      out.accountFound = true;
      emails.add(key.toLowerCase());
      emails.add(em);
    }
  }
  for (const [key, b] of Object.entries(bans)) {
    if (!b) continue;
    const kl = key.toLowerCase();
    const bu = String(b.username || '').trim().toLowerCase();
    const bn = String(b.nick || '').trim().toLowerCase();
    if (kl === q || (bu && bu === q) || (bn && bn === q)) emails.add(kl);
  }
  for (const key of Object.keys(bans)) {
    if (!emails.has(key.toLowerCase())) continue;
    const acc = accounts[key];
    const b = bans[key];
    out.removed.push((acc && acc.username) || (b && b.username) || key);
    delete bans[key];
  }
  if (out.removed.length) saveBans();
  for (const [key, b] of Object.entries(bans)) {
    if (!b || !b.until || b.until <= Date.now()) continue;
    const acc = accounts[key];
    out.activeNames.push((acc && acc.username) || b.username || key);
  }
  return out;
}

// As contas vinculadas dos bots (ver seção BOTS mais abaixo) entram direto
// aqui em `accounts`, gravadas em accounts.json normalmente — igual conta
// de jogador de verdade, só marcadas com isBot:true pra referência interna.

// Nome que aparece pros outros jogadores (lista de amigos, convites,
// notificações...). Nunca mostra o e-mail inteiro: se a conta não tiver
// username, usa o nome do perfil, e por último a parte do e-mail antes do @.
function displayNameFor(emailLower) {
  const acc = accounts[emailLower];
  if (acc && typeof acc.username === 'string' && acc.username.trim()) return acc.username.trim();
  const prof = profiles[emailLower];
  if (prof && typeof prof.name === 'string' && prof.name.trim() && !prof.name.includes('@')) return prof.name.trim();
  return String(emailLower || '').split('@')[0] || 'Alguém';
}

// Contas antigas (criadas antes de existir "nome de usuário") ficavam sem
// username e apareciam com o e-mail na lista de amigos. Aqui cada uma ganha
// um username único: o nome que o jogador já usa no perfil ou, se não
// tiver, a parte do e-mail antes do @.
(function migrateMissingUsernames() {
  let changed = false;
  for (const [emailLower, acc] of Object.entries(accounts)) {
    if (acc && typeof acc.username === 'string' && acc.username.trim()) continue;
    const prof = profiles[emailLower];
    const profName = prof && typeof prof.name === 'string' ? prof.name.trim() : '';
    const useProf = profName && !profName.includes('@') && !/^user \d+$/i.test(profName);
    let base = (useProf ? profName : emailLower.split('@')[0]).slice(0, 20) || 'jogador';
    let candidate = base;
    let n = 2;
    while (usedUsernames.has(candidate.toLowerCase())) {
      const suffix = String(n++);
      candidate = base.slice(0, 20 - suffix.length) + suffix;
    }
    acc.username = candidate;
    usedUsernames.add(candidate.toLowerCase());
    changed = true;
  }
  if (changed) saveAccounts();
})();

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function createAccount({ firstName, lastName, email, password, username }) {
  const emailLower = email.trim().toLowerCase();
  const salt = crypto.randomBytes(16).toString('hex');
  const sessionToken = crypto.randomBytes(24).toString('hex');
  const account = {
    firstName: String(firstName).trim().slice(0, 40),
    lastName: String(lastName).trim().slice(0, 40),
    email: emailLower,
    username: String(username).trim().slice(0, 20),
    passwordHash: hashPassword(password, salt),
    salt,
    sessionToken,
  };
  accounts[emailLower] = account;
  usedUsernames.add(account.username.toLowerCase());
  saveAccounts();
  return account;
}

function verifyPassword(account, password) {
  const hash = hashPassword(password, account.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(account.passwordHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- Contas ADM ----------
// A tag "ADM" (colorida do lado do nome) e o Painel ADM só valem pra quem
// está logado com um desses e-mails. NUNCA é o cliente quem decide isso —
// ele só recebe um "admin:true/false" pronto do servidor em cada mensagem —
// então não dá pra alguém "se dar" admin mexendo no navegador.
const ADMIN_EMAILS = new Set(['cleiltondeoliveira12@gmail.com']);
function isAdminEmail(emailLower) {
  return !!emailLower && ADMIN_EMAILS.has(String(emailLower).toLowerCase());
}
// true só quando a CONEXÃO (c) está logada numa conta ADM de verdade.
function isAdminClient(c) {
  return !!(c && c.accountId && isAdminEmail(c.accountId));
}

function ensureProfile(emailLower, fallbackName) {
  let prof = profiles[emailLower];
  if (!prof) {
    prof = { name: fallbackName, kills: 0, accessibility: 20, btnScale: 100, skin: null };
    profiles[emailLower] = prof;
    saveProfiles();
  }
  return prof;
}

// Skin do jogador. Formas aceitas:
//  • cor do vestiário: {type:'color', value:'#rrggbb'} (muda camisa e calça)
//  • "Crie o seu": {type:'parts', parts:{head,body,hands,legs}, eyes:true|false},
//    onde cada peça é um PNG em dataURL ou null (= padrão da peça): atlas 48x64 com
//    um quadradinho 16x16 por face e por lado (o 16x16 antigo, um desenho só, ainda vale)
//  • formato antigo: {type:'custom', dataUrl:'data:image/png;...'} (desenho único)
// Valida no servidor pra nunca gravar/repassar pros outros jogadores algo
// que não seja isso — nem um objeto gigante, nem um valor malformado.
const MAX_SKIN_DATAURL_LEN = 60000; // dataURL de um PNG 16x16 é bem pequeno; sobra folga
const MAX_SKIN_PART_LEN = 40000;    // limite de cada peça no formato 'parts' (atlas 48x64 pintado à mão cabe folgado)
const SKIN_PART_KEYS = ['head', 'body', 'hands', 'legs'];
// Cabelo pintado no "Crie o seu": PNG opcional (atlas 48x64), guardado em skin.hairTex.
function isValidHairTex(v) {
  if (v === undefined || v === null) return true;
  return typeof v === 'string' && v.length <= MAX_SKIN_PART_LEN && v.startsWith('data:image/png;base64,');
}
function isValidSkin(skin) {
  if (!skin || typeof skin !== 'object') return false;
  if (skin.type === 'color') {
    if (!Object.keys(skin).every((k) => k === 'type' || k === 'value' || k === 'hair' || k === 'mouth' || k === 'hairTex')) return false;
    if ((skin.hair !== undefined && typeof skin.hair !== 'boolean') || (skin.mouth !== undefined && typeof skin.mouth !== 'boolean')) return false;
    if (!isValidHairTex(skin.hairTex)) return false;
    return typeof skin.value === 'string' && /^#[0-9a-fA-F]{6}$/.test(skin.value);
  }
  if (skin.type === 'custom') {
    return typeof skin.dataUrl === 'string' && skin.dataUrl.length <= MAX_SKIN_DATAURL_LEN
      && skin.dataUrl.startsWith('data:image/');
  }
  if (skin.type === 'parts') {
    // só as chaves conhecidas (nada de propriedades extras pra inflar o objeto)
    if (!Object.keys(skin).every((k) => k === 'type' || k === 'parts' || k === 'eyes' || k === 'hair' || k === 'mouth' || k === 'hairTex')) return false;
    if (!isValidHairTex(skin.hairTex)) return false;
    if (skin.eyes !== undefined && typeof skin.eyes !== 'boolean') return false;
    if (skin.hair !== undefined && typeof skin.hair !== 'boolean') return false;
    if (skin.mouth !== undefined && typeof skin.mouth !== 'boolean') return false;
    const parts = skin.parts;
    if (!parts || typeof parts !== 'object' || Array.isArray(parts)) return false;
    if (!Object.keys(parts).every((k) => SKIN_PART_KEYS.includes(k))) return false;
    return SKIN_PART_KEYS.every((k) => {
      const v = parts[k];
      if (v === undefined || v === null) return true;
      return typeof v === 'string' && v.length <= MAX_SKIN_PART_LEN && v.startsWith('data:image/png;base64,');
    });
  }
  return false;
}

// ---------- Skins geradas pelos bots (pixel art 16x16, sem lib externa) ----------
// PNG mínimo (RGBA, sem paleta) feito na mão com zlib.deflateSync — mesmo
// formato { type:'parts', parts:{head,body,hands,legs} } que o "Crie o seu"
// do jogador salva, então funciona igual pros outros verem.
function botPngCrc32(buf) {
  if (!botPngCrc32.table) {
    const t = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    botPngCrc32.table = t;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = botPngCrc32.table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function botPngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(botPngCrc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function botEncodePng16(rgba) { // rgba: Buffer de 16*16*4 bytes
  const w = 16, h = 16;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(w, 0); ihdrData.writeUInt32BE(h, 4);
  ihdrData[8] = 8; ihdrData[9] = 6; // 8 bits, RGBA
  const ihdr = botPngChunk('IHDR', ihdrData);
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // sem filtro
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = botPngChunk('IDAT', zlib.deflateSync(raw));
  const iend = botPngChunk('IEND', Buffer.alloc(0));
  return 'data:image/png;base64,' + Buffer.concat([sig, ihdr, idat, iend]).toString('base64');
}
// Bots vestem SÓ skins do vestiário (as mesmas do cliente: cores lisas, padrões e
// camisas de futebol — ver PRESET_SKINS e WARDROBE_OUTFITS no ArenaCraft.html).
const BOT_WARDROBE_COLORS = [
  '#3fae52', '#d64545', '#3b6fd6', '#e8c93a', '#9a4fd1',
  '#e07fc0', '#2e2e2e', '#e8e8e8', '#e08a2e', '#3ac6c6',
];
// { shirt, pants? }: cada um é { solid:[r,g,b] } ou { pattern, base:[r,g,b], accent:[r,g,b] }
const BOT_WARDROBE_OUTFITS = [
  { shirt: { pattern: 'listras', base: [214, 69, 69], accent: [46, 46, 46] } },      // Listras
  { shirt: { pattern: 'xadrez', base: [46, 46, 46], accent: [232, 232, 232] } },     // Xadrez
  { shirt: { pattern: 'blocos', base: [63, 107, 63], accent: [91, 122, 63] } },      // Camuflagem
  { shirt: { pattern: 'listras', base: [224, 138, 46], accent: [0, 0, 0] } },        // Tigre
  { shirt: { pattern: 'blocos', base: [122, 122, 122], accent: [58, 198, 198] } },   // Robô
  { shirt: { pattern: 'listras', base: [255, 255, 255], accent: [0, 0, 0] } },       // Zebra
  { shirt: { pattern: 'listras', base: [255, 255, 255], accent: [117, 170, 219] }, pants: { solid: [26, 26, 26] } }, // Celeste e branco
  { shirt: { solid: [200, 16, 46] }, pants: { solid: [11, 107, 58] } },              // Vermelho e verde
  { shirt: { solid: [247, 209, 23] }, pants: { solid: [28, 63, 148] } },             // Amarelo e azul
  { shirt: { solid: [31, 58, 147] }, pants: { solid: [242, 242, 242] } },            // Azul e branco
  { shirt: { pattern: 'listras', base: [165, 0, 68], accent: [0, 77, 152] }, pants: { solid: [26, 26, 58] } }, // Azul e grená
  { shirt: { solid: [245, 124, 0] }, pants: { solid: [242, 242, 242] } },            // Laranja e branco
];
function botPiecePng(spec) {
  const buf = Buffer.alloc(16 * 16 * 4);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      let c;
      if (spec.solid) c = spec.solid;
      else {
        let useAccent;
        if (spec.pattern === 'listras') useAccent = Math.floor(x / 2) % 2 === 0;
        else if (spec.pattern === 'xadrez') useAccent = (x + y) % 2 === 0;
        else useAccent = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0; // blocos
        c = useAccent ? spec.accent : spec.base;
      }
      const i = (y * 16 + x) * 4;
      buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = 255;
    }
  }
  return botEncodePng16(buf);
}
let botWardrobeSkinsCache = null;
function botWardrobeSkins() {
  if (!botWardrobeSkinsCache) {
    const list = BOT_WARDROBE_COLORS.map((value) => ({ type: 'color', value }));
    BOT_WARDROBE_OUTFITS.forEach((def) => {
      const shirt = botPiecePng(def.shirt);
      const pants = def.pants ? botPiecePng(def.pants) : shirt;
      // cabeça = null (pele padrão): só a camisa e a calça mudam
      list.push({ type: 'parts', parts: { head: null, body: shirt, hands: shirt, legs: pants }, eyes: true });
    });
    botWardrobeSkinsCache = list;
  }
  return botWardrobeSkinsCache;
}
// Cada bot novo sorteia uma skin do vestiário (cor lisa, padrão ou camisa de futebol).
function botPickSkin() {
  const list = botWardrobeSkins();
  return list[Math.floor(Math.random() * list.length)];
}

// ---------- Amigos + notificações (por conta, salvos entre navegadores) ----------
const FRIENDS_PATH = path.join(__dirname, 'friends.json');
// email (minúsculo) -> { friends: [email,...], notifications: [{id,text,ts,read}] }
let friendsData = {};
try {
  friendsData = JSON.parse(fs.readFileSync(FRIENDS_PATH, 'utf8'));
} catch (e) {
  friendsData = {};
}
let friendsSaveTimer = null;
function saveFriends() {
  clearTimeout(friendsSaveTimer);
  friendsSaveTimer = setTimeout(() => {
    writeJsonAtomic(FRIENDS_PATH, friendsData, true);
  }, 500);
}
function ensureFriends(emailLower) {
  let f = friendsData[emailLower];
  if (!f) {
    f = { friends: [], incoming: [], outgoing: [], notifications: [] };
    friendsData[emailLower] = f;
  }
  // Reforço: contas criadas antes desse recurso existir têm 'friends' e
  // 'notifications' salvos mas não têm 'incoming'/'outgoing' ainda.
  if (!Array.isArray(f.incoming)) f.incoming = [];
  if (!Array.isArray(f.outgoing)) f.outgoing = [];
  if (!Array.isArray(f.friends)) f.friends = [];
  if (!Array.isArray(f.notifications)) f.notifications = [];
  // Caixa de entrada > engrenagem: receber pedidos de amizade / convites pra jogar (padrão: ligado).
  if (!f.prefs || typeof f.prefs !== 'object') f.prefs = { requests: true, invites: true };
  if (typeof f.prefs.requests !== 'boolean') f.prefs.requests = true;
  if (typeof f.prefs.invites !== 'boolean') f.prefs.invites = true;
  // Remove duplicados (aceitar 2x, pedidos cruzados etc. deixavam o mesmo
  // amigo/pedido repetido e travavam a lista).
  for (const k of ['friends', 'incoming', 'outgoing']) {
    if (new Set(f[k]).size !== f[k].length) f[k] = Array.from(new Set(f[k]));
  }
  // Quem já é amigo não pode continuar como pedido pendente.
  if (f.friends.length) {
    f.incoming = f.incoming.filter((e) => !f.friends.includes(e));
    f.outgoing = f.outgoing.filter((e) => !f.friends.includes(e));
  }
  return f;
}
// ---------- Chat entre amigos (conversas salvas por conta, entre navegadores) ----------
const CONVERSATIONS_PATH = path.join(__dirname, 'conversations.json');
// "email1|email2" (emails em ordem alfabética) -> { messages: [{id, from, ts, text?, attachment?, audio?}] }
let conversations = {};
try {
  conversations = JSON.parse(fs.readFileSync(CONVERSATIONS_PATH, 'utf8'));
} catch (e) {
  conversations = {};
}
let conversationsSaveTimer = null;
function saveConversations() {
  clearTimeout(conversationsSaveTimer);
  conversationsSaveTimer = setTimeout(() => {
    writeJsonAtomic(CONVERSATIONS_PATH, conversations, true);
  }, 500);
}
function conversationKey(emailA, emailB) {
  return [emailA, emailB].sort().join('|');
}
function ensureConversation(key) {
  let conv = conversations[key];
  if (!conv) {
    conv = { messages: [] };
    conversations[key] = conv;
  }
  return conv;
}
// Limite generoso pro tamanho do data URL (base64) de um anexo/áudio — o
// base64 aumenta o tamanho original em ~33%, então isso cobre um arquivo
// de uns 6MB, batendo com o limite que o próprio cliente já checa antes
// de mandar (ver MAX_CHAT_ATTACHMENT_BYTES no arena_3d.html).
const MAX_ATTACHMENT_DATAURL_LEN = 9 * 1024 * 1024;
// Verdadeiro se alguma sessão online dessa conta estiver com a tela de
// chat aberta bem nessa conversa específica agora — usado pra não mandar
// notificação/toast de mensagem nova pra quem já está olhando ela.
function isAccountViewingChat(emailLower, withEmailLower) {
  for (const target of findClientsByAccount(emailLower)) {
    const c = target.state.clients.get(target.id);
    if (c && c.activeChatWith === withEmailLower) return true;
  }
  return false;
}

// Marca como lidas (visto) todas as mensagens que "withEmail" mandou pra
// c.accountId nessa conversa, e avisa "withEmail" em tempo real (se
// estiver online) pra atualizar o "Visto às HH:MM" na hora, sem precisar
// recarregar a conversa.
function markConversationRead(c, withEmailRaw) {
  if (!c.accountId) return;
  const withEmail = typeof withEmailRaw === 'string' ? withEmailRaw.trim().toLowerCase() : '';
  if (!withEmail) return;
  const conv = conversations[conversationKey(c.accountId, withEmail)];
  if (!conv) return;
  const now = Date.now();
  let changed = false;
  for (const m of conv.messages) {
    if (m.from === withEmail && !m.read) { m.read = true; m.readTs = now; changed = true; }
  }
  if (changed) {
    saveConversations();
    broadcastToAccount(withEmail, { type: 'messagesRead', withEmail: c.accountId, readTs: now });
  }
}

function pushNotification(emailLower, text, extra) {
  const f = ensureFriends(emailLower);
  const notif = Object.assign({
    id: crypto.randomBytes(6).toString('hex'),
    text,
    ts: Date.now(),
    read: false,
  }, extra || {});
  f.notifications.push(notif);
  if (f.notifications.length > 50) f.notifications.splice(0, f.notifications.length - 50);
  return notif;
}
function accountByUsername(username) {
  const uLower = String(username).toLowerCase();
  for (const acc of Object.values(accounts)) {
    if ((acc.username || '').toLowerCase() === uLower) return acc;
  }
  return null;
}
// Procura, em TODOS os servidores virtuais, cada conexão logada com essa
// conta — o cliente abre uma conexão com cada um dos 4 servidores virtuais
// ao mesmo tempo, então uma conta pode estar "presente" em várias ao mesmo
// tempo. Isso é o que permite saber se um amigo está online agora e mandar
// notificação em tempo real pro dispositivo dele, mesmo sem saber em qual
// servidor virtual ele está com a partida ativa.
function findClientsByAccount(emailLower) {
  const found = [];
  for (const st of virtualServers) {
    for (const [cid, c] of st.clients) {
      if (c.accountId === emailLower) found.push({ state: st, id: cid });
    }
  }
  return found;
}
function isAccountOnline(emailLower) {
  return findClientsByAccount(emailLower).length > 0;
}
// Verdadeiro se essa conta já estiver numa partida em andamento (ou numa
// fila esperando uma) em QUALQUER conexão, em qualquer servidor virtual,
// diferente da que está pedindo pra entrar na fila agora — usado pra
// impedir jogar duas partidas ao mesmo tempo com a mesma conta.
function isAccountBusyElsewhere(emailLower, excludeState, excludeId) {
  for (const target of findClientsByAccount(emailLower)) {
    if (target.state === excludeState && target.id === excludeId) continue;
    const c = target.state.clients.get(target.id);
    if (!c) continue;
    if (c.room) return true;
    for (const mode of Object.keys(target.state.queues)) {
      if (target.state.queues[mode].includes(target.id)) return true;
    }
  }
  return false;
}
// Manda a notificação + os dados de amigos atualizados pra QUALQUER sessão
// dessa conta que estiver online agora (tempo real).
function pushLiveUpdate(emailLower, notif) {
  for (const target of findClientsByAccount(emailLower)) {
    if (notif) {
      const unread = ensureFriends(emailLower).notifications.filter((n) => !n.read).length;
      send(target.state, target.id, { type: 'notification', notification: notif, unread });
    }
    sendFriendsData(target.state, target.id, emailLower);
  }
}
// ---------- Convites de partida entre amigos ----------
// id do convite (curto) -> { id, fromEmail, fromUsername, toEmail, toUsername, mode, vs, createdAt }
let gameInvites = {};
// Acha o id de conexão de uma conta especificamente NESSE servidor virtual
// (o convite só vale pro servidor em que foi criado, já que a partida vai
// ser formada na fila desse "state" específico).
function findClientInVs(state, emailLower) {
  for (const [cid, c] of state.clients) {
    if (c.accountId === emailLower) return cid;
  }
  return null;
}
// Manda uma mensagem "ao vivo" (não é notificação persistente) pra TODAS as
// sessões online dessa conta, em qualquer servidor virtual — usado pra
// avisar na hora quando um convite é cancelado ou expira.
function broadcastToAccount(emailLower, obj) {
  for (const target of findClientsByAccount(emailLower)) {
    send(target.state, target.id, obj);
  }
}
function pendingInvitesFor(emailLower) {
  return Object.values(gameInvites)
    .filter((inv) => inv.toEmail === emailLower)
    .map((inv) => ({ id: inv.id, fromEmail: inv.fromEmail, fromUsername: inv.fromUsername, mode: inv.mode, vs: inv.vs }));
}

function sendFriendsData(state, id, emailLower) {
  const f = ensureFriends(emailLower);
  const friendsList = f.friends.map((fe) => {
    const acc = accounts[fe];
    return Object.assign({ email: fe, username: displayNameFor(fe), online: isAccountOnline(fe), admin: isAdminEmail(fe) }, friendActivityFor(fe));
  });
  const incomingList = f.incoming.map((fe) => {
    const acc = accounts[fe];
    return { email: fe, username: displayNameFor(fe), admin: isAdminEmail(fe) };
  });
  const outgoingList = f.outgoing.map((fe) => {
    const acc = accounts[fe];
    return { email: fe, username: displayNameFor(fe), admin: isAdminEmail(fe) };
  });
  send(state, id, { type: 'friendsData', friends: friendsList, incoming: incomingList, outgoing: outgoingList, notifications: f.notifications, gameInvites: pendingInvitesFor(emailLower), prefs: { requests: f.prefs.requests, invites: f.prefs.invites } });
}


// Quantos jogadores cada modo precisa pra começar, e o tamanho de cada time.
const MODE_INFO = {
  '1x1': { total: 2, teamSize: 1 },
  '2x2': { total: 4, teamSize: 2 },
  '3x3': { total: 6, teamSize: 3 },
  ffa: { total: 8, teamSize: 1 },
  mega: { total: 10, teamSize: 5 },               // Mega: 5 x 5 (times), 1 vida só (quem morre já era), 1 rodada
  survival: { total: 100, teamSize: 1, min: 6 },  // Survival: todos contra todos, arena gigante, só começa com 100 (aviso "em breve" a partir de 25)
  bedwars: { total: 8, teamSize: 1 },        // BedWars Solo
  bedwars_duo: { total: 10, teamSize: 2 },   // BedWars Duo
  bedwars_trio: { total: 12, teamSize: 3 },  // BedWars Trio
};

// Regras da fila do FFA (todos contra todos): espera até lotar 8, mas se
// depois de 10s já tiver pelo menos 2 gente esperando, dispara uma contagem
// final de 10s que força o início da partida com quem estiver na fila.
const FFA_MIN = 2;
const FFA_MAX = 8;
const FFA_WAIT_MS = 10000;
const FFA_COUNTDOWN_MS = 10000;

// Filas do BedWars (Solo, Duo e Trio). Todas seguem a mesma regra:
//  - max: lotou, a partida começa na hora;
//  - min: com essa quantidade a tela já mostra "O jogo começará em breve...";
//    se ninguém novo entrar por BEDWARS_WAIT_MS, roda uma contagem final de
//    BEDWARS_COUNTDOWN_MS e a partida começa com quem estiver na fila;
//  - teamSize: tamanho máximo de cada equipe. Equipes podem ficar com 1 ou 2
//    jogadores a menos (ex.: Trio começando com 10 = equipes 3-3-2-2).
const BEDWARS_WAIT_MS = 15000;
const BEDWARS_COUNTDOWN_MS = 10000;
const BEDWARS_MODES = {
  bedwars:      { label: 'Solo', max: 8,  min: 3,  teamSize: 1 },
  bedwars_duo:  { label: 'Duo',  max: 10, min: 8,  teamSize: 2 },
  bedwars_trio: { label: 'Trio', max: 12, min: 10, teamSize: 3 },
};
// FFA e Survival são "todos contra todos" (cada jogador é o próprio time).
// Mega e Survival: "todos contra todos" grandes, 1 vida, arena maior (multiplicador sobre a arena normal).
const BIG_FFA_ARENA_MUL = { survival: 12 };
function isBigFfa(mode) { return Object.prototype.hasOwnProperty.call(BIG_FFA_ARENA_MUL, mode); }
function isFfaMode(mode) { return mode === 'ffa' || isBigFfa(mode); }
function isBedwarsMode(mode) {
  return Object.prototype.hasOwnProperty.call(BEDWARS_MODES, mode);
}

// ---------- PWA: permite "Instalar app" no Chrome ----------
// O Chrome só mostra "Instalar" (em vez de "Criar atalho") quando existem:
// manifest com ícones 192/512, service worker com fetch handler e HTTPS (o ngrok já dá).
const PWA_ICON_192 = Buffer.from('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', 'base64');
const PWA_ICON_512 = Buffer.from('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', 'base64');
const PWA_ICON_192_MASK = Buffer.from('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', 'base64'); // com margem, pra o Android recortar em círculo sem cortar a logo
const PWA_ICON_512_MASK = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAMAAADDpiTIAAADAFBMVEX7+/z67tL13cz92HDO7fbK2vDi2Nrd0Nm5z+/gzrjjyL7Zx8TVxsvgxKj5xFzOwtStw+zMwLHRt8HFtcLCssDZsZb2rza8scars9iwqMuzqrO0q3/sk5G3mqL+kyDckjaloL2ln6ykl7qklqClkWFw7v0y8/2Jw/hewPwM8/4M5P0M0vwOwPqArO1lp/N7n9ORnZRPrfxNnfMhpvYGp/KQlLyNir13jsFzhraRj6GBiKKKiZGFjDFalNZYi9hKi95Ti75UiK48i+I8hr0ejvwVjNjpenjreiDyZUfFYUuec3mhZS2cV1adWC99fbN2fap6f5J5bZ5+dkt8ZWZ5WWuCWDhgfrplfatgdLJlcqpjdKBgbZ1cZ59cYKlbZZNiboRicTVeZIZeY1ljW3pYWnlfWVlEgMhGdsJDfrBJc7I0e9o1eq8jetMJeuM/a7lCaa5FaahBX6wrY70pWa8MYMxQa3JPYXFOXXs3bI4fa5lBX2ghX49KWJRKV3xMVnFLWD09V1slV42zTT6LTT56Slh8STK5OTPIFhh7PzR/ICBlTXVnTGNrSVxqSExoRx9nOkdqOC1nNh5jKyJnERVKTo5KT3dNTW9UTGRHTWVNQ2JOSlZMSzVMQFBSPydNNkxOMTJONRdOKxhQJCBMIxNLHBdPCA07To09R3tAS2w9S1k+RVQ8QVI6OmM6NlM8OUk3MEk6TTE5TRM3RCA5OD84Oho4MDo9LxQ3LQ03JzQ5IyI6JxE8IBM3KAsyKQw2Hwo8FhQ0ExQ4GAwxFQs3Dg8xDhA5AwYgT6gjTJQGScQHRZseSnUcQG8LQnYGNZkIMXQgM1gMNFksRCIrPh4hQCYlOR8iNR8hLywgMA0QLkwSLikBJYADJWQcKEoBIVIpJjokITYYIjgJJD4qJiUqKg0qKAklICooHxgbJR0QJBkAFGQDD0IXGCoECioiGB0ZFRwPEx4JDBwBBRwqFAwaExMdDA8OEBIKCQ8NBgwBBQ8BARABAQkfDwQHBgUPAQIBAQUAAAGVHePZAAEAAElEQVR42tT9CVzUV7bujReohVEUFRAoQwBBccYJFQs0MQ6hBC0tYuLQAhZoxyGOGeyoJIKGCAT0tCBlCR3Tx4mh0Eqdtzh5P/f2Of9PqxhxSjQJCCjvi8ossSHAoan/Wnv/xpooTM69990qYgFS1PPdz1prj5J4aB8J20FH2p8PkLaRaxs2rCdt3bq12FYK2wqzJvrgqlXrsNGvZv+3A2z78zlb7TOmXfst7Sq0vWZtt7DtZNsubO8x7V2mvcM29oeZT1sY2wL4JuPaSHEb5lgTfQ3/nwUIG/d9w5gnMn+ejcY983ckL6U/C8ABAQAbbAKw8uUBOHDunF0EfrP8FvrbAcBc/3fN9bcAIPC/HQCZfQDmr5hns71DOJDEJ3z03wDAWocBWCkEYIMFAH8+d64PBl6egqv9MICdjgBgof//dgDm2W8IQMJHCS8BwEFbADhgASv7BmBjvwB4OQb60/8JAO+ZA7C2HwDIbAEw7GUAGOmwA8zrq0k++uij3wOAjYz+/QdgrV0A+iDg5U3gat8A7NzpWASwA0Dg/1IAXoYAycvpbwUAew4gQsDsI+sEAKzvPwAvlxFetaG/LQCsGYADKcBLAPAKNHjzuwEw/389AFYJcMwBrADQDwKuffa/Qv8+U4D5Av0D+50CMACYITDSJgAWBISG9icLMAPAQueTJw+e/F0AWNkHAGZlQH8toF8M2JRfBMBOEQA733M4AogACOwHAIzybLNjALYBCKX6h74cAAetAADNDgEbrZQBtixgpTX5zQDY8LIWwFHw0umfPf15+fseBBBFgD4dgFdfJH4/AJCZAwAIIAUvEQKsiW+TgL7KAKsArHwZAPpDgAOZwNWX0H/ney9hAEIH8JX59gXAK78HAAFE/zDCQH8BsKW+DQLsAGA9Bqy0pr5NAF6WgD4gsKP+yxqA/QhAAfD19ZX1GwARA/0BgG0OeYDEiv6HzOS3isABOzHABgDWmwMA9I8AOwAQ9fvWf+fOPvV31AAsABjZHwB4BBwFQEjAnDmOA8BpT9rJkw4TYJkF2ooBDgFgPQbYHRHux+CAnc5vD4D3XsoAGAACGQB8X8IABAS8DAAOESDh9D/Et5OOEPC7ASAkYIMNC+hnFLA6MGBffV7/nQ7ob9sALAAIpPqzBFgH4JV+AjDSIQCQAISgLwCE2ttmoC8L2GAeA9Y6qL8jMaD/JiB2gb19N0f6vwMGYAUA398CAEVg5MiXtIA5xAXm2Z4Tkhyy3vpvARv6qgP6CYAFAX9+aQT29kP/nY7o70gE4AAI/O8GQGbPApgwsKK/ADjgAbayQA6AtS8BgD0C+usCnwECex1sNuTvE4C+DYDV3/cl9f9NAFAPmGMnD5AcemkL6HMkwCEC+gVAvxnop/67d/5WA7ACgIiAlwDglf4BYJOAFf10ACsU9BkD2DRwreME2AHAOgH94uB37f92DMCBCPDyAEB7eQAYAubYIsA+AIcu2CPAdhLgOABrXxKAPtHgcrrfIH+f+vfLAGwD8MpvBMBBAqxmAjYAuMA3hwGwFgPWOgKAaD5ww28mgDThtJ5D+vcpv0P62wXA93cEwMNxAIQEWOYCEtvKW0GgzyTAwgLWOqC/CACRBWz8HeTvgwFHu38/DcAGAFbHAV95CQD6YwF8LcARwIPAAXDq1AXbzeEkgB0KWOsgAX0BsPF3AsAWA7blt63/u44YgEMAOGwAlgR49McCQoUAmC0VkaD0XOsnAVZigCUAa38TABt/L/2tMWAp//ukwV/vOaB/fyMAEPDfBUBfBIRaJQCb5JRZs0+AozFgrYMEWAFg/cbfSsBue82W/O/jL669914/DMDRCADtdwTAngVYJWCOYwDYYuDlY4A9AhwAoN8I7Nq1a7fDjev5AvXf/+0G8N8OgH0LGBtqhYD5DgNgHQIHLMAWAGvt6y+uA60QsLF/8u9yFAHe98Xy90///yUAvNKHA/QZA/jlAX0CcOGUnSjQNwAUATMC1v42ABxmYJegOST+TjPpHQ8AVgzAWgpgB4Bhvw0AuwQEOEqA4w5gjYADVgmwBsBaO/o7BIBjEOza5QgCFlnf+7+PAfQNgOf/RgCEa8X7BuDUb7WAtWv7RGCtCID16/smgAXBOhO7rDSbyttU38H+b80A5H0D4Pk7AtAvAsSbBRwAwGYaYM8C7AJghoDwA2YEbOx/O7DBqv4sAjt3Wtb677/vIABraHt3TR8GIJfL/w8CIMBCf6sESC6aNbsIOAiAAwSIH//tAJBva52AnVbb+47qv0bQ+jAAOYeAbQA8/9sAsGMBVjYM2QRASEHfFnBATMAGAQFrrTdr+vc7BliV3wYBv01+WwBYNwCOgN8fgKFWAHDYAvoNAMdAPy3AAQCstHW/1QG4b7vBQQDef7+//u84API+APB8mTJw6MsAwBEQxhNgwYBNABgGXjIG9IuAdet+NwCsINAf+UH/LVu22JJfAIAd/QkBvzsA0KwA4KAFhIW9HAAEgf8PALDBHgD90X8L02zpv8Yh/ZEAewB49h+AoS8HAINA2MsDgAhYEHDQkSRgw28BYP3L62+BQP/l55qF/v/nAODeDwDCfhMA5gSctE/Ahpch4LcBsGGDXQIcdn8L/df0rb8NAORyWwBYJcBBAIQEuDtOQFgfAFzC1j8C/k8CgM4gr7dGwHvkz0v3/zVrXtYAxAAEWujfbwsY+vIAhIU5BIBdCsQE2ATggHl3dJgASwDW90t/bjGZkACzZL4P/bds6QcAK18eADMHcMwChg61IMAGALLfBIBNBsQEHLIxEnDA0o/X9weA9f0HYL1FY77xezaaw+pb1X+Nw/rbjgGeLxED7AHg8ZsBKMBmnwG7FmAPgA39AGD97wIAg8B77zmOgFX5t7xuHQCyisrWIOBLAEARcFD/oQL9f2cARBD0QYBdADa+BADrXhIAa/KTA0pw1uY9BxnY0g/91zDrKB0wAPl0B2NAnwQMHWodAPeXBGC+TQAEDNgnoB8x4L8TAKvar2MBsEcAMkA42GKrvf6bAZD/TgAMtQaAu7stC/iNAPAMvBQAL0nAywFgS334D9/tmwDQnwz6vYz+jgEw3bFCkBLgIABDR+Hnj3K3DYCsLwDm9wWAAwSc/O8AoC/98UzreFsArBM0DoC+CHjPtvzWAZhnBsB8uwDYJcB8gZ9j8gMA0PoFQB8GoFQqLQBgEbADgNgCDogJ6H8a6AgA8QwAsbHwB35ttCE/3ZPkEAF25Lev/zyH9JdPn27HAhwjYKg1AEb9FgCE6suVSusAWENAOClgB4ADlgNzv0cEoPLHx3LNtv4CB+gDATv6/94ABL4cAEOtA+Du7ngOYEN/OTxlpdI2AFYJ4HMA20nASwCwrm8ALPSPtSm/yAHsEmBHfmsACLfTmetvHQC7FjCybwKGDv3tAFgzADl5ukq2SYqxFfSZCQimhg/ZTgKAgA22CHj33Zc0AEv9eQLW9QHAu/0CwDH95zlkAAhAfwgY6YD+VgHwcBwAwXM1A8ASAmsEOBIDDlgHANQnB6w7lAGst9Q/1rzZ018IwLsvob8VAiwA6NsA7AQBXyv6j+xTfXEK4AgAZvrzz0yptAKAGQLmBAgA8PHxIm3sd1WVlVV9tu+EJwXTncrWj4wknxXqDM0F2hB8x9kpDL4H06rILxvtlvV28+ZN/GPRHDtU2sodAtzdMYJ1wgQLfPLz58+hSzBYCQSjf2ZtwIABFo/hJw+DH/oV7vDYYSNlYSvXrTeb5LTc53Zt79WrV6+ZARBoCwClDQCK7eYBPAEsAF4+5x0i4LzgpGh7ANDP8GcIoAA4O5+3qbkD+t+yqv5NR84TxjfmAAjuDnrXKgBU/7H29R8gaBYfFB4VP1IWEDb/HTRIMQFWt7vC87ULgNX+DwDoi20gYNsCAAB3BoGNVY4gcE4o/9ixAMBK2wCscKcAMPo7ud75veXvAwB6nCxDgcUBcrvEewU4/eeRH8+y+5sDMMCsWRLAye8bNn/lOzRC2tBftN/56lWbtwfY1h8A0NtCwBIAhgAwAHcPagFeqyodIWDjHKbrw0sEAKyw5wAr5rgKAXB2Cqh6WQBeRn72MHn+VFHxthLLAwNZ/efMsdb/fe3Kb0kAu5HcF+VfSQFwIAaQZscAbMhPAdCLILBFAL9KeKU/yUIoAX0nAt+dWyuU37b+LAFjhwAAQ0gIcMI/sVUvpf/LRX7U3exEaUsAuBRzDaf/HEZ//pYgC/mHCXV/hX0H+roZAJAz0pQdX5V3MFFeb7HSyQEAHNKfA0DAQJ8EbFg7dhRPgA8TpG3E/40rOfFDUX4EwGrvFyQKY4e4Dh2KBDgRAuynAY6Jf83BvI+1U1sniNrQfx6rv63wj54ukN9ZIhkgIIA0sf4cAO8gAOstlrpZI0BmywBs6y8EwBIBKwAgAcDkHPdRFAAgABKBSlsIVM5hjyiivR9aKNP/V9Dz4+kfswaJwliPUUOGOBH9ndx/j65fZld0eqTctb5OEOT0x61ioD9XH84xS/9lduV3kkgkzlYJoAAwDsASwKWBFlFA/Fz7DADKPgDgELCaBwoBWLvSZxTjAV5ebiu5Qs0CgBW8/jwAjjTIFj1GOTsRBJzC6n+T/Df76PR2ThGyov97RH7R+AAb/hkDICU5D8Awsf6voPwSiZOACGsACC0A2vq1YgT6A4Bt/WNjrQNQbM0CuP1idASHDwNebiQRsEQA/s0DwDoAyQEcAYAlABBwiu+P9d+AX44DsNfeQVJW5GcNoA/9ZbKRPADC4E/llwhiAEMAlwNaWMA73GgqBwD3jAXP+apQ/0AH9McRtZcHgIYBhgAfUZiuquQB4A+qYwCY4xgAxAN8GQKc5tf3o/PfwOZI0kdTvT5OkTI/NexdCwOYy+ovAmCktd7Py29pAeYACAl4xxYAzNOGP1ev7uqf/nRI1QwABwjgAFi70svNnakH3L02mnVQMmgHOYDguBqivsP6UwKGUABW9Sm/qMffAHX7qvbZm6PND5HaLe7+Zvpbyi/Ufyyn/0ir+gvktwBAUAWyBFiYwLsbbJx9sffq7jU+blYDgA392TF1cwDEBFyyagH8QL6/m5u7G0WATwREbc5YtoWCBcxhBwIdjwKEAKd1lbccl9+xkT6m1rN1jpjZkRIW0V8wPzBXBIBAf3vyi9JAQS1oQQDvAe+++571gy/27n0v1E0qdbFmANb15ydVLAAQ54EiAthjAwRTOXPc3Zjm5Rb63Y0NGy0A8B871t/fH+RHRUMdBmAOO25IgwAHgAPq37hBNbbDgWCox8ZJcmL5mU3DlvLPtbQAVn8mtRdWfmbNySYAQgJWMgSQiS2ro4HQ+V2kOH1ixQCs6i+cVbMEQG/TAqwAsHaFD0eAl3/oWK8wCwBQflZzvih0gIA5dOCYELCeAcCe/Bj5HRnpuSYe6uMneXbu2skRwOv/Pm//Yv3nsm2OAICxAdb1t5QfLcDZIgdgCAjg8wDWAd4VGoBgLHDXXC8qPw+AZQCwqb81AKwQII4BwtMeoBpgAcB+7i/1v2UWAkKFaguGBfr2f0qADAkgAPSR9/Xr1lgGAN4DmG2EQgDYvUSWO4WF8gv052LASDP/d3aypr/EydkyC2QAYGXkAHjXGgB857cBgBX9zebVrQGg78MCWPk3rr+4CQiY4+aKALhDVw/1cXPxuiEEYOMc8yEe+wSwHxIUjx6jnJw22s37b7B5f//0Z00Atea3kbIAYNe3Kv88Tv7QuaTGEWa5PACenP6vWJdfBIBZGhggDgEsAO+JxgL37prnJeXl5wDoj/72ALC0ABaAFfH6goIH0J5dXo1hwMvFhQIw1sfFzcXtz4KMrfKABQE2w8Acqw3HBG0BwMmP4m9Y4d9v/dkowNo8JQAf2ik8MWSNre4fKqpxuCRwpGD0z6b8FqOBPAAgImsAK2wAsHv3uyTxc7EEwF4CYLGyRmKwqb+lBXAAfPTs2cPbt28/vJAUJ1+3bmO8XJ4U5Obv7+Pv4+Li6uKyXugB52g+Z4eAOfYbEOC80ab/g/i3bl47t3aOj5eXNLSf8nMWsFOwiZRYK3tiiLVtgjwAYvUh3eVyQC4DsCO/MA0UDQT48gFgxYqV8+a9wwHwHmUAIhZ2frH8LAB2DMBcffUHH0gMBoNdAqwCsPHn20DAg59/LokrKfkezOBPn4YHof4AgIurm8sK4YDA+Tm8szOT5nwYsKc7SRjwdV2x8Ttb+sPba7vmhfp4+0BzkZ7rl/gcAPwwz/vUA3baA2DNPHP5/dnGXgzFZQASiWMADBACwHZj1H8erz+zvA1SVdL5zeVnAXBY/w+wIQAGezHACgArV2x4+N2zZ0+fPWu/f//n7/W3HzzQ/xx3OTzM24emJG4uYwVBoOrGCl5ocwLs6M8MHK7983e3Kq2v9YK35zbM9WGal5eLxL+/+psD8J7FzlHLFaKi/u8vbKz+wxwzAEEMEDoArz8FYB4LwLvUAeb5SJkmkt/Ny2wW2L7+H3zAA2DoG4BLAgB2r1378NGjZ89+fvbz/Wc/Q8M3cUlx4WN8vF3Is3IVp4LfCQnAd0Md0V/mMXbOhnO3bNR+8ObagXeYrk/193Jxctpw7Vx/5Kc5ADvQAz3eAf2FAFjKL9B/mK3yz4oFWAFgDnfJDwcA1AHvzXWT8o0VX+ri5sNMRTqmv5rKv2kTBcDgmAUwAJRdO3D79oPbt0H3K/dbWzuRhJ/j4jYFxa0OY56Uq4vbeWEisNbM7PskYKyPxyhnfzuLfa5tmOPPq48AuLtJnZzcru3e65j0AgDsnBrhoP7cslyPkWIABvQDgGECAALCyB0PzC1PXA4wz8fFyVkqJgDeQA3OzUXbAsBK99+0iQVA3z8Ayssf/vzs4XfQ7+/ff/4MGrx3OTwcosDl4c70WblJVwprgcoNc1bMcbyFerlKmfEfq+ofmBfq7S1UHw3AzQ2/ZO7V3WRFj3DAx676e/fu2WNLf0ZxK+rPDeH090H5X5XJfHx9PTxGmgPgWAwYZgEAOeF/BQ/AOyA/dH6x/FIqv48/vxihn/qzDmCwPRRgCUB5efmdB7eJ8d99igC0QhQ4HXf5cnhcePhqSoCryyoRAFAO9qN5kQkAJ2e3c9ai/60D5upTA3BFAKSkirvqSONmfWwBwCpuqX8Ir79/oK9M5rsU/hxe6jHSAgDHYgC/JEjmK/NlAZjDAjAPDGCeP0Q4qUVz8/LxhyR07FgKgCP6C+TnATDYtAAuCdBoWADKyh//fPsnjP5X7nV2dnS0Agvhly9fvnc6/NllTxdnYkxiB+gfAWNdGQC8blhL/g5YyI8G4DqUfFHoXnMC9tpVn1iAmQlwx8TMFenPd38eAJ/ALxReMt+3vHyjozw8cPeu4FL4vi3AySwFGAkgyZhLPzBjovqveSfUS4ryO5vL78NQiLNtof3Qf9OmlwFAwwJQdufOzyT7e3a/o7P9WWtr6zPo/nE/Xr4XFz491BUX9UrniwG4VfnnUIeTgLE+lAA3Nx9rpd8uawB4eXm44NdId9EZXZHWrOQ8EyL9339/jxX9X18wlwdgrlB90D8kbAxpnkFHo6IUS/2WRqZGvYoS4mP9jgEsACP57T0EANr9MfI70TXSIv/n5CcAjLUAwAH9eQAMfcUAjYYl4PGtsrKfmlqftT7vfPasoxMMoLW9Ne5yHLRn4eFj5sxxBw9wDiPuLSTgHK/+ig03DoTaxmCsj48LBcAt1HLozwoA+Ar4+7gTanzYKX2284uWeYr7Pu3+Vk8N2vz6ggiqeMSaiLnm+od6Ry1bFrkMW2R09NFlry2LPBwN/1i+fHn0cs9+xwARAAIHQP1DMbdxttAfvd/HR1CEjPW3pb/SPPvfZA0Ag62xIIH+FIBnz376Dnv/s/v3k0o6OjvbMA8o+RGSAMgEL8vBuKBQdQ5lwjc/jY/lII4BrD1wAx89F2rHAUhNBwB4u82tuCme+Ll2810xAP6hZMWhv48X9Y13uUUd5n3dWmMBIKoLzo3h9Be3EMb+A6L9Ikk7fCT68DIAYNlR+Cty+fLkZDEADsUAJgcYyTsAs5IKAJBy8vMEQOdnwBe2vg3AQv+XAgDF//n7n38uuV9ypSTuXsnd75Pul9yP+39+JGngdAxdY12dx7L5m4CAWytXbDj3HVPc2SYgFAFwlxIH8B78bgUd8+EAKGcA8Cbi88NxPl508YDbXjKhg+q/2+fVwUz8t9wqutkqALT/+/t7K6JR/eWHoeOj/q8BARQAaP0BQCJKAkcKDIAOl83zd3IWEEDSAFcvHn4hA/w2YFsBwEJ/IQAGGwBoLQAghf+zZ9/fLbl79+79uLvfwz/aofP/+GP4ZQIAaOjibw4AIYAb18F3z9kEAMR0HyUlAHiP2F1htthnnhutAvxFl2JA3HAfRSxgHlrA7nfn+ntL/a++pP5gATwAISL9QzD/iyQA0CAAAIxGAiAOIBSRYgAciQHmAIzlAXBjNkewBEDRL7I/HxsAWAsAlvon2gJAbx0ADeMAqPiz+89+Lim5TwYD2589i0MCnl2+rCQKgs9zgVuYB4jKOlsegGJCWefm4kYJ2FshXuo1z81cfDIfgxZAUgeX99bM9fEiqxSk79kWnm02jgsDC4iI4EQPYf+mDhAAoR7a4cOM/gwAaAFmOYBDMcAMgLEcAHNDpbQgYuR3pdtxzDMgWpD0of8HFvonJvYJQHGBljSNhifg+c/Pn0Pe1wEMfH/3/tP7z0iLC/8yPPxKODrAyg3nboqEptozHiAiwAYAof6kg3sTALy9r90SLfX7g4+VS9GgGPbx8aAW4MIuU3Jz8kat7clvHYDNmzcvgIYIhFg0iABLIfRHRy+PjDxK9YeGacDRw5HLo6M9RXWgcx8x4BWzHIAzAExt5vozQyIYB6SuHsy2bKvNizsHwrH+n5hoBoDBDgBaAQCtP//8vLUda8B2MiWEEaGj/R7YfzjkAEpI8W5VWI7fCOxf8OC1OVbnhhj/QwJA/xEhZeKlnms4AvzFAHiNcjUDQPoeI7M16an+rOK89qQxAFgS4O3v7b8MdD58mESA10D/AcMJAMtoFuDJ7/Ae9oqzswOFIAVg5EjOAZjbPkPn0rwWEXAZ5e7hYUd/Hx/+HBCb+n/4oUh+jaZPALSWADxD8X9+9vz77++C+mgEWBFAAAjHWvBRhe3d2lawuDbH7Jp78TCBN3GAEXPLRXs5rs71twCAmCBkAZgHurAEQETw3vP+HnsN9N9MdRfJT/QnCFgC4OMdiACAA5D0D3r/gAHUA17DojBaCAB2XXsEOL0ywAIAf3YtPUQARn3pUHI0iF0H8OfPAepT/0RGfzEABscA6Ox81t7ZCm+f3f+5Hfr+s+7ejmc/x92D/g9x4JtNt/rVkICxZgQINhR6jxiBCJwz28ELyhPtx5KuP5YdlmMswIUlAFOCLTaEf5/Tn2hP3m4WNBYAC/2hRUUfpgCg/sOHg4TDEQBIBA6LAXgFd7Y59TkZJNRf5u/PGwAZFHcewp4O5OFlkwAmCWTP/zMHQG2pP9Gz3wAAAe04/tPe3vrs+/a7zzoxI2zvae/EGvDy5bjL34TH/amiPwTM8RHecU1/8DliAkZ4bxATcG036k0cYCy/HAMBcMc8kCxLITmgkw0LQN/HhxnNxdILALDUHwHwiYqGno4pIMg/eoDzACcnBgEyFMQBgOf92CHASbQ1cKQlAHPn4g/gPHQUPR/InY0BSADdmi1KBLmD4GwYgEh/Rk4xAFYI0FoS8DOZ/sOpoPtJd9vv0jGhZ+FxvXHh39zrhEQgfHU/CLi2dsM8wcJKs3gQSggY4b3+D2bz/H/wgZcJV2H584tySCY0CoIAs0LCzY1EUKsWAABs3bN9+1bw/83WG5MDWOn/3t6Ry5ehA0QDAAOGD0CRgAJgQRACUHzqANazACcns93BvP5cCKARAAyAPx+KJcDcBoQA2NT/Qwv9XwaAnJ+ftZJC8Of79+8++/77n0F9SAMux724h6XgN+Ffxo0O/85hBG7evHVtbqjVC+8ZAhCAtX/YdU44wX/t2lrvtMzMzLT5YbQU9vFhCfBydaLyw2s0ilqAVQK2bt0KAJDG6M0ovxD/LGBzwAgzCFB/X8j+jkTj2O9rA5wGsGnaAAQAc4NhztDx6XlfVH+nvuVHADxYAFgCaAQYMmQo6wDcflyLMEABsBUAGP0/FNu/FQAMjgAAHf57NIDvS+7iMMCz7+9/D0lBHISAby5fxikBNIFNtxxH4NbNef6hVhkgb31GjPABAHaj/oUXCs9/d+NUzvnzhbF5+fn52kxF6Crqe2MpADiKDAHA3YuuEcCRQetJAAKwhwMA9V5I9Yd3FgrltyAgAAeBSBG47LXh/LI+iAF+kVAFRDKnPQ1jAHCySAOdnAZY0Z8CQIOZAABnDgDuiDgLAuhwkM0AoGb0/9Cs+zsAgNaaA3xPIwD0/B/uQiJ4lzAQB0UAZAE/Xo7DXDC8LxOoEABy89Yt6wTQRfdz/NEBdgMAV2/k55fml5aW5ucVFxvysrIAgeSM/Py8vLzi/EAfhgAfL1eyUwnDJK0DttgCgOv/tMcvXEilX7DADgAh3vLoyCNRUVHRoDUzFujnB78j6Tjg8kiSH3ryAcAMAFLWm+uPBmAJgD8FgIsBFAKreSB8kb0E4EPaUP8czW8F4OefW1uftbY+J2+e4oggxAEcCPwmzi/ORNaFXLGTClZU3Lp5rsKMgHetE0CjgLfPWmIAZTeM2EpLjfnwVPOjj+Zn5Z/IzCQE5Af5s3mAD25VYYzS3dkWANt5+QGAhbzslvqLAZgaFh2dlZycfCSZ5AFkSJA0eP/tI2/ThokAq7+oEsR0wdn5FWsG4GGmfyhJAikArn3KzwBgfQrIlv595gDWAGhsRPGRAQDgGb4Hf7V/gwkABAAoBCACnC4JtwFAxa1ru+aGuPmbeUCFDQIIBHNXYA5YVlZ2oxTlBwcgLfUL8ICsVCQAmt9YjgAvF54AV6cRe2jGLxIfG9f9EQA+6lvIb5YITg07kprFCv92NDECfAsxASFgaBjGJADOwjSQeD85ChK0F3R/Tn+ZsP9DcyH6D+FPieWrAEEN4O/v7WMbADUHAOifI9b/ZQDQ/PQILABM4OefAYVnRP/Wp//3k/b7OBIIMSD8R5wY8LMSAqDrH3h3DsmjpT7XKspF63ysEzBnxYq1f9iw4QDRHwAoZfQ/ceJE1tFlQEBqahYhINPP158jgEwjMK+V0+Ctm8UAbOf1RwIWLlwo1N8eAFOn4nMPS806Ehn9NpgAdHjqAdHEAOA3PBidDAawfJizszkATk6vDCCJgWCgiKsABQCE8gB4MwC4MgkAIz8Jb4IMwEceCsVpnwbwIejfTwCsJIGaRz8/AAQanzcCBo2tjdj/nz37v/7t6dOnuDK0Pe7Z5fD2K1fCL1RwsR5/V2DXJ4s5SXORugEB5RUVDADlZeV/EBHgT+Vfu4GeQcwA8KT2yRMg4OyJ4ycwB1/2xRdHv0gF+Y3GfD8/skKTsQCeAJfBe1gAtgvaVrYRAMSCi//FAUDl9x4RkJqVirJHg9bJJBmMJAAwECwnswSvOJsRgDsBzZUXAMAc+2sGQCjUAEOcnUeJ9Pfiur/3WH+cGB27KS5utUpu0wBY/XPM9b90yXEH4AjIefTgwU8/gQmA9I2N7a0tQEDz06dPnkI1+GPclz+OxhmBuOfhmyqEcwI3z9GuD08amxsWaruAgPLyW/DrZnl52bXyXf44ohfKvME5ghUrEYBz0K7REGDACJB//MSJ41k4CL/si7NffHEilcSASD9fH94CnF1dCQCAgTeoDNrv2b7Hivxbty5kxnsY7RcujIiwpT8FQD4dfIdxegAA/4rEdOAI6o/voCssNwPA2bb8w7i7YC0iAMQATCKkZgAwWYCXt/Ly6qDp/spN+tVxf5q+qY8AQPTPEet/yfEkkLeAWw8BgEc//dT48+PW1paWlubm9r/+ZztODz9rf/blvfA4UgnGkRCAuR608opd3sLm40W2D6wp51sZKLyb+fmZXWQCAMgYAAkBxnzjmWij8cRxMgl/FCwgNTUzL9+Q5een8OaCgJcLEuDu4x+yAAv+rdvNGu37oP5CKjjoO43Rf2Ef+nunHskikQfbmfwz+CY//wy0rDNn8vFDR6C9bQ6A8BBgCwCI/l7iHAD7vzedC3K1BAC7f8CmkqTpq1cn/ank6erVSmWJAABrAcCa/i8FQFnZ7QePfnr408+PHj9+3Nzc0vzixbe//OPFs/tPn33zzbP7l8Mvx125HO63uuJmBRUff+329rEEQBoqAIAQAM4Ptr927R/+sHbtStxTuhZHAHYzw4BXIQkEu89abswC/x8+nJmBQwcwZEVGK7iZcbQAFzefuVuI7VsCwPT9hVuJ3kTcqdQCFpoTwId/lgAiPb7J59sZTEcpDqB/cvQRTyczAGzr/wrn/0w6T+UP9SYbHVgAzAzAyycgaVOisiRM+ekP9+7d+z487sc4BwLAKTP9bYeAYnsAlN387gHGgcd3fmourX3xovnr//zHfz558s03Z848ePA9mRUOD/8TGHsFK6+ZA8DPRne1+JTxAEArvzYPkr4Nu3bt3rXrDxvwiNkVeDgOOQ9hLwEACcg6nIqzMMMH4PQLMJCMWeCRyGSFYFbAy9lt7potTNw3A4D1fpr7RUybSts0aASAhdZSfw4AFWQAIDIoXkuL0lojU5Yw5ckRyALGOFvobwuAV14ZSSZ6ZT4+zIAmAuDjyh6SCG+5MSBe/wB50qakkis/Pr3/4/2n9364fPlPH5RYM4APbBrApd8CQFnZrZs/PYDfkJM1gwN89fU//vof3365/MwPD+6W3L2CxSAAIGhiAIB0KSHAbZD3NYH+0K69uwL1PoeHdvxh5Rx2c8QuchTW3hvkFc4iazCGDwcCRkMcWHb4CALgt1xBhsSoefqMcp27YPPW7Xs4xS30ZxIADgACAdfzpzHCC+THFqzE3g/6H8/KNxiMRgMyQEmAZjDk6wGA6CDnIZYA8FNEouxvyFAEAE2dJrHQvFyduWUAbAowSqh/2OkrJZs2Xblyma7GgbIrbvr0EqsBIMGGAVz6jQCgDZSV3fnpSfOL0ictx498/fV/fPvN22cenD795ZlvIA8IH71JBMB7vPqEcH8XhoARe8vLBACUXdv9Lhn0wU7/B3oEK3xRyHvv7dy7d+9n0OGMRpL/MaOvw4e/tiw6NT8TAIiMSkAEQP81c+f6+7j5L9hslvLBe8L0j7EBCsA0xgQ4ADguBPIDAOuyMjHGgwHk5RWTl4q+cuS1y8vTajMgAxwyZIiF/AwBAhKI/uw8L7e0y13qxDdiAa6CESDaVMqky/cuX75y+en9p/ch9D79oQRSL6sloEj/U+b6/yYAiGfXlUJZ1nwiOvXEX49fOV3yoOT7K2fO/IDTQiIHKN8lED+EJDluZAeR26C55WXidpW4PZ7hies6mRZCBnOu1dVCO7ts+Gju7DVIBLAOzH/bb/ny6uSxJHyuWTM3BNx0wVbLnN+8LVq0MIKxf9os9OebN74Jzcw8gmngifx8eJH02jw91d9IKcjLAwCGScUE8JfBMJdEiuQfxRgAJcDLyckCADyBR5QAbNoUd/kyxH4wAEAA52LDk+6GW9FfzRrAIaH+Fzn9bQJQ7DAAfwMCmo9HR39x4suS06fvlnz/6MyVK6cfPAgPKi8TAPDeCIt1nF7UAuaWmTdyhOd7IGKIIGxMPaTV5Grz8/LzMvOj/aBFqVSREAZG+y3PzIOWkbw8WR81J4REANzIE+KzYHufACxCAED1aQIC6F9m2tPnAA6gysfuTzJAVNxQbMAXB7s+GAD8BgcwTwCtXAlH5BdcAMQC4OPv5mTWnPH8HbH+XkmXr/x4H6P/U1yS96y9/Ur4zz8nWS4D5/U/hPqfMu//NgEotgIAPxBwjempCEDLi+ZmAGBZ9BfR0Q++//77e6fjTl85/WVJXNwHCAB+CmnX5obMCREN9PiH+pBEcC75j8xMoGyN8IUnwy+J2M/zaMuEchskOII1QHQGefnz8ggAc0NCQ9ACcDRv81be8TG3W7TImv4LI2YuXDgT2jRhE7r+CKYhACFHso5A70f9tdpitABtGjRtYlqMFuxAk54WNUbYf63rD4kfq7+HB1GXHdMNdRGrL3WlR3CJCZCXlJT8cOWHZ3dJDtDe8Szu6YOSp5YGkCA2AJaASw4DoLUGQJb2NrQi4+nTbyfeNpbml54t/XJ5dPTR5Tdu/vTdbf2ncTe/u3jzRpnY2cvL1oSIDQBTHhepixQAsCSgbIGZ/t4jcoxos3l6AkBWajT0wNTD0aB/ppY+uDxSHzWX2c6LqzzMYz0SQJtQf5SevBETQKUPhjcjRggBUEEFkHXiBDpARpq22FBMXpcMCP3p2jz4pVUFiR3cmYzlDgHNmb/ovWAjae8nS3w8vAQASMXqjxrlxgAgQMAn6d6nkATgOpzWe0/b4e/TcUlJJRYGkMACAAZwitP/4kVO/oICieMGwAGQYWypLS2tLf230tJ/+wpeihMnTpz9drlfZDQrdRmf0wmkLd8dIlrBSct1qTQEALjqAABqYz4Z8wWptVAJZOUb8zOxIgP9aVse+fbyNYKF3aKuvlDQFvFtIaO9kABhzw8eIWj4YErqkVQo+U9ADZCeVqxFAFQxKlV6epoqMU+jzctIGWMGwBBRY++FM1vdwQ3s+3MAOOMEgCu7vNndTQTA3ac//nivvf3+D1dK4pJA/GdJcSVJ5gDEswAwAcCK/gUSuxmADQDya29Amlb7zUGdrrgU+n9p6ZkzWUeW+93ghGf/vrp3N69t+dW5PuJzdeDn9ZaGWgfAe6p45GCEmhlzwX6Wl09MGM0/LyNDo9VSACIj3xUs7TbL9cSN1X+hCAEhACLtsaEdTI1hhgDzjXkZORot8wrl6eHVIe+lq8aIk7ghoqv/qBVQ/T3oCj8fgf7+Id6s+kNHuWJz45tgEEglL/nx2Y9X4kquXP4BokHJlbtJkBXa0p8zgFP2AbBcEVqcZw2A2vz8wnPnbj/5N/jp02pL87958uTMmTMvXiwfriwzz+j3rlnzvkDdd/3F5+r4ePt4QwjYa0kAD8BUUop7j0jLJ5N++fic8vIzM7Oy8jJIz8d/4/MD/YPeXSta272Zcf9FFgAs5B4xswDi/MG8/oOhCQCAEEAIMBozY9RpaRq1WlvLNL0qEbxAIQZgyFBXVzEBOLknqOroIiay1dEfah43ZhHgUHP5hQT4lNy7/+OPl+8mXYZa4Aquynp2+d4P98wCgMAADp3iALjoAADF9gE4bYCftvnFk2+evHjybzgGfgVa+JXO45GjPTdeM8vm9q4JERKwO9QnlFnPi8DPXbPzatlVSwCuUgCo9rSNUJ7IOoFuww66GNn3GGfIxAU5CqUYAGa4X6C3oM00b0z/F1j/YNr4EKBKPRJ95MgRiEUAQI46JydNUwsBsRTe6FWkKYQAUB1pg6SP3IVEZvfdrazs8yKrmOkaMFe7AMSW3APt74PoPzy7f//+Dz/8gMmgCID4eFsACPW3CoDgEjmrIcBorNWdP1+o+7fa1pba+1fOPPnmypV74X5xX/5baeTwILnYBa7u3bJASACEAX8ifuhczhvIMk/h18C/Fkw1W447dYTqOBJQV1vHtCc4CtncTKeHs0AYJEApXOINIrMALGTGeGfabmwGwHs/aj9oEKs/BeAIWQUEAORB7o8AaMEEl2fVltbmx8SAA4hyABeBhhjyGTdwZW7cEqzp8HZzceZcY4gVAxBUAW5uytMlCMDTe1AM3v3hGbwP9cBTcQAQ6s8DIDCAAusAiG4RtArAlSvgAMV6wzf3rtx7cK82v/TJV/9WutzPLzz8Sml+9HDPjeXlYgIEUQC0XSMSX0iA6AiXBSERIaIpmalT01F/aI2NLaSB+vi2DpgoxQn6SD+wgM1C/ReIuzyO71gKHxEizgCDBfoPgjZYmAOoog8fPno0KzNTn66B0gpeFD0BwFhaa0hPTAMH8HVilHR2chZISHI+N0IAzlOK+r63m3D0j64AEQIgGgNwc5NvSrp8Je5yScmzH0gl0P703t27V0qgClhnBQCB/qcu2gZAp9Prdeb6Wx0G0NwFx/nhRzSet6PPGMgsCM7GYwsvPeI3esCYXUIEru59fwsnN7h92e7dVgp/s3b9+p4F0ywm5TLPlup01dAasRmq4ZfB0FhXXV2Tf/YIKOPnBw7AR3+y1JNx+whBlccqP4P+NT8oRFT+BYv1H0S7PikJp06NOoyHQgAAeRlpajWU2hACSjE7MdYa0P8VJAegVx4K9ihSDREAKqxQf8hzRLU/TROGcgSI5feangTSJ1354W7J5SvP7t17+uzeD/effn+3JOkH5bp1Yv3NAUD5xfpTAHRM0zsGwJV7P/6IDNy79+XbXxL54dfy4YQAv+XDM5aPHjByr5CAq3ve33uVB8B6E8t/fd/1fQumLRCtzwmZNjfzLAJQU1NXzTSjwViN/0rOOhF99Ogyv2VKXOHNp38sAWZVPhF+ehC06WNkbyQFBY0ZM4ZgwOpPQ/8gxgAEo0KQjno5v5KcCWV/mjpXrU7L0dQatRl5+YZSQ3p6DJMDkKWgzlIqn0BFFgB4lx5xwCS64rwRm8tQVzoC7C4EwM1HGRf3Y9LlH+5dSSq5+xQkePbj5Wf3L9+9eznufsc6HoB4kQGwAFy0AoBO1Mz0twHAXUhB7yMAZ46cYdZnGqOp/n5Bw1drl0YO9wy7aq4tF977JADkJ23hNDIoj7/pQr1pCwpzc4tQ+KKiIl1xsU6nNdQAAEZjVPTx6KPLlo32GwOJtDdZ40/Lf54A0UAfIDDjA7qDIegD8ldceAhJAIL51I/LAEnnD2YQGCF1co5MhgIkTQ01QE6Ops6ozzMYjLV5KhUBgL3y1Jm5SsWN2eTujSywBiCucc0BGMr2frH+XmGbkpKSSi7fv1Jy5R5Y8NNnPzy7d/kHUgVAGmjTABwHQFfcdwqgaa4FAH58Ulr7w5Uvr9Qa8vIMefnG5QwAy6OClg4IKo0eMGy+mbh9AcBlAlR+cIHr24X5Ou2f8UUkBsAzZSxAhw5giIqMPn4UZ4lxHN6JELCVJSDC0gEIAh+Ery5Jiovb9EFJXFwJQOAt1p9P/oQWMGIwrtSOTM2HFyQNUsAcrRYHJDIys/IzQPzAQKYMRP3NZfbmA4Lo4RBv0dC/K6++aPzXLTBpU9KmK0mX75dc+eHe0/uXr5T8cBc6/93L9y5DGXj5rrkBIAFC/SkBIv3tA6C1DsA//vGPF//P//Pk2ydPSr/8ptZIV0KcZS1g+ZmMyCB9xtIxAzx3CcXtIwTQT7i6Z0uEt/e+7ewY3VROjhHB1JKlCUXYml+8eNHeDm+MBTqdwVAc5BcZ/cUysIBXpGi/IdjvufEfQeo/jedgxp9KkpLCw5M2fXoxDlcxhnub9X+a+QUL9Q8eLMUjTJ0jswwQApRpkAZo36YrwSPBFRRSV3KGk9k+sIHQBokAEOvPAUDGDYdyyZ/ZDBDk/kn3oOPfw8L/CmT+T9tBfCgG7t774el98AUOgPh4zgFEAFgawEsB8Ouv//hH85PaWqMhP/ovzf/45W/fQvvbL18BApF+y+H3magxY0YeiBk9IIBPBdLWi0KBFflB/LkhuBPUKWQEvFz+oaG4wiX2w0PwvHUPHz0iiV9XgBTdvwhrQNKMuTpDta4oyM9v2dJhw4bQ66adXBAAfrCPG+2fgcqzKd+nEAKSkuL0BZfiSAjwDqb6Y+B3c6MEBIsnBUeAupjdR6bmpWliVOAA6rQUXB7+dnJ05JEUySZTe3t7S3OtEZIpjSZxk0qllE+fHiCTuUoGCQAwNwZa/pMrsxEAYeLoxif/bqpNuArgypWnP17GcZ97d9vB/38mx/WQJjQAqw5gaQDmADgSATT/+PVFs7FOr4eCLDW19AXw8Ldv4dff/vbVkUi/L0+/Hf2XrKwoz8D5mgzPYfK916+X6b4ru6aPCmTu5RYP+DDil20J8fYeQcd8oQdd6O7q7jWZt97eXlOL1K2osKioDqkrBROqKyouMhQXjxkTOXoIqb9oDea9UEgAC8D01UGrQemRFIA/lUA2XfKgWl8QF5cUtzrci+g/wlsxxjNQsXRMoHzMiGBrAIDHRGXmaXLSwP81uVoEIIpsB5AONdlqHS42AGALQIz8ZE/zULP6n1EfjCLiUxAf0/4rd3+4cgWiQMn9u7gz++dWekrLs3V96C/KAV4egJwXv/YAAEZjXXPdkdSzpU9egCP84x+/QPvHL8e/DI/78i9HjhzxHDMm9vbtyOGvKK+W3bxx49wlfdA5VcB1QsBVAQBM3lfGqA8NXFaSY+rp7iENRO/t7iVvsZk6tG5ukAnW/e3Jt9/C935SpysuKi7QBgVFDh/C7cSDFsIN+NMMYBEC8AEG+5Lw0aP9cd7/U5C/BCsfAkASAEBMf12iQqFSjFElJgaxBsDNDwwmh/RJnVOM2hgAgLwcKrIn0C/y8FDft029pl5B62Fbb7tUAAAnvotUmPnRTe2iASAvigBECeT545LLkPE9/fHKFXD+krv3nz7FTdq4V/fp9/cFDhDvQApgHYBiRyJATl1Le7PR2NxcZzAewRGQJy/af+359R/w9tcXv+YvDw//MtxvuafzmKAxvrF5Y4JilGXlN84nalO+Kwjayx7ca1H6h7AAjEAAPjSBAfRa60o9RqO7l666+Ze/4QjgkxfGnFz4dUwRFTSAWYNDX1FphMgCFlIAoM+D0uHhMgQgCdevw7+TklZjGRDuRRO+7ERI5hWKtJjEIG92pSCXADJnoWdoYyAEKHPScPAv0m+0H/weFvjFaavPGXzLhACMEAIgEJ8BwIUDQNT9QfwIJhX+OKkE0v8r965AAnD3h/v3n/7889PW1vYO/Z9qSx7c+OnZel5/qykAIcAeAMWOAVBT01hXWwcA1NVlRR+BFLAZPOHX9hZIyZpbzuAGOXg1xwx7ZbhfkGeQ5mGR58h15eezCxNu3I5ae3XL3C3WDm++PpUBYMQINwAglryS0Os7obU1NTU9xlbVCQ9qYtUSN3WjMTc7+9Sl3CJdLhSGObm+CAC+eC4uDAKDhVN+i2gKgPn+3SRI+EKnTZ8fkYQEbEparUratBoR8KaT/gUxCEBOWqImSBwABnN3NLipVGlaTU6MFlwgTRW5DOQf4Ox8NLIUnl/nnTt3quDJNjU9hwZPnzDxAgEYwelvueyH6/9mw/9UfFrKfvDBB5eh/LtCFoM+hfbz09onzS+aS1/U3vju50c/WwJwyBKAiy8JgEYMgFGnqzYaao5ER2UaS5tb2jt+fQEAtLxoPosAAAF+fp7Dxiz3G730UVGuyjPswqGK8pu3jvjuXeMWsmev5YHu19EBRtADgdxcJEoEoJPZNMgcEnir8lYTPJwYEBYoGxhbfeHChcLCwiKdNldblKvxDfIcPoS8ZK4sAd7CmX8WgJKSuwBB0twJq+MiVkOLC4c3mzbFxQWFhw+G/H/E4JCiROjcAIBcI7cJgCJGk67VHNNoIA9IiXzttdFOLu6BgYEt8Pwem+W3N+8gAC3SwQwABHQXy3Vf5u7PtAX8aObCD5JI/798+cp9XAwGrfTs3540/+3sk/wbt58+eLBerP9HFgD0kQOY6V9gXX9NTjVU3nUGXbXOYMyIysg0GIwEAKzMmp+cXf52UPTh6LfDg8Z4DvMMilz6UKc8+F3ChTHy87duZozZs3fLgj1Xr+JxbcJxv+vXuRCATRJGAUDVuWvpK6sqAYBu4qp6ibwYen91UbUBnmeRVqtQDPMcxR4NRi6bcBokXPuBQ/6vv46FH5R+cfoPYj+9+MHquE1xOA6wGkdXwleHj/H0HCMb7F2UyMzqxWAICAkWA+ACBcIgN0VaWjp0f5wNyMkAB3CS9bBZ6mOO2JsUgCr8SLMUa4rBboPpmVdScwCkVtTHfRPezLZ1BgAs+UF9ov+DB7getxRnw86W3v/++9vfmwHQbwcw07+gwLoB5FTrauqMddW6PJ1BA14Yk2esa+mAHIDMy53wizxy5ATZKBce5Dls6au6h/LAg98VBinGKG58pyTn9ZHJHnhPoP/1EFIQ0yNYQgYFEAAqK2/tX7J//xJss6FN3l/V2Y1RoQMICMzMzMe1AEU52bk5Cb6KYcOGenOvHL7Ag5nSnxLwAXTzEgz6IHZBgR4nPqDn42IaPDYFigDwAqRDGarD8RyVHDJBHCpWBI1hM0EsAQaREQK3mJg0bV5OTIz6mComJTl6iPRXkvDBk2vYPxmf6mzypJfsL7t1iwBQKxnMLC2wGPlzIqujraiPzXsh3a9MitkPLpdgCAD57yfd/eGB4Sy84Gf/9u3ZrNK/fP+9/uKfhAB8hO2QHQAu9QFAgQgAof45uuoaXJ6nMxQb9DGKdG0xFAStvzbXVTcDit8u91tOzsg4HH06DmzgVd+EhPOFhbeDProGmfWBPZz7UwJQ+317ti5cAMpzZ/BMHSTDF60TOv3sicK2/9ZjE+jfDXgEOQctO5yamQkMFOiKCsBtPEcJhtukPAAziQFAL8cEEBVPgp+uuPh2wWp8fxMBYBPIH746OyG36NLFIoBalZaYlhYTBAisXh3E5IEIwCAKwAhVTHpePi4CyolJSzk8zPmICRwA6hRT1a0l4mdcefMx/iwGCZ1hGEEcYLBYfWvWzxx0x06IsgCU3H3w/d3793+AHv9D6V8RgLMnjmf9z/xt295ctGg9p78YgGw7FsADQAbYioqLyR/6QRsAkBCAKWAz/MpLz8jMNza2tL+oq/4bpOXf4sIsPz+/I0eOn8EkK2iMIkF9+/ZthbLs2qmgoMC91/ex8R8Q2Ldnz+YFEez+G84BBruRHLDqTtWSiZPYNnESvJx3mnrJCEHH8mWvDH9t2eEM0B/KwIIxQzgAKAJSp0Gimd9NqDbp/0lJ+oc4j3ApPI4SAAhABFgdtCk2NhsyyiKVPEYNXTwGAIBHg8bwgwDs2gDvmPS0jHzUPydGnTJkyLLjTMLfdNMqAL2mYolgbRmbAjhLXaynfvyIYYQIgNNXfvj+0vd3f/j++wcPftB/dRbbV8dTU79OXIxtfexGFoCP7AAgIkDCay9o7DCRVf1znj/vqKlubO/owDn5jpba/Pz8utaOXyACfAsA0GO0/f79yb/98kMcaYkqRW6R6vzNG9/l3AhSxO/Zx7gAjvhHTJ1qeQ5fyAiXDgJAJQsAeTERgMrKxw1NUAz0Bi1b5jTgtdcik6uLdcVFWjye11045u7iNCh4GjP6SwBAB0iirRh/6NuXVsfFrSYAwB94P2h14YVTBfDTp6nUUARCLQBRQKVazYaA4BE4MRiMw4Xeaek4+J+fn5mZkTFqyNGjX6FhQa1yywKAKshcAQCNCABy+h9/6ZtN/XkAkIGZn37zqf7upx9DHlvywxsffJZ3tvTsibN/TY1O/SJn8eJFFIB4KwCcsg7AJRYAm/rbAKD1eWdjTWPj8+c11e0dwEH7i+ball//0fzkb0+ePCmNwgMT/Pz+0tP+65M4PDAK3FWlUKvk578rVF04+FnU/H3MQR0IgKDv41wrGRj3hr7Wjv2p6lbVfjMAyGnTj+EVDRjm6SwZMHr0clwTZjAEeXpCDsCvIHUbLB00Ipgs6R40CBd+o/AlJACUJBXcfviw6HYB2Ht40qdgCIZLQfA0V2sKLxYUAQFg62lY4acFKVQK1SYEgA4SMwODwcHeMRns3uCsoRJPzyGnIQQ8LsOKxQyAsqoqAkCiEIAR5P4fgf62AeD3Ks1cOPPjT//0p5KPP757r6Tk05kLFx36Gvz/zNupqanHD02LmDnr4/UbN26Mt+8AoiyArAksKrKt/yWr+uc8anzeiCPzrTV5NS0dHd2Q/HS2t7fU1D0p/eWXUkVK1OHDkZHHe37tab+ShKcHhwcBAmmBvoW3VReidh38w3burBYEYKpg+2VIBGQCKOCgFisAYH+CcqCSpFUtDyCRi33lteV0X+7y4SIAvMmQPo3XgySDZs6IIACU4EY+vb7g9u0iAIDYE9i/tliDGUD46qKLFwsKinT4U2IOpFGoTimCVGNIp6cTUnS5aPDUtExcFppvNGaOisXdgWhYVVio3qw0B6CSALDJHADnvv2fBQAJ4EIZFDZbP94M78yaceGrrOgvS/yOAABZq5cnXjBu5AD4yD4AAg+wBgBHwKVL1vTPqa5phDTgUWNNjaG6Dpygs+N5a0tjY01d6beQlUSlRKVmHYk+8u//b/tfvvzyxTd4blx4UNCmxJyYbNWNmF2qMHow11aCQIhgpQVku1s3AwHwj4EPEIDHtyr38zkAYLDk5ieffLJ//00MAqSFDcANQvmlpctHmwMwYvAgZlpXIhkxIwI3TiTpa4zg2gYdAaA4DhxgDNSCWl1GECSEqzcVwQsCKVCaKkerK47SFFzKyUnEEMDqTwAgEKABGHGP8FA5HewzNd2BJ4YNgxa6FQNAZWWbCewhVhQCBtML4OgVm+SaTRuN2bNoZSXjjI3vqKKXn7l35UtcKJuvrzWU1m40dwCGgGxzAgQmYMcB8MPW9M+pqa7BVTk1NdUaKAjrGjs6wA7gX804O1eqUKVkpkRlZf3l3//9yy+//I///K+vvgzCZRdBq8d4+sbH7E5cxR3KuXUrAwBaAK12t24Nwd24A4vNAJhM2vhx48ePGzdu/K2qXsy6e3oTJVG4Rh8AeM3Pc6hYf9YCSEk4FeRPKsH1a5nJyQ/x6vPbBfCsRkql8jht3umg8KDV4ZsKT13Ejo+D/GmJkUGX4AdOzFEFUgBG8PoHK0+AAeQnH472lGjgWWD6f3Pf5PGkTZxMni9DwE0GAOVAIQAjnJzZEIDd3IU/3FjQ+b2ncptWzcTHUY11R774IvVEc8vpL//2pPR00vSwueeKbQEgsgAzAiR29UcCNJYAgAEgA9W6dK0eAOjsQP1rqp98+y0QkJKRosjIjIrKKv32l//49j++/pcvvkgOWo4EjPH19FTEXlrJH8W4cCtKH8GfzYVz+FARRgzUkJz6VuUnE2kBIAJgVmVlJ+13GidpYBYuyFt+ZPlrMrqVCF9gZkUfAcAFD+kbHKpMSvzgQ2Pt6TP5y3WEgOLw8Ffc21USpT7zNFkZtLrwZOHtooJElTpNnaZJCcJF1IkqVQAoHuo/mJc/OIwmAMmHhzg5a0gBCOl/2RQKwHgxAFX4VHtM0wUAgLT0AkAXqnKIlD/enBN/mmARo0Xvj4jNyPrLmTNPcSVo3OnTJM/alKi3CAEcALYJkNhOACgAmlwN/sY3jP451Y011UWQPFYXq7R6QKHjeQ0aQPWTv/0CISBZkZKpUGWmZDb/7X/++us/fvnr14cjj2QtBxcIwntRPQN9Q0MiFkSwA1z8qYwcAVsXLhy0CUeCAIAyMwfA/g8AgAXQEcGhyS6BuCItMvX4aM9pdC8Zv6aT/D10wBhP50GDg2M/+ABH/EaHh+tpORD3Co7fbZKooDzEisB3bFiYMicuCDI/lTxQNSbn4ia1KjYUDUCpGMzrPzU5NRW3piUPcY501uK0lamp6uZ1IQCTeQCqCACBYgAGs+KTRieYePFDuC3qVuSfMeN1kH/TB1eCgkD8y1dWJz29fzdJ3/jwTwabDmCHAInN8E9bLm0a+MPqn6NDtaH/11Snp2uLDXXtz8EB4N8YAkpLg6KiMlLgNcwo/Tr6xC//aH/xS/ToyMORy5cHBYH+cmTAwz+EHd/cLECAfQwQGBzLAHDTzAEQgPHj8aaJ53SE1TdQIjM2Nx85ftxvtCc5yI2u4CEIkDcj/TC+J50uuXwvCeeCw3EBO+Z/QwNNvRBKNE5BdIQwaAy4FCQDkPzHxEABEPOhXD7Ge0SwXKFKV8lTQnkAjqSC/hkjJcM8JQYAoO1xZWXZvlk8AJNZACYBAN3oELKBVPowmTdZd+ItXGfqIqXXI9GeT5ZBMgSQd2fO5HOAGTPXbfryeOIHm06fiYv75pv796/gM9Gvzkj808fEARyxACEBEnv+z+lPGgdAK3V8ne6SIi1PV1z9vBX/XVNDTvArfTs5KiozQ5UCABxO/er419/+40xktN+yyMjlCEAg/vbw8JTNJWLzR3RyZ3Ti+P32YDkC0AYATDLPAcZTAAABqAZ7EpVKuatrojH6+F/8/EbL0AMgVk/DYz1GeKtilapNqk0lJSXfXMbdS7VnwP/9wv1GDx+++shqqRwnans7THrpdCgBcE0A4eCKQkVmebUZqsRNq72Cg2PlwYcU/kpvFoAQPCTmhEoaqFJt2tRu6n6MkxVl+3gHmMwDcKuKjASbvAaO8Jk+Xa5UjhkzxjcwwHyZiYs45lMAcP6CSL8m43W2BojN+MtXGbGb4p59c+btL0u/TIo7DVaG5z9f0lfbAUCcBXAIXLQAQCy/SH8egO7u7mpclqUrCFTEFOsgBDSSGFD6y9++PnH8xIkTyW+npGRk5H8bHZmKN2skK6KiwAMi8zMVvgpoaAKeY4aFRPDbNngPwDJn0fYJdDIAQwB9IUUhYDy9gqyKnXBPdM3383vbL3J0wMxpzDkv8zTvTH3nMjQU/t4ViJWnr+AO1tRIvzi/0aOH+0U6qUw9uHyju8dU6/KKXzgFIKnkdIkCHCAtUVOshdd19ZgAL7nK+5DCO4wDYGpmampW6kg9893byFTVreuTWQBIY573zUoSrHrcBk9H/WOV0xVBCsV0oQFMnTZ1BHnS3ElV0yLYwm/hzIiV78SGaOi/Xld/+XX+JuX81XF3849/eYauZyDt+0cPHjys3sgT8JF9C+AR4AEohCaW34b+OBJYXfRQhw4QE6PVVrc+JxFAl2Gs+9v//Prrr/7jH9/mpyhU+WcjI6OPREdHJquighRjIiObm0vzM0B+xauvDhimGPBKiGCiS7BncysC4I8AdN+5c+cm1n37mSmBSePhDbzGZKJl1rbHz0242qbHJPONHD3a7+3RoewerzX5+dnT1n9z5QrV/4dvTp8+feYInu0W6bfaDwlwSjR1dmP+3gsR+oXbK+E0LJwmAGBTaQEATUZQukqhGKOI8vaXcUkAFIFZChnzvTuXkImfWbPGiwYAlpTt319WBlUgwbRdOoJc5RYbK49VKZXcShNcamJ2JMU0YeUX8XqsOjF7lzZxwYzXEzVnjqfNWx2nTVldUnv2DE5r4LZgHBcs+f4BtEd2ALBCAGVAIpCfbX3on9PY2gpyQxpYpFLFaIurG1tpUgDvG2tf/PKf//ELLtdJyQDrX556PDkyOSoDKoOoqOb25vb22gwFAuAZ6DkMCODiPt3Dx+7l3jrDm0z7Pr5TRRs7usKkViQSjJt16xZJBXtMASM9h1MASNKEACRMm/DONyX3vvmm9i/f/ADe/+WXZFd31vLRy/GWFycN0b/XhAR0m164vkL2BkBKnXQ6CEI+7vFR4YKBoJg03PIb5BXGA5Camhw1JsBEZoDbqqbgMwJvGi98hhP3VzAz2ThsCQAEk6vcAAB5rHxMUIhIbeYdMQEEgLR1MyLitRcunv7oUP5XH27MmLryzGm1LK629ErJ3bi4KyVXzt7/4f7d2rvfN4L+jRt5Aj6ytAArBAADkkIr7dKlQjP5hfrnND5qxQ6vKypSxEASQACAlABSwjyDobm29h+4Pqzj15b8qORkcna+IipFkZmSAvK3N794YVS9+uqrnnN8PYd5sfUf1Z4jAAAY3EEBoI0HgL6+1GuX3KIzbVBkKcY4DYcggABgnjzhdWPO3HXab8i+XaiXzmYdJ5u6IQc4sny5n98AqR78H0JZ10dNvZ3gA6Zf3Z1wtGL1228nffk2JIDp2rwMbRJUWKshI4CIEOUbIKPTAMHB3snJIxWRBIDehluVs4n+OALAP0GcuGTuS3yMmUbzwKn8xk1lrFwEwFSzhYeC3D/njYicvEMzTp42XjyUse6DzDStNlsZhAcCwO+/fANOgPvSS2sf1DU2NjZbBeCgfQKsAoDtom0AcCQQc4CiS9BLitEBGklOqEjPyMOzsl6YOjvaWxob8zzHKMAEoiMVigx4TRW1L5qbU48ciV7q6wsAzBnr60PGANggsEi4gGdQI+8AAMB+DoBJnAMgAJVtoF+PSRUY6eTkl+wJOfSaiIg33ll3Kv/M6W+OZ+GRwuRQT/IXVIv5+UcOZ30VJDWYOnCJadM8iXdjbye+2xPgFImXPkYfOZKfl6FKz8jMy8jMzMzHdQxysIQoRaBcoZAroqAYiHIeEu0JAPS2VVXeqlxCuj8FQDBqTa/KZAAwAAB4Zg84AO7hlk/ltbY8jIwDYNq0BO2pXWtOHSw2XJy27kxivnqVVnP6Ci5mhsD2byfOluafufJN/hXj6ZKausbmJ+vtWQASkO0wABAcqPCn4FcufJ4QgBpI+TAA6IogVGq01XXPQX4gIhDKJTwlpbm3o7Wlsa5Oq1B4KqJw035KRqZCFYX7R5KTjxyOVKxapdTm5QXJQhYIAEAG6Lk9ixbNGlRDRoKsADBJAMAtzL/aek21ctlIF6elkTHZmryMLM3FM/kGw5UrZ44fP06P7sWTZKB2zzfkG7IOR49xbwH/7+rqavCXjBs3+JGpq6u7q9s0fQg57PlIar5Bj8f9ZSZji4KSFn4wVRQUgkei3s44AonsEJdARcAm0v2hLUFDog5A5qzNAGhCAPQD5ytpCMB9AnL59AB/Mv1hpj/hgd+7tDIl88CMNYkFHx8oKFiXUKpM1CaRlO8epLT5Z5JPwM92piS/9HT+FT1E4NJ86wAcFHiAJQK2HODUKZQ9l/s8IQCPiAMUFeqqwQHStdU1rTUkJ8AcX5uu0Rg721H/ao0nABDoGYRVQAY4AI5ZH0lOTT7+1dn8/G9Lzy7zG+4bwhzQLMgAqQNUY+h8XkUBqBQCMEkQAnDVIC4UhIKwR+PkdyRfr83P1+RCXz/zzTfQ8Y8fxzOdUrPOnj1xAo91AwRSPd1fQOTvamur8paMGz8JCOhq68JUQDlseXQy2IWxrq7GoM/MxDtBjkQGRUVFYUIAv6G4TUk+fHiY0tSByUc3vQR9CZP9jzefBKDtOZ0NlgMAJACQZFARFBQkn8odRhPM7D8w27y2JiLho0PFxR/N2HVR905sfmJSSVLJvXv3vsnP/yYLnlxWfv7Z/Lu4t+F0Mbz8taUsABvNABARkO0QAOac5JiFAJL0VddU56Vr0nQ1rSQj0JHcGZCo7iRzQ9V5Y6Dkw6y/OSMKPhCFu8hxG/8JnDgGGJZH+o0OWWBuAUT/RQMLSB1YZcUBJk2C/oamu6SKdLE2TANw6bWLU2SmVsvcH/IXPLz77Fl8F94a8QgPPMrVWOor60D9u7oqB0P/Hz9p0rhBt7swCnSaVCPJ8a9AitFYk5mckZqRnxEdGZkcGRVFAACOM5KTPaUvcPUPZADkNtz6fezw1CThxCULAB0HShyI3Z8e4CCHchBSQdV00WFU4gyQBAEgIPHits0bP9p88JJBexpns0rg52g+Sw6rjns7C4/KwoBQcgYHZOtEAFglwAoCVgG4cMouAI8g62sklwVA9G80QBYI315XXQOvkS++TsbO1tY6QETrixsswBZ+bX8C9Z8CZ8+BgOVHmum1H7h2aA4d5zI7v2vmrIGJZGE4zQKrqm7S4po67CTGAWZt24bTb5WPH5NRwR7ZMOfD+dpMOlEPeV9GTJ42TZNnxOiPx0npjXq9USbrQfXbuu4MGjiOADBp/MBCzAO6Okyb3PPqjMa8jIwMfU0eHj+ZnxIduSzyMK5xUYyBOJCuTfaUuNP0v6mKmf7jHIA08jwnTSqrIpdl33pM5izUA/kckDgBACBnOz9/ClWwAICZEeqEdTmn3syGNODSJf2lTy+B0vk49YfTX2dOx8Vl4c7806fhgbMGnaEaAOAI2CgEwJIAAQSWAFzAZheA562NkPPXNJKLg54/ZwaCISCA/OgAxm7gAh4BAMaoQHjFi/YX7b8+weN14RlnJZ9o/hshAArEI0eilBHTZq5ZYAbA4oFkMsDUSRfXdzeRzlb1iagaHEfaZFx6i3NDve7DnCWKzIxMcnh/fv5XGTF4hGNeRkpGjDY9ndQoevcAUy/R/zbRfxwZuR8/8EJ3JzzaaUp0ycjHXb6qjLo8egJZ6uHDkYcPR2clB2EsSFFJXQPJmnVTZfk+5jkwyjMYlJFLMm42dLa1NTW1tZFnZlIOIvGfUADdXw5/EQcA9QUIBNOkgAHg9cSN0w6d+vik5tAfL3568dMSvcFA9+Ljybhn8kveTs0ix+aBy5UacJW+UQSAGQGWCFAIJNbkBwDMEMgWAtD66JGuCDo9Lgrq7Oh83kprAsgBAhUpqowYfWcjGIChutg3kIz8qdp/RQL+IysrMwM6fmrWE3rzD2Zcf/36ODx6XDGT2cDBtMWDlb09gs01Teimd6puCqvB8RSAKQgAhgHT0we1m6RRyNmJVEj/UpNT0kF4TXoaaJ8eE5OeYchzlZsg34P4f2Mg0X8cGbcDAk52t0Eq2GPSSlX5UUHwpDOwaTNS/CKTk1OPHk0F9SEjjJLGQrqB0z+9lRU2AKB3ZzcxW4JMZL5BPigWAYglnR8DQKxcIQ+mm5GDmSNJgoMFs7+4e1l98WBuwbk3NElJl8AC9HoDKF2LWQyGgBNfQrZ6trS5HY/Iqaupq6mpa1nvEAEiBrIl1uQ3NwH6qXwIeFRdmFOE1R8iAKEAaoIaQFClwjQwQ2sgI4M1NQYyoga1YB3E39KsE3/7Nj+r9EVzFgcAZDJnT2QdP/H118kxq1auI8GfBUBOV9kLAagUADCJA2B2OQMA+WTlyNQjqcfPQqqRdTxZlZKRDqWpId9oAAOIychwiTUR/287JyH+P34cM3A7fqAaXAGlMrgookjeh9MZGRlRo/E6yNF+eBtUanKqTNrTDdECB5BuEQDG2wPARLYHdkMWIBtERwDAAuKxDsBScDrp+mTKEhcb8SNAbBBIfGPaKf2nn0LsLyArmfIy841PIZFNzU9OPYEv4JPmOsMjMjHT2NgCMVkIgDgIEAIECByyBsAFs2amPxJAIEh4+LCoMFerq8GFgW3PW0kEwDRQBeWyQhWjMrQ21hnwWFfkAaEgB7ll5Tc/aX4CT7r07FkGgMNHsr7GVc0nwAdOHP8iduHmjesYAGZMvdBCB3kEAFTeFFaDFIDxU/BUsiaoBXt74NcmiadfUBBO5EAfS4lJAeHxaMHMlPSYFIV0E0n/2rpY/QGAKVOmEBMYGNvV2dXd222qdfWMSknJrDYYMoCDyNFIwIDhh7GcPezp5NtOt32auipsOcAtBgDElyDc+Wj+oPlcChAfy4SBsGBu1cqIYPMCgADwwZ8uXfz000uXqvX6PDweEcLTs1oIAeD9kNM2N9fpcnN1D6trHlbTjGy9HQIoAkIGDokBuGBLf6FfEP0TGh8VFeVoi/GwnkbMADAj0F3KLVJ4puThzKkW1c/PzMjLz1SpAj0VCEBmRkY+nit//Hhzc3MpHvD25Mn/PB6djNd/HT/77VeYH0Bd+/WRRYtn4TjA4sUzFv7xI00tYwKPaVFdJiwGGAAmTV5SVtYA4bYTR+Y34ZXcTiNzlN7er4wB/VPScTgnIxO6c6BEQ8r/trYDqD+p3QkAhIDJ45TgDVAL9La4jsyISr9UbEhRpCAAA0YPHzA6MnIAXvi4dEwH7lXubGpoKK/YLwQAno8AAKb8B4BV8ukhb4SGKbkV+6j/RsBAHsAtW7Kqf8QbGjR+3L6MWxC0xcV5mRn5T8kKyFoif3V1bm4B9r2iInDjOnMArBMgZuDQIYlV8XkCssXt0KGEhITWxqKitDSyLKDmeStOBOJsAjoAHpIVo9IbAQEITKVGeKKQBAblG/PgyWeS5P/sk+ZmHKAtTT3+P598m4X9/8SJr3C0Duq3s6VZ+ad2fXziPYRg65YDI9wZCwAAsBq4aQ2ASZOW3MT9o01dJgTgFScnJ89ExSueA4JSMASkZ6CVq0B/rakN5W9bR/Wn43dTeAIC4MPQetvdh0TFwCueDoWfEAAnibOzSyvO/zc0NNRXlE1mE1H6hCwAoLNAg6eGrKMlQHx8QrxaHR+7bt369bHx60KFBmAxBjDz05KkS5D4gfdnIgC4VRMAaDHml5IdGeSYLO2xY/C6P9TpHjVWG2qq19sngENACIHkgu1mrv8hqn8C5IDVOWmQBeh0Nc/JasCiolzMAUjGp4rJM2j0hmqjoaUdnmdzszEFN3HBk2+HCGA8pyOHfKKRHS8tPY7txPGvUlMBgxOkePv6RP5fczYvmrVo64HCjW5MFmAGgNBySUGI2/D23YRg215bW5oo9YwaDkbAApABCGT6SvWmTqL/Sgm1fwQAigiegIH+bRAeoBbo8BqSkYtH/6akRI0eTS4miYwc7iRHNXpMvQ379u3ft2QJ/+2Fz2cScxtmA12z1uL2xryp78TGrotdjwCo1RCaQP/174Tw/Z9dby42gE8//bQAR64Mem2eoRjPR85LzcRrishBiZhkgfZpubio/yHu1YOka31fBAgZYCiwB4BF76f6JzyqqdEdOwYWAAy2tj4i48C4REyD4wAqRXqeHtLuvGJDc0dzSnod+EK+AQqqlPy/lea/v3VrIWYE8Cc6C5K1s18c/fwLhCCVgEAG7CBF+PbbvEO7DgJIru1MDkDGhB8/LoO6e9++SczA20SuFiD78XY0MSmjyslvgPOwZZGqGJQfr/EwBkrrqP5Nc1n9kYCB4yYLCBjn09RFhoV7ZO7F2vQUyAEIAMQBnN2Y3f6myimkcmA6P6/97H37ysr2k32stP6Hz60epJw+Yurcd9a9s279/Fi1Wq1QgBXMmzpiMKP/CJIKMkOBQgDQ//Py8g16PSQxBq0GCMjUGvI0uUU6XIMLvU+rqy7OKcK9TLk1oEn1IwsArCEg5sAeAJbyU/0TcB5QHXNMjQS0NlYXk0XCuF2sOg+zQBWIHZMO/cdYZ1SpDBmAhLHRmJehKSoq3Lp10W7maF8orlNTvzjxxeGjn39+NDoVB21TT5w9cZamiN9+/fVXX32d5dpCX3UIzZigNeGLW1EuBGAckwoCAPsaaN7da5AMG+Dk/FpkDDiAFsJRnkEmbaH6N4QK9B84EAHgCJg0aZxXI4kC3aYwD22aCpPA1yAADB8+/C1PyRgygQiWVDUbPn3SRB4AxgiWkFvyqhoIZ8yqVYPval960FRoiHdsrDpeoQiZGhIsOPuKbjsRWcCEGQAA6A5RP1+fkZdJL8owGNLBBTQFRToyFItdrlitTsjO1eUWPaqGOPBwneMEcM1RAAT6JxQ9hCQwN+dYbjEkgljy49mtjY1GA57gqNcq8HyNlAxtep4RelFNHjBhqIG88By5qGHRLlzFm5mfefitw4exwF6wcM2q5ONHjwIEWbie6GwpUyT85fi/nZHWmgS1gOkxrQUm8UPvLAATgYB9VU30NAYDnhQ14LVICEfgAPDSyVxauqn+3mL9CQAcAkCAG04MIAFyN8xoSBWAMeBV5wFBZI0KaFs1ezIX/scLCNhXzwDQ3d3LbhY3jFk+ZrB3bJjbiMEDvdWxyliFInjwYMEh1IJTiLje/87rEyLWQRKdnlecAf0eB7eNYPGQDGRmaKHDV1cTB8jVFqmP5eYWnsrOrSGD8eusEdAHAhJH9GfyBUb/hIe6QjSeYzHaYm1xTSsWgnVQETbieATWI8YYRToOCWqNWpWqzqhQpFcbivMMB8lVHYt2ZUJSA0Qffivy8OHDa/AAnxm7/uXzo8mpX3yBp0H/tZTsefy29Ku/lJaqakWHrRAAqm6Nt3AAeAcBqEQEek21kuFOErBtUJ+MAHt4tHe3YfhH/dnATfRnAOBNYJzLwzacGuo2xUqBAArA8AFOTq86yyD9626oBxOazX9nIQBLCABN3PFW+JfWIzBIrlSGyf29B/vjUJBCHiw4hs7S+idMmBByPCsn/2ymVg+ZH45H4810mOwXZ8C/NFD51VQ36opyIe8qUquLLmRfSCgCPygs1K2zRUB8/wGwLT8AQA5qKzomT8vRkiHh1ueNBogCz3FUCKygURGoQhtIN6QrMupSwA4aMYs5uIhM9OzE69bgx8Lx9WWRC8gJThHvro2YufC9j7L+5QRKTwgo/erbr779j196XuAW1B4egKqqmzwA0Gc5J55d1lDV0NCE6zxVcnmA1HM52BAeZeMegMM/bU1tVW6Sccy60nFUfxYASgCaAE4NoQe09W6SqjLTUpa9Bg4gdZUFBKpM3aYu+A4NDbMn2gAAr8ll0v+e9vb2p0+NIH6gMszNLSBQoVQqFYoxKkVYQOAwdz71E+k/IUQ1dx0ZjcaN7/A6ZeUb6xrrqnGgrViblqZJT8vVQmevgdcfj8ZZdazwQnZuNumQjxo5AMwIMJ8dcgAAS/15ANSYgkDKoVVo0tIgCLR0Pn/ekgeZQGsnjkZAVaCi04IZ+hiVSo/v19QYtPoLZKZv5vt4rAMkiclZ0cuWvbVg4QIy8EnPbd58IAc3PBMHePLtt19/9W1pPogZOFJPX1UGgInjx4urANq20zNZmP5XK/VMTsnQ1xldp5Pw39R0Z9DA8eOF/i8AgCWATA11EwJMGqkiPcoPHOCVRmY4oo1u/xLk/7QIoH9IDkAHAMD7XfBWOE9PX99Aua+vLBAXhMLrgkvPg4CDQZb6T506YdrryqyzGZlZUDLl4y0oeug4xca6lqLCRl1xnjYmJiY9rYCcklqkLcKzyotqHj169BD/PHz4qHWdbQLM9gv0AwBL/dXPOx9VNzY+0sWkpcGzNDR2dz5vzcFZ4Q4MBnU4LYi/FHh6vooEAyMk4vpcBGBzwgED3vqTp4OcD0xgwcyImdwAOJjBzq+/PqvNP/v1t5gIlpb+4x+//A1gUCQyAGAtUFmJMu+fLCzBmHmhKUwt0NvT3WFSDwMA8nD4n+jf9t3AgePF/i8EQEhANvUAk14aCFXA6AEjTTgA3Gtqqp8ycZIw7HAU7th3vazsZj27AAQQKHAaPtzXV7H0Vd/AWMUYeXygMl6pUuFEQGCgcqPvmDG+MnZnCO37wYooZUZ+RtZpVQbYn5EAYCjG85CrsdKGcKs5loYvOYoPAf9S7rHY6kePWqE1NTUCAZAE2iOARYBrH5G31gE4CcqfPHnyECe/UH81aI8tRwEGAErWdUDcBz4NCAAZn0iDHEChomtrU/CtsVhfnJeLy/42ZObCl5DExnjYLzIyRLz/adGiAwfem7lo8868r7/FE4devKjFRWbyTcypYfjSNqALVNYLAWCmBSbO3gEAVLXR/EvvBKlojIuK6f/nJVb0FwDAZYKTxw+Mh3wBo0CNqyfo7+RL8n9TW1X9kkmY/42zqACvQ9+vhPDf2dnWjd+825ToPHz4AE/42ZWBgYG+vuD+aqUC3Ewuny6Xx/v6ytUquW8wPXoEZwBDVEeyMlQZUVn5Z/NL6QV5BpziqSZHI1fjYWi5Mepjx45pwf51NUXw3ip1EZ6g+uhRI3GAoqJ1QgKsIGDBgHUATrLt0ElL/RGAh0Vk/UeuCmJSTrGhBvp9K1iVobGjpY6MUKQp6ClL2FJa9RmqaoNBBwDsxp8iLxevfcvMMxpTD/stiwzhJkC5fY/wZ8aWC+cftb94Ulv7jV5frJerTPzcYBVdamUJwHjMBKEYbGhqw1TQ4OmpULloyPBfU9M5q/oPHDdpsrkH4MTAKkpAV6PXMEgBpoMDdDfA90UAJloDoKz+1q1bFU3seaYAwCZnT6geh6sOxQZ4jB1LhoI/ilXG41wAeIGvXBkvjw0LnuofDJ1fFaRIg6wvUxmD95HidVhnjbSmamzU0fXXaPi5MbEEAKChQB2bcyxBXVj4EBv0fygDc3PfeKMvAiwpkNjWn5dfrL+a7AnQVRfFpOVp0zAGNNa1aGNyiuue1+aTBeIqXxwQUqVjPaiCxLAaR6+M2oUH8vIAAKjMcSTImJ+anxl11JffDyE40mnRzFmLLtYaau/du3Jam5gxMtBBACYRAKDhobJjIn1dH/QSJZsOWNcfALBOwHwkAP50TncaPgC/ext+UwBA9O04APbX36qsrGjgDgrt6FUO9UQCok7FBnqEKeXxsR988BGZEpaPCQQAAmOVygNh3iEBAVOnzgM7VKlA9wxNRjSu9jirL4aXDJNAXTU9v6cwNyfnGGlaEDpbnXtMrYa/Ci8AG4W6R9AlHz7MzX7DjABbCAhJkNhSX4hAghkAdOg/VxGThtvHdY0EVRwOyMsjK0PQARR0GZ0iprWxOi9De+3ajQMz/0Bv/czLx7sGj6cezsIF9oH+YgKQAfi9eNs3hgeGkrslp9/28xvgJqgFGQCYsXfB0oDxWBZALQAN+2JPwEip3ESiedt6vvwT6T9wILfrSNAmQXERisPCbW3ddS7DXlGZSOBBACb2AUAvc46dSSZ7e8ywYcODElXTfXEVqPKDDz/ExUBKRZDnmFj5GCgN1yvD5iujorT5qoyMdOz4KRlHyHEHtRmqfEOBTpenLWIGWYty1Tm5uWqQPacoGw8yys3JzoHs/wKU5IWFj6AE1D08pn7jjX4iAE1iR/9D1vUHAArxieWqYmI0Gm2erpEsDoFkpI7cPVKgS/PFiWFFCq4IVNVA/ZKXQLx9QQ4BAFvyiazU5NTUw4eTj/pyq+KnCc51m7ntil6vv3Kl5Mry4cODXFW1zS0vyF6BXmat1ezJZkXARFreLSnHXByH4ntaW1704uqPpnmScWwbOI5ZCkL/NRD7/ezZtO9jDjmbjghNGhfymISBjhctv9ITyypvlZfNEtoOW4tMmjJ5P65YAgBwgXlna8vTWrlUkRw4cPBA18CgIPn0oNUffKCIVag+gEAAfz744EPV8DGBuFUsVhWlzcBFTLjCF2fEDEZDnlH30bypwSEh8UW5hYWk5s4tzAUzyMF+X4SpuS5Xna2Ojc8tfPgIxHh0G/6GSPGGFQLW9wcAh/q/Wl1YVIi/wQHomquaIl2xARmoYbeNM4vDyAoRXTFkirFTp0KwX5MDCUBmZkp6CoEgKjL5cORRCgCtg6ZxByAgAAX606fvX7m33HN4kDowQObr6k4IeN7U9Ji4QPn1HfumjBvP9H02NI8jV02UQ0ckA3LdZPwP/X8SM404fpxwRmn2Dr7tI1eV0Pdnj79DAKC7x0xl5PFx46xNACBxDU1NTQ1tJlxaqnTzl3l5xWgz5QODBwaXqYJU8PtPH+IL8gFID04Av1XDh48ZMwYISMzII3ef0wVzWckZmvyzpW/OIKPDB6C8RwR0hdl4T4oOX/xLuaB/bk32sVy1epX6pK7wQnYRKQIhH3zjDasIrHcMgJMWzUJ/DgDqSzEEAG1eY7WhWGcgK4QM6dU18F6NXqsKDCSFgKoarx+MJb08Pi8HM8D0lJRM9IGUyMjI0a+95RvML4kX7IN/E5I/3AJzb3lQeFBOnladopDWcXEAl+RXVJSXz6K7RQWjwuOmgI7l5Q14bB9u/kMHQALIMiKy0Xj8OH4b32Sx/kgAeXf2pCqiPw4KYgFSho9S2sQA0AkALv/r7jKFeeUkqDWJiYZYBOCqKkUVFZXy6SnVsVzcxfvhhzmHPjwEAPgFBY0J+uCDxEwDrlfIxMXLUPylRcyIeAMqY7JILL6oMDc7F/29CBRuqsYQcCknGx6oKczOVqvjwQrgnSJSA0J7wxYBdjCQ2JTfpv5qzPNwLcCj6rw8bY42r04Hb3S6GrIU3KDT4l1e1dX6mBhcEKqAfxRrVxGRV6UdS8tNT0lPz2QcAAAY/tZSD+5KDtFhCJ+WfHoaj8VfPXx0kFaTk6NSSQ3Mady9pio8LgwImEEBIMsEGQCgKt8xe19lU1vbc5QPAWiiHsAeNoFfMN4CAEb/faz+TQwAXbi2cx8EB+Z8ErPhP1IAVjT0sqdb94YFqA/hrJ8iAELA4AlKSO0yNBcTFXI5zi7lXrx48VSiJmP4AERApc7Jz8+kVx+/8fqlr0/NmDkDG50s+qiIDPFhd8M+Xq1WH8stuoSPQQIIeqxKABguZBc26qBPFj7iHMAWAmY0kHcktuU/aUN/tQ7XoJH2COeCIemL0UA5UA0GkJlZ06ijtSAiUqNVKXQ4DBxLAFgJAKSlpYD+KRwAo0e/9dZS9lYWIQALDxVf0ujvGvRJcUkZeDpJWjoAwI6y4xIhHHidRRd2EWHHcQRMnEg7ZlsvWQLW1sAQwJ42xRMwWaw/A8CUyVVdVP+u7q5K/J9mkwUo1gDA9I8WAMzEpVtYQkL2KUWgr8fg4IGDx72B91sU5MYo5GE4t6ApvHhRk5ESBdXl8JicNPUpPJU7Mx/iQMSEzbsWkSNAZtDpgkH+RYXZp3JpGCgqelidnZ2jxpvKjh3LPobTgAABAHCy8NHDwqLbRY8a33jDHAF7DKznATh50pYBWNNfjUMTeINL63PCQLUWgnxaTJrheQseId/6/Dk9QcKggwKxBmJDgTYvnui7Ih0BSE/HBXoZmSkpFIDRby1lLuaaxh3riBNEuScvXLhYnF2gL0nSg9HkpOV6BNbVNbezAGDlXTFjnCgrG88isIQxZrIFBGJAE50HEhGAeeNkC/0BgClTGrj+b2qooAAw2ou/3fjxU9ABmALA1NtYUxcricXzGOSBvqMQgMFvgHwFubl45IhcqYrJvXRRkwI/+vDhwwZ40tV4BZnquRFvvE66PtWfOd9ssPeIwauyIQygCRAHUCMA2cey1ccKgYsEdIDCC4UPISPDAeE3rBDQFwMSG/Kj/gcPJlgHAAh4iEtRyabQal2uttiAi+hbca1KDZ0O0JGzpMnCBfhdnEABQAdIz0QAolIyM6KWRkb6EQBwXQxJA/iDkWa8d/HCxUt6/akCzAQ0mmIwAXXASE+JjK4QIWPClRXblyyZMos5m0OwVpwAgCszu4kFQAxoEBMwiZFyspn/g/77pswi+jMAVFEALPv+eKgflizZXkGqUgSg29Q4yNt7kH88AcA3cNTA4MEDx72Rdgqr+JigIABAfSwRfg4EYNiA4cM9seNqtfGvz5gAbQbXgvnrikesz86+gAagewhJ4LHYWHQAjP4kOSChAYLDQyjKbgtyADEBfCOSk3dYLtZJTtrQ/+DBgx9Z118NqX41PJ/qR42PyGpgLU5bFRtw5NJorCGjAtDxi3OhcsEPV0OteoDsgkQAjqVnQA4YA69BStTSpW9RB6D3MwYTAMihCcFTg985dSG74MH3BcX6779/UJynxR3KaZF+r7hya8U7GxrQnsuvL+H35jEAjNtBOmaDyUSzgDYkwMcKAQwAgu6/b/YSVJ/NAMEBKkmosQQAck1ko4EsFEcAeh8NDFUqlQnQKYtUKrnrwGAggAKQi0ePY9mXpk1MT4lKiRr2CgJQeBtSm6kC7YkL8PsEpk7dmH0yO5sQgJO/q9Q5ubgIJBsM4dHD27fxLWSIuqLCkycv3H7jjT4RsGgS2/rb6P9kIAh1xUygGvjTFeVBZwerb8aLvKsfkfOCMCvE9SJgAOcXMdc2Tl1x7BiJAClgAlAL8gC4DCKLI8niWGa1zIj4govkwJKiUGXC+uzceHVOTmKM3xhnl1/ZLSO9nQ24C6einAWA2zQ2bvysveXQbj7uZLIAXDWKq4GEBIzjABDovwP1Z/o/EtBEpxitAkD0J+6PmwXhsx8N8g9duW79SuhZSmVswODgwcHj5sWcgpL5kipQKUcAYgDkNHVO1DDnAQNkEH7VKlWISH7yCvCbRA5kXwAAoBxAAI4dywHjzwY1dBB8G3EWANIENUSA28DIwzestJcD4KA9/WPpSCAo3YjT0jpdWh5OWRl1D2vqnpwtRVeo1kF5WKzVkT2kFxYxF3fOBf1JEoDdHzLBqLfeAgCGD39tqZvwqj6aAI3IvVSgu3Do1KnsFStXrNwYD08hMScxcvkYKTco3GuiAFTwDjBpPDc5iIc1TVoCaQBRkhIw14KAyeb6T+H7P7amW+SEKvH6z/H8DBABgJSbGAIKBkFuvW5eKLT5MpkPHi03MNRXDeoUHgqLjcejAdQgekL8QcUw52EDfBEAhSKEsf9pdK+YeJ/AgeyEkxeyMREs0uF8wLHsVQlgAUXMLDBUBNm50AvxWxS98RIESBzTXwBAbCydnsBtAToyVo1H60IKULho6/Y9284T19eRRbXFNbhp9Dxzdd+0NRQAoj8QkJ5CABg9fPRbbuzJfoLD9LIvFRScOnTqUPaKjStXgv7xOZpL2pS3o4Yq9YbadqYYJPvwKrZz4tBlQoIF4xW32sj2f0pA0zzJ4HFCAsZNYfVn8v/JS9oY/Wn22HSLrBPiq38BAVc5ACABfF5UUDRfGnrwo4/WzXtn3cqV8/3HehEA3lAnfIeih8mV6AEXwKzj4xMUGAJkJw+djFWGTaUJwDThSkFulcBGnJbNhoCve4TjAMdyjmEBCCGAtNuFuof02MtsiDtv2GrvWBf/HWgSW/p/ZKv/x1IHwAtbcGKyuqhIg7tE8vIukJMd9laTx3I02hycGaipriuk2/4WoAPgjDaxfxIGKACjGQCmjhAslAqemoMhAAg46L1y5TpyB4I6IVH7dnLUyKFSiYqcCcAAUC9coS3MBBGAisq23i4+DLwzcCAPwKRxA2dY6k/9Hwd1MXm8NWnyeH78jzoM872ukiVg5VUk/yse6O09OHTjxo8+Wjl3PTzjlQFhXgMJABfOY6GVIFfilCAAcDAhPv4kOMCA4SOhzlEGEAAmTGAOJKYbRYQhAGJA4W2S6qmzQQD4A4KA5+NjhYXEByBFyL6gK7Kpv50m6b/+sfR+CdLRiRXE4C4KbV4hGcPfqyMnyOWkabSak4u2vL937/sL6dVdM9fgwDHkADHUANIhB1iK+r/2lgddG8FcqkJqwpCcSwXFRadOHYqfAwlrAqRCCYcKCjSJiekZKoWLnM4ONlU14Cxt2T48pstieQAQQKrBhjYmE6QEDOYJmDxwAi3/KAD7WP8nCWAX5P+V9WWTuP+N3/4zefasJfv2lddjq2oiM0AF3htxdOXAwfNgWJhnz5/vT5JA/8CEC9QBwAIwo79w8oLcF0OApwxQiF+1MoQ5jHgwu0eAOY2OFEMH0AEgxkMrwpFAyIays7MTMOg/ZFYDPcIJoQvZF2wCYA8BiQMBwEz/2Gs3bt+mNzfTE8agV2tzcrS5JNa/T+aviuDfeZps/to2bFvSQf+YdBwHSGGrgOHDhwMAPtxRCZwJhKTlaDSaQxcOHVwXDy8t/IgJh27fzjl06KOE+EPuAfz0MM7TYlfcIcgEuckeOhxQ2SsgYN1Adi8Xjg3P4qM/5H/72/gEoLcB08iKcu4/ozkGHf2BD1TUo7l009ZluuS9ccOBAwfOfXbj3LxQiADn1q+bTxzA3zcWt14dDAuThwEL8IOcLAz0HDNSOsrXXRkWduDcgVUjaBXEnkfPETB12gwAANjHAA+/1Meg+lPHq7PjE+CR27gOAKcBcD4AMLETAuwQIOlXAUC3N+JBXnv27Nl9bvd5cr4cAKDR5EIIWLggYtoWHRm2yoWHclgAFlAEEICUmHQw/8z0KATgrbeWDockcPSrxACwThjBEeANsOTkZJ/KvrBuffzGjdiHoLxKSAA+Pzrphof0MYsvcFYAE4ElfJbGA/BmPVlH3MkRAO3CjZt3bt68c+enn3CzUQN6CJ1gLC9rYxsSgFSVV+zh/i/BBkACAJSHDb3gFGS+wXRx8O6PP/4M28ehoSvWrTywcmUoCwDGgITAMGjxSMCFCwoCgMeosLD5APcqcl2x8DRqzgMAgNyTCSeZ7ZuxZBwQHEAdTwAgC4EgDlwohMIQTOKNN/qPgMRyAKgv/WO3b2XP8zuH+hfh5XmaNG32wgjIYxcUPiTVP25nzmUBIOc/IADpadj7MzNToqIIAKQKQAC82ROzgpkzfr1R/xwId/Hr0FsPXrgQHw8v40cffRT/UUJsAF8JYB4Av+v3kXE5vKlr//6PwaN++ulxY+tzTOW6aT/tYsoBkg7QLL+NfBC3AZiYfePChllj0+M7d27c+GT/tjffXDJ7ClMOjJtFzIEWAN29JMMMmLpz597PPvtk/yd/nBu68p3160Ln+0MSOI4AcP78yZNQBIRBJYALLgsVnp4jh470HTU/LGzd+nWruMsozPTH0uAgTv7Qlr0KJwJz4+Oz4aUoxBAAv1CBkycRgMLCN16CAInjA4Cs/jwAW8+RBQC46l+blpFD1/ZEbDlQCK50+/Z3351jIwA9DnJNTAzu16b2j42tApZ6sxaADNATM0Jw+F+N2f86HLyC7Co+/vz5hINIaKzSXxYYUEuH3/ESkaoGqN0f/4xLwcjlXZze3d2dbW2dnT2dnZ1MXScSmX2si/cHTnnahO83gVlU3bl545OPb9RX0l1A5Hs9x3vAgt8k92Hu3bZty9zQuaHz3gkNpUmgfyACcP78QfBuCPlg1YeUvr6+I52HykZ9FL9q3fx1K0eMMO/5JPyT9t6unbt2HSy8cP78gXWrSAa4alVCNgBQBBaABnwBkgqI/5gQ/vElCJD0MQEgAIDVP3Yr3/Z+9l0RWbWo011K4De4CO/s5M8CXkPrPyo+tsNvvUVCwFujRggJIAzMJUcTqhMOHVqJg5cHPt64SvnxO2P9vfBiSKmrqyyQmRokozDMPEwXuWm2Df4i63qFF/kSIMhxYh0d7XioBTuhhScdtXZ2dDx//pyq32CnESba2IEFhqDnXhKJBDw8OCTi9W1vbns9JHRO6Nx5/v5uksEEgPUHz0FbJVfKY6EgPH8hFvRXjHQeOXTUwfM31oeuW8nLTgaCps0wb+8deC9ixrSpK0GFY9mrVkHmmH3hQiHee8Ls7c4tevQo++Qf+0fAPGxWAEjowwCEABAIruE9oHu2LpjG73Fi1/aJDoOeS8RnGEAMIiMxCWQA8BYenAgvB/yo2TkJp05lr1o5P9THe9BAeJHd3GXTVRp9LbtRhK7Bw07fKxC7l+3VBr1eq0nchMcxBMai2yd6eLi7urrgZQ0SiVTQqotd3FzcHoH+j7y9ffxD58xZseIP0P587tz5WxWY7LPyC8yBBBPiHK01xR8qw2Rug4CEgYMGDwIDmxv6jtfAgYMHDvQJWH8OMr0D8wOhDPgOevJ5NAD5yKEy31EHzp1bP2flymkTxHMB1tqEGRER61GGhPiEk+Ta3KKHtwuLbmMAOAlp4sOHCECfBKxZg9KvoeJbAmAhvzX9eQDotS+kQVhYSE58JwLOtArAgrmrog6z0uOfSMYBlnqRe14EJyZCh1ifm52bEDvf3w21cvGYrkzUP+1gJSZ3sgsv6O5pb2+u1WtBbXlgQAtBoLtOImhuGOndJDZaWE4AvEELOC9aMIYNhyVHePvPWbF2w5/PN/Dys+ECf5MQ0tXWWl0E+QnBa+BAQBa/3Cdg42cHDuzaNT8wMCz2BmQDB8EBApWykb6BI6FqWBe6ctW0GQ60Ce+t2ajOzj7FJ38PbxfpChMIAAmFDwvj4/9on4A1fJtnHQDLAKB2FAB60Qfm+wsiyKzeQrzsENcB4tQ+e0VMyAoF7/+RhxEAdIBX8UplMv7HH503yAfN3sVVJleqDC/Y0X/wb4HwPS21eo1qE35ARl51plWbcByvu1oEQCMU6+4Smy321COSH+wZOHG8+Eji8fw087iB69uautZ7+/uvWLXxPEhBbYHNG55jomHqbW1qqtHnxIZ5uZD/eVDIG+/t+uyz+R6+vsrzByENUOJuoZHOnp5D1m8EAFasdAiAGefPnczNpmNCD2+TW48gA7yAbpANdQK++0f7BFiRHwAgO0Cy+V0AtvS3BgAiQP9s3bxw60J66PfWRVv+9PGfLn4atxp6o/IjzcaPlXOBA6I/tDmKSEZ/zgGGv0pu1WYGQUaAbcLLJnUNUGpq2xlnF/b4nnaUXTk9wMOFaC5thcekAi2lOjL+320QAVBj6rEHgPRSUSMuHdk6bry1xowBj1sJqeAMsjIMV5dC7ebtv2LtRoJCE24qxSwEzQCfaNfzRoMmNtDdBaPXCDeXUbJAKPpXxSpH+srDCADrNmIIiI/ADt5XDFh4+7OThVAGFz4sun0b4v/58+j+zBDBbdL+aJcAq/ojALb2gIr1tw4Ag4HgvH8AYNvF2z9f+r7kezzD8sHp01fCw4Omh7L6T/UF+4+k6r/FAkCuzIFqGJWXgN2riuvaeeEZ7X9tqS3epAyUuUrF0rlU95p6XIRaFpIywCQG4FF3Z69NAMh/6QXKVeywDgCDwbjQpqaKGeOFkwJMrBjs7bMuPruo5jn6CCQmnW0QUEga2t3WWKyWyzCUSQZ7e41Vykf5hilHOr8yzHkdhID589dMsGiM6wuZmPnZeSghEuILb18gRSEZHLgAsV+ng7/OF363d/sf7RGwxioAc80BcEB/SwCo+zPXPyxatO327YsFeLrRA/h990pJuN/y5cuDwkJB/jljfXwjmUYBGD58wOhXGfuWugeq2EDfKwjyPT0aZaCHUHgmd6PS6jpMHSIHKOyyBMCrsbOz28NCeCn/t1RyqaupfN+4iXYAGO/f1nB9pvhqCI4EhGEwnjzcdsnQSDaZY7UAxQUmpL3dLdWa2AB3/IZSF/fAkc7DhjnP3XVgQxgzF2DRwA3FtrA5HvK/hMLbUEmeJB0fKCCLRS7Ap87cMWvGmzYIeJ00c/3nkiaxcgSMNf3NARBHf4oAhWDhws0PHhR8T463wnssrtyNC//yy7eXL/fz98G2dOlSIv5SBoABTnitm4tMnmhke/2vjPTttVpVYCJYd61Yd2G8l0jcda2mdqlAU/ea5zg/19viIuEf9mrq7O5wNQfARZQWxnY1VVwfbxeAuV0V1xeOm2i7jf+pu/u7gZA3+gQo1bnVTV10EPL58w66vLijpljuQmIX/Nyhuz7eMH/lVH4EQCR/sHlU2JAACOAsAJSAGPQvnDxICoILi2bMWjxz8KA333yTBYBqzv79uhABXvyXBECJer87Z07o1s3WnGDhwvf1BdD3S1B9AwIQ/vZf/vLll8v9fCgAjPTIwKuvOEmchvgqtLU9rOOTvzue6jcpA6jZu/fgYdsCzQUEkH4bWNNqapGyPg5vXWqek/mZYqG4srbu3h5X3u+Z/0sMQHdTfbkNB5hIV5Euaaso32rdAZhH7/Q27RjHhYYR3mFKtbamlc4vd3R0IAXPO1oNiXIZhC34uP+aqeJhIL77m9cB6xNwWPj2hYSTxP+zT54/eLIQEdi+ePFUeE3efJMi8LrNRvSfK2wS66fA2DMAJY5rnVTO912w0AIAUvu9/+DGZ589KHnQiAg8KLkC4mNDADw8Ri1ltB/m7OQ0dIhn5l//65/U8em5Cs36TeSl4Qw6oMZkSpRIpeb2z3mB/HkrdXvOz2vaCAB6iUsY91UBCACV24v/v/zFAJiaGsrt5AATJ02c0lBfsd2q/MyNIRM/MZUvHiwoHwgJg70ClNm6RpIcktFpgnktxATCJKQQ5uPA5kkhMrEy/iRuCD2JA4rZFwpxPABy/4MHDy6aMVjqEACvvz7XrEnER0HY0l9oAEpMOE8plArlR/LXzQDY+f7Onbs+1hdcQvdvfNDYWPf0m6dnkAC/5X6jPEa9+uqrb71FtJfKFBlP/vn3v/Pdvh17hauU9mve6sN07SaVRGo5eMMB0NYKWgsCg1sjuQ4EHEAq40MAxGRMFeFz3HkAAsQA9DY1VNgCgMo7uaGhfrsN88dV5hMn3my4vmPwuPHma4jQDgZ7B8QmVuNhlYg6MQNTd0tBLH0WIgpE+SAbEtZnM9NCYP8JZJb4woWDBzce3Dh1oJQDABF4SQCys23qLyCAAPDdxZhY9amLUYHi/v8xhP2HD/SX9HhRN7nc4nSSoeRtTAL9lo9+ddSoUUOcnZ2cRypSzv4XtXw6gtfOOCIEZVc3V1eRvsrqRhYAq02i7HwOAHCRQSpxf04Paa0LlHHZpUzZ1NXVqYZn7yKlAEjDlMrYBDc+IEgpABPG45QfnfabZKYjANDUUL/PdgYAX7CtonxfsPmeRc4pgINLps5ufR2mur3dnR0dWCl0NxbEBlIKBtvIB/Dfr7/32Wcfnzt//uM/LlyffSF+I8hPJ/CZl4IF4M2XBsC2A6h5/ZW4OqFQFRt78bZKIQz/AMCN2w++K9YXkPzPoEcKkpJOxy33Gz0a/vj5DYCOr8r/O5PlM8d/JU5nFMHbdF1dmaFatrlo6lpMcpsAwNcpu56btML8UFZs0JMtJLUBboxruLkVP8cjIHPc8BOkJFqcwjTaTSJIKGK72xoqpoDsk3DlIK4zn022ii2ZPWsKOxP4uKnhqugGM/M2paL8+ixhJjlxPBcjyBHHn5hMVcEDB3vJ1bqWbkpBJ8SE3i6WgoEDLWcGaUhAGshUwYQ16oMJCRfO//kglgTxYgDefHkAsvvUHwHAEHAx58PYP91WjREDsPMhOD+Wfw/0kP4Z0AKSSq6Eh4f7oQm8/X9//e0/Bblei74ZCGim2jOqWwAg1T7vMAVKrAhPv8xdpoZPqA2QCT8ILgD/s15YMMbiNXFKISe5D3MLH7oLH4k1IQB05wgBYPxsuuyvvLycXTfUBCYxe/IkOwA04DJlQXYw0Swa7Dc93zeBJIkQE8JitWgGvTgIiYlBV/WHdATRnAJ+cIBOD6khH4j/88Y/Qx54IR6Jlg4a9KYDBDgIgL0IoCy4XXDx0qWfLrIOwBQD6ADf3daLGgBw+nTcaJD/y/+XiM6UeO21iXIPCN8gk0YiENzSAaT6zh6TzBwAF1dZgFypzsm5VGzQNXZiuBfzIYP/WSsWtweTQMHnnGrUVTeKAFACAPUcANhdOQAIBIBBfVtDQ/kkQZuNxwqJUoGGhort463lCHRv4sQlvWU7Joxj9pYjBSMClDmG52SqEqoEwKCzJkdOXNFqQKATA9kHE+IPbty48WB8/MGTLjgZOWLEbwfApv7CCKC8+OmlixdViVp4M2Yz3vLHFIBbF217cLFATzwAuj/If9qA93Sf+fL/+i++4/fUaZQ01wMA6kwQ30UAuJiHgOoeE9TvgkfC1OocTTE9OUNnwA1oHSKtOQA0ZgCYxADkPHr4qNFLDEBnEwAwmQNgEgMA18obWADYMEB8YbzADsZX2QCAXYc2u6F834xxAlOgGPgrNXV4E2FXZ3cPLjJqLYiVSdnc0GKU6L2EhPiThVCOQRlwcr10EFlG96YDBIjlDwnpJwCov7KgqOBSAW7TUG1KVMVvXD9/ATMPsGjbRb2+oBq7/oMkjP4lDx7cbyE3bDHiQ8d3Zzs6CK0ubhfbOwDgIs4BXes6ejtkXIiARzS44RxPzzIYqvFoksbG5yKtKQB494ObSFwAQCnj/hsXj7rnra2dAUIA5L0AwOxJ5IAIsmbUAoCKrq4mkQNMJItKhXpPetxQsWf85Ek2R4rGVdbzAIjqBKgSlNXdnb2m7rbnHZgePIeA4EadgB8bpACcPI/lwPlzG98JdZOS/i90gDcd0h/H5iU55CKIbPIbLwM4ZlV/kQMU3damqFSJmkuJiZdUKtWmoBXstO+uixduFOiLifdDq23v4SN+j5G4vgREdnMDnV1cpC45+jpTgMTFRewAIillAFCPMMBLNeRUypq6Gjw1G09JAwA2WQJgMrVqZEIAuk3t7sLPqTVBHSZKHYgDzJ7EnRNjCUC9qaupvnzSRB6A/fUQHMZPFFwYdqeponzylMkTBVeIidq476BQFGWJgigx7g1T76MPDa0of2cHlotdjcVKHLlgwwEFYCb0t82bF82EBwZLpAwBb/ZNQIRYfgRA1OhBRGqbBBAHuF1UpElUxYD6mzSJmzZtUq1kAdj2GYQAfQFJ/k7fMwl7/nRXMgjuyjQCgIfW0N4u0hs/IAoA0rD2DlOdSFzNc3IsLTmYlgDQ2mFRJ5LsYpM4BHSbWkSfYsDbw20DQCCYzSwFg+ofG+4zAgAmiwCor2cBIEdQTLzZhg/wnzJlspkF3IA0kWHIDABob5o6t4PrB8RqSYnQ1dGJuWHLJaUHA4HZfFFw8Ah87o4BQK7qFcpvA4Bj9gHQFV3KwcMuCsACAAAVD8CWgmL9xQKw/tOnk5KeMFM5tZsCSch3IU0IgLKlxVQr0hs/QdhNXSSBkOMbxAC0t7S0NLe0tLb3sKuCLAFQFmta5HzccJESAFxEAODoo0xMTXdT/SwRAHQih7ZuvF8UPoMpFBgAAI3yKRMFj9zsEhIxaeKO6zt27JgkyBL2AwBChsR4dJQtHscEhLBE4/NehICMGbUWx5LRYxoO2I3E4AD44polgTYIiOAICLEPgCUBMSIAijSaS2mqxERVjga8IGPlQg4ASAL0p7V6veF0PspjVMnlEkZ8vs6jmb6LU2JHu0krUMnFVa5Wa5SCrNBFKn+OV3kJmShoFa4LkKsQAYuBgrAiTaNSBACODIkYIedQy4SwEQBEDjClSbBulIDQ1YCVIgkQ8GbyxP293fXlsyeZASDUdwnJEgRi72+qrJg9cZJ5YwC4tm/HOG5/y8ARAeriFhws6CCpVIdeBZnhQG6AiOwoGMReO+EgANBCbAGQYxsAcvYjAaC6Go+KLNBogANtImSCSrIWiMwGb9m1IQdPvUrPKAVdyACdiyvt+0QNHOjjXL4Y7F0F4jAfdZG66Yq1xWEAgAsnnKqjw5QoFXRd9+qWpyh8gAcpF/C8gB4AgP8K0pQFAWoLAJ6KGFElblIlysjnMM+PhIAlk6YITg5sopvEmAYAtDEATGY4WWIyIQCTBQD0gkcIAYAk4bpgP9rEJW31FUsm2Wjj9l7fMYEeekW2u6MVQDxoJruhMTM0tcolwXTRDB3mGMTtqNzWBwARfQNgwwFiyLG/LAA63UNc+190+2FRbrEWHg3j1nzRpX9r3t04J+YXvNZdglk9CwCKjMu8OFVqIHorpa4CezAYig0BqAnzmIs0saNHXCm6ergwswIuiJY0rJt8I8RImDu6SVzDRABAgf3UxXwwSerCNzepHABomDWenhmJbwCA7i5WexoJEABhlFiiN3xXvkQIwH4AYJYAAEgkIUgIAJjSWVVfNmWydQAm7q/YMWM8aweT2AvyoEqkEPQyA1wSsuBwoFD/Edu2bbNLQITjDnDMXH8hACkZUfkAQB65LVJXnKNauWChEAFc+BF49J///GcLE9Wp+IxAnNpSWWMLSMc8ThzAo7q1uo7tlMxAYGePSdiVXSgdrixWUnkH9O1AiUBJMvaLigofi++CEOAioI88NTcRAGGmzraGWeAAzLGBUybPRgB62SSAAYCcGMxFiXHjxgVPEJaO+3urhB0cAKhvKJ8l0Hhya1NDmUUImEwhmrikHjIGJiLQUzDZeDBYJte0AwKtUo4AjP0CB7APQESEFQJsOMAxM/lFAMDfKbrq1Ejlquzs3JMHNmyct2BuqMAAQhSff/75F//8Jw7yYVLnxsnCei35I03s6TB1uHKawl8BhvaWVg8eABepax2UEYF8SHDhIwrNKQEASOYDpYJHhapyAKgBgFqpi51GAaifxcmPjQAgbF1mAJCCkcpP35+4pKuhYslEvoPPBqpEQWLS47aGMgEhk5fgDTSEASwa6sv3TbLIEGnJMG4gpCmdJpkAAP40meDgbfYJcACANDzDxZwAIQCEABVk/nmG5MPyuatCA+WhYYoVCxSBfPcPGQv6//2feGa+zMXdzdXDVcqqLtZED95dJ3xYqjS0mKAuFIRl9zpSrHOMmDXwgVhMj6wC4CoCAP6fWpe+AOhuq18iAuBxb98ACIYNrl/ft2NfGwCATExmO3xXQ/liYZ1wBwpFYd/Hr5rNxYTKiusMT8ynj2evygQf8O4BANQsAFwAoFcQIwDb/vhHRyzAJgDQRADEsE0AANR5BSpDfuRw5bvTDl76UBEVpQgMmRbByD91ztHPP/8XnPTp0GLXdXGV8tYsAqAWACgWebda14oqSXnLkNX0mDrcbfdcNxc1ZImmAFEwt+oAvTQE2P48N2kgOsBLAoA+MGkKzhc0AAD7+NGkSZMf94oAmDzxTld9hTAFKKNTTYSCyZNu1l+fMon7atYIGALG1fZ2MosdB7LJvzAHsEdAhDULkFjoLyQgJsYcACRAkxSnzctIiQryU/6hUFek0eVFRfrOXUP/wzkrwsAA/hUBoIO8TLAG8UfJlAIppS51ZLDGlVfbVVsDlQOTNbriLRtqjaGDeAIfO8wswCWRAiB0ADc3CwakCd3mAJBPYt6Q5iLvBbdeNF4MQLcVAPhzxcUMAAAV9ZAm1JcJs4SfTFXXdwjLgP3d9RWzhcPJFXj/cRlzTEFV5XUsEnkCOBIQgD+Zuk0dLrj/SCw+DwBPQH8BSEsTEmADACBAA8W/Bt6L8QvKydFqtZq83JSoGPWq+XPmzAlZlRIFAOAyr1oSsdkUMECpztGkCRSUjqrrJvUb/4iHWjldxqV3Gk1OmqYaAGi249sebhrIEk0B4sxAkCRSStwIALVuXCPSc6TQx0gIaNhu1wG6EYB9ok/hQYD43VDf1tsGOZ4QgJumhnIxAF319aRwIB+eTE61BOtAAsquV7ZVAAezBVUC9x589sT9JihnAiRW5BcAYJ0AxwGgBMTEWNMfACgqLirS4lkPq4PSdDpdXro2VxUZNndOSioEg6gUEgH+Cbk7aguFP3mJJYnatByNXAiADIpAEt7F+Tv7vruhGPSvq+swGTl1XcUSg7DuUg1gZJK5COpNsI4wN37AET8XADBhDuBmrwEAvRYAmEQAdFsFgJYN+Kbs5q3WHqCoTGgMS/647f2tooGArqr67Twik5bU08lmhKCit6nyOpl53rdk9mRWd+oCpC7pBAtIlFgaAJsDCAmwB0CEBQBpaWICbACgUj6s1umK0nJi0lRBkVGZGXm69JSUtxUhc2M1Mbjtj0kBaX7PqiJRG8AtPIQAyNs7TD1utjquVAbit7S3tHSY9FIhAIyw7PIB92Lo2j0ygbQuBTXVxW7spAMZeYIHcxwDoKth+xRzAPhRgG4bAAjNYNasx5DjTRGnB+Mn8LkiCAlBYp8QAFNXU9UtCAOge2d3UyVLg2jAgRrGlMmP4QdplAwUnqvGbi/fZt8CIiKseIANANLMARBaAPR6fXFBsRYCQWKUKj0Dr9hdvjQwMCUD932CAXyOGYBeEJZdpW7qGnB0YRYoVeM0jzieC81A3lLXrNe0dPSYNPR/chWkkq7u0M1ViTlafQ1ON/8qY0V0Ba2LG3UaobCubiwAIr0F5i8GYBYn56wpP/UKRwIJAPX2AEAGMMdjTMFqg7SwoX7veMF44+3af+BhNw1VFQ2mrgZ2EVJFhWjAYRK50mTyTdwQ7T6QuXUymDlPkpwos60/FsAQILGuPxq8TQcA/bFVP7z9MGnTpqRNiZr09PRXl0ZF0h3fpAboNclFAASo6wx6rUhhLSinlVgFwBV+yWTubmTKzqTCRJKbRgyQqxM1xeS20mZcDYAAtHsI9S7oqBYBgARIKQDutMFj7m7kRu8AN3eeCBoCpswibcpsBOBOL3+EBD10gkz+zBIKTg6NFbSbJhYALkBMFjvCTw0VV8cLHxg/ISRMdfoJdpw2bu4ZMgeBTUyeQhCYvASTAKWETAxPE58m8JsASHMYAFV1dfUD/QNyEkwSaZsSoxRLl0ICsDRy6VIaAUwvRL3dXalBuYW5ums1GeR1FUwSCmYLcVUAho+cHjJazDdpQQudDKatsaWlvdf0wkOgo+ulrlathb3n4AYj+Cx3trkVFBXmFgbyD7h7KYUAzJqNFNzp5o8Roa2hvoECAJ+BN43s2DFrxgz2xhHyBwGYPdlaeGA6/KSbTRVl47lriiazl1EHh4TG/klXWcno31C+T2gbZdd3wDecPOU5nkkmsXaiwDYhAX/sMwZE9AcAIQF4WbSBHhOZhAt/NiUlpceo6Ib/4aOJAfRAnsKJ7RYgq2uv6+mlXZmL8eju1CZcrTfsujl1xEuYYI6tmMrf2NzCtk5Ti4e7oCNf6u42uDEP4P/iRkNAj8no5sHL7XapOje7KIADwMvdLRZDwJ4Zs/g2pcrEHgLBtgacDZrNfnzWlH1YxM8yd4Alk23lCAjA/raKcjLiaFFPAgafmKCMqKqoamoovy74yKT9pFLYMfsxZIHPpcFWdhOLAfhjvwBI6xcARqOxDn4Zq/NPIwFJSRn05BcA4C1mFFDG93ZXmbKno67d9GugB/+YVNVOigA7AAAtHpqaHlOgi4AJd31ri1mDQtGdAwD+u4JuU7ULJz3zcC4BwF0AQMGjat2jMHhI5oXyu3u5kRxg84RZPAKz9x+K//P58+euVZBDQvAkAHAAHgBAYAdUbddFIu831dcvmWw7TSQAVAiHnIXXlk3eT0/CbgIHQErMa4UG3EfQKxsoBGDahGnTpvJJoMMWEMEBkNYnAAICID03Qg8EAIypyXgFZMbpDHr6T+Rby5gUsFaUAcg7oJn0gYky3sqV8EiHHfFRQJew4saeHg9X0pVHwSPuo9wNHa2NVPj2djwuAtcc1aKio0ZhZJflKItNpmZlrDrWXSh3LkDJAeDl7uWFANQ0yt283GXMgwhAW33EBNR18eLFNAzMIPPug0cEj5g6NWTF2j9fqEcABB6xpB5Uoe7PtCW9feSJk5d0VVZETDaPDkziuIQeeQQuUF7+psAiZtfXk3NJyXaKWIlg1wh7wuy2/loAECCxpb8dBzAaiQmD/obMw6nJycmpyVn5mSnJyXjq0+ef/yuu0AC3J6U5BUDTgatDWp4/l3FeTuZ5a6WuQndnhR/FUSKvaez+1YPRbRQ0V/fqjg4UnjsUCM8Ox+zOg9i7W2CsTA+PNtY0auAhDwEAJpNRQISXe/Gj6moEwAsA8MLmLkcAFkxYTAFYTD2ANvI+wjAOzwflDACCMgBQwQDABIIlXX0VCkvaKivEI46CBpU+BQD03iv8JHChigbmbiKdhL+EHs/VGywYCLJNgCUAERJb+ttxAASgtJQ4QObhKAAg+fDRo8mph+H3529RA+hxJ5k8E/JlPR3NetV0lVYtcPdiLPAkIukRFqI2D0BrS28zZ9wIgEdNO3deDNlPiv9qDpTJWLVHuRYgALrqHHdef3eXXLxW3ksGDd6A6P6yOlxlkxMWFuDvRRs4AJRim8UACBpFAe8l3CH46JIKCgChhJG3qv6qqFCwaE31FW8KtaX/NTf2QE5AxcsQyoQuUVZfyV5NbtJxIwEjgoPNRgLFQaAPC3gpAGj3x1vt06MySM8/Ci01NfXo52+99UUvEFAsJerT8s0lgC7HFkR7N1f3unYs8NyZbA8dXiZXqosDXFz5h6TK5+3C1G2Uu0tAXavgmKCe9lrcZKcnjJBPA9GLu02m1poaBAD+5UGam4YDgDZ/f3IFmVoWQHigAPRCFb55BguAVQimAAD1wo8sgZStYgkbFIiaOBnApAk2AHhcVbHHEgAGgztE5Ta8qqR8hjBwNDB3k2EVMHAwf7ykcDq4v0FAYkt/OwRU19TV6YxGPBQ4TRGjUMRERaZmpqYmAwSfD3n17724QkdKhmZH8QsARR7v6u4aiOXbdAoALc5clNVabbGH6yj+86Tq1nZTsYsgd3cJxAFkEJ4sCwuTebgU4x4gZMRDxsgN3tLb2tiYyGhPmnsx3iYsAEAmq8VQFesVEBDg7+8/dqy/v5ccAdgzw5b4sxYTACA7p3xQm1jSCVl72RTBZ89uQgCEaQLk7mIUHjeIOreIgCmfEADoUbUzhIGDuTKt03RKQjaOTWDUJxRMmzZh/8sBkOYYALwD6HQ1NUVFFABVTIwCfkdFYf8/+tZbkqP/xEEAZuDGzTytYzv3KBfMAU0eLry0HgBAQXGx6POlOQCAxkXgAK5Kg2aTcrrM3ZWM4rl7uOaAsho3D05tmQyDS0djqxgAHbx0VgBQEwBk/mMDxvqPVYoBWDzLjAF8RAgAMYrZz7ubEAAeGHMAIEpUlF/fJzD5KTeboAywBcA+AkA3GQ4QLU+hq2E7ew9JBk8g68PJKeODRrDniu63tIA/9pUFSGzqb9sBjLrq6iJdnq4oFxxAgee/Rh0+fBgSgbc+X+r8Lz3/xBEfF1erBPDS4izuCw93Qed2VdZVVxeLrEKqxTX/QgcAMycDuPiejCirAZAS3bDzyxgCijvQInpoCGDIcNf18gBAj/cnAEAI8AnABg4QMHZsLN5DtI0HAAXfsWPHYmGDEFBfPkvwwOymXgYADoHHTfVloriBUl6FoECTSezkAMDsKXyQwHvvceSRELCkk/g8uY1gyXjRAAPZ954gCZ4guGKAOWYaysL9+60CYJcASVr/AcBbw3RFeegAOCOUHhOlwAMgsQQYsvTvEJ97oLxntLdFgIu+vcNkdBVI6+6qbmyp0biM4kt+d5kBEwUXGa8jldiDCffE26G/IwAeHAD658QrNewDFIBuCAE+0NnNHMAfDQCQABNAB+imDsArjMfIUwp2LJ45a+biGfub6suXCAF4DAk7AwDDwB34FJF14J6iq4LBg9n7oQzg8gZkAC1ix2Ly/uzZGOq7u8l1ZfvGiwYYegEMpYTdMspVAcF0UmC/DQLsA4BHeDsEAEdAEbkTJC8P/j6mQAvIjEmhJ/++5fQ5RgC91J2t3EnpZkV/97pWCN2Cvg2fpW7saE+Ugs+PcidWLvMIaMTRQneBkKyenP4eOKKscRd6O1IDL5UG3T0AkzyZLAAA6DEZZAGoNIHAnwKQ6M8wAXWBf1gHAHB11mJ7bcI2yOCFpjDrDiTsZTP4vHHxrBttwIgQgHKo4ERpAq4b3M4DMGtKWT27KgiQ+gmeWHc3mRQqFwaKJXgibiNZDjyIZICCU6YxFdgvJsAqAOYESNKxOeYAMQIHoFdFFOXg5bCKqBjm9PdXh5CVAHJQkabxtFmJALJWyAFVAgfwcA/UwUObXJlUDh8aFYAzPQHuMhmnO+sELAAeAQjAJiEAAdX0eEkKQAACEBDggQDoZQF8wyqg15TjD9Y/1p+mgWEdvZ0AwA57AMyyDoCImk/a6isWzeJtZFZZfQPOIInyRCgDBHnifgYAbGXPiQM0kRmB7eIkoLe3yw03DAtPmOcWBOy3RkAfeSAFAFwg3fEYQG+No9uztenwAYUiHfSPBAOIxHmgdsjrQXa3UQgAKd/N9Yd43wlFvBwBYHO3UbHPO8hDjMAg9aiwVtwZKrRy+gUUGVTWIwytJNEjgAcgkAEgUSYAQFaNC+oh4PsT8RkAetABiPxIgH8gBWBxnwDsE4SIxTdNbfXXZwm/ahsFgM0jwRK6GuorZu8TWMDjhvqrs2YLxxMrOADaSArQRacF904RTE7fwZNv5ktE9wvwCwImWAUAEbAzKcgAQCFwMAbgddZgAnl5uD8bz4o36qLITPBS5y/QABKlHkR391Hs+I0rxwASAQq6qnGnU+AoFIwBwBVLPujufKyXucqfd5ja3XkA3Kn+5GvoV7oE1LVAmgBGT6QmilfToaIcvr/D59bA99P7mzlAj0k9dn4Ao/8q5aqO3q6mq4v32bWARQDAdUsAhJ+CjDAAkFJh1ic417/v+g4egJ8gT5yxWAhAZQVzCAW5hhhnoUkZsHcGlyjMwiSg13RBwq0EMTtcbv/+/gcBEQBmNhBjg4CiIswBczPzDHl4MyAaQZRCsXTpW0Ne/VdMAWSuwlF4xGAUVZ7r7h6uWpCtXeYhBABLvl+Ffd3DVQ6lQrMbn98R2WWC3i4bFYa7S1QBgbyyNAcAB+AelIUpCQAGHz5OBHhRALzCwpi6IDY3tt3U3VR+vfw6uUHIFgDQmcuEDyAAkBaSNJG2NxvMANhvamtrQtugpeTiHbNwCzEDAPms2ZX1lfQWCnoNNS49IEnAdcHk5JQ3e8AaHg/klgMNHiw6OmL/S1iAAACaDKTbAyCGzQGK8rRpeA98HpE/Lw/XAixd6nT071ADGqRi/dHyA+Qyd1EWh/221oOKwdRzxa2M2mwLcFd3QubmQrw+IIARTiZqbspW+J+UVGsZ7e2MAyTKAtmvkifIa3DAcKw6wIPaRKBc2UxygIAwpgUEqNXtpt62ih3XdywWqS9mYWYDJHSiiG/CvX6LSbHAM7KdBQBV3wMO0HBVWFvehEJhxixaNJDHHreRwX862UMAIEOBFeUCAGbP+hlPE3KzD0D/LMAMAHEyYIMAvC8aL0BNiUnLI/IzALw65Iv/IimgsLhz9whUqjVGg5sQANeA5pZeUzGTutGeDaG7w6R3Ie/Tjhsoy8EJI1lAILYAYQbHAeCu6gC55bJAgQVU0ypAhQAEBuJ1bWpdQSP0qzp1QY46IScB/uTk5pKDaQ0J2dk5ufCvnOzshFz4OhCz4vqOfURqHGChB/XNmMl5/KLGhnpzB2ggAHC+saMKTELoANtNXQ0Nwi+aDcVkxaxZnP6YStI54G5mtLcLF4ghAIuEyxNu4oU4NAlgyj9HALBnAeYAiGoCGwDU1BThpfZ5eQAABgMEABKASOelf4cI0O46Sjhu45pYbTDo69QufCB3l7mCcWOhHsgqCT04rLEd6zkUnuiNMutp6i4TOjxDAPOVHjHdmDoGyikUmCUE1tEkUJ9ToMnRaguKdbqaxjo8c6P9Uu4lKF0KaCOHUtfkFtB6puBSbm4xmYPBjJ1PyfGcuK1bZy7Cu29nzJwBfz0CAPZd5/2hHJfxYQjg48at+oqrMwS+seR5d4OoUpi1pKmyYsmsxdy0w6ybJuEFN73deCoFyQK3Cheo7EcALkisnijJAbDfCgBv9gcADoEY6wQ0VhdB/8/Nhc9gAMjFAPAqmwIKg72Hq75abzA2yl1lXBQPCHRVNUL/wy5K/gndNDBA3oKDPh5EatCf2HcNhIBEdwv1abpHwHFVdXeYeuTHqmOhp8uVSmWsOq2ObKU3tRTodIbqaiZTbewEAHS6aqaBcxEAGot0XCuqpkPweBSI4Fyocv6QOJR4O1Rw8Ck7uPiwr5cAsI83gFk36ytEo4WLmwCAcuEDS5qquChBK0UxAF14KgnJCbZPEI4odEJ9+Fh4hJx9APq2AOsApNsGABCoQQDANfHCSGoA6TQF/DvkKKZANxLWGb1dZXXNOHnEpgA0mrvmAAC9AVzvBwBkSgIAMBHIOUBAHX3ICgEBtBLIkSd2QH/XavT64mK8rlirLTbU0QPn22vIOTI1VHEEoEPHXHBFmiUAOD8IIaC+wnqjHFR0N1TUNzSRun3fvusV1/d1EgCuCwD4BACYKdT7cTcEeFFm0dRQvk8IwD4hAL0UgHrzLHD2lMem7s4274HBVs6X5gGwtIA/vrl5s3UCbADAIGCdgGpdYW4uXmSel0czgMx0mgJC/ze1eHCJPSrkEtvYUmeo04/ik3iM3HrI3FrYuh0BCJPFtIApyAOo2oEkBQhkmWByAsoF/vc4yhQWG6Opq67Gz2kxYKuurqHLBSkAPXiNPa1T4W8AoLe3WlfNE0BygEYddxGuTtdIHEBsAJz6jBeUN+G6YCCAnhrUYGpr6m4DMYVjx4v3iwHYsfgOAjCLSwLhk5qayq8KZx2WdAoNoLcbAWCyQH6aYfaUGwBA10qJUHy7ANgKAq/3CYAdAvC1yj2GF8HnagEA4CAFcoBXh/wr1lU4ci/jx25ctc3tHdUtiRgBsK+TMD0qACOA0Z0xAAwBYQFaAKAHrZ/TW6ZsxwSPeQjTQDI+AF8RJleqYoqrq1FunFZur2bFJ2dHMVdO1NUw3R//rsMXuE6gPwWgBQ85KCqiALSys7AWJlDOBoPr5bgstF54kVw3AlBeQSPETLzbY8Y2+PqFfIfHsYIGUinwgt9pKy8TArD4uSgFIDkATQIWzuKnGaZsw/qgUBI8jhFfdLvEJ5/YyQLMLOD1PgEgCFgFAG+MpgCkpaEDpKenRB393Hnpf4EBdHgIUnsP2ajAOjznr5eJ7QFEQ5mLEsd8IOEjAQEzgLAw6O0dphdC/w8MiMEpYzmDg8cod48AqCjU6rS0nDzIK6qp3q0Q8Xvq8Nw4rjGXi3H2j62OHLbF/RM+RD6rlRBBGKmrwTNb28xtn94RygFQ0dUk1B8IwA2F5SRxIDFix46ti69CHFlEKgc6l0QAqBdVl2VtfJpAPumxIAb0IlRsErBlgnAgsh23Jw4aOE4cAKYt3Lz5zT12ALBCwOt9ApBuCwC8Gxh3DgEARUT/lKi3ljpBCgilnYt4dEdV14zTg3LS+WX0T4BLInbbGA/e2OGjLb29JqNHIEMAVAVKWSIUAR1AA+4TjlEp4RvmaA3FBoNAa3CADqKsEAB68wgjdw1plIp24RfSM2tJmlBHvxqrx7Z6cRP4Achbfr2hq6leBEBbb3dbE71HHA+TIxSQ5Zs7FkPpMJNGgv0IwD5hhy9rgApPAMCOWzwAvSwA5BtfFQHwEyYB/iIAAIE9V6Ht/YQjYJsDFuAAANBsApCGW8egDCA5QGbUUTIK2ItTdwL9ZYEGXP1vqnMTZO8BMhctqobDdzKm6AuUBbRDT9bLAtkmi1W741rSHvyO2Okhu6uus9ZQ2Q6I9TXmALQLQam2AQCKz7YekgSSBeBCBho4FnDvXhtvAMSm8UKYJsEnNzDK1dM0kXb6N01NVQCAwAH2EQD4WmIxXwawexAZAMpFAHyCSUC8xBwAcm/tJy9hAX0BYA2BIiZpymNaZmbm0aM4CthjekFm7txlgUzIl9PjzbRsKYceAB26GnJAdAW+yeQ4oJMoCyMBAB9Rq+Va3DpQlwaZvR7Fb262CgCN5cJHmukL2UGMnc0M2q0C0FpN/YH8RgWaRJqLGjX8NpL+oTpVxABMCABRvYr9LGCkAt+pqq+gEOyoAAAahDMIO/Y1VZRvnSVIE94UpoDdXZgEMFuEImbxKxRmvQl1YNdtibgOmEoAuPqJPQvAQsAKAX0DkG4lCcSsiSZOuWl5EAFScSkQjgJq3DCrg3qcBndZjKmjhwzKCQq4QJmqE6hoZgZhif5hMlUHqJ2oNqjBBOTg9Roo6jQtHb29v2rrrAvPxQCTubR1PVwZIOakw9w5MHag9DUkeewhq7EbuINBrQDQZhJ2d6wCMCtr4L8IqGjqYt+lSEAK2dWFACzmgsK+6/ugkNzODBaRELCkwxyAygpKwGZhsrgDco6upsEDg4WXzEwl91bv7RsASwIcAMCCgEIcCITknwCQDgAkYwqIo4AmVRh03MAwpo4LlBnJvRC/Cip5ENs1Bg9pNQRg7scBoOlo7+w11tTp1SC+VqvHui7H0I27PvR19hs9g9zCFLAMEDzWavZZNSwAzHBBXXWdqW8AunGokG2gbxPO3LfxAFRVVdW3kTxR+JVdZFNxObPiYyYCsKOqvnyPEIDFj0UAdLWB+hSAvRNEFSUmAXMkg0UAbCMW8AlPwE5LAKwS8LojAECWJwagMDc3J5fMA+jwg1GHj76Fo4Am0wu5XB4YwI7a4+heBy7erw0IZNM91NyjuBdvApOxDoAMyAwd7d29dcTtDQZjbV210WAo1hBtDX0AgHL3NluYAgAg1LuF3Nlm4QDMI1gp4mf0Wpe/gQUAt49WCaXFWYcmYVZY34BJoei/aTARAGgaQYeXr+9rACAmLGanEHagsr0cAHjhIKYRBIBrIgDK0HLOScS3TG1jI4AVAIRpoCUBjgEgRgAnAtLSoPzPMxrTcTXY0c9fhRQQnr/SPUDk9YlYyPeYtOz4Hu3zAXV4sltMANP/cSxILm/GZKHHwCV6tdVGY53hBb6+LdV1fccAK0lATzEOAzGf00IwacftZB09v3I30ZJzP+jtpGT3koleA8yHdK73EwCa2CSBjwAmOmjD+n9DQ2eXOErUN3SiawvKCiwUKroAACYgUABu8gD0EgeoZEekpgkB2IcfrKL7AjgANm/Zs2fL+wIA9u/caTUNtCDAUQCEsQABOHYsjQwEZqYjAG85HcVTgdplAaJhW5kRl3RhChAWGMZke6C5HLAAWMLk8Bg4BpR4aRpDczsp54wgPc3ajUZjrVHfayGujRjQLqCEpnMmU3MLCt7TI7xb3uEGKnSSbcFNgt7dZjKJ7KGJ7uHhujsSAAwx8wncJ/WCnoKyEht8UjldCUrzgh07ygTfGfeh11fST6+vjxCNKj42QUbhLeEnBHFpyODX35+6RWQBlgS8uWWzJQF9AUD2fArei4lJT8+FGJB2DCtAHZ4OE3UYU0A0AC073EMzgEBVBynSe4jxswDIA1S9gMWLsFi1Up2DwV5vqG1uwQUCGKQ5HXHnUR05HtUswFuPAT1G2tlx13h7h+n3br3kgvg2IElkDXigfy9/nDx+xDxNpHlid4MIgPIm+KRykiCSsSOkYLsYgLYGAgB+zWbBzCI6BTyTdxgA2L1hU7fsjdj9WR8AMBYgQqBvAKjyKTwJAEARzgTmkmkgAgCmgPDMlTJuJB+6tjJMayK2WssbALwjlyX2gkAv0rTk4o9iLO9aWqDEo8dhG1lVa6HVtdB0rsWRGAC69/Sa/hc0RIFECRIBTF2MAUD+h3Git4uZT2IBaCNfwepPB5WrellKSK1YjhDwDkD0b4JPqCROUr83eMdiZmk6vNmL/913zN6w4IiQEFR0796duxkAPunLATa/vrnfAIgeo+NADAGZmSlHmdXgzcwKjDBi7XKlDE/kx6XXFIAwOu0b4K4n8beFZHtGstW4GVrdC2r3Rl5YIKCuHf37V2uy18KXAjsv2tt/Nf1vab1dnWYRAJLFJlwewlwvwhhAb29XV4NwZLG8vMs8T4DH+YHALgpAFdYB9WQscIdwrqkT/79BdCRg6vY39+zZtmfbro//uOtAHwBwWYDQAxwAwKLh7FlazLFj6cwo4OevDiOjgCo3ktbLmRYW2EG7pDJQztZ78I5cqacPN9MNppDxN9NG07I6I+38+BayACOlRax9M7X6Fx29pv8DWi/Rixm46yZriip4Bjrx42K1K5q62trMSo2GXtH/B1/SVMVNSEyjQ4bMxMJDU1dnUygzI7h1c8S2vdt27v74409sAmBhAQICXgYAHAVKO0bHgdEAjtLV4B0egWFCAmQqE9nH+4Jke+D9kOtpYvBNC8nKemopAAYGgBb6EnQwWNBWZyAP9zS30MQQTAOH//n9wf8HNSj/qiAocAZAT/ohgorFbupuM0OCBApzAHiQ2JlFAsCsD0yQnW5kCsHtmzfv2bZt94GP9+//+LPPRABYWMAW3gE4AiQO5ICiBIA6ADMIiKPAKUeZ1eBad3Z9JQOAwUR28OtxWZ5KnaMxVOuLiw2Y29NY3U7kB0mJ/O2/vmAtQEiA0UgyujoDCRh1UCz0vERCb+txrAB77XzRyzgMGStmD3qr6CJ7PMSdHZOI+op6i3KCbdRRiAOQoaD6LeykAfGAN5gkgAKwLeL9PXv3Qvzf/wkPwMdWAXhTaAEMApI+lWf+IQ4B0Ix5+JHMFEgBX/37P6FLhgXIhQAEBnT0EK8vVkGnh6bNI6qCtsV19JVtNjAxgAZ8Y7PQAowkCgAhdKjX2Pzi199q+KApOe3R5od7UXUr36XXURK4+RxQsLKs7Pq+ShO7yEQ0LthlHgBMYgBQ/6aGSnY28toEJgkkBCxqxyRgsCQYk8Ct77+/5U3Q+GNoAgA+3rlTgAAXAra8udkMAYm9Pm+t+2MIyMN1YLq8tBg8GgoHAUgK6BEmcgAPpYkMA5p6yFqtvGJ9sZ6R1qh5QV+m5jpRzl/bYRImB9Qf9LUvL3hnZ9vztqbH0G7dvFlWVt7QhZeAsW6bGBSVfCQ5KugFZ+E4BtTWUFZWdvPmrVuVVVCrNbW1dXbb0JqnhR/BYTmij3Q+JmliA5vnMZ3dIgA0dIoBaKN3lXHT0eWLp02bxg0ZzbqDIwFz6WjwQsgAtm1DyT8BB/jMLgBb3nxTDMBmEQAp9poYAFwGpAMHAAIOQwr4L5gCxsiEBhAW6KrvYEJ1uwaLfbD/YlbXPAN9gXqE+iMCNDkgyuu1eXq0/L4cv9d8oKe3uxNevapbt27iEdzlZfv2XS8jx3CXwSuNLy3z2R0uw4YPX7r01VcVHYyC3eSFbyvfAZ+8b8eOfdfLy/ddv47/S1klHhEm8oHuzs5O9iYpq62bswM6gcjUBVW9vV1tthMAWldQAKoYACpxQnHxYmbAaMfiT0ydbW0HJIMnLFm0CHv/Ngz6n3z8GesA6AbWADCPAdgkfQjP6i9kII8AkJebhoMARz93JikgHe2R8wM+gfoeti5vSUQAoIHlE9evNTK9rr1WAAD3sDExr9hQ29JHtO+1CN+dpAvjsbvlFeT0dQSA/IXj72XkpYbwyXxVu+fSpX5Ll74V6Sw3MUklJaCBrveEdr2cPcMdj/EtryfCtHWx4YScHkpAoCxYp4F9brjxA55YF44c1NtOAIAyxgA4bBoa6FgBTiTh2PF2MlIsGTd7yVZyFBxF4DMGgI95ACzLAEsAUlL6B0BGRgaZCgAAcgkAzFIgg4z0exkd7FGq0rRGPsFqTqMA6Gl2h+N8zKKNZib8MweP1dJLRu33e2Hi9s8nhkSVPPA02U9HB20x+OLp+6hg2b7Z3PlLSyqhca91j6nD89Wlo9EDFEMC2KqilyZw5expHWgDSACxgevlzCQgmaxbv3LjgfMPwRe4M0SRhC7+ljErFHSTMgHqBLYetJIAwOd2CQCoryALC6rY1QVoBUue474Rt4FTZm3ftg1qAMgB93722bVrDADYdu36fQHAlsE2siMA5M/FeQBIAf8V5wGUZBQoTJmWZ9TGaPRGrNu4H9ykTyPdv5a1ehCdCQJsLdjc3v6i2VjbbrfT88r/80XpaRDeVeokkUicnBKJOxP9HzeU4SkbS1C9HTumsAeuT5k9+1ZlZQXf2doDXl26dPjw4W8tVfhKf2U9oImO1vFntAqPbyqrryStC4cCQ8jNbQMHefvPW3fuxndVDW1tlIU27p5BC0tgvnVTVb1goICMJwsSi17cFdJEflexk5BVOM1MRxIB7AYyGDlPMmXW1m2kBNi9a/duIIDXnwFgpwUAb74kABnCBgAAAiRtgBRQcvTv/9VjqvPA+z3IOo48Qx1dwlFbx/9kTK7PE8Ck/KYWBoDaF+0dv/aY7CTojPK/GJNUgSMZ4YcNGO43evRrw/XktLgmnIupatjPdV8EgDlnG94vg5qKBaA90WVIZOTS0QPQARSjNOw3ogCA3zL3vE0WHuDGANCEALStnzAbTw4cN45e4UdI2HD+u8oGTBzJ6bJCDkQoYHoKEDDrDRssKpHeJhJrmvBz6MQyBwC9vxarjK7vJBOWQA3w/vs7d773h12f7WUcQKi/OQBbfi8AoPvjnAAC8KrzF7gjtAUX7dFkn4zVUGNv4X8yZmyPbwYmDahFZ7BT43Ep3j+fnFZNH+lClHceNgDbcD8/v0j4M9y3g+la6AA8ALMZB5i0j1TlYKpMIhcr9VwaiQBACHhVoVD4BgbI6WwwvOx0GcaSiTwAUwQAVDTg3F5b17oJO5YswQ3fE7AcGxQczNzlOMh77oY/gyE0kZOFITBYdQNaKmK8qafVhKi1MQAwi8+qBPpXgGH0klVIoZJxi7Zu2fL++3t379y9e+/ea3s/MzcAMwDe3PLmywGQIW5puCQ8PSUNHeAtyVISAUwdeQameGfG94nKvKO3G5lMj+SApNH+/qvNgN/LRub/+hall1LlPcdA7kYa+LcfqIgEDBhJv1Pb44bHTftn8yGcuaEB51zquQSg1xTw6mFyoAHUAFAFREWlKDykHUIXqK/fR695Ep7thQBUNJAO3Xl+5vZ927cvicCj+kNCXn99O7ZFMyewHAz2Bj+oRAxIesC7AakPcNlnL007u9i7SATlAwtAU30VMbUqQdbYhl8O+ntLxlEA9ry/c+9OAGDvtc9sRQABAG/+PgCQJcEkBDh7/gsBwPRCy0zuUA7oZJ4gkX/B6s7V+Ea7Yza91PDzWelfgZwN1I6Kgso9KAj+QAAfHUTvKPAbpqLZo6kTXjoGADyWmb105Sa8iPWVbWwOaZIvjWQAGLb01aiYmGPHFO7cU6Wv9hJybeOk2eR4Z3oWPABA9e81NU5Ysm/P9u37IkIipkVs27Xr4137QYI92zZvX7RopveIEcEUg4GD/deeu81gQN7w19DSt6Ze7mZS1iS6e0kWCF/ErDBgez/gV9VtItcWVA0G/cct3AwGsOf93bt3ggfs3ivQ31YK8BIAZFg0cqEI5oGUgFf/5Z+EgBYtDwANAs3NdUaegGajaIDHWPfC7sDtP//zjCrQlfR6sPply5Ydjk7Gg0iiUkD8qKi3oxAANIDly/089Wy8+LW95elP+1j9yfHLeNJ2GdqooNqSLY3EQ23QAZYqYlKA6DAXbriPBQCv62NufqME3IKu2GOigz2PIpbs275n/1z/uSERf1wH7ePPAIJd7+HVjSvmrtk6berUqRFTRwwaSKPCxhs/MRh0CtyAvYUE/tn4XJAvkCywjcwqVdJVBvRNZVUv2TnedmfQwHHjgoMJACQLQAvYzchvywDo8eH9dwArAOCOgFw6eHT4Lcmr/9LzT/TV5jwWAN7sDQaegDpO+1obts9o/19/zVD5DnEi0r82+rXRqH5k5OHk5OS334bnExWEl5MEBQ0fTQGIHFZrYtYB//KktPTBT4+RAOb4dUzeK8vAARpo/+99UatVyoYBABkMAEsBgJycmMDAB/w4DG7jmL1k9hR6eRdzkPvNO3fuPGLmLLt7HwYv2rdtz9zQ0Lmv/1EZu/Hjj8+d+/izAwfiNx7YtWr9hvVrV6x8932ouhYsmDY1eDDFYN6B76qa2NsH+FvJ0RseDz7Z1cZhgVlgW1NFhfmi1Cayb7St6buBRP/gBVsoAIwFfMwDsOt3A8DSADLIurA0Mg4Yg2dDSV791x5iAi/0Yvmx5fNG32PIywNGmtt77Xj+/y9V4ekM2g959a23lmF7bfToZW9FHj4MBnAkGX8jAODfQX7UAZYHOUnaWf1/eZKfr7/z050lFABS/V0nS7UZ+zcZpc4SZ8wdUjKjlpKmgAiQA2WNzC3Aw4OZpcBVPdD9dsyezQNQduvmzcpHtXW/0tHGNp+BEdu3vz43dN7cXZ99tPHgyZPnz5+/cR5v21Oo1auwHdiw9g/v/uHdLdu3Lpo5g1IwcEToRi5D5ArHtqoRkvmCCNHbZkV/srasF/chnZcwO4MAAELA7r07IRHY64j+v0cIoADkpoH+UWQygBBA4zzN8QQAQIUvSAOarSb7NNH/53+dpf1+yKtL8dj5o0ePHgYARgMAy6D/UwDwcHoSAiKDIikAw0ZOl9cS2f7rFwAg8fTtO3d++mkJewUD6F9ZWVXVxqZ/eqdXPf1G+0VRABRYBCooAMdiwrwkesZLTJ2VuCyfVBH0xh7U/+aNavjRkIBu08OBIwYOWrh5bkCo/3vn4j9OSMg+f+HC+ZOQHakVMYSA+D/Hr9q4ceOqtbvBCrZuXQTZQXAwQ8GGG1VNLAWQ7YcMHDy4gScAezmav3jFSANZLNbWdo7VP3gz6f/vb3l/9/v42yEA3vy9HCANAEgh58QexVKgB/eGm34VZnnsGM8L+2M7pOP/zwzFSPR80P5zov3Rw9giI4kDMABAO3IkOSuZdwC/SE9lD3NmvOmX//wf//nv8ukXHz9+/HNj2RJ6PQsp3QQAaIZEwpf5JUdlZDAAwM9wDOpaAGCV2kXLAtCGFT93wefk2WUgf9n+dQW1lIDe7uePHj2cPygCYkDoe+c+PqDOvnC+8MJ3F2LIsXkx5PzEk2r1MbUagsIf/gAQgE5bNm/dunDatBEMBbvQC3DMLwIyOsl31A+oBzTw/Z95D8rPbqL/AXJSMNkTuhD6P/GAnSQO2ND/NwGQYQ0A5k45PB0yhgSBpZK3mCjQnG80b4b8dnuZ/j///tfkMdDxnYcQ7T8nB88fjU49DHF/GesAgMDh1NTUIwBAxttQACyNxCIQxwF8+Wrxl//xP/793xVjVAX6B08aqypv/f95exOAJq+s8RuXqmOFqq2MVZBppWPf1qUubcdKdWqVHUcBO0uniqLTGSp9W6XfW1s7WtZEJCShQsGYQIJiayAiRBJRNrWKC7hVbA37UgcIW0CQsHzn3Ps8yRMWBWfmf4QQFgU5v3u2e+65V3evfXVtfek9/NPK2prtYxzg79mACwh1syEeAGedxsfHxe2HRTsxwQKAe/8qhDhw2drCa/fKiq9e3f3OO8erNHV6AgAxA2/NAwB+sxxvVN68+f+OHYuNhQBpv487Ff/9sbHgF47u2bNn06cXL+764ZMP/vdP7/0tYOWCqQtoYDB+KsQF//pfq0kAwB9bOQSU4tVRFn3E9f3d5BjiX0H/L7/MzATAKUbz/obFQPQDJv0PZQBMl4qPBoCoIWXD/nhybNjdE7eDMZh2tbNyvdA5kAAZEU2VoWe4om7vBbG7/dgxxOhT5fPw3gkeDwx9sIsXBABz5jAAuITjx8n1FKA1GwdbAoCLrX0f86/3GHMAgBz3116bvbWq7hdc9gDBPQj/UZOm/bat1oDOuHHOzqGhDjZ4yxlqChxaPAHgxe3sTgMCAMbj2tqgwiL8B9RVxaB/AKCqrqoDTzZhHNC/+alfP/vrKdNnTZu7fPlb6/GuXQBpP85PJ2DFHjt45crFb74BAo5evHj58p5Ne95//5N/rHvjN2++vmrVwgULJ2HV4CkI6ea9NH5mY6u5ioz7UhaNxI2M/v+I6/9lC/nbzo93/e+HH+/6dCQOYHQxwDAA+LMAYE4W6kmiaSCglxCglYHmWfVr9Z3DKL/XmBzibj0WPL5p4YeH8/k8IehZiAQEz3GjANggAOFoA4LhGxIAHGyI/kHGPEfcf0/d6VOJiYmHDye6z37NZy8AUEoUX1ra3dcFzrYRLxjuedC0fYW9sysDQJQD2AE3YgDwqAMBYPkLrL9qBR+MxSN4KUICIMH57J2/v5Nm0NfV6Q117dSAbbZ6ZuIzU5597rkXGADc3Tzd3OAfdHOeu9zdM/JgbMrlo19tAy/wzdHLly9v8/9mw/ub3l+37o0X3/j4vffeCFj80ssvzRs/CVz6S5PGl3Jyg4dYIuimtULsJCb6h3DhTSucCoEELDYBsGrnxztJKGgyAJ8MdgDvPgEAQ6s/Ohp+UfuJpwOhl4XBmrS2CjcRIGOUP0Su10eUz1h9DPVNyg8PQdUL5TwUeBrs4mBLLYDNHEwGMBUICUECsAg4ZsyEp6e9sMJnK60A1J06dSrR29Hd0dHxNfetW9UEACLmbo6eF6bNmGEHCvIMnW3t5hwV7YAxpDMDQGTcfnf4j/3m1y+8hrdO9XW1tnZ1dfVBLEbkOjYofPbOOxLZoajtCZjpdGLS+t2kp2jlb8LM1wEA+KWAwXKFGBa8i727W2jstpSUb/wPfrXlq68gQ7js779tw56jmzase2P5H3b940/r3n7ZdLYHfMBRuotgFqw49XdhaxjqHxtJX2cnxeP1ACYLsOvjXaQa8Aj9PxEAoUPrP9p97gZfGuugoSPqd7ZDAigA/droaFlde89Q27hE+Z72k62sxlrDr8nVNZxVPi7taKEM/iAA+OAFASDGgONsbOfYzqGVICTA08HWdsxrmqYHnC4sCgCIu/uhw1u3a4cCoGkCRA5u7s6Os2fb2c2Y4e6JWrIbR9LAyP2RsbEbYmMheF/3m2fMVeH+Rqr/e3cBgISEL3yIe9+qVjOhbV9XS0XxsS1/WTR+/MwX3tpGfiXOrmC0wMi4unkegHApZZsvJIhK5RWQryApAG/wl3Xr/vr1p59+sm7ey2YCXrZ6k5b/BkPQ19r9kOh/ptVL3PsiGQAWrnobK0IkBviEAjDUeIBRxwBDax/EHoQC4Mmk0kTG4umAXlLdH2z3e0mk1osrH5RvR5SPfyk4HM09Kha+YzQajuhoIUoIzwuSwGCXOTa2KHNIHIiYAAA2NmMSLJuB6hJPJR4G/ft4R2mNddq6oQConeDoaePo6Yje2c3G2h1AYgCI3B+3/+DBgxuOKf3nbtiyZd3EZlPvTysDgA4tQEZdlLsPMLAdi1kd7IkhtNWNu61mLl/uj3jY2bgCswCAg5sneMr9sZANQCSoLL5y5fKe9/8KEeFRcAF//frrT//6/gLUH7n4FwAY/9TRIlIgoBQMuLCU6t/yvlBOHLBwwYe7dpr0/7+P0P8AAkYFQPSjALBzHoPdwdQIWOgeW4bh8UgIZHqQ6LlSIdbX3TOEF+0ZGh0dSgGAyAHeYAQAAISj659jY2MCgBQDQ7AGDACYmnaRrDaIABAA760AgNFoqNMPBkD9tKPbbEdPd8fQqFBHG2u0JGAPxrlhRhu/H7L4/fFKyAT9t2x4qmooADRVdXVq4ve2Y3f6A2aSBxZ3Hzwstpo5a7k/fhIMIg1QbN08fT19fQGAYwfBA4ABSNn0PhiAPXs2vPXGpstf7/nkTUZ3C8iMp5cwHnz9fZoaDjQF8Lx05hD3xbIzohZgSWCwAfj7vwHAcOqPjrazs2MBcOdYAGebMXhdANU3q3oqxgs8d2vI9OxcSZZPtI/hl6e7JzaWh4aSh1AMHmXwHO8hcwtGALAQCL9LG0sAHGysMiwhM9SdOnzY29EbfsxMI0p7PQNAn6kDKGOsG1aQQt2jpFFuztahoa4OnkCCW+gByAF89yuVscpUX//Ybf7vP6UxAdDFAlCHYpARAKI0as0vHab1D9l5d8X4SbPmbiYAkC4DIMDW1RN/SZGR+5XHUg4eVIIZ2LQBAPjmq/ffevH9y0f3fLKATeWYUW8vvcSUjNEUmChgzgn9a5LVENcFUwImTVr48cc7d37CyEcjNwCjACDaDADJnrEOMAAAGyu7mF4jUblZ+ReO8N1mjGWVT2s8NPgid01QAAABggG+B68hwQAAfCEBAPRPAMBiEMYKng4sAH0dzfdRfvqp7mzd6cOOaAKiZMZeAACvXcNEsJQNPPv7M2aFktXvDv+12dbWM2bQXgJIBMACgOZjY5XHMHPftuWpDJKp9JkBqO/ubQcxyEgQsF1d1dDwU2MLCvYM9yEAU1+Yu54aALQAtggA+gDPyPi4Y0ql8pgy5WDKlrc2bNq05crlbzYd3fT++39YQCd8kZHEzLy/l14i+8njJ72558q/zKagsfHepPFD6Z8gMG/8vJcXggn4ZPQGYFgAhl//0dFsBR235iwBAAKOGCkBoAR4vcDHyv4Ya5rqMeE+ZnOeTK0klAUgitE9PoTyQoLdqP4JANQFuAYHe3mRGMDBdgzZYXjw00937/6EUnW6ru6k96FDUVGHtHXAIAkNGksrSyvp1aI9HXq9j7ssSubo7j579gyIAeHRDTICV7cQN/e4uPg45bENG7b4b3gLMoFNM7ea9qYIAGQfsafd2F53iFoAvaGjqbK0tLLy+vXSyhY8ygMAvL7cZwAArp6Rnp6Rcb6xoH+MAa/834YN72/ZVnzl6PsAwF/+Qpz/yziQmhoBdurbS+zu0Z+P3qMQ1Bc9NR4Sv8VDCq0LrDJZgEcbgCcBgGeh/2hmD8VzCABssD8Edd97AVZ+sN1YK7r0iddn9G8BgGcwAcDTM9QEQGg03kVKUn8KgK0JAJIseMK7Y8hhgR7UvWkw1u77bWim29qMPRaNZDi3gtxh6e5j7z4bAHCcAQLfG4KPkBBsMdgfn+ofr9ymPHhw+YY/vPXWhnW/fmH5+oQMNViBrlJ2HwkIqKtSR0kAMtN3/PJ6KQGgGwCYuXzFwViSBZAYgAIAiyQy0t3/2LGDJAvYsmHL+1u2QCyw4ej77296nwCwYOGChQvffnvhwNmvtNds/Mw39xT9q/7aU+MXDyfzJqFleHnVroEA/H0E+h8MQAhX+7woHivRvAEAODsPBQASgD4/Jth5MkR8NNejEjEkAOGhjAtgAAjFjg+eMCSY0b8ZABoBhIV42NrajKljLMBPP+0mbdHYGH3fwAAwsPbw7LS5EL37RtES7Vx3IGGuj7sdsDDD3dHZeS4Y/g2bt23ZdnDberAAWzZgov6bp8ZPaLI8ENTJNLM1r32FbRm9XllJAAAXMPOt9SlKEgO4YeY6DgHAosOBSHffg8e2pTAAgKRAFJiC34cCsGjBooXk8u8h5v++NI/4A8gyh9U/rH/ydklAwNDqt9T/o4PAEEaizIq3EKJ/IQcAZ+cBBDjPsHKLCXG2HkPsPqZ6ZgDCuQCYCAiN5ix+vIEcKwJCHjqAOXMQAJIGkCzQzQs3g0IcAAADBwBG/7t/6iD6rxsIQMcUd18fn+3bJQd8fIEBH/dpMyZPHmtvP9eevELw5u+/fPn6FagToqFtX331zTcbXp/QMODfAeVrtdqKSvPd8AhAI5ns+hQCkIJlEQIACASBnjYO8OC5399/2zFIA68cJN/im02QDW7Z8D4DAAg+zJs39ARoYgsmDa//l8zPzQbg738fXv+WDFiZtc4RHm9YACBFJ10U5vTPjgMAKQiNtRozBgM3kumj82ctABsDcE0AhIEkBIxmUsFQUu7l8cjqJwDYMgC4IgDw7Td6ONhMIAB0gP7vMxPREID7HYY6cAMDqxC/THAn+s8AAMiFB/Qbz4309fFdAQis8I2LBxSWL1++YT0C4H/Qf9P7G/7wxlN3BqQauPy1tZWDAejra3lq5h82pRyM9XV3dnO1xW0K+P8DCvhbQAD8MRBUHoN/ffOGlKMp6AU2UADmLTQPfR5S/y8vfpRwP2syAH8fBQAhIaMAgEdqNB4bN24UgEBUjrsAlAI7CoCzHZboiTOgBEQcieGTAJCxA0gAdvaZAeARtQMBngwA4Oh5IW4urAUYZ0u3AzAGwG8fBlnAhA4WgJ8sAOgB/VMD0MEeIejpl0zw3Z4gkaironzw6jt3ewYArGfYT5v13Iq5vu74dO7cF/B2EX+AAABYt+6ptAEk6TVE/4MAwMM8Ty346PMt2/x9PZ2ZNJALgK+/fywCcPDYsSuQDaI32LDhD4wFWLhwKAC4uz0j1D8LwN9Hof+hAQh7pP6FfgI/P4Eg/ZQTQOBhy6x9IMDOBt/QXRpCgLMrGIAjFyAejKEIEArC3ajQUNId9O1JokAmEkQAPGkIwLgAW9YFBIdsDNsIBgAA6DQDAPLOu/j4U3NHT4/RyOz7z8X0D89/92+1whDAxydKJo2GwOYAm9fgg2R71AE85gRo+PruBzx8IW+PPYiOYNNT3w48FKzXVlWyAJB+MwYASBefWfDuJwBAnC/2qI7DzSoWAFs33/37Uf/HDm7bti0l5auvsChocgFD+f+RGoABnwT9/32QjB6AsEevf6Ew3YmIwMnDw9bBw8PDBV4d7IjqGTEbgYiYC1SOAAF81g6A+l0Zt+HmybR6MiYAIcCLqF1d5tAtgDlsDIBZIH4n+JY2E3ssAPiIZgEdpt2nvv40q9dYC/CaFbPmo5JEuNGkyc7OzstW5IpFIlEYvCbJ5VpFnVyu0WiIl5PGk/Ntbz21nowP4F7kYHhAADBd+WwC4OEzT/1mvf+2uFjwLzQLsMUgENm1cdu/Pz6e6B9CgJSvUlIAgJQNmzYxLmABWoBFr82a9sI77/z+nTdnLrAk4BH6nzcgNBip/rkMWI1c/SYAak7VJJ465WTr4eCR6CDwEHiIvBxcqeKp9tkHGxtX/gVWzre314lNnsCV3QxAWxCMO3Q0A4DFzxPyQgAA0D4BAFMABMA1OEwo2LgxzMNjo4fNFGrmf7pPAdjNAmA++SeZMG3W1q3b0yBfnDgFy1bbo3xCQOE8UZhMnCTOzhaJRbwwLy8vkRcwIBfLeULcyFZj32IcxgMvvvXUC/0Dzn+Te50aG9fS+77NLqC/7+Ezk/74/v/FHjuGIYYt2a12gP8hmi8btAD7Uf/+GzZtTqEuIGXD+1ve56z8d/Z98cVnKzav37xituNrr61/cyQAzBs/4JOj0P9wAIxA/UJhdWdNTY3RwyHLweOMINFDwI/hu7qOo4JKpyU/Inx0AOfPn28noq3T8i0QQAAoA55MEAAAYBmIAWAOAwC8DScRAMQewICXGYD7FgD0mAHIsA61n/b0BCurKbOIAUDFwHL3CpNFqcUKhSIJnnsBADxkQCSWy0PkEOHLZTKZOiNu+YoVy194a+bE7Qnfg2RYHFPuqkQAmANDV1kAup+Z+fnnr832OeYDWQY2q9laAuAfu20bRBebNnwFAvpPQSfDAeDvxV9cvvwFyGV82feOhQl4eWT6XzwK/QMA9C0XgLCwR+nfDECbsabmrFEgMCYmOuTkeIhc+OHwPx03lgEgIiYm5giVC1z1t7dp8/Lq5AwBEfBl8AzCBGds+SUBIAUgGveCw11YCzDHlrgCAMALADh8GCJQjxkcADiFIG7rmQRUDt7e3X3WNKJ8fPX0ComO9gnVJsm1crmIHxZGEAAJE4vkMm22NtuLJ4uOksTPtccD7n+a+hTI1KmL9ry//I7ZCDRygkAOAPM+/3zzCv9jvpG+CABErpAOuBL35QrRhX/swW37YyFI2Lb5mxQMBP3/8Ic353EtwJUr+4CBK1e++Az+vPn4QHDe+EEfHg0ArFiZlf9I7XP0LzQaDNU1bYmJiQLiARRefFeS+YxB/Y9z5XO0z1E/GABtXV0eMQIgF4y9dckIAwBAtgdoJIAZAHwLPq58SwDCvXhC2eHDMvhBvWZMMwFAtgJ+wprwXS4Ar03z9vGJ3L59e2jURmwT8Dlw4ICP42xs1nKXadW64zK+l1zjAQCEbRQluniJZDIwAFpP0N/6zf5z567fsP6tv2za89dPPvl019d7Ppm6ud9kBRpL2Trg1aulDAA9fb+et/vLzzb/UxlJAMCVj5aNAODgjhYATECs8uDBTZv/vhvdwAbLyO+d4uLiK1+A/q/v+wzknaGygSH0/xgA3h0hAFT7CEDYCPQvJNttPU62oH5BgcgjJpxP9D9uzBhr63FgAEzaR/23m0WLhbo8+DXzUf9GyNiq0CM4u1oA4EmSUBdLC2DrEu7l4bURE1CIAcIsAWju6OjAVxYAvJR21l4/H5L8RUmivDeG+viERoWCGfA9AAQ4ytU6lZrv5SWAmNIjTBAmcgnnQxQgV8hW+LqvWGE/d4W7+2b/FWiu9+w5ejTlmz3/+E2fiYCWu6j1SpMQAPqff7nw8hefKXXFqXG+GAPY2pgAcHb33+9/EAA4ePCrLRs2vL0rJeXoV2YAFi16/S+ff34dLMC+61euX9/nzbiAIfJBRuHwhtE/7Qz7twAApZtkZAZA2NlpNNYYnQS9Z4y9xhwvLxcHNP5jxwIBY8bYRXDVz9F/Zx0BoA4AqBLzY3p7sXLfxHiE8HACgBt5IR7AhY0BEACHOXgY1Gmjk5/AyQF+peNmEYvMAnCfEea2sP6mKS+cOLR363aJRJKRkXFIcugQU/vxjZRG+vp4ioTwh097TvF7wDO+GGNBmb+vL558nAtf6m+P9xNtw9WasufTmXOb2BECLZWWQgH4zbyPNm/+/7Z6b93q7eiAaqcAkCfwj23AfeZtW/wBgE8upnyT8tWGRayGPzuxd+vWvcXF1+/erbx7HQi4e7d4/cx5wyFA938Z/S95e8nCt99esoRy8QT6f9dqZOrn6h8sQE1bb4/AKfEMeAGBwMvDwQXr8wSCMa4xrPFvHyBU/wgAGoGYXrrDXkfDwmBy7DMkFJLCYEwCSAnQlmYBTP7nxAiQYAEAMQAgLAD96gmzDu09tHc7AJBBTqKp1bJDUWA8HB3dPCBND1NANgD/5JwwScJ2qWS7RAsAiPgAgNDZ2RH0FhoHidt+/7i4uFhy2uOrTZsgHljfTY+uDQ3AC5Pefn35ivXejiBbt27FkMON1AEoAP7+x0DACGzbsuhPR785+tUWEwB/2Udlq9++fcXf7dvnvW/vVkfH2Y6zfzcMAy+9PH784iVvv71owe/xNCC8/v2dv8O7bz8RALyRiNBCsmqMWYKsRCesAQgwDcQ/Lh40DYhg9W+0VH9nu5ajf21dspa+n0dzw3BMBkNwQwDUHxIeTpYmBcAhOMQjLDHpsOAwiMDJyc8JAcDVyC79ZmQAXAABoGf9hFnbt+89dCghIU2aVoVDidRVVZmnTyWe9rDF0pKtR74iX5HtFW4ruVf08/WioqIyFxcveVJSkpznYOsA6AXrdCqVTiX5/rtvvz2mPHbsqy2b/vK7ReN//X3zUADQHecX5q19d8+2bUqgxmd7msQHgglnMwD73eOVyuLYWKVyy5ZJi8AC/MOs3E37vtj33RdAwN59WyEX3Oe9dd/WrZ999sW+z4epDL40fvzLO3bvppPBvvzyKoUAHv5fAVCTVZMlAE04ODl5IAQOiR4uYAOI/p1ZAAboHzyAjKhcyxKglWnrDAYSFgIBpDxIukNwLzgknFpnAoAbBCkiCDlPZWZm1mUK/MwAkCn/KB0UAGKim6zmbicASCSatISqKjQCGk1mtUGhADvlAhG6h0KsECXxvWwzSnW6Mt31K2oAAD6WJBdh+m7r7KlKk8rUwmhVccL3SiWagG/++rt1v1tg9R0anpbSQRYAAFg+fu27X23b9l1cXML2BNV2H1/fAxwL4OseqzymBDMQu2Xz1Hl/3bPnPTrpHWUzrHp4Ob7vu+Lvrly5jEYAAkKIBD+fN5S8NAlPhgAAXxZ+ycjVq1e/BBYKn0D/IwPAUv9CY1tN+lmBk8BW4JHokUgiKYjQSCAwDjzA4OiPyQFQ7SYASNKtBQLy6mIimPIgOgHcDOZRAGxpHcANosLEpMRThzNR/NALjHth0ORG08zPqgk+27cfysjAOXMHJMQCaKq0mUkKRT7EZPhTeigU2QoF32uOul4Zp004el0DLkAhUiQliWyAD2fr2WUq+FtiCBUlacWpymPgvDe9/+d1vx9PAOjCViDsGe82T/1BAJb8PuWf//weLMD2NBWOxPUlMQBGgxh+7D928ODm9du2bXgLxztOnTrJRMBf9n0Hqt/33ffFx0H3l+8WEyAuf/HFOwNVT2Q86QxHC/ClCYDLV8nb/xYAwoEAGI1ncvzSBZADnjkjEDhgLVjk4kIqgRExRwZGf9QA6LVDiFybl5dXF2FqE8VCIDqBkPA5ZgAc4EcAA6BFAE5l+kHU4TRu7nCjO/v6JWNmuzt6b4zCmF8irSInVfV12Ul8sAB2Dm7OdnZeoGxRkggAKNr19j8WrbyCAIhF4AOENg4ONs4z3MvoHbNqdUZaKhCwDQ/4vb/h9+P/v+G+bU//W5Pe/eOxY/8sVn77XVyaLiHSZ3uUm6cbqQlTACAFOLhtW8q6SaxMZQjYTCKA744fP15MVj+w8N0Xn0FK+PmQ+h9P/MG7H+3+kmXg8lU0AfD43wFAOEh6jW1GY6LgVKKTLdYBRAKBwsPLa46zs6uNK/EA54YAgFE5Tbc5CMjrjpiaBtw8g4M9SUcgFwBbsDCJSUnazFN1daczBRsh7LB+BABbx8ye7ei50Wf23EiJNAMn1sjkiuy6HJFCgd1kIY4zwrKTFGJwAXNU1y7u2rnz44sIQDIYgFyhs6uDjYOzu0aDl2FUyGQZKlXxcSUEhP7Ll2/4x/j1/T3DA/CP9/957J/bt/p4e3uTGM7JwdGdSQPdfSkAX205+DsuAISAP+6jLuB7QOA7EHwHxCIXZPU/nh4MfnneajodEgi4ih4AAPj68tUn0P/jARisf7AAbW3Y9pXlBJpReBAfAKkUFnYjaA4wWP/twwAARoBvAiCY9ByA/rkAuLg4OAiy206drqsCh1EtwALUowBY8TS745+QkHAoM/Pw4cRTotOGuiRFUoinja2nu7MwXwECFkBTUQF5u04HWYBXslwuTw4DAOa4uPkAACpdWXnVoQydTqf8Nj5uv/+KP7z45vgXHmEBnnpn07Z/bp1tYzPb0W/vXr+9fhCsONJCkBsA4HvQfxsEkwffnDSV3PPBQGC2APBajE+Ki7+AWPCL4n1fWFoAVD52B9GQ8COmFlV4lZEvv37/6hPo/7EACIcEoBdfIAUsSATdz/FwgVTQxcWVbP4O5QE6O00eQDbYD+TxTb0CeEoA8kAWACAgHPJTgeDwKRICVldnQhAI0eeYuSQA7OkbNAe8r3/WdIgB7O1nW9sfkEgFoP3ExF8STxvaTp/OiXLHvnBPUUF2dja4AJeqSiBAV1FRh1mAOFuey8OhcwCAXlMGH6+Fx4qKSt338b5z12/e8Naf5z3TbfENacchuXaqf/mk3V+n/POLfVtx/UOq4gcUOCINtg4O2PsAccSWr7ZsARdADb8ZgT9+Aea/+O7xrRACfFeMFHyGEcA+kwUghmLSJDJzaDxDwLsMAEwMSJ3Afx4A4ZCCHb85AqMg8UwOrH6Fi0jk4cL3ciDbAAiAhfo7Uf2dnXXaYaVOz+4PkL5veDUBYDsnXCgKO3z4FGaAfof8cFWhjLUf7sB5T8+Up+diq8cMe3dpVa0WXBSyU11XV332NFMOSjKiAQAARGFYX/DyEqELSD6f2yZycHOASCRK34RgQJSaUabeGJ1x3NfTfcX6t/4w06qB9BjQm8b6uPj1vfXU7q8vX9m69fi+E8edbOBnBAzgh/U74XciCiyA74b3t2zZtOf9Py7iXvZFLn2ZNHXm7zZ/hov/ODUDxfuuXy++fPny59w2kZdeQv2/9NIkCwCQAULBVQwF/+MADK1/sAA5RoFDYqIiMdFDYFTA79gLDfU4CAGJAbBUPwGg/RH6r8vTysJp01B4eHAItv8HuzEuwCVcJBKLDuPyPwk54I/VmYcF6eACrKbZz31txQqfrdsTJBlqTZ2hkx0SUGXlfgB7/+zd3TWgfgcXDxfsIPDyyqymPd3205MK8B8VudC2Q/wm4eH83OTs7LakcTZ2djOs3eu0quJinReE8V48D56X8ICv7/K5s1540WrrgKnurS3NFWXf/3Pz+tcnTNp99P+2bd2678RPlU57f/rpp1u34OWW34m9TlF4XHjq1L/u2bRpEXr+SWwCSCYMEocwb96CNzdvLiuG73r8/c/feefN3/9+0YIFA5J/HAzEXhZvBmD3lzQOGJgF/NsADKN9oVicU4BL/xTEfomg/USFi0cM38PFFnJAAsB5S+NPRP8oAOpgqYWFUwDCg91cGQBsCQA8kTApiaaAdVWZmT8CAJAHOM4eZz1u7OSxY8eMsYI/YyZMmPj003hv9XMT7EOjog4c2O7uE4rNQ2EEThJIOHhG+s6FjHxuQYECXICCT3qOHRyw2BAuTk4WJ+cl2Tpi/ACJaNSmv6yPcsNjIx7wEhLq479ly4aU3038PuH777795+bN69cvf37mzEm4XchY5vf2QBa4dd/evSdO+AEA9wkDJ7whGEAL4A4AgCxiHb8ZgKmTSGfom1Mnva7G8tP3aBkGVX/mjadJAHsufIdZ/btR/4XoCP6TQaBweP2Lz2SdyTnjQSoAiQLcTee7zPHiu4wbR3PAIfTfXvdoAIAAvYIUBMODSb8Q1wIkJSaePnyy6mRdZmbVj3XpgqwsbEjEknDYxo0bPT0dZzvbYKe/9a8mTx47ZvbhKJk0SiNx94kSCCBVqVE40N4kW1uvEE+3kNADoULsB+OFhZHtJgdbpuMM7UC4i4Onh1uImwPw4u4e5QYBnByshUAkDPWFFP7Ylanjn6JjIEH1EyfMW/j262++OfPN9957E9R/8Jjy2L4TKE4nfmq+hRbgzp0Tdw7d8sZTcJMAgD17FjCen1Hw6zMnvbl35rxJv/vss8wVs9aTWxgSFgwu/8Hyfwm7g18ybfzs2G1hAkhR6D8HgPBR6gcLkJN/wSjwMCIAClGMC98DbKmDzThbYgCMQwBgeKT+6zA2bDPUeblEkGNjnp7BrqwFcBGJkw4nngbd1/2CWwe/pAtqziYKSCTgAQBAfAUBHxXw/Nj5ESWLOhAVOs0+ynj2VGLWaQEC4LHRERY6Fiy9oh1tnJ1nz5gxzmaOqeOENp0wSYebhwcdP+PmBjFCdp02OykvaeP2OB//775LSfnrb2Dlz3z99d+8vnzWmx9++OdvNq37456/vr8nRVlcnFq8b++djLt3T1ADAADcv3Pixi1vLARMnbTo6CeLuMHfvHmLEta//pfNL8x67bO9+8B07JVIAIGEz16bOul3v+MC8NL4lyx2A5eCrN3BRACFoPureMVF4X8GAOGjhOhfnH/hyAUFbgIYE0V8Pj88nIxtxSogloB7B+v/USEgLQ7KtO1teXqviAjSMx7KAIDGmRcmPKU9fPhkZlXVL3VVN2+f9EtHH+CHLYnCMBrVmVu9sfHjwAFJlO8Be3dZr7GgwMsDl7iDV/ZGB68wEY+3cQaGiO6+M3DnGgu/Pu60hRG37SBm93QMg9/B7DHWY8faOTtEeXnVkYkgHQKnE36HYHFnbPnDW6+/se4NJOD5Z555Zpb/wQ3bDh48+NlnkP7Pnu1999ZPlbcwBGhpvt/y0y1MB08wAEx6k67tqSYjsPDb9W/+32afKD9MA7/77rhUCrYpwdt7/WtffLFgHp4XxFlA88zq5wCwlFKwdjcOsv+ysHD3R4WF/x4AwseI2CQ5ivwjHi7hCg+RyM2Lj+MwaD9gBNF/72D9t9fVPQoBlDYAQBsewRwaIADQrQCeMDEJYsATmdiUX/fjjycFCIAT+gCBTOgDDt/HJ5S8gO6x0/8AAhAV5e6DALQpFALa84OjwTzQqbvPXe8OEEy2njEO4gjr539jDSyMw/ZEnBjr607GEJOyNqSMjh4QLoohCEmncvvOtrf+sO4Pf/7zXzb9+a9/+fMf//DirPX7v1XGK71n2zg6eTuC6pt/OoEWoKXl/v1bP9058dMtbycHAsBUzn3Pk6a+/pvX1r+VsOX/vtsetX0rAPD98eNpMnWURCLZ98Vnn13e9/q8Xb9nEwAL9S/lALB07dKPdoP2P/n6y6CgJwRAOEIx61+sSBLzIYJydnRwtsYDAbQJ1gYNAB4LpbrnAqCvq+NuBQ8l7W1tdSIXkgmSxgDTZiDEAADASYwB6zJP3rwJAGRSAk6dOiw7QI6tYn/3AVD/gQORvgfgdyiNkkT5aLT5+ZDt5YuIeIBW0d/bOLrjIJnQeH//EFc8G7xpjzvkHW72c198i/gRZxIUuMxxcHAJlfj4SMWg/qTTSZnp6SXpN0t+/DF2w5b3N+HBvk1k3MdmcN2pqanH9+7zc3L0c7rV+NP91p9u3b8PADTjsZXmG357T0BK6D7TVPmjrcDfb8WzzJ/984vt20O3g6E4nqErw+2LNFUC6Qx87bX1i5j8j+0MNHd+mAlY+i6JAb7evXpHUNB/DQCIg7hy5EhMBAAwI4SP7d2uruQ3BkE8hIBGAgDkZJ1cqTPLkNqXyerAANR50f0AdwYA/GcdnN1CwrRaSAKrbp+8eRLlcHU6ToM6nHTqdKIgCoymt6OjD84uJA3/sPol2NgpC42S9RYU5CvaCkjZT8SHUBV7zMnatvaRbd0u50EA8eedO3fuUaqi13/w1y2OtKmRZg3BbsEH1JLjGfltbTk1HWdg9Z+8WXLq5snj/uvJFNBNW7Yc/OqrTcuXv7X8W53q+NYT+/b6+Tl677v1097bXa0tXd1dXS0/Nbc8/PGE3wkMWBynWSQA875N+H6ro7e3o/fWfd99/x0EABlld/ZuVaUd3xq6FUzAZ5vXv/baokUDGwOJzs0ErA1au2MXIWD36lWrV/+XABigfgpABCRoMRgAuIRjCcc2gh8TQ5pB4fVCO2Jg1r9BW/coBEgMWNdWJ3dhAHAnANjO8WIOjoRGCbWyw4dPn8o8lZmYmFl9GNMGuQw+IID1L9vo4OCYsB3lQFSkT8IBX/SkPva+MixYGbNJ3VeBVoAX5mFLjysQc+D4+yXMqK23334LPsLYnPBgF7dgF5xSeSBakhAtUiTlZJWUgP4Pp9/MvFmi2vbWhs14fnDbsWP/d5Cc9kzV6XR79+09cefWrb2wqp1OQAZw/8f7P92ANPDk7b2kduXnl76X3QHE1wUAQML2rSj7vk87/t2+rXslW/fu3Qfvf/EFaH/9+nfeeeejNxeBDFD/WnhdwhCwI2j37o92kWjwo4927vhvACAapH6xOOYI3wUAIPGfCynh2c6JoOo/go/kHAjtDCRFQf2j9c9+LIwC4Obs7uyOFsCBRw4K44PwsNBLVJAPf/heh2SyaJk2VyYTZmfLo6I0msOCjYfS0uhNxPAgkajBBRxwP6A1GttyjIo29AT5CpGYD47AxnE2uisHCDVcZox/avwk/E1OGjN+vA09gmjr4BbsFeyFPciewbLoaKnG2G7MzqkpKblZkgkAlPxSFr9hi/9XBADlsWN4hGhbakVFxd69t06QzM/b0ckPtAmxHyx8MAp7/W75+e27te/Wd1/M42wBLvj2+PEETx/c/Pk21Hvr1u37tvqAJwC/AOv/i89XrP/8j2+99c6b7769aNHbSywBILJ08dIgWP5BQbv/dxfNBnbvfrJ+gEdonop4CAAiGAD4EWT9u4AHoK3giAHpB4gxS0REsn4QAHXkhQOAXEZ6AByCvcAlQ9DG43mR/mBZMCx/bVWVQJSvKMjP54dlHMqIAggOoecXyg4dAuu5d3uoNzaLbgwL2wghgVQWLTngq9bilIo2I/wlEIVYHCYSezj6zB072dqaJH52k8dOeGrpssWBi379+m/oUY45eAzJAQKc4JDQUM/DSYmJiaKk0wowJCXpien3S07Kqhrit/hvi/Xftu3gsS1b/OPiYr+N1TUAAJAhAABgAvbeuUVqQM3377PjK07s23fipxN7Zz095alZbhNpBhD3rfL7uO9Vqu/3feaz9TMfx61bffbtwwIyyBeXN/8FlvQ7v//9u6sWvb1qIQvAfA4BS5ag+ikA6AUKBwPw9ycDQMQV8VACOsW6CT+Cj2/JTG+OAYihj1wAIvi5FlYA20O1de2kPFDXbmDbBMnpYb6Y7wVkhQm8wrA1RKzVCoVhGzHqw0auGL7XycOHDx0igwjhzUanvXsPnTxE5wYT6+4oi46SyaTRB6R1vW2QrxAHkG/MVxyJUVyYDcq3njx5OiSB1ta/Gjt27IRnpjwz89lnfv2sNX4Iq0kz7JydZzjzcGAZ/P8h4UyCv200Gm4eTk+/+WOGpkH13fHvjh9XqY4f/+6f32akxW7bFl9WUZEBAGDIf+vGLUj/AICfbpnKwfiw7+6tG/CvhYWFgY1zdAzDiYY+PpKMMtW+/8/fx/011Lv7Vh+fzz6DAOCLz//yx7d+9/d3wAMsWPR7kwX4LR5HIAysXr1q1Wq8L27nzt27djEFwd27n6greDjVD69/BgAXNAAY+0WwABDtxwwUegyAn1c3QAydnT3YKQwxAiGgLoaMiuWLeV6w+l08PPgAAM4Gd3HYiMdQFfmof76HwMPJY6MHHhARgPf38DsEb2xtHBjxlGmkoH9ptK9U3wN5YA5gk59kT8V98tixk5+G18nwMnmy9a+sx1pj/gpR4dixv/rVZPjcZEBgxtjJ9DCp4PDppNM5bQX5bb2GmxAHlJTcUcNSR5tz4sZeIifVx47FRvGi9966c78Za7978S0Wgm5hRvgTLH0iYBv2bo9bv367UBwdJYyKksmFOK86xBsXPRYwsJt0xfq5n6H6P/scAoDXf7Po7d+/83nxvdUEgN/+9rd0/DnGgEuWrF67dse77374+7///R28Nu7fAEA0rIiH0b8Yderiwp7+Igd/Tfpn/YCFASCSbGkE6pgoEXMGAkAV6N/FwYHP46H/5ceIxHiQ09PR0cPJ73BiYhJJ6vheXjW4Be3gsZH2XtvQu4NotdfGxjNUhoNKo6XRUdp2I1n9ioJen4nTJ0+fPnHCNFzgM+BlLMqviB2wcyYnGSePhffGWqP6Z9i/YD/FaszYydPs57a1tRW0Yf+LIfPQiRu379yp2ohr1cPRw83bD7u5gYfvjp84HLYVPACqHT4A6m6mh1VYuUXkRLAXKFrI83EPdffJkMkyJGmpko1+3k6Os2fDP4SNoP/fP7/4bP2K9a+99dprb7711vrLusaHDxs/Wkr1T4UQQABYu2PHzt27d/7+7x/943d//GTXR0MA8NG/A4B4WME1PWcOc/bv3HnjhYgIs94H6p9vPieYq9czZwMMBr2B1gmws5N2C8nhK9xcg0N4IcGenrYOHrakNgX2HmzvqdP5bejJ4Z/jG3MSPWznkHKthfqJuEVp9VVaqQbMgMFYk0jkVOK0ydMnzA318XFj9oVmz7I3y3P29jOm2T/7zPTp06fYY1nDDmz0XHv75f779/tnGPPzC7D7oVMdl5amKiurDXNjv6MzZHHb96I9OHn7BsSA4AOAgRO3uoj24eGuiQAAAj4/y97dJ0oo9P/LZv9t38mEvCjJ8dRoiQRyASwJeDv6bP3i8r4vPlsBBKz/4jt6J2Vra+vVxbgNALpfuqPwX8v+h3iB1UtWrd7xLnYFMZ1BPxQW7h7UFUwGJzwZAMNrXyyXo+l3QeuP6gfBYKu3v9eIwf+wBoAiQNy/Xm8wtPcgAD1tR4w46ZmEAK7hOECQnhHEIE3k6SkOEYYJxSJRmBgWstF4QSGKwQZUDw8BU3xycDQrH02CV+LZmurqzKzqU5lYuBOQ8p3j9GnTwfxPcwTlOzs4OI/1379pP7wc/Oab/d9QObhpkz+8SZk+dvr0yTNc5jj4r/f1j42Ll8A/Vl1SUtLRURtfXqauLa8N8yCz5ZACO0dn3FWY7ejp7QgL/8SJ+ycg4ofY78H9jvvEAZBYAJ7euPXTXm/HiU9NmjfVw23Gc5AJLKqtBTuVJolKk0RHkx4w0goOKeDnn23+/JPKfvYGytbG0vmo/LXk+uLGwv8h51IxDIAgYMeOoI/eo7rGUMBC9383DwsbJQBi8SPVDwAw+jxyjmn+I+MATaMhLUGIsBB+ch2W1tvbezoNWCvEskFvfz+2C0SQ0BzzQLwmAiSZF8LzEvKEYr6QJxdni8MEIjD9Dh5eoqiNHqzNZ4y/LSjFCyICgYDuFPgR1Qv8BDhOgIyjc58xw8HFDiM967FxB7f4f7PpG3z55tMPP/jgA4aClOJZY6dNm/40uAEfsAG+38bFHWJqwDdvZuh/aWpq+uVwCBCId9Vhp+JhDzcwA1sd7ez2kiQAXIAfVTnH/INvQPOw1dFmnPXkaS7Ov4If2Np+a0JGRZla7b79uDQ64bvvj5M2QHo8ePPF0lacQkovFGpt3M0on1wlOf+V+QQAzARW/e3dHR/9HpX993cXTZr59iDNj4ABqxGrnlW/XM4a/7xz7NZ/b2+/8cgF7nBQcn4Q80G+JQERMXkGtP79BIBcLB8Z8Xa4umRyRUwwvQbQxcUGrLwbT6GQi+XJQvnhwwa9Nlt7GNJDD0/3EGtHD5PuGQoAAQHomj09RI6s4ACTOXNs6RSSGdazHWZMx9hv8gwVTu2E9Q4vR4MCA3bt2oVPcZ7vWxArgMN4GjyGvTtWlggAN/Hhxu2Sktvp6SfDvDaGEYMDGGx0A1916MdfDjtiNHD/xI0Tfn4kFLhPjqveb27+qYXJBG6d2Dr2V9b4485wZH5qR0fcfPaRqCUJkgRsCkz47p/Hjh37KqW+8WE3vUO2m7kP2yxB/0NSgcVIwI7Vq3ZAKPhR0I53164FJj756NEyHADikYjcLGT154GYWz/Al/fG8I1mBIys9A5EgJ8MX9/Tj5sFBj4WEHv6+9raOmIi+ERiMAv0woXL50EkvtEDN6rcPE4JNvoJBIeFGz0hyRPKvcIObzT7/3E2EBNia4ctqfIAANQlYIefrc1kzPzRbEPsN3mG/YzJ9jpdsVKZsmsnSCAspzWBQTsvXrxy5UrxvU2Tn3afDSHBjGmedrNJk4Fjup9ferofFSc8meghSNrIHYYCitzo7X3izp1bv9y6ARZgH0sA7gn8RHaH4KO3tvqQIMULfk43/O+BJ/MKgyhHXtUg8fXxiUs4npDg/3//9PcvbmzF+bMPHjzswiGhLS2NjdyJoXiB1cvjsRy4em0gBII7gnasfXnS4pdfWhr0OAC4LLBPrMSjVT8CIJYlnz+vR1POIaD/SIy5S9YMAXiHgUags72vH2IAQy4s+ogj/f2dEGwz+iciJs5DocA54mGOEBZEYeOxByAgk3nKMIr0ErS15WfjGT/4uJubwJgDa9EJEGDKAeyIGjK1CLy0W7CH12xY/NNmzJ5tPZfcxb4zYA3K0sUvLw0MCgy6tHPXtWs/f2M/eRpEAdOmPe3u5Tj7aZ+5Y61NBxLpG6wWOniQLQUb9hU3w2fM9j50484vft50vf9EkkFAAQsCt0iV8MTGsLAwoVaIjdE4iEImFMuq4J1aACAuMjIhLSHun//cvFnX2vqgo6G8rLyBqh+FvWMM75da+z/zX/3tS6QeAK6ADgteQooCuz///KNRi9VotQ8iJLdB6PVNBoPBvPWLQ5P7BkwJZxk4YmEF+BfIUPn2dr6rg2s4mI32trbkCJMFgFcxH6sNyTGQCwqjpFKNOponh1W/cWOU0DFEnCRK9HIWCLy8BGGwmLwEOOrDlAyM465N1L+z3QxnErdNtp48dtpkyP82XMMr4QNWgfoDFy4JXLMmKCgQjEDQpR9+uLh87NgZNjOAgmkeLhs3eh0OwdXqYANw2TiYDqdi2WEcgwD7fcaN83a08TtBssBbrP8HP4A2oBKh+ClTKxcKZVohjwcPRGRanDvY1CCNi4uMg9f92/xj61srmpobGhoaGbUPAKC+vpCmg2AGSJvg+Ekvrw1imkM/fwICrEapfBS8CEjfhGIwdHR24HYPPoG47kFP35AM9DKOgM9UhWIwYGhvc3OGuB0jgDZwBmRvwQwBPMTg1nOobzQZIi6XY/znGeLsxvNywFFRGCo4YE9XWGKYB9nqBUXR/TyiGDquhOT92ArkYjcZMv3ZEAM+m0IA2BkQiBZgdWDgmqBLQEBg0A8XL1786+SnZ6PtBxOA1Hh42pG5d+McWBvgRLd2BI7jqPWnuaiHh7d35kYHJ8HJH2/cuPPTrbt3UfW3Gn7CloDDhw6peUK5UBQWEiLU8MLCCAAyNP9amVheVSGJjN+/7ZuDx5TFFa0NKn1/d4t54VuYALxh7N58MkSWtoguXfr2ogVTFy36PckGyZUx/0kA5EMLXgjFANDZ2WHo6OnpQAKIPOjpG3RbAEHAeAQdPp9FAMxAfxK6bDG577Etws3d0xPHx8fwQlgAwBfgBLHoUN8ocPxh4PSxJLwRTwg7+cEfQoGbB+0QJJEfbrvS7iQbZmYR1no88AC7w2SwAJABTB77xr9+vkQF1b4GXuEpXjV/6crPRUftre3tJ8+YNm2yfbADKRrNmIH/zDhyVTULAMSE1TyvMMhLkvCcOfrzurqkw/iTJCYmehjqtL80N/d01DkIQO+HhV5eYqFQKxYJhSI56J2HE2rkaA5kVXjNcoXEd1txBfj47v7usrIH/f19QwKAb5CA3aj9l3776qvLMBMIWrvj3bffBgL+zgDw+X8IAPnwotfXogMgBDTpCQYGJIAyMJCAfubGAHAEMXwzAhAKeGEif+TCEf6R3iPhpvHhAAHP3c0Fz5t6bfT29Iw6HBV16NBGb9Pi82OeMdm/LaqdNInhwnRyoBOGmXMFrq7OsOxxTbvZOTvAH8jAZq3/wzrs4/wAz4Xt3BGwIwiDwcCla3YevZiS4g6x+mTcMJjsHgwPWDdm/f04RMCBegBHR5KukKF1ZBcxO1uuyMz85Zfq+yWnsGqFZa4cJwenjYLDYUIZBLJykTA6yne7WrH9rd/97s3fL/rnceWxg0qIR3U6yTYdXkbb19+kbiITybrMBNC35AXfx8HhL73EXGtPAGCH5LEWYJQEWI1S+ShNg8RgYEwAPDwY6nLQHnqHwAXQf3KeKSJwdbXxuhATjkPF3EyTQ1F+jQ2b4N0xoyf6xtmkHgJsBSJ6TvfzcCC5nyBdwFQEmQxwzhyXCLxhimCA9WpXa1j1sPbRC+CrgzX2ko+B1xlMyID/ElaFf2U/DXSP14oSxTrAj4Q7ArOdaJ3BCeMAG5JokFAQLb8LCU6xJOChx3NrJSVkxyA/Pz+7w5DblkN+eIHQSyiL9pW9RQYCL9rEzIZacEx5EITcJdD4kBwueVDbQ2dQmEwAvuCD2RCACViLuwLL6KYgAFBIpiVzAPj83wHgkZpPpmKpfLQFoP7ODpMR6OwZ9p7Q3iNH8nLPnTOVh1z5RyKczRfIMMNj3Z/BG6PBVohEiYnE4pPQ+fTZszmnFSLBqVNZJDKDiF8gcOAGfQ5E9bZMPyE+d3V2Cw7hzRjr6YHtvggBqTTgi4cLGTxj68AcG3Aga9qBFKG8yPxL/GFQheSAn62TLd1vIlUnB+wdcXChH3BiqkWsccpXKNo6s7PzTjuBHXMRiR091dFvs0cB2HuiFuCwCALAsYMVD7vwAqpu0xXKXZaWn9E/YwIKLQAICtrNzso1XR79+WgASLKQx6t/EADwYujp72kyAfCgp6dv+Ltie8/nJh/h5ATkZKgbFwB3z+fgV04BEOPZvsxTOB5EkH4K3hGQs6g4kAbyPnD+frQMhIPZXGhbN23zZkZMO7uJhKLQsU974flVbAunr+REGLzBUyNehADyQfLEAd8R4df7gAuYjRYHnD+pKThhQsDwAv8EE2hi5YGUCdLTHQQbBX4C3LbIUyjyzjg5eIi9khKxgLmIbfNezN4MsGjPN1sO+sceU8ZuUzYWN/R3dZuvU+1DXXd1PWQSAXhlSCAEzDcHAGABglj9cwAYOQFWSYMBSBpO8ywABoOlCcDpXGj/2TDgQQ89usncFQfPcN/nQQdzhWj7OYsCMTM71p1e4UguEnoOb42HUBEbUMl+joCcB6JBAPyGmZWGbxyYXQEb2zmmoVK0uQfbym0gjLOzsx4724Nsw7s5kmlDLjgWChyCB6NpYsS9yPvUT3h4bJw929nZ3d5+hrWTjVOJwJZ8NxuBE1JA1rpfupMNWw1AB0GqRfBDVleX1OQXkDaE3NNoHyBIRTMze+bL9GYPnPBP5b2UlJRjx2KPxR48eOVKQzcHgL6+B10PH3bRy6JaOWkgJWD3b/FWdJMPYFrCPuICMGIGBgIw2AYkJw8BAEGAiQTJfM4HTSQCwA8b0Akw0ofdoT09DzroZ9iTlCYL4GoCwBkvIcR791580d1+ki0BAOuE8qRsbP9MZ2r78EuuOVuTng4v1fABJ6YcOG7cHDpc2oXsERODQNy1HYq19Yzp06c/DTLRfSPZTCLzIcmqF3lRU0Btghs+RUjcJ4yZMGHyNDABGPSXONn6YQCYno7PTYVBNu0kvHkAEoLMxDb437cVJIMTyE7OSfdzchCcAl7xC2bPYzu7mTOf72EBOhYvKTqoa+x+2NXFXnPS3d3d1UIA6Go1rXwzAK2lv33FDMDaIDwZUDjAAoDsfjIAUOcKCxkEAIn2iP4hHWDGs8IHOHbB8AD7gpnpPQb2E3pzbNAbQ68QcnNmDQC9wxcIeHHq8zOnUgBINghxSXJuUlZWVjq4gPSamqwakLM1RLIE6RBkedDzfSTqo6vfZhy9aw4H9Dg7zJhMxX7a5GkY3k+Y9fTk6U/bz6CJ4TT3X/2KNANh9g9fMMN+mv20afb2EP5Pt588drKjABZ3Omq9xMkJXmDlk8xw3DgsArCFB4wSYK2X1OTAf9dYkJ/b1laQn5OVmZ55ONGQ7kQPoM1CJ0BmvC95mQBw9JsUiAO3xLf0PXzY3cWYAHIXWXcLrn9aDB4ojY1rfzt/GUsABgG7yfGQwgEAMIZh5AAoBkvyUIIrHZWqr61l74V+YDAYuI6BpgT0I6aPW1wjDxkBHgN35lwiyFgA7J+nAITTwhBYIUV2zZn0dIWC6h/n1BnhocbPCYxATU26wIOPK5rcMom6oMuf9KqH872sUdPWDAPTcDcIlvbYpydMePppMAwTZk2AZ/Bh/AB+zfSxsPgnrJg+lrQOjf3VbO8SwAzieyNuMUIywAxFZhJDWgkiWYjgcElJ0tkSgdHYdvokbnZUnxKUlJyiJ9kcHCF5fJ0BgPiBf6AFwOWPFxwTAIjyKQAcEzBYin5rSgMBgN10/Q8JwGMZsFI8QpKHFsbd603q7++j+uamhR3Me2bLYHGfaI+hqrZKHBLsZuc6IAl4HvRPsoAIpjpMWhDgp0lMTzyTlU4MQM0ZRU+PEWeVZaXji4MHlhgi0P6TUeU2VP+QBsKHPX188B4k71CfAzJY12PHkH6gMU+PGTOZPJkFSeHYaZMhM0QosGkM0kSrp7f7UNm61U8ABHQYS4xoCsAGOIwzC9lycnPz3HgIDw7cLLmZnn7TAwg4I+hug6V/SnCzJCyc3aT0O/EZvfmdznUEAPZ8swlywKLG/m4cOtXVTSlAAPr66I2RXUOaAOwLMQNA1D/YBZjlo92jByB5eGFcAOdq6E7DAADwC9hiERsrGiwueqyr0lZVVcmEdDwMvcadjPWfiQDY2DLLlxAgk4MnUAjSMzOZfCudeATc+gcLgMUfLDCFR5BLxugNE+MwKiAti+EhoVHRUmmiSCZTq1esWLF87ooVc1fMxRcis1bgXSF4xtR+Fv0YPr7wQoJGnSGVJSaCEp38yHfDB8jz/WxtzPpn9pvs7Nwzbt6+/eOPP8IP5ZFEotZqp5Jq/IkFvGAPSBD99p64+9PnL5P74ej5no+V3+xJ0bW29t272t+P14V3ddHZY+Q6yv5u052hloIfK3zlpVcRgECzF/j8nXeG0/+jKLAarfYpAE36Dm6m10km9TFJISc/bOJSwOGlSV+nr6NXcMnJfHlydQAHAHTgDAByHpiAmBhFPk6JgNWON1WYKoJYnMVyDD8/hrQos5Nl2JO+GGnwsJAsTUpMkmk1CZKEhASJJEEqkaQlSNPSpBJpgloiTZNWaSTwMel+STx8Ji4uPj4hTa1WS7WJWU6Hs0qQNfxmJTQZsOEiYDd3wwcffPDp0ZTIEzdA0m8KSCqYCazcP1X9442bJw5tdHI6lKErzsjQ/x9kgQsZC7B44T+++aYZFN9fGVh6vbUflz8zfI7sqvUNBcDD7oeNpYWBy5a9/BJjAoKIgAV4Z9Ej9T+MQ7Aavf6TOyxWPylhkeyPhIUmjcNbfGnS0zphU4fZXOAX1REAtFpNOLlaihwCsn9xLniAmRQAWxoGxsj52IbIj1EkncrKOpWFq58eD2YSQczLPfgXaJO6JQB020EYjduXEOEk5Wkj4+ISCAKRcQQAiUQSp5FkpKVptPCeRu0PH5Co4uPj4yLVVWqZDL4lRBh+6SWkxjcOvhvE+mTdQ17x3ItvrHtx+Qc7d1669MO1a9c+2ERKAek3bqbfTL8NTzLhxzzs53cIUgFbB7+KjDK1fAWofeHLC/CeGNzIXfieDiO/1sCgwKv9XV0mAOji6h7gAx529z2svBoUSO4qWIYmYJkJAAgB3/k9q/wv4WX3I2V4AB6j++RcEIOl+gfqX0/0bqJBb6AA9JjU32QgANQRAGRRtBaELuDFmc+/iAaAxAAg1ASEiOWkQikSJZ5RKM5gAnCWeICsrETQDynn8El5md0DYAHAJCJGIcb9S60sSZvdrgX9w3pPgzUuyYB1n6GWpmXoM8DWq7NB20nYwuOyHgAAeGpJREFU+ZmWpkYuJLX6Ko32dE4NJPeQ+hMCcBcIwgGyL+gLy37nzp2f/oC7SqD+az9/+sFfMWV08jssgmz18MkTYPb9DpN9KzD/JzQamVq2Ai3AQpwIMo8g8PbBlq7+vsrAwGVru7oZAvrYbXULE2Ba+owEznuJDQIIAyQN/JIju0cmViNUfS5HBtb2qP4Nei4A5rcDDIChikQHZgCigyOIC0AAnp9J9M8AgHkAX8wX5+XlyjVazE6zkxUx+Vln8xXoj7POZCEJHnMgnedfoL3qZMCoDQNABIkBIImIlmu1Uo1MVqeRpEmlalRvArwBq58hk0bVwnsH1ApRduIpbRzoPi0tXpKmSqutrqvLzs7HGKMEfX8HMQKk4gsadfL54Qei+w9XrcYNxcDAa7s+/PBPjuiSPMRefk4iD2+/vVi2Onz7zp1bGSdukCOr61/Ge2IX4G3BCxCAlZuKH3b1BS1bFtTYxwKAISA7hIjqHz7Ual76DABLX1rGTQUxF/j6669HjYDVCBZ/7gAZuNHTMdAAcFFgdorMCQP7GQqARhYdRa+NcKYAMBaAzOxwpYlgTG6yXK6VC5OTFXxFjCLrTH42mGYip9ACuLiExxjxZjJaBmTnfbAA4H8grw6n0tZB4lqrqdVoNGXq2lp1rVqjlmmkVRnl6rSybG1dTk6dWlNWXlauLqutLesoSc9sO1cg6HHyY/Z4Sjr8BD0QBJKmEG/4nQeuWbN0ktVL814mbUWXdgYEfOCD0YnTRj+/k4dO3Dix18/pUJg4A+QWBCCAwHpmxhNOh8AwYOU3B1u7Wq8uCwyE7K+ry4QAawK6sC+0tb6okGg/0AIB6gM4ccDaAQCMCAGr5JGv/GEAGGwA9LRGVEsIoAWBDs79m/TzJATEX4osOIIJAl+cycgzdiwAtEFEnixP1orlycnYJpIEP1Z2TlbW2TNAQGKiF859OXIBryekd0tQ94ETYUhnKDBytjqrBhOTDjJKJMrdB1O8toK2gvzsvLaC9oIC0H5+QZvRqN0edQhlL7ziWs88W4OZBgsAGADIBtMx7PDY+NH8l3FYw+JJVuPnkdFNiwMDAj6lBGCE6ncjoyxNd6dYxo9KK7tzR4M3Usn+Qs4jcwHYpCutbw1atraRA8BDtrUKcsHG60T5aGOWWcril+hbwkAQvL78NZHREWA1Wu0PAoAxAIYmrgmorcVXFGZ7iHv5HmMBSBCIAESHR5C7g5zBACxYQAjAS+ioCwAfwBfjGM+8ZHluLp9sWSYnJyaeqTmTk5OjSMzxAv2LaARAqGEtgAvZpWXVkZ6YVVOTaY/nfmbTSl+70VhQUIDNKvDYZsRnvdpZ9uSQ3uzZs3HY6+xpfkZjVnpHD5h/oxF9gBFtgJOfVzivIuPdpS+Tg/rMEf6lS8EVBHywwQciPhKcOt3R6XRld+V8aZq6DOw/AvA+ue9jAat/CAk/vFzf2n+9EMvAhIBuagLor6qycC0x90OoH03A/GWvkpIgjQXnjf96MAGPZcBqlMofDEAnA4CBi0AtK020ScTyDmYzAMQERIdEEAtg/zzo3wSAnY2zbTgDgFielKTgQzAol4nFubkAACx+ACBfLM/zchGY9E9zAFb/pNbPtonjiQFvLAXPnjF5GsjcXiNYgPwCWPjwwLDQ5j4DGLGfO9vREQ98zJ7maCi534GbGh3Gnh6M8Gwd0jsE3nvV397zc3x3DTPCbdJ4ysDiNUEfAAF+fidu3bh14tYdVbHuTgUAUJaGJ8EgF1X9bfESNAEYBTBXP/6tGH08vZium0gXrQaB3Aui15MFDklA4OpXXlk676WXmKrw0kmTvh6SgC+fAIDcR8rQBgAJsPQBIHqmU8xie9jA8QHkJB8xAVwL8DwBwM7GDesAsOIBAZHIC7OBXAhVcpMVAEAiAMAX11bJhWGi5Ah6zaR5/c8hu32ma0ZIa0n6bOtpkyc74tbAtLHu5s71AjL6GMXgQwrG02bPmAFGAM9qE8vf0ZOVZYS4EwCAPCDzlFh4J+Fbb0fHt5eSDb55dHwreoFLKd988EHx3Tt37t66dau2VldW2yCP2gYhh1AolUn+gVe7AAELF8xbwACw+G9HK+noeWLysQTUTWqC/f2NhZAdzh/aAgQGFt4rWjb/av3Pu96e9NLL+CH4Kb5+AgKsRqv9gQCYDcBAANgIAD9pyYzewBoAiALJjBj0Aa4IAGrfDIArWACyHYk7QmgJRLlAgCJbkZgoSlSIhTxtVZW+VisXRzDZv41J/5w7Zkxijce/HZ2mwSKf4dPLzLwmANAnvYatsyfPQOVbPz3h6dlOTo5OjukmIZkguAJBYoZUkoAjgR1/Q6/vfQkIYKK7j6/s2gUAVOju3Lmj1UIcpNEcj4fEUiaEcBe1Dy8LOS5g8apPrzwEAvq6mdQfa8C4LdRVSgK7+cuGkKCrpY2tV19dW48tgqVX3yVzhOBHuHz58jAIfDliAHJHIGQ6dm8vedPZbnYAQ+QB1ADoHwy4hltbhY2lxAUQAKr4aAKefx4JeH76r58nANjZURcAus/DXiUMAsEaZLe15Zw5LRfyhFEhPFpM0mrlfHLRILP+bfHw6GD9Ozk64KweMO+wwn1NBgA4YE1Am7ejNVn7s6dNIz4AB/6S6g6rf4wE/fYmQBRJbgeaRW/tenk8FSurSbuu/VBcUdVQUZVbp4XAXyKTlZerVKo0IVi6JYvp7U7YEvLyQhaAo3jko6uvvze3AE1AX393V393aeElAsCygQQEFRbVt/b1N6599So5M1RR0VB/b/fCSePHvzz/8uXRI2AGIHdEymcAYA6A4fEOkA7DMAA04a4RJAgDE8covMYDCYDfEWMCIuymP08IeH46CAOAKwNALk4pE8rz8njiZEVbW81p0pqOmX27gTIk5/NdzFUgFwFzSNDJj6N/7OiBoBCWtaONoy+eaB0odRud4FMOfk7YAOIEPoD2H7MM0EYA+BiZ7YPjXLwXTRoPf+ZNonO8X1687NK/fkj7JRccnFZWdfKEWiaUqVRlqalcAMACTDURsGrPpzoEoN+oUIh7CQD9fZWFlwoZArgABAZdrW/F9sEuWP6NDxGclgYipVd3vj1p/OXLXAS+/HIkDFiNdNlzATD1+bJjYQ2m3WBL/dMuMX3HwNKRNoqYAHIuggCg4UU4EwBApk//NQOADQ4MwSpgspCHFiAvF2AQ55zJCsEeQY26KuFZd0mVHmdGicUAADYEkMYQl8REplAAKqMdRPgiSHcS+KXTRqLIXiNzboV5JAAc8oNwAbRtw5gMR6CA9QDpfjgG9saNG/BYXHz37t3r168W7Zy3BNW6Zs28xYF4ziDwUlFhtKysrEyl1p7KzLx9mwcAqCTxKp5MFoXqX4gGYOpTVpPm0UBw1dFPj7a2PgQDoBAFi8nhmtarly7h9r6lCQgqLMXz4ugqWq9evd7STQ8PN1MCGipLi45eNsnIEbDKHb2YjgBHRJzn6N+07WsBAIh+cGNglJSYAPOoqKqIiOmUAPJIAbBzCyfbwWI5j0c8Qa44WZx8+NSpaNB/XZW6yn3ChImzVmzHoWFyPr1tntR/XERYJc7CTUPaOIJ/Skpq4AMl6TUl6Zl+jhIcTADRPWlcYjrX+g1RwMvGjQKy4nH3H3HBEgDxADdQ+zgE5sat47fulhVfBwQuBQaREC1oyRp6yKCw+Eq0SlWLpq3uVPXt22ABUlVl5SpeBrUAC4kLeMrqqaemkjhgyeqPPy5qxXUtDnYLbidN4YVUaHmH7PsGgd3H8+I0Umjt6iwvpzsF3V0tLYSBivKKisuXH4/Al08EQB5Xcqn+sfp+hF4NYKF/MwGM/qs6B1/rofdF7TMBAE5jrZODCaCCEDAAuGIQgGkAjycEF5CbJ4SkkEfdhw+s/VkTp0yZMnHiijogIGKOqQIc4aLIyc86C4nCGdB5Oig/i2iwJr06C1/S050cM8jot0MZaZKT6el7t1afPHmiytAEUYKjI4QPZMXTzV+ifQaA2ydvn7j14y83b2Vo75QV360tboBIHeUSxQAAuFRcLNbUNsAPpK3LvHn7Jk8DmqmoUEWrzTHA4sXzngKHQfQPsnhHfWtrf382DsnuxN9OqckBYLmRhHxkW4jNpfqaKyrKGpissbu7pbm5uQG/yeXLI0Lgy1ECkDdQyLlv0tPFXA4xAAAWAVoG1lcNdbGLVFJFV34V6B/rwr/wXSdOnkzV/2vWAoTTKBAtAAQB8txkHh6uxNBRkzFxor3PlAkTp0yfPtHHoJXHROCVgOgF8AdTKGJyzigUkOeTDhIAoCSrptpYXQDLvyY9PcvPG498H9q+fXukxM/b28fbz+/QoUMZGd4QJQjQT2Sml7CtBzU1iWcFWSXGkky87+TWHW12tvq4XAYRvrZWUxh46dJOfGEB+EGpFFc1NBSrZJrM9Js3T4o1ZXgtSSoYLekqCgDqfN6kBZgQLFkCbmPJ0iI8FdSPcxHFeCtR91V2+QcFFda30qVuzqS7YbmXl5c96O/r68IUEgFAAzAAAIaBL4eWEQKQN5RcMBL1u0TEMJcDDASANQCkH0hjGKo5vOMABABVNBOgOwN54XbOAMCvn+e4gPAILgDJeck8WS3JHvWG7ROmTJgyawqagCkSPQDgQh0AAIDdITFHyFApccyZM6dyanLaaqqzzmQZjfk5JdX5CkWNn/chb9C7u4/31r3ek+e6O5IhLU6O3n646Z9O58KWpFdnkj6QRIUiMctYIuAJZXKNBkuROKpQr5XJ5AgAHjQMAt3jGdPAQp1SU9agKy5WSiEC+MWgqC0u1qXqVEKx7CCz/hGAxfMW4uJfQk8oBzU2AgBCAMANe6m7iq5dY/Rf1IiDQixO3fa1UADKAQX28FgzfGAIAB6JAKXAatTqz8s7gk29ri44GeiCRRDAaQClqx8eqjRD3+0kwzhQra6qq8KZMXUGg9jN1dVuOhMIsC4AAAjHzmQ+jycXC2VinhYAqNXMXSGZO2HixFn2s9AJzNJgFuBicgF8Pmkox5liCpFCwVfkFORnKWIU6TU1bTk1+TExMVl+fo6O9o72szGqd5wBz2fPtncnp88ENVg4FuBsYGOJsaYmMzExXSCKEZxS1CQJo+Ra2QHfaJ4wWoazyKI12kLmmOElBOAShIE/VBTL8LqR4hRJU3NDbXlZ5fVCnUol9X3v7cUm/YMsnLeY1f+aJWtKH9aX9ve4AQHZ/Z3ZqdcYC1BY/3CA9lH/zahuIKCpv8t8ehCjgMuXh0HgEQxYjVr9eXlMKze5HsIMAMn4OH1h9D2D2jCU+vv6ew7I1DjckwyN0nfkkomTzhQAd74Q7/djAABlJkMcIBZqNNLoKn1tlT5h4sQJU56dMsXeftZzEyZOmKvXAADMqQAEAE8UQNgIfzE/H48V4J4RAFBC+olhNSvO4sx5H5rSEbV7+zmBBcDgAJs/nNJJ2ofXo2Y5ecWITglEJTX5OcJQH2lkZJSvXCiUaqQamVSt0V4LunTtEr5iLAB+YM0POpUMz/spD8ZWVFTW19e3Nl4rVqWqf/cyBv0LYOFTBLgArFl67eqatQ/rEIBguZgX8gMNLO61Djhxj9tDoP+WBgSgoaHbfIAcrUDz5cvDIjB6APKGF3rDE8cAEAI6DOzBAHNfcEcHGICeoU1A1QF6qSdY/6a6EOaECJqA6e5HjlTVib2AAVcyOpIvzwUGxDK0/VJJbZN+BSz7556bhbO+IAqYsF2v1SaHzzG5gAi8BxKbB/IV4vxE2s6ngJgwHaMBRX7N2ZwzoP+NsMr9SDXHkZAAXsCPRn5M0ue0MVGAKAgENYk1JTWJBUIcQCgTC0UirURdq9FEqmWya5cuAQN4vBgwADMAAOg0OvD58MrO9SkqVqukv1tIBCK/BRj9LVm4YIkZAJxTsfQtO3QBbm5ewcH/B1ElLP+hbsUiHp9k/83ND/q7u0z6B7l8+REIfD0qAPIeJbSTm9wQdt5cB+joGGQAQMAADHdSMJqmgnVNhihUtYkAO/6RZLDzTXpwCtQCQPIvhGS/CjL/7VPst694Flz/LBT7WRMnTpyiAQBiXDgAkD1kHBKaJFIw2WAOKD+9JufMmSNnMDVMp6e8SaqP/p8+Yet9mAVCIFBNTvvAXyzpMJbUnM7mRSeopTJhCM9LrtZIJGQns/ASumu0AJeAAABgV2qxDLIAla6R1X9rUVHqFeXylykBi8lGAD7hArB0yZKl8+yI/vHSLM/CoMJ7XYO1j/rHpd5Q3oD3pZO7rLu7TABcuXLlUQyMHIC8RwuOc7M0AICAeUuA0T/xCWgAWAB6B/x/9KEajAJq5W44nY8BwNluunPMkbza2qra2mYhCwAfa0VVesj8wfXD4n9u+nMvvEDc//QJVrP0kFCwIYAJgPBgnkIh4inQANQgBTXwkpOVpaih5VwyYcAJa35+3sQCzHactpcp9naQCkB6tWM1AAChY43R2GM05vB5vst9ZEk8OU8s02s0ckhJZIXXfgYArl1jLADEAGD/IR4rVtbTuT6NpVdLS+vvXfNfQAGAAHAhbgZwYkAEAGUatQAAgNuewsYhtA9CA76ysopmRKCFfopl4AqRy6PyBFaj1z+1ABb67xggBgPTCCbr7GEB6O0dSEA0LCK1jDSFOjubTUA4eIBayCFr9W7ko6hOSCb1Gp8EjRqy/udw7U95dtZzE6dM8NH7zvLBK8n4LjQJpAMsYf0reCKjWCHKz8o6k14Dj+k5ZOr72bMlNWxNn9R200syICO8kYYz228znyFtP35+xnQjuAIAIKegDW8f4YtkPu4ZSWFyL55WlVabJ5Rp5QSASwhAEC0JFdbX43WUxccQgNKru5e9+srVxvrSa0rzskcGFjDPuACwJiDYzau221L5pFMU1vsDLPpAAlBe1oAENLCbLH1dD0wAjI4Bq9HrnwAQweeu/44hCIAUsENT1U8BoMXjXur9TXtCoVVqHqrdjgUAW4PsYmKO1Or1Ek2T3NnGxjVCLuRHJDdB5ieZOPFZe0j6AIC5YPqngB+YmAHfidxJFT6HTQJwWikOBydXhCvyzxTkIAA16QBCTwlov6amhKntUPnxePXJ9JsZ32dkHL+BHsAIBj+LRIGofvjTi80i8NMreMIkhVDoFaYVizVxcTKeDPIT7AdFAK5BEIiBQGBhaSm4/+LUgxWw/te+8uqrr76yG0LBn6+wyqcEmJ5xCFhszQAgNvXPMX2CLS1deGjoAS36AQEgtALMubqyu+vKlcciMIiBAQCcAxkJAOAAyP1wnUOqnwHAoCcGoIcdGnbhwgAzIAthLow0mQA+39kt5sh5XO4+CZ42CEAThFpVTfpaw/Yp06dMnz5rrv0s+7lgCCZOmDBhFu5A517oNSa70G4AyAMAgHwjz12eLCPXASdFixWJSUk1iQrBKfhZektI7Z8AQA56pFerq6pu3ixTq+uqbtZkIgDYBQQkZNWQ+LGkH8jtgQcRPyQkWhbtKVPHaZpqG+Cl+UFjEJMFXgugkSBYgNLK4uLiVGVFa2Prl6/OBwDWtqIbKCqq32XSu5kGrhOYSXxASBvz62EaxEjU1/IAa74tLWYAysnTZq6luGIhj4wIvx4SgHPnhgbg/PlBAMRQ/Q8DAFMW0NTRGjuzeXThSAw+MUHbc4Rd96wTOPcgOYLf29PT2ZHg4+OjbePZuIprMyBZ9Nmu6VgxkYzzXTELbMCUKRPmqldMXNGpN7ThUFK2CAAWAGdP5gujo0KjtVGhoTKxL08sFCqSxAq+Alx5PyzmmhqI6WrS08/iKi+pyZPIsn+8U9eWra1rw3oxuR2AhIPEQnT04PLv6c3nh/jH7ffftjn++821fVh9bWhoabzEdoUHBDEAlN67XqxTHotVteKe/atklsP8V0vBHzRefnkx1wwM8gEvW89eEakxWX+2SZCEffDNSK6H+ucA0PBgWAAeYQY4EFgN1P9Q6qdiAQBH/wwBDwYBoFf39HH0f+QIP4LcKmWeFhLuGsExATEdhvYOMj6qv18NAGgetLmJ6zR4F8j0ic/NtX/uWQj+VsydMmX6swDA9k6DRt//wIADR/h0JAzZDsSjABdQ9SBRoVqxUCwqaMMrY4IBAPy2eKw0Pf/I2XR4zCkpwWmkuXp9viJXolXk5BgL8nt7kIOakmqwAQXpZK8Q/hP5ilBsGo+PT6s9zqy+hob6S1gGAP1fQgCCqAW4DhagOF6N57hR/cuWweP1xtb6+uurPl21eEj9UwDWflXRyHX+3a0UAKrqZpIAEOWXYRQw2ARcGSyPY+Brq4Hrn4sAKP08R8wARBwx0uGAHaD8TlA+I1z9NxnU+j6TAUD9x4CJJ/uu5Kcl84TdzAS4yUjgmMePiADjUKWR+CZItGjiq9Sa7VjwtcdzexAAUPc/HdyCPr+gtzf5XC5YABe6E0CuMQAAoqNl2uhQHCqKIaRIKAqDFwV+7x4jAUCRmFXTVhBzpqQkERyFNk0mEuVFaTFoKMg39oLnz1Fk1SgUmDMajafxL+YrouLT4hCAMv/yZqr/hkpMADAGvBRwKchkAZQg8ZIGPMTJAACB4N3S+vp79f9rYQQY7cMzHPtY+rDPNCOG4wRa2B3f5mbW/FMEBpmAK1dGhQChwGqg+k0InB8sJgD4xgtk2ns7+5lzR1g5d77dVANipkSQWdLYtx/hHEEuFjPp/0iMCYAQrUZDzEZT7rn+/g5ItH23J9T2dPT4rJfo12PlB89w4vIHFhJ8ps/taDLUiWOOnMttAxNASgC0F4R/5Fy+MVoox7vkEADIBcXk6iORoq0ANdnWBgDguaKcIxdyStIPCaNkURAyRstE+QUFCtofVpKlUKRnKRJLshLxugDsHShQ4M5+mqpco4ovK69owGysXEcyALACEAkyAFReBwuQooxXNUAasPZVnOUxHzF4ZXdrY9HPFwcBsIQAAASsrW/pIseCOYFdVytGACwBRFj1w49Aseh7NACPQcBqgO6J/s8NrX8WAVICwGmfvSa1x3AGvdJ7I87lygwQ//WZ9c+HcB99BwLQSweKg1dgCJDjDp/WQPpFDXh4QIPXgDV1PjA8O2HKXJLyY+H3uSlTnp3io65tUld1Gjq04hgxGIDcZMsY4Ej+OaFnKNgAGRgCkViRnB3iKRSHheWTHpBevAIGfTxuEdXUVMtk8mxFjOxAnEyWjScFCvCGmJKaM1mnzkJIeDYftQ9+wZivEOKxsTJ4iE/VqXRgjCsaEAAaA5BNoaBLay7WV94tVqYc21aOZYDdr7wK6qcMrMVs8IfFw+UA83fD1zPZvvnMRUODCQB2yVP102IwfvKBKbdC1zNaBKzODSEDTP9AAHDQJ2cVk8nw/BgTA/QJrHf6P+nlGAA7uwhiAS5cYAGgYQBfXyXDqpCeNgwb+js79T4+2yUPOno0uOTtn4UYYO4sDAKnPzs9oweyQrA/fdgpkIsto3zTbECyFxQTE4I9Q9HR0VFaPsTu2VEhCkWYV34vzu7Bu8cKwPOX0ISwRCVVy7IVeDTYX4tt4vmo8vT0xMQzZzBrzMqBD7SB7cgXhURG7k9L8I+L26/SpZY3lDVUlOmoAbh2rRBDgKA1QWsult67q1QePBZfDnlg4/Xd90xxwLL6+qtF9+4V3bs+KAZAAF4tBJfR2m1JQF8zFSz+s3FfuVloPbCbrRMhAMXXr48KgWEAGFYQADrjv7/fOKQBIBcIAgU0mDNdIYBn9+yc7ZwxEbiAFoQhAJ1AbhMeENBoqvAmESSgvbNH7e7jntBp6Nk+cfqUWaD8WXNfAPP/HCAwS99haNJq2/NwgyAfmxnlMS50NACGAXw+/KtCnlwoC43SyrR8kcjTM0os8hKFtQEA+Yo2vAKkJL+gJD0nvwacvVojlUhlGXhkMDvnlBFrxj0lOI5GoYAAoCS9AHcU8OYZRUikJE6dFhcviS8vU1U0qMrKy4pZAGDxBy1Zs2RH4A9FRcU4+i+2XNfY2FBf31i/jLgBeFg7n9SE6htXL7ZAYClGAEtfKYKosbWre6AJoAAwht9C+2xBuAWCBdIyQNRPZOQIWI1O/xSAI0aiVo7+YwboH8eBxsRcYEdEsgYATEA4o3mTCeDzaY+4WlMFa7/JgKMDAAA8vaXu0Hfixg+OcZjyLBiAiQl69YoVPR0dTXKxXEh3CcgAEQYAvG8cf4ILYiHPUyiL1kaL+QoxLyxbIQ728jL2wjomUkPKgWeOZMGjWp0hjcLcPtI/W3GorcZYU9NRAhHCqUSwAJAX5pBrBxViY76nv1SqjvOPj4wsw1AsNbWhnFgACASxHrxmSWDgpTVF94quKJWxsf4VOpVUmgoErH2F+ABg4JVXChuBgMZ3aUsAhwIE4F4jAaDLkgDWApBvWW4p1AUAAa0P0Xq0mvQ/CgaeBACyfk0KHGL9x6AD4FMAWANAJgI64w4vvVrK9Pd7u6rorIAqcpkI2IAka59+va+vjy/OoXnh2Wefw+iftoup+3o6DH0PIPnLSxbzsKEViz1yshXkwsQA8DO0wUfFclm0LJQH0R+EdmKxV5ioALsDRAoRHwAwwp8sYuPV0jS1TCaRQtgpV5zBsAAYyEL3APZfkZ6uiInJh78To8iPkpTBnziJNF5VFq9MVaZWNNwNYgoBlwICVq/GGOBKY2WxUpVaHJeKGlNVNrZ+ufYqGwtCIFgJJmDnYgv143tLX321qLGxpRWbwi28QA/JNsqZ6N9S/Q2UgJZGcqVIfSNX/0MzMCIAzj8eAFTgEU4AMJgANABH+iwNAOrfLhzJMP1dcs2IoYo5JUKuk+oMsx471tDk6+MjgRwgY/pzEPrNnQumf8XcKfb6nqamvLZe0o1+Pjm37TzEsOfPnUumE+IIAQie0dNTFi0FHyDVyjyjcrPFQrFQCG7AS8Tjib34CtQxBHrVeM4jQ6OukskywP6o5YocBR44VJxxIM2kAEBWusArzEuIw+TCZCq1RKVOkKji8JcPeUBLTxFuAjLVwKAlQRgEVlZWNlRUpPrHwZdUqCqaG8CxQyw4f/6y+a9gTaiwtbSw8Oq9ANoOiF2hO1cvBgMw/xoAQI8IWqSCTeqGclP6Z6F8FoDmlquvLFt76ed/DQRgKAb+MwAMbwD47E1BTKBgEQEQBMi0eFbo7oAeVV9HTUC7p7X1uLFzIRHcrukz9PtiDDgRi8BTNJ3bt+Mp9ORc+BHb89pzxfJcPDgOYWCMeUI0FoIuXOCFyqKiNaGh0VqZe7TsgOyAVAM5YTRPkyDRAhXZNYlJeLaYVP1K2DMfdeBQREkiUVJOtiBJUZBTnX5GoTgFrsjXN3K9r7+vZLO/f5zKPy7Nvxx35EELTUWB18js+Z/hMXBJYEDQkiv19QBA6v79cSRgV6kSKuohGXiF3PmHocDuh/W4Wkk6AMq/eA+egwf47bJC9AD9Fvaf/HZU5eb6b9kA/TMENK4FvOYHXh9KHmMGrEav/zwLC865JYyDAQtALwb9RjYCcHa2t5vubDYBF5iiYKeWjouoq6prd7PGyTtjDkEquF3T0TcXS0BTJm53n/JsR2dPx4MHHXW553PzcuFnSRbKZclg6c/TSiCnFAxBYDQOHjgQLdPgcBCpTBoVJdNGRwk1aWkaqUaTrDgsVpytyTHmtxlNJ35KqnEIAZgKeV67UAh+v7oaYj+xbxyEfZLIOElahj+OFoKX+Ap2U+YaB4CAJdgdfrmxslKni40HACoqKo6nqg6oIBlYW3iVJgPzX1179SoScBUB2NFIZn4VIQCBV+uxNXQQAP0daQ0sAYMMAGsCivD0wPzr10eIwJVHAHD+8QCYzlH0MoVd0zVBBAvGABACLoCSAQBSAyACfhyjAEKA0fR/rGPCAH07n45e+tW0zr4qd3cfybMTsO1zem1nRkJfR0db8vneNnne+VxZ7vk8AEAsJ8dFYringggA0dGQBILSNVJfnyipTKaX+Wq0QiEPTL1MW6dJhtBQUYA3y+fnEAJIRmiQa7Xi6Ci5PK9NKE9KgshRBL7DPz4uPi4uThKnkuxXJcQnxKWp48oqKui2LBeAwAUBEAlevFd6FzxAamQkANAAkeIBnqwCVnwptQCwUv9nGeSH9VfX7NixNIC2jPxr6dL5vw26V9lFjP+gOcvszl/ZAP9vBqChMWg+ZJPXr48cgStPBACtBPY/RkDv1CRcMFIvf4HWAKj+p9tFUAI4+4I9ZPlX6UV8V2b41hif/gQfH3efKp9ZEydMnGvQN+HIWTwgKhfntmvFuefbk6NlclIJOBfDKQTNIdEnHh3TyjR6vAI4OkoapVVr9HU8XgjeCQx2QS4WihRyNB/iMyUQDZQgBfdLtKTJRytvbxMLQ8iF82KRyF8C2gcbsD5SokqLwxlSEAPg/hyE5rXXAi9dw0kxSEEQbgcEXrx373qDShnvK8E4QZWaGhrsWd5YT4uC5LT3K/PvgREohXRwx9LKVvxU/dplv51fWFrZilMiBwPw4HjtoAIAR/vEB5QuW/YIAIZGgEDw3wCgn1wgxbXzFxgDQEN5ZzZD4BwXBf3r67xsHEzz18ZmQBjongBZgWTFBJ9OfZWhvbM9RkiOB5zPhdfePKGcBPu5yexmEOkMJ0+9omWw/KOiSe9utKxKI5NqtGIRT06qQ9HJCkgRNXVyuTYJln5WiZE6Ai1xGFFgARTCkCSRuE0WnZ+UkJGGE+NUEolao1Gp1GlpKkk5Wd1lqrLCgB8AgGsEgEtkO+hy6b3rFcWp8ZFxAEiFShof6hWyadeO6w8bdxcVsltDr8yvb6yvb921+GppURHeBTf/t2uLKitbmGmxA6VcRfcehl7+BIDGwmWBjwJgOASuWI1e/yMCoPcIq39S+40xewDqBC4M7A+rakpys+GM4Bw7DQHIaNLre/o1Gn0t1gZy+TziovPyzkMUkIzd2eC05dQCmKJARAEBiI4+IJP6HoiKgjDQF/xBdJhCJs+WC0U8mUKM9w/AgpdDRmg4U2PsKekw9tyXyeKAGNmpxGxFNogiOyoqW+zr7+8vjfSNjPSFaCBSErfZf//+MmzCxizvhwAcEPfztZ+JCQhatWrNxdLi4gplfLwvAUCSFhcasmHh4sW78aaHIhIHvDofTEEpvl9aWX+1qAhc/z3wAKWNCEBX9+BJ+93daXT3iZP9DwKgPnBN4PXro0fgSQDo7R+ZDaBpXi/2gfAZF0ARcI24MLBDsLOK58rVvzU4gartPvoOvJCmr0ev5/OTzxMPIJfDT2I0nj8vxmqfXEYtAG0JJZUgxgLgZrBMQ2wABIQaMAcioacnNvSJhElJ0QCGVCupa8P+DyM9Idih0WbIZIl7M0uqFcIovLFKIhMLI0HSfOnFbhJMAuLj48sqWhCAcvUPZCuYVgIDA9YEBKxGAHRK+KJU1BC4jOjXSbhHLoGl93/jxsDVot3XIT9sLLoHXuD61VfBAzQ20t3fIQBoljSTzUC6+puZjUGz/oGAlqJljwNgSASsRq//vJ7+kRHABHqQCRyJMAGACNh5evb2WBDQ1ztA/yBPG3qqJLUdPf09nf197Vg/SKaDg/Py8Ec1Cnm50UII3HPFfOwInIP3Q5C20DkIAI9sBmn0Pj4yaa1Giic5wO6HhsjFENspkuRRB2QarTYvu4CMf+u4fx+jQLU0WpuenlVSAu5/oyhMq84WifBCN1Xk/jgwAvGSeKwEAgBYBlBDfoYt4TtJDBAIWcCawIAlJgAgC1DFQfbg8ya57bv07pX6RvD/BABk4JWrD1shGGjs7rv6P7+FJLC+saWrdUgn0N3Vp1YN2BVstlA/uVxy7avXRyD/CQD6RygXaAjYgzGgq51Z7O2fnx5t2R1mjOHbjRsAwJjX+qt8fBOqevqN/PNiVz4AEMPHM6Lncs/hHqYYg0DsyxOL+XPYPNCFOoEQ0DUkAvDHRyoNjZKBA5BpecLcZHk2n6/giRQF+eAB8uTa/DZzGlhSoK3SaLMyBZklInAACnGeQqTgQQiYIPGNTPD1hShQkhYZnybZrNIpU1WS1NTaIiwC7bwU9DPuBC9Zszpg4Q9FV4p1KpVEVdbcEJcQGRkX+ibbCXql9XpRPWTsmA2QgsDDUgDg4cN7vx3/SiEpBLe2tHYNdgE4MkTSYEFAs4WQVqGW6yMCYCACTwJAX98oCOgl10M4j+XqH8T5HBcAY74iJnichViPnZHUl+Ebud3HJ4OHbaj8GHEyPzycx5Nj+0Jycm50tDAagjrGApDNAPbWEBcPHrCBIT9ecRkVSqbRaZNFcpFIHCbKFwrzD5/OgSggSp5TY54Bk95WW65WZx6SHc5S5IvEonw+X5QtzFBnSNRpUmmaNKFMEpewXapSJ6RC/IdVmdorAMC1nTt3kq5gLAQFXtTpKnDWYEtLQ0WaNC41Pup3FIDVSy5iwX73MrZJZG1ff31RUeXD1vp5419Zi3XgVjIpYigA+hokLc3Ng30/sxVAugYaC69fv8vIyBGwGr3+83oGFyuGJ+BCr5EfcyHCbjKrfgDgxRft7T3NzWE9F0g50dkSAMe23k4JWAAfd3eZMBgAIN3+DABtecnJYjnewxktThYztacIcxg4Zw6eW8MqVJ2evdu0J9rdNwqDQ5nm1Cm/6rPZhzMzM2vS6TEwfHQyNjdBLlLVYaiDXEEqhQRSkqbx9Y/0j0vw95f4pPV0tLQ8QC2Q5ix8cjGQRv+4FxCAz4K+1ukg94tHp12RACZDEk0AwMGgOyH1a70aSAGYP39td39jUVEphIDjX3p1/lVmJKwlADgyiPQG9qnKTCageaC0YNsgOIG7XBkhA08CQDfeBTMyBkhhKOJc3pGIsdac9Q9id8RsAo4QDXpZxIAhF4ydndu3JyS4u/s0NTdpXcMjyNWimAbmnjt/DrJ4SAMhcSeTAxEAMi6cOSKO3eGUAK1eq9Xr67SQRRwAgyyRRko1GkPWiZKabHoAlKkEk0mgHR1tbQVtPf16CPW+j08Fb5+qXrF/f2Sc/37/+BUZ/Q9asDEfCzOoiYqK8iK6G4jHg0gWeCnockWFSqWKj8fPx6emSlTR7wEAC6dOxSMhux62lgatxSYR9AKN/a1FkAU+3GT121fnB1bSqdCcEKCvu5HMBCFbvQ9Sm4eXltbBAIyQAavRtQJQC0AuA3rk1WBm437kCD+m43xuTMQYO2cuAnaeDADw0Ebrx+aLGKxniC4ojP09aknG9hUrthv0TYfJrAhyt2zyObD/MaB/yALkWiGZH8UBgKkF8BkCZHQCib5Or3eXSUH5Eo1aU5eUc/psQWYJ9geXmMc/9RgMebnYNla3H5ZuampqmqpcvV4Sh6VAico3A9b/A7I1S+1weVltEVYAiAUIurQDg8GgqxXEAsQjHxA1SiRSBGDBVHISZPWuHVe7GwvvXSWh4N2+1iIIAhomvIRbRYXUAnD6wR4+LCxqbKXjAR72l9M4cBgC8Mho6927o0Pg+hMCQBtAe0bmBSADOGdoP5cc48oSQPVvZxeDpwZ7SW8ZNeJeM1j9O8fkKxS4lWDQJ6yYm9FU2xRiS+bGEgCwBwTyAaFYjmUAIbwmgw1AAMxTolz4JA29YAQroYV4H4cQHJAeOCBRa6QJtXXi5KRT2W3a7DZjumkQLJiDtvaq9jqtsbcuEgdG48hoSdp6yALABkRGAgDN2KBZXqaiObmqrPZiEAJAigAUgEtXdbpUJWQBAEBZZHxqmkT2h3kLFiyYupCJBHfh1n0ptonNv9rfeq+0sV/3EtYIgy4RJ9DF0X9r49rA+kYyGgZHBqsaWh4BwIOW0qt3h5LHMPDEAHSOOBKM6Wg3tOcmRziPcbbjiju2aJ/D3YJ8CgCfbgSNG+d5AYdXY3Wgs7ezSqLR65vcbMjkaDwsjEOtknFknFAmz8OWXnLhJQQREcyFsaQUwDQdGJPlaABqEQA8jJqh0UsktYYCeVJ2drYsOjmHjH8x0oNCRux11iIAarUag7wyTZo6EsfLp6VJEiI1reD9Qa9lqaAK7AgBAAKvMW3hgYwFuFysK1bGxsdXAAGSA1KJ74pfT5o0dSoLwJKd3a319fXL8O7XwsqrpX3d/UV4DeD8S4HLKrkA9HW3tv5rydLC+kbGBPQ1qRBARuHNLRwaOh60NNYXBi4bGoC7owFgJPoHADoePHic/nvYi8R72gEAQxsQYDfW2ZmbChwIpRvDYtMmojMhIKy/V4GdG9hP2tPZb9i+Xapxw0NCzI3SuckxyefPG3k8oVCrFWtzxdHoBDAIdCG9wcQRMHvOF3gQz8n0Umw59IlOiJRm+CZI02QiufCwQnwuNz+fORBMDgnlGHvb29rbCox1/rDs08r9EyLj4tbv3+8rifTx9XWXtsDKryhTpcaX44yGMkmZak8Aun9aCCKN4Wsug/6PxcbGYq2mVq2OncrIPCYZXL1z9dXW1rXLdl9vbLx69WpLX2tg4GKyT7QsiOMB+rofNjZeW7w48F59I7kmpru7r6ycRIEUAJOAV7peGBiIU4ru3h09Ak8GwIPOnsfFgD0PyLGwzk56UKD9fO6RiMmTuQDY2U1341uK1zhr6xlJ5MbxfLdgMoyyp1ftu903o07o5hBBCcCGo2T4WXk8cTRuBuXhRdyDAKCbzvBVUQQAPIgeKpMcgIUskUpkMflyuTgp6+SpfBwEVYKHwICBtvxsbbtGW2DU+sfHx6UlwKMkbkVcpH+8r29kpLukAZc1rPw4CkCaSnU0AAcEkZYwAABSgsArFcV4HXAsfKkKvmfsApwLjD5gwUKTFygqrG+l096uVvZfDQxa+/JSMgkOnIBZ/+ApghYTE9BIXUDfg+O0BNTMXfuN1+ktEjhR4u5wMmIARqR/AKCnZwQAmE6J4EN7exsQMMbazlLC+eEWBLiNc1Rg6zZo3s0t5gIBQBK5fTt6AXk4EkAuEAADgADg8DgsDWIYgHmgi+nSYDIpCPcjz0djMUCLI5qwQUitkRxQSxJkivR0gSK9pDornxkfRgAwtikgZszLL5DHqdLiVXH7If6L27x/v38cASChETeBVWWqyPKyMlU5Hg8AALAM9DMC8OGlwMCg1SmpxcqDythtECuoINyMZw8FAwELFpq6wErxouCuq0VXG8EABAUuWLAUEQhs7DLpHwCo37F4CWMCCAH9tSqu9sHtV17dHWgaIllYevfu6BF4IgDMF8MOr//Ozg6DaXQQAtCelxvjajUAAGcL9fPABuTnK4y9544Yk11tbF3DY3p7DXhAoEpf1cRzdoU4AELBGPKDnuOHhAABEF3gri7xAZwLYyAIhOUPaSDeF6TRysAESN0PgPalEk1GpOwMJP5ZJW2KxFNE/8xp4Zx8+O7Z+QAARP8qtSQuLU4SBzFAggTvGnJPaKFdAGWR5TimDfsBjgbsAgCuIQBBAYGBawKWHIUQ8KBSGQ/RgkojlWyGCJCeBCWXhDBuYMmOrr6uxsqrla19V8l0sXlT56EWC/u5FuAeXkew9JLZBPSrcFOIQNDRCdpfazE/+tK9u3dHj8BIAeAeFiQHvh5tAfDG2M4O5spAA7lNoi4vL5c/iIBgTjMZn5/f25aPffkheJecra2tq6tXv0GyPVKir6pqcnN2dsNSUAwZansuhlwjkdve3ivHEWJgAcLnsHtCNAbAjcie4JDoA9G4F1Ali9KqD8g0ar1aLROk5ySmp0OqcQYBaCN30UIMUJCb15ZXZ+jRqiD8U+HtMWVq3Aby9fVZn7AioaJCB5pPlbo3PSQnNSuwEESCwEtkYCTuCH2NE6IqdBAnNqQKV8ybN2/qVNPKX8i4gTWrdzaWFhUVVfb1t9IBg0uemrcE1vLa0spKyOe7urogUygtWoMzpZZeK21sZS4RaU5tpoUgon3aXmCeIxt09zHyOADOj8wA5PbhiM1H6L+P3BgMYroylM6Ng78aYTdmkBNgBTsHehU5ivze3mBsH0T9O4sgEDCoNfqqWq0zAcANgwDIBCESgHQAT7C0i3GIHJ9pCmABIM3HRqMxJBobArA5TEoPnRjaDT3tUduTCxJPtbUZ286eURgBgBxjjbFNX6sqbyhvaOqrxd7v/f7+++PUZXNB/SD+CXPjGnQIQFm8b0MrObBbUcECgFlAIEkJixoqdMUVxcqG5rJU8Qbw/lOp7ScHwBYsIDNCVjf2P7xXdK8IDL5hJ5kzGgRfhY68COXevXtFVwsLCy+tJQAEYrWQ2SUuKyNzISqJ9i0BAALu3h09AlajdgB5uY/1AIz+Ox8w1wiyo0PzIBWwNu8KWGNEwMaB4cmIjhFPYPQaXSkAQMAFUi7qaaqqFdoxFgALAejg4S2eYMs9L0QAeDgtmgJgay4EQa4QhVXdaCk4Ab0MJxMjAm1CjTBbmK+tMhYU5CTl55+pKcg3FiQ11JaV1zY0NPXX0nPA8FKW5iOJ9N0fuT9O4h7XUF6hK0tNjY8j9QDQdNnFIKYSyABwLagIgkAcD4AeQv4XMg5mARJAAMBoEK1Ac193Kai5pb8/xJ0MF7wWMHXqYnABVP1U/4WBZKjc0mU4H/wh/X0/UMG3rbxbGvTq/IEEBBbV3707egSsRu0AcnMHHmAbnoAOMi/UwCHgSMTYsXZMKDjDHAeGuzm3k7KgEUOAZGcGAOdgGhBCLmkIsXO2YwDAY0eYDyafz8O2cCHkg1gMdJnDqQRh7zH8l4xC3BOEGFAjxVBQj2PJOju1QrEoObu9U1vQlpQkUuChUIVCzKutrS2rbW7q6NcAAKmS1HisBPmmJSRATpig9pVU4Kns1FTVcZzUUAEOofwiKQWT2RBBDABlSmVxsVIJMUJZymri+xmtEwuwAN9bWNzfX3+vtLSlv8PZeRcCUFq44KmpS4MY9ReRSaGBS+kpwqVri+7VsyXiq8uK7t6trCxdZgkA/AuQQNy9O3oErEZvAHJN19xzO4CYwm4PHQnBAEDviGQJgEjwfN6R8DEmAuhAaFAqZIfOaFN6e/twijuPuVLa1TnY2Mu0nPYHYyHR2TmYOXsUQXoDzucmJ58T8+huAD0izrQEYBaA/eM8on2c6yjTkysM4aGzTZ6Ex4CTFQVGcZJIhNoXK3iiBmKvOh70aRJUaSp1mUqtUqVFxiXEYVdwpHtchaqsHGI8tACo/zIWAKYhJOgaIHCvuREcwLF4/NI1a1az3n/ePDIkbiqB4cPrjZX1jbjxe9jO2ROS+KB7hTsmPbXgatG969eLruLyB7uwbClzeHB+4b1SOjegu+jSq2vrK0vvFQXONxEQiONEyTiJJ9C/GYDzI40ACACDTICpSbjTUgYS0JYHqcBkCwKCcUqYXajp3zAa3ZxNBLiGi0kHcr+Rniuxc8PGkOTkIzFHyL5QcrL8nDCEZwKA3Q0kZ0TPJZ875xmKBIRGHYiSymrxp5HV6g1V0RptnlYOa78tOV+UVKDIz5Zni8S15WXN5aqGpu40yPr2q9IgAYz0Xw8BgMTX3dd9+f4KICBVGR8fiwCUQTTAuoCff8ZDQcQSAAA65THlAQAodTVDALzB+G/qVFIT/BOkdfdKK/GX2I+BbTkJAi4tmvDXK1cup4CQ5R+4bD57ehRMQGkjvSYgqDDoVfAN8BfISQDcQrjXaJokcPcJTIDVyLvBWf0PtgC9w6mfIYDMjCaHPsEG5PKdrQaWA1CxwtxexpAY6cQYSgC8Deaf6811MwFAMnwvrxg+GP5kOSQC4hAsBDExAB0V5zInAudLJueeCwH9azRIgUZW21Sr16s18CDzjZRWRYWI88H2JyUV5CuEIdlCEdZZaiEIeKDer5LEqeKwB3i/b4IkPi2OWABw6xWq+FhlLKRiYP8hITxqAiCQAhBY1NCgK9YVgwUoQwAIAQwIC6c+9dSkSZPee4ghfiX+/uowsNUGEQJ2vHk0hcjR3aB/iPKWmk4PY79YK94jgJEB1nwgKriHO4pB91qZm4a6RwGABQNWI9H/EAD0mwGg578jjqC7HpoAMvqDJQBrwpapAFMgdnbjHQGD398WzAGAuVjajYSF+JUUAD5m+ji1WZ6bdx5iwBBeOMcC4AtkAcnnz50/x5PJ0AJERx+QyvS1GrQAmlptlFYWJUsWJ+W3KRQ8L152vlwucxc34fidVFV5kzoyLR4LQRAG+kdK4iLTIBOIXOHfUAZ2PzY+1r+c9GgDLRfJqid1gEtrVsM6DriOg6J18XHlFWVKevZ79WoEYDWGgGgC5i0EC1AJAHRd2T0XL04P/ooAEFRaT0dLVlbWQwq4duka8xjRtQBANwNA0PzC+kr4ykKqfewiHz0AZgSsRqL/8xb6z+XMe2XOfhkv4Ox4PC4yUP0QDhiYy0NpEqbPlePGoIX+zeIWkitnnrpaEEDWv7OdzbhxDm4QBrg5e4nIZTJyOckCeJAExIS7MFcH0jTwCPzg7UbaFiQjU141OJxWCqGeVp6tALMvEgnwuLhYlJ0fGq31TOpoaqhFxXaUqcvLVGUQAEhU6P0RgMhI3/iKckgDjh2LjafjmSswDWSbQgMCVgdgNlAE6x8Pjh49GrB6DUdWo/6nTsKKsK67u7Gysb9y8WJ78HFurp4kEyyi9Z6HkPI9bKz/VyD3L8+/97DxXmNfUSE1AfcqGy06xxgT0H337ugRsBqB+gcYgFx24DPn7GeEi61LxAUuAiQSpAEhWxHUk4pQXvIRtzHD6J8rrgMJMLeLzABbID9HWoTxYJAco8CY5HPh5iQQAYAAAKJAz9DQ0APR0dGg+XYwR+3kZ2vD66hxjCDW/RT5ClF2lDZP5NXdTOZwtPSXRUqkkZHxcZEStbqj40FTc3NzV0uLSqlSlaceiz2mhHXagLcA6GhXMLaFrQ4MvEQBuAsApCoPqgOo4k1zgAgAQMCC4n4yDKhlyeJFZC6c6x4EgBR86TXR9ffuXeLqf83S3fVXC+/VFxaS+HBZKZ4f7WbXfUtXP7ltrrvv7miFAnD+/OgMQK5pdClX//grRwLaTfo3SaclALnJ4WMep/0h9M82DduMI3/NLQTvlMQe4dzkPBwTknzEBADZC4iBAAD+byFSbO+KltVKpZ2Mi+rpr3I/gKmBTK5tU0N6qBWDaajSynEGb215Q3O/ZHk8loH2+6skkv4usgvb1dVcXKxK1anAAigbG0gWSAD4mRwNwyyANIdcxSmR8fHxn368mtp/MwBkT2jeggVf99P+/48WLn6BjIb0hCig8GEXHhWoR0dwr+jnQEsAAgvNcg/iwZZmdkI4GRHSR2cL3X0CsRqF+gcBYKF/IOCImQAuAH0dzN0h6AH0dbm5ESwAznYjAcCZAcDGBiBgP89sI4iFYAWSSZeoBQBzIFfAGsF5Hp4QiQb/L5W29/TQ5sD+ugPSqCiNVF2nzZZCso8KO64ubyAANDQ0d0s2q1JTJRABlMVJu5pJ/1fLgwdKpSq1IjU1NvZYA54AL9cVqxAAYgEIACQIBAsQr4xVBlhoED0AIoCloIULv8akrVn3N0gMyZW5blsCIQKAP6Wl9+7h6wADYAFAJb00hHalMftCTEj+3wFgkP5NADDz32LYZsw5EReIF0AA+vpp42A/jokycMJAACCZP9bamYZ+zo81Ac7M+gdxtrH4AtB+jJh0BWEgcA4AYE4HkTSQFozzzmMZCADQQCgIqu/tbEcLUOcj9T0glerr5HJpqkYiSZUcT4WwHfu9mh+0POiL2xyP5z8kcWn+khZS823uam7R6VQqXUWqSqdrrKxAF6AEAC4xAIAVJ1MCinSVxAUEDND/EmZDgNiBry//79+WkNnRi0jk47ajEJRfTwkA+XnNwCFCQYXkIrHCq8wQ6QfMfAgyRrSZGRX3XwEgbzAATPwxUP+2ti582onbaz46QrYFsPhivmA+T8sfyzYGOD+SALIbwGh/nM3Az/OwIMCPjhbivXLnc2PIkABbcx0gBm1Anlwrw4u7cU/QgO6oHeOAumjcJDTINFq5RpakKVNDwAdRX3N57YOm8oamrrS41Pi0NLz7TYK1V/xFd7U0qFLBLkCOD2kgiQAqdGVMDHCNCwC4APiS1QMBWE2FbAsSO0DlBfwfuvqC6itJ+H+vqAiSysEDRYMIAEWmjqEmkwVAT9DV///CArAjBTv7zPE/Z/1DAI5hADsIkKi/s/NB54MHBnqDKAHAAADEWFtTzT6SALwF1JVRP67/IQAQYzFALNbKk8/FxBwJZ+cEsf0Auedzcz1Do0KjZb4HoiAG6OvE6cZ6fUeeHJuJZNF4c5lMrK3V6zVIAYSAzTiB84HKHyRNsj/Of3Ncc0VFA+kEb1CmqpTKYwDAwQrc8dFVFJf/QMbEUQACSBB4BbLAeEgVVw9wASahO8NmIUluCJ5LFuob1VJJ/J4lq5csXrLQEoDFxAmUciJ/9oQA7Q7r/n8AgGmkaEdnD2MAyO1RZgBoGGDSfw9RPwGgCU0AA0CdNgbnhDAXz5id/ED94z3ArPpx/Q9kgG4h410y2BaKAMyhJ8QYADAKOJ8bgi1hUlC/VNYJ4SgkpbW1TVpeSGi0Jkqq0cri4lKl0lopJHtxKgIApAF9Ev+4OP/4uP1x8f6Q+5URE9DQoAQXAEmAUhVb0Vihwpng6AIwDQQ3sCYwgLiCy8VXlJYABBAB1dNHggDLwJIlS99EAsQysVCoadZIpZIDK+knLPW/NDCo0PIKkQem3hAMUlv6/usuwDxTtsOABJAAMIb2YTEGAEvwCEAP0xNEu0cRANOeEIQCddojrtakgcvFJcIkA0mAf87GBl9N9n8gADw8gQ4WAHJAHm4NnwtnN4OYGABdQHIIGgAZ2Q1s7+lohx9FozdohdHRURoNnhGPl6pU6tq4eKlEosa94Oba8vIHkv0qUgjCY4F0GtuD1oZyJVb3lPGp6ALwWqDi4lQKwCUw2lwA9sdLlKtpBrA6YIBYmAHi4u2dnT1xnoFKBZRKpN+QtoGFJkqo/u9dDbzWOmByiMp8WryZzAz+LwCQN4T+AYCOTlq1J/p3MRsAHNfPeIAesvYpAmABqP9vQgD0eefCrfHvhYeHR1iIi4OLi4MDq3pbjPtp6E9UP8gJuAXzw/lC0hOGZb/z1AXQu6Nwavy5czHncz3RAshIU0B7D9p/BEDupceDo9ooYV28RJMm0cRJwPaqcDu4AafBxuF2cFkcNoTHtZIlBiFAufJYeaou9VjKN38F969TFhcXV/wQxEwLJzEArQPoVMqjOwMYsx8QMDQBNBYg3n2VszMpVhUrQf/x0o+XmhpHyD4i3jC7tKixvrCVW3/DKLzsezo9sIGdGv3/CoDOjo7OTrP+XcwGADMBnATZgwm3GYAOBgCmJFiXF24dwVwFEhFBIMAdYS8PEAd4cXCYw572JjAAAK7DBQpe5FwIhAO553JduADg1YHn4IUvI02BEApq9D39nT3thvb2XhEWiKNkUVqeUKKpVYELkKhVcWl45KMczLwqMg6TgDj//fH+kRgDNpD93/iDx1KUqSkpKXt05FwQMDAQgCDI33ddDjB7/UcAwNiAJWted5MBxBpdqhS+aQpTM2CDRZCX15IqoWlyAM35IMVKSy0zD44vf9B//d8AoKAAX/HRLAUcArjXCkA819luNOnfEgCXCLYc+IAZIt7Z00GbQpirZA11ev4MHBCLZ33wlaDg5eCAAJBL38kTDwfa4eNCqEAsHBwskwR8CIHlj4VgcAFH6I9iKgThwOIjR4LJSBCNTKuXNZEcwGBo783GMpAaLwLVatRpKuwAxBoxXsKKWV9Lmbq8HJtDsOZfATlgMwHg4DGIAFVKVXFKBZkRVKFU7mKmhf+MN8YFBawJHBj2DQeAScX4dtNXez65eO/ah3+DrzeXjRgA5r0cVNrIBYBuxPaRNmGVmQCIXYufBIAConeTEBYKTEwMZQByUYnGtiMmw82uVcYCmOrBVP2Qd3ear5JEadPzyYVwLh7kUjhsByKK9xAInPCCdycBvbsbFE9e8Q53+iEHJwcqroz+bUOwHxTCABwQax4XOocCcO7ceQSA2gBZtAGvNzC069t7OzRgDyAbMDzoi/Tf778fLL1EIkHllzez45lbKvDMZQNRNbUAsalKTASL9xwFFwBpAakDsKNisZ6/mgPA6sdaAEIBRYAqfSH3AgGmkWTBwvGL/0Vun7IEAB+6+5u+54yOL68ovv4kAAwpLBVD6T+bTNVSUO2H88PJL90MwBG2GshovwcMr56rf4jDYpwBAA8vNADIAKx+J8FGBwdBogDv7iX3OZowIIp3cOIKcMABABJBIWkpZeoAZgByAQAe6p4AIGuCEKAddyR7O2o1Uk1tba3e0BOJzf8QfdU2SBqYCzlI+39DgwqBqKCLHbPABtS/iuzz6HR4a5dOGf8DORaGJ8OwKdQMwOph9R+wmiM03iNtgiafwK0dg4x/KfAS0T85KMwSQBsyuvvKUstN1weUlxc/AQHDAGCWwQAkp6dnZmUJqPpFonAXqn4bZlx/Fkh1dXUd6QfvJN2DPVz1G9rb9Efw1ilGiHGnahWAUOX7+fkJnIYS5osZAJxtQ8gQUHItBN80MJoCgHWi3CMhkOfjNCCNVIba12uBgJ4OTS3eWlprMHRGgq+Pl0LglxbfQK7nwbMfmA40lOGd3OUqXRnJtluaKyAB1KWm6opTriAVGOzF/wCr/wc8GEwAWLUmYLVl0j88AUssCEAETFH/avYWiSULF48fvyww8B49HdhnCv9M0g3ui+ofXyEs/S8BYGEAksl5eoFXuJdAkJgoCqf6ZyyAi8A0biEzM/Mmnroy9hiq6kz67wAzrL9AAPDyEog8BijYD0HAE/vgDujVroJ0cr+fCQBbJwYA0jkeIkYLQE4Hx1gCwIwtDdEKxdo8NAIa3IrAs+Jgn2qbakH/YAE6EyQ4A06qKpPEk0lMDaY5XDoCAzYCVzRUIAzxuPyLsWcDP1pcrPwmdmfQpU/XBQUxFmBVIABgqvkNo3+GgFUsAUyox8n7VpvuEVkyb/wrAMClRsv7w/v6zPcIHqcElFMLMHoT8DgA8vMHAJDNAJCI2k88lShycbGIAQXpAyWz5JDf3pMnMzOrqw8dygDLUFdnjHBhA74B+vcjDp8iBubATyCgzwQCC4vgQNVva+Ph4cbn0XNBXi5zzNvBxALknjsHMQBOCwrFPUGtoZ12pXQapBoNMFCrb+rQlJWpVWQJqcqJAYA0QIXvVKSSvh/ICVRlEAeCU4AQ8KBS+Q0AoMMqkK64WDV34Ycf/MkMAGiXHPwYAQHsl3HrghAFWFiAxYvHv/QqNvwX9dODIewMwT4SA+LoiO6G+DLTCNHiJyDg8QAAAvkW+k82qRaM/SlRONuOT8dzsZ/De7n92Ofe3k7kfW9H70Pp6Scza/guVP9+ArrMnRi/72fh6fH2RhNQfpYAONgyOaItnw9ZALgjG6r5OWw/AD/m3HnjOdoUGiqVqqVaiAI7yVVH+mhwAHqpura2CWe/pNVKJGnH41XNxPKTS7lUFWVKchIUANBhMRgAUCqLdbqUFKUSXIFMhYUglT0A8CELwJpVK1cxXaAmIz8MAAFgAVaxtUHTXXKWJUA8Urb0VQLApcZuAKCbUwPoJhvA3d1d3aQa8F8DgI7X5+qftQCZ6Ouz0BJ4EfHwIA8mfR0i6s8k524ZJZMLeol7z4xwdfGg65qA4Sew1C9jDvA2b/YpSQ9YTpwcGK9jY2PjwOeR48UONnPM4yHoXsARbAkjRRYAAOI89D5gBAyd+gPSaCl1Ar4QAEjK9kPevy2VzP4gAMCi18XWNoP+i8HWNxIAKlLxF4we4KtPL/JSAQAlALDyT2gBrhEAAlYtYI9/UbUOGwQAAKtMn+QwwMkOyZnCwrWvBpJ75LsZEwBLv58mgd1dfd14x1B3mYqdH1r8BASMCIB8rv4pACUl4OIzLW096nOA+YcvY4wBFRrfbXRztbbzIl+NANC3HDfg58RYBfajDk7pqHMKAH7W1gyALY+OF7FhAbBl2sLJGeLkkGgeXvcI+o/Wd7afJ2EgWAANaB/9gD5SgiY/TpIaH6vCdiCw/mDzy8srymLLiAGAsK+ioRFjgoPFV3D5K5UpRy/yU3EOgNR+4bo/rWMBCAwMWLhw4sQFS8yHAIdLBAMCVhEC6BdY7BSRCuA88i8sXlJ0dT4BIKiyjwWA3CHaR5qBsA2su6+rvIwLwCgJGBUAVP/J5EBtZvrIxc9C0gUbPZ3H2nmxnzLpn/ECApO9cGKhwbBA4GcKBtO5AKA4eOAz87BQ9uogvJCETBYEL6CBLKCnXZ+Xp9W3a6NlGrUaB8ZU+UIWWFaLhb9YdPqkKQxNQKoytrylsREMQgPxAA0VmACA74c4INJNGq7CzQDV3FUffvhhENMPsAYRmDh24syZMyGqm/nMzIVLuMt8AAWs/i13DWnwP28qvWF8R1FpYSA1AWSx95EGcFz5fX1dkGZ3kWvGHjAuoJYCUPwfBCDfDEA2o38AwHz1cvroKcCnhw+HWFMAGAdAlWt+x1IYLhITCQAQDCaaADAhYALA1pbTDwAEhGMSkEfGBOn1nQbcDTK059Gr62s7mmp9JampKgBAGe8fTzIAMP+Q7+HGP178hxUgsAAtkBCmKnVKCP4PbkvxsfHkS4t1qUrfNwI+3vkxloOD1tAzfoHPTASZueCZZ+DJTJMX4ESFkACs+hvI70HefP3NRa+/CfLW6yivvbbirdkmcXSc/eW90tLAoJ+RgHv9JhOA9bUu5g35WLMaCahtKH4CEzAyAPIZ5XMAGExA5ggQoE8StSEz7PjU/lv4BhoODCKAkpMoIAAABmc8OPofZ2PLbB/N4ZaC+XSSxBE+jpTGQoAME0A9eTXk8TQ0DTDoD4DBTy3DCk9sLMmowQMcxDgv9RhOg2ukmWAjuIZUpRJsABiAFJ9x4+x8dRXlxStXIgBkTFQg7e4PhJX/zMRnZk58ZtEzY8Eb0FB/zbuOJrU6oMXCH9kB971suAIfc2JrnQ4OTg7eRaWVjUWFRQjApVaIA023SeLiJ4VWMl+8m06SZwEYFQFWI9J/fvZgAEBuZppT/kERwfAiOCwLs3P2GkbRw6g/PT2JACBIdBIc8bLl/OqYMhROinUxzweIIHfT8HG2qFabq9WCwrV57XotBoKGXAAAAkCMAZjL1zDKI9eyo9dXEgugpB6hAgxABcSGpAhQUaxMOZjiCwC4R8cd3blmTdCuTz++xNwbjbY6ED04+IBnnlkwcywSQAH4CL0Wq1lW+UxNi0Yy7P/GgcbKEC07Oe7DLqHGUggwSCrITo8gmqf6f0Byw64H9DJBFoDi/wwA+UPqHwgoGUJGA4DfxsNhzq5efiMXYjYUAkwGBJB28D1YAOjyd0D9u7oy+1JsISicdowIhTJtnlijAQRA/+AM8oADqUpVW6spr9U34dopI2MXKojzB4eQihv/oPCK5gra/NuAb7EZTNeggxAw1nHcuBl2dhvAi6+5dO3aLrYUvAYBWENTAGz6mjlx7DMzF6xctWT1kndPnPBzYjRPGHAwVzUZBhiT5sApe9+tJOMCqG251Gi6UBbXPwPAgz4SDbSUA7Kq4icwAVYj0b8FAMnDAHDz5s0RIuDnHbXR0cGDtfjEKDxW/wSA9EwEwMPLhdr+caj/Oa6uoH8sDJkqgbZMKTiG7+LF5wll8mQhunxtnh7HRubpDXpZGax+dW1tbTM2A6qwD6xMpyPlIFjox5SpqcWpx3QVtOSLADSAx8cksFiljPe0s8bDjfHrFixcGVRINwOC1gRhEEgOAtB4nsaBM59/Hqt8AAD8v8mqd2Lq3k5+g4vcDrbcXY9ZoH54eXiVhhdFOCWgz3SreDdrArqRhWYgN7X4CUyA1Uj0/1gAUPs3Sd0X32Y+GgU/P294ceLqn1s4Gkb/BACIA73wAi8HxgLYEv27wu8V24lMFoABgA+uYg5YAIgCSBagyctDBHJzDXKZGlc/ANCEhT80n/Gxugp4gpd9pGKqB0sdbX+xrlJHtoZ0KgAgZVOxUhkfv+H555i558/jmRASBNIsIMC0F7RwKmh/5syFC8EbzJy6Dv8HN/2cHCyqnkx868BkQNQqmMCYbeWP58Qau6gJKCxlzo7hMDk8V0AJwFzwASFAZbYAoyDAarT6z1YMAYBJ/+YPWESH5HOZnBoRapVTKuRGiEOrPz39FAIgwHKTVzjZ9AMDYAKAtJNZ7AWQnrBg2znhOFFUjuUgqSbvXB4ZVKIXC8tqm5oegBeo7WigVzA0kN6vMnLRF/4GdcUpaAFUukpyCARt/zEIDvFW0Pg/L3jj+enTJ1tPtp6+k84KBgsAQsb9MAgsxGRwIUSBCyEheObFGyfp/8JC/X7mChktfzDbHzQa/NXEuToEoKXrKjk6Vk8F75ihF4xSL8A6A/jJRwdAJZERAJCTbQmAYkj9pw8DAPfDmaMvGjDmP5EA4Jco8goORgDm0MiJ6NrV1cHBBMAc5mygi4trsDjE1XVOOB+zANISUJucjHeT5umb5KHYCUr2AEhTDWb75RXY9l2GlR9lCmj62DcqPPuDu8HoCkDzB7cUK3E8QOgHC1euXLTg+cnW1jM++ODTDygAAQEkEWDPgpGWD3IcBDzBRPsbN8hv5Ha62QhY6n+AO4D/n9WvX1jf0ggAtKAJwIMDpfWV5PgoBYCJBh8whuBBQ/nIAag0idWw+s+hrzkD9D8kAOnw5+aQ+s8c/MUlJY8uJAxl/hPTMxVigUAURgGYQ5oFbZl2ZMYG0AIAaU0FAFzpfiEFIE9bi04g5pw+D5JBbZMckj9JeZqqvLYWd/hVtP5bnKpTldMNPyz3HUwtq9Cl6hiBj2w7Bua/WHnAbcPqVZDMr3x+urUdALAugAEggAJAsn1yHBiiRAwGgQD7G9XVZDWwvo6rfb9B8QDxABPmzp2rIgC0FoEBKCVCAGhtfUg3g03qx4pQS23xiAl4LAA5OTmgeiqDADAOAcDNYQC4WfIoGWnmAACcUogEYWD+CQC248aREIBqn24M2trMMaWBCAAj4eT8oAyTABk/Lw+sAcSB8miwAGXSVBzjgUFgA275qXDQO8RSOt0VEgN8oyTrHt0B2ftTxiqV7p5gAXh71mA1B6zA8899AEIBWBOAm4FrlnCOgMDTlRgLzpz6YvqPZBbhfQYCygFjB9Jx04u+cGTCM8uXL/evqMQjgI2FxACQGWJ0pnT3AABwb6B5pABUVj4SgBxLyR4MgNE4wAOkY+A3FACZJY8WCBctGbhpET2Y9J+YCQB4YQAQjHtOeFCUhoBAAPoA2pDCAoBGwDRhBJuWYvhyrVYjBABy8+S5yfLwaJVGheGfSoWTHMoRAJUKAn0EQKm8kqIsrtAdTG0AresgCiSC4V+kb2Rx6pWdpLC3ChF449MPPliH00IBgFUrA1atWgIhP6esv2oJ6eta8ObJurobN9JLDOgqb6ebtj5NgYDZ3DGWz9Fq1ty5K9antiIAraX38NhYJWsCAIM+vGXYAoDurhECUPkIAHIGyyAAkjrw5khy1aKpHpQ5IAbMHAUA5gpCZqZlYGHW/6nM0wwAZOeR1T8iYKoDEQBYt+DCnjMIF4vlfD5fDiaAF5FMp9XlJQvB+DfhSKDaVKafRkezQHLml8QAkPLh6S9G4FeqXPXx5U+v6HQXqZVfRWTnpx98DADs2rmG7O+sWvXMM7T4s4QzG3Dhwrc15+uAboOBiZXS2Rhgr2UEvJd1g+nT0AOs2LC/hRDQRXZ/WlsaTdLV12cuBlAAuotHREDlsADkDC0DDUBST0+PBQGZpAhAJm4OtAA3RwPAgEzCFDQiAGfyFZj/eaEX8HIxAUBraOQQGfh70ktOQXBhj5kAAMlavVwMMQAvXF6LLWFkUFBDbRMZuUka/SAQ0DUUN7Tib7uruRkB0KUAAJUUAKACo/9VoMnVOwM4HV+rVl26tJNcGBm0JpAFADeBVg/Y4l+lyc2BIMDQXoK/kvv3S24OTHIGBkITn507d/n6zf4qBKDVYhxEHx0H0dXFEtA1GgAqhwUgZ6QAkFtijSZHUE0LwXj7grGGiEl1mVwqhtJ/pqmInMl2kA0FQNKpHApAGA8JoD3itA9pHM0GSMDHHRXLHjNCCyDXynlCXnS4XFuLm0JafZ5QQ1q+4TUlRUXCAF1ZSkVLY0MjngGDxV+MJz90WAfAiS86MgB6EW3c4m7soPu/RC6LCQxEmxAQgEkfpP/gClbR9b8SCVilUWQXZKbXtTM3k+D/fa8fmw4P1v/e9BXoATZv3uzfgFBanAggUnLfBACtCw1wAcUjUr8JgJxHiIX+TymSzAAgAjXVFIDq6hr2gzXVJgDIBykTJcNVkE36HxYAUZIiO1/BA9XzIA/08GICKHp6gOkTxyyAFIHYIJA5PRCOFwxr8TJpaUi4WKMVgzlIDufXNpEZP00Nx1JSsetLV6ZTNrQ0NDbSfn/QvhLrAIzxB6cA8uLEXy9aad7Hx418CgDJA4MCVmJH0DPPUATQEJBTwCtxRvBKWbIiDwA4T5IgAsD922wlZAgC9qb7vfDC3PX+mzdvOA4ADL5Krif9RldXF7svRADoarjyWAIqhwIg59ECWj/NvMAfAoDRDADo9mxWVhYAUGMCoK2mmlGd6YPDEHCTC8AgD8AkCYkEgOwkXPu8MA83D4HAtEdM3+DREYCAjghiLQB7fIQfDkEAT6aRSmWQEGhxZ1Duwq9FQQZSU1X0aAVp/8bOr/Jy0vtFSoHMETCSBSrtJ09/ftFKkt0xnR5cAAIDAwJWrlxF9I9bwmMnIgYzFxAMFskOCw4fNkW6jJYtNc/AgIEBgrFi1vIVG4AA/4qWloGzeLu7IZ0gJqCbwQAAaEi9cuWxJmAwADk5jwXgNEcQACNHQP9nSXNYdU0bFwCiupvwQUYsCTAO9AGZNzMzB+kfAAD3DwYAAVCIw9ADeAW7eQmY/iE/wRDps8cAANz44Xx5eIiGTImCYFCu1dSK5vA1Gg2eBi+vxWSgrAIzgtSGZlj/uoqyMmVKsbKClgLB+YP7r6gEQ6CcPhkJYAGgnT0sAEG0Erx69UwCwOSxKMjBM9gcsmDRXr+BJUDLAGAvSQXM+oenLyzHGMB/8/eDr5Lr7gKGblPfzxLQcDz+yhOYgMcDcNpC/6dOWQAABiAHAag+exZ0zegfAMjKLKFuYUgAmL9ZUo3CAHBzsAEoyTrFACDGQU4IQBgFwI8LgJ9lIcUUA1AE3GIIAFK8MIrHc4F8UKP1msPHwiCs99qy1LJyHP2USu94wHngZSqIASEKIGYA35AgQHdFaT8dAVhIfMCqlTQLMAOwZjWpA2M/wHQGAAIB2IEFM5/fyzY9DixzEY3vNeWCTqbM4Ob6uevBBPhDFDB4HHfHjXRiAkhXIDEADanxIwCgcrQAnDlz+pEAgLbhi86i5BSwym7Lqalm5CwNMZAAk1prWExQqoEVEwEUDaMlAIkEAAXGgKB/j+BgLwGbOwu4faWMU/AYAICrm1twaAj2BuMRcU8H15BoB1vbcBwbUgupgEZahrGgSqlMjdU10rvgVPvB4UMaqAQAruxIufgD/F6vXLny6fNEFq1E3a9cBLJy0coBAASuAYP/zHSz/okZAJuwNz3d3PWyl0MA9435o/C76FAvX78eAPDffLyLlP65BNy/cfPmjZsdtCUMAWhWxY8AgMp/F4BTFIA2o9nct2EMcfbMmZz8AjMBNBmoqT6bw+wnFHABaMO/ZvrK6mq6l4T6rzFaEJDF6F8kTkoSi8JA/xACeniYWkcEljvJ5PfrQVMBF+60AXd3T9wMkqriP9iwfN06ZxtbPh4Mq9WUldXGx+NmsFKXWqzU0WNg5WV0X1VJAMC6/kUAoLhozYJFiygA+PLGG288/8aiRcy18Zd2rF6yEJ3CEjD3z4OvYBCYTGXs5L3plADW7u9lqwADAYDPkJ7Ljp4H/ivQBfj7HzcNA2npeNBCEr+S27dv37x5nzSFYkGgWaUcAQCV/y4Ap6gYWSVTHZIw8nQ2UbOF1JgziJwcEwA1NRZflAMAmD9lAYDJAIjEYrGIF8bjkTKQqZeYWIB0i/XvN9ACkEcWAGnsB38GmWtjG67V1zZppBAD0F103PxBfVcQC0DsPv1lmgC4cilw5Uqy7om88SK1B0F0Vvil50Hbv8Ibj2cwYjNjxmyOMDvdTuaSD2vr/TgFIW4B/X5HxuatW7f6++8vq2WEgoAX1t2gv6EO0hPY191SpoxX/hcAOHNmSADaBkgB2TEaDEBBPpnFSOYxnjUFATWEGQ4m1Ra2gcQHXABEZqEAJJZkccvHAgv9+zmwm0GUAJwy444AkMtgv0H9b1hnZwuZgaa2rAw3gGm172CxcoOugoT9FWUkBMDfJnCAAFzG964GkuIvrn0k4Pnnp4M8v/MS9utd2mnNTjEkbV0OjgPFD0N/y8Bv715z8M/RPamI3SYrfO/eEye2+0tMqicCuUvZ8RM3buAX/dJFG4XLif4HAlA8Av0/AoAzVEYCQEF+fnb+MAAkoSAAZi23MWEB+asFNYNtA/1QzdkkS/2LwhgAhthNNPUTuthalIKJAdiwAYIACAOkYAA++ODPG+xtwsVimYYcAlSV4QSAcmz3pIf+dRWqWAwBiGEovogA7Cq+ePFqIQAQAMHfyjffRABeJAA8txMEAAiwtjGpHwBwHAzAjZvD1Pz27h38MVAu+MUbJ0+cOHkiIePOHWoAfgFpwCeq70/Qrzt5H7eFuyuo/v+jFuCMSQbp/xRXgywARP+DAGD0n6Q4bQKghgMACRBruGgwn6rBY6Q1ZxRJYPo54jUEAJBqVOMJJXrEwE/A7AcNAMDXd/+BA9L9f8bNuw82uNt4yWUaDemkTYUQgFz2qSymO/+6Clz/xVfA/4PQFp8dJMDHQl9AACLwBkYAz02HrGDnzo8/DggICrC2JRNthgcgnSmP3ywZsN2FAJAQaOCmGMjJEydPnoCV/iMjQACWL9JMzNx80NdHEoD4eGVq6mMAGLkFOMOVQfo/1caE9gUmRbOR3gAAsk0AZNdwALDYfmqrsUSDcETjyxwuAGLWAIRlDgKgGhPRdAwLBCIX26EAoPLBBywAwXJsEsSGULINiHuAeNdTRUVlBc38ruC4NwDgQzqxgQKwkp7poABAFGACYAcA4OBg0j/jApyGBgC3zy2Kfqy6B5mBmydB8DO3qSADd+7cAQ9g+qJfWP3Hp1Y0PBqAypECcObMCAEYYAAGAZDPBYDNG2racky9RtQAWKBB/x0KQDYCIDYDQA2A4Cz9K+wB1WoyjiCrhAOA2QW4Dg2AsxtJClSq8nLSAKjCjn8EQIf6L06JPEACQJB1i1aBEQjYEbgjgAMAEACvQMBzH+/8+MOAILQATk6OXO07OnqDcFwA8xMP3QwzJAHEyJuLI6h+wkHGCc7nO0gCCKJqbPkPxABnBssQAAwI44b1ABwAClgA2jh7C9hz1GYiAAFg/h3ylQXZqH8GAEwDqAFIJJtOJdWM/km6iRSkk6SAP7AhZCgA5joHY1agkoIXKNOh7smRPx2eAUG9H7Rzv1esgycpV+ztXkS179ixA40/ebIjAELBN4kjeP7FDz8mLmCVNXZ6OXKjP29vlgB49Pa7yeid6aAZEgDWSHBRoADc51Jw5wYHgDsq5bfffhsf/+1gC1A8agtw5swjADhlAQArpBLA6O3RAJAvNrYV5JhSA0gOsvNNRQOQApMlMXkAjgUII7uBIgXdX2K2G6pJHFltAiB8DscC2A4DgL2dW7hbOB/CwIZaKTZ9VehU2PtBR8AX666sCti58+KVix+uw1vO31i5mgFg0UoKQMDf/rYSIQAEPkQXEEQB8PPmGH1vFgGQjd7eh26S6ylZAAYRcOOmWUogAThpAuA2bh/f59RHf/ylhHzFyfQbIN+j8oGAb5W6igH6Lx6B/kcAwJlBABjN2mdqQZYyOAlQoKJNgUESI2Rcv4ka4huoXaAfYwAQc0NAnkiUTb5jTQ3ZgcgigeNZDAIAAFFYWDhzOpToH7trbcwEMPr/ANRq4xIewgsvU5XXovVndv10FSwAa1DPF3euXvnGi3aTp79IVj6Y/ucXEQB2UEdAENjJADDDgSShG71Ni99sBvATJ0tKjNUcAG4ObQJuo78vgRTwJDchGCj3CRE0Lvg+Ftc/QKAsbxk1APAfJgCcHSUARq7+jfRdTisxZaCAUwZARbPtpmYA0DLkW1iMbAVDABaXMASAr0ECeDwWAB5PQZGrOYO8ZOXgv1ldDXFBuiCMH+bFBYDcPTkEABvsnW1seDJeSFlZWa1UiSYgtZgGgTpyAPgK0fMPOwP+9t4bL0Kk9wZx/ivfeP4NCsCOABYBCsCOoJUEgEOHDm30toz+GRvgd7i6xhKAm9TD37zBXftU/RbhAPdTtzkAUCn55c53sQQAZVlL96MAoApnXyuYRwIA1vFJNffMIwA4dYoLgNFC//T9AtP5ASa8o+9TS89+jCh5EAAMQgwwnNaTpAEAhMEzBVM+QAAAXfinc6qrgYPEMC++FwMA2ytKh827WwKwAQGw5WuEvLLahgYphoDYBZZyVEfVX6y7TLS8M2gHBvzP2dk9hwSs/PXk6c+vZAhgrcCbO4N2kiczHFD/J09aEmByAt5hZ9vaaF+wgT1HAWbfvKhvm9RcMjAgvMH4CI7qO8wI3M+Ijf1WGa/UNXf3XXmkAaggeq8YIFZkHwcfhgUga4D+T1GNG42WBBRwz48MPFHCOWSisACgYKjCYTZLDgEA9B8WRsuAPASAWhnGZuFX5dSczS/ITwrDfjEXOih0DjcGtAQAnmCN2HO/bzQsnGjIBXS6cl0KRPxU/yYAUMsfrnzzxel2xAmsfG4y2AITAIwVCAoiBKy08zgM6/9k5slD3kPp33vjaaOxmjh44/2SEpO3H3i4xiwnB8eJqH/mSnYOAb8cBxOQWoaXRhQPZwF0d+8OVj0HgEfrP2uA/lkX8CgALJVuccjI0gBAxD9E5ZgjAIAwDGI/BAAxECnw+1A3AxSgm8gm2YPIywyACwcAk/45ALhvWLduw4Zv4D33aFVqqk6VSkq/OnIiqLj4IrUAO4njf+PFF19840PiAaYDAAGDAAiCx5V2YZmHwQAAABuHBkALFoCcijAaSkqG0D+XgBtD1wxvcgDgUFD2bSzov3tYAHR3SVtjxRMCQGMtCwA4KQCzLUiscvYgAMDiF9DSTsFwALRxAMgeBgAeBYA+mgFAyU5CAPD7cAHAc0EcAAYkAR9scOfgEI0NoarUFPABuP9HADi6YyfqnxDw4Xvr3lj3Hqj6Q0QBSQjgELCSASDAXqg9eeJkJgBwyJT9e3MBSCrIy6mmm+GPBWC44xFDE/CL6tvUBnJs9LsB+tfdpS//BgBZWUMAgFu41TVcwVTuLIkVLAgY4qzZEAAYGQiGBSCMqJ4GAggAE2jCv5WsQAAUyXj3Vxi2C4S7MCcDzbfNDAEANyCITlXpSMvXwW9w/WM/uC6FaJ9KwIcfrlv33ocAAiR9L7647sMPPwQCdrIEUAACAjbItJlgAKrADhzy9h6ofgQgNzu7ro0AYBgSgJtsvD88ADduYxAwyATcSU2tINfIDQBAZ5aKxwLwaP1bAjAgKWF7Pyy/6NTp7Jz8IQBQDAEA9Sn5QwOASx8AENNiAAMAWf0EDwQARUwMQLiLKQg0NQNsGAIA9unHG0IhC1DSvp/LOy//kKLSXfxh106uUALeI9XfN8AaAA0sHAGrgoIuBWEl8AMOAFFY+fEeCACsiALwAgSAIY7TlpjfHx6Am0wUOCASuJOqIleGDAtAxRMCkDUiABgIaGMPl4DTQEB+Qb4FAYNiQIsYYlgASCmQ5ANimiW2MQAw9QTaMOQVHO5iSgMfBcAHZgAOFDN1QKXyIizsi2U6VP/HH5sB+BgAeGMd0T6R9z40fRItwKWgHQhAtOwUAqDFWDCKUfrGqKiNjEQlkZiorhqIN+Dv6xEADEnASbIBbM4AGf2T1OAXVWpF638egKyskQFA965vmvo7M1kUkABTzZ9hgInuFVT/2QVt5iCClAEUimTMAqjuTQDwSE8QABDGE7N1hnwWAAUDQBgLgKuLq+lYAMcDDAXApx/EK7HtE7u+lUdBpT8UX0Gdv/fex1wAyOq3f/GNdYSD9ywACArCi38BAG1mprauCgBAI3BogBzW5uflk/8vAlDTdjbzUQDcNGudClsj4NYBEADm/TupxQ3d/V3fjV7/wwOQZSlDA8DqnpO8nDxpOucFXiDbkgBaG+CWhwYAgBdAKpgkkKpWbAKAhoNi9p/MhwjAAgCeF+MCcFjISAD4lAJgEgRgJzH/H77xxp84AJBEAF/XAQb29utMJoACgAx8ivdPagEA2WEUCAczqxi5Da8/VmXn0zQJnJ6hpA0BuM3o0qT122YAbtyg5WFS7GPqg4OKgeSv4ifu/1KmwuH2/0kAskYEQIml/k9aJK9gAzj5ANcIcMNEzp4iqj3ZVAWiALBJAFsQgBjARI8FTSLSMBbuSncBTC7AfQgAzMsfXvbHK+NTlMQNXDS7/Tde/NPHnPfs7Yn9X7du3Yu4OfCnDz8kPgIzAoYASwBO3qz68ccf6+rq4PXHH3+p+wWe0spodjYAYGjLOZ3FKeoypaDbA/OB20OdpeAWBE043CnTNTQ3HD8+av03cAE4O7z+hwPAgoAblsULMwAcTQ8cP1FgaRyyLcqAxAMgAEIR1T8vjDQIE/dAe5DwrynQFtBCQThZ/AiAyQA8koBPP4gk+8Ggf+oCmEX/3roPOUHAOlj3qP0//Qme2dm/+N6HrKw0AUDupdHWaU8SAG4T9bOC+gcA8rIVTNgDANBGuPuGDsN9RpW3ByWEQ6nfXDI2bxJiHAjKLBsagEepv4EDgIUZGDEAljbg8QBw+4hM5mCISTQmCyAS8pgQAPUPpoAND5jqMv61/PxkCgCPBcCVC4D7cAB88CkAYPIAKebg/+OPuVHgzn+sAxMADuBPf/rTGwgAZAJEPnxvZYDZAiABVdpMAgBYfar7atT+L0hAnhmAtrZsFgAmlDewqiQs3DYBcJ/aiPtD/LZv/8ggQL1BRYXqOBeAERgA0mJoqgOcfUIASrgm4IY5BMAYgAKgsACAu4HExv2so8g2Q8AAgHVAHo8AwJSCTAEE7RxgAMhlAHAbeOOwuzsXgUH6//TTWFS9UomhwA+cRc/V/86PceVjDPindfgECFhHMkJ4gxnhDgKARibTaKuAgEwCQN1AycujAOSR//jp6mqDAes6kBWC/klqaHYJZgA4wjoACxvA/B3AqOx4PJeAxwPQMBiAs/8mAOAETg4IAnGqGFu5tdxBhJd8y9YA7lBSJglAtfN46AGYdNDkART5tC0Nvh7/lgLMA+SBLgP0zwIwtBH4lJU933z66a6jluk/F4CP/4TRH+gdVG5PxA4MAQp6igAzAOADtGAETlZhA+cvXCcA/7+87GQEgNawztah6g0G0+NjATCFC7fNwgkI76TFcQAYqQEYBoCsrEcRUDK8D2DjAJIVnjrNrQm2DdxAIMX/JEUSF4C8PIYAUxkQLIAQDADNBsJEChaObDZ0wDJgbn4SnhviPR6ADRZJIEc+3jm8fPzxB2TNryMEvGhvZxLMCDAVCDQBAKI9mVkFgR8HgF8QgGyS5iAAxM5hPoiaN9I3BpMqTQDcLhmGALMtYBggAGQkHDcTMML1PxCAs8Pqn0vAoDO+FkbABECWBQBtwwFg2gAkLj0v37yLzAAgxMOhBAAv8ADU6ysQAGowkgk5WAjkPQIAMwEbPhgSgE93DWEAPjaFBB+A9V/3ZwgC4C0HADusEu/gApAHAEAKiFcmGVgC8Ko8/E/lIgAFDAAFhACqfwNzGobVsjkIvP8oArie4P4vGd+bAXisAWj4DwJwe1AcSMtCp0YEANcAFAxoIyAAkJNhCEAYACDOZouG+SSEZF7pXiAFgNkK/k8A8PGnn7IAQLj4wQbaVU5SQRMAH+7cgTOiP1XhJEp0AXkEgF/oDYlE8LpUQx4xAQgus2+KNRBiABhDYBgtACUWAJT8cidjCAAqRgnA2eEBGFDqZyVxsBzmiOCxEmaSjVzxshCPYcVrsISwgv8oj0o0R6SWkoZCboawFOVASbGQo2bZwxFK0yeffjKU/NUk74NsMstmKp8NK19YyD6ufEfkOCNpGVz933mc/gcBcHZ4AJ6MgCdGYIQEPAqAEJP+HwUAISD1P6R/FoBHKZ8hYJD6N49Q/UPpnwUggwpVf9mdO3ceo//BAJwdVv+jIGCURkAwFAFeT0xAyBAEPBqAEah/WP1/M0j/nzxW/e+PSv2PWv4MAN+b1j8LwP/f3P28tJVFARzvH5jsMjtfB2Oyn824GEIVolDUdHgQG0zCYBBUnC6CikI69n8w0YCbUkjBRf+Jee/l/bg/zjn33Ptu1DOt7ay/n3tuMmTyvn+P889hAiSAu9tbDwJEA5/cCDAFkADau3p//Q4o0b8r92+B239tzdvx39Ym6X8hL4CrIj9IgAZwZwsAEVCaAE8ADSAVQAL4x5y/RP81YCz6G/LD/a+k/qqAX798AzAT8CKg6gKAsQHM+ZX+Z3l+pX9L3v8BnF9/8cfrv70NA7hIAVwVI/ef/8gJPD39eCoBwFqAHYFPKoEqg4ABwFJAp8MGUKp/S8wf/BEw+5fJD/Wf6xMZiONHP1YDwCzAaQtUDQSq9LuAjECnIwkgADDyn+X51f6tlpg/Gjr/ejRUf2N+7PxDAObzp2yMAAgCNzf2BAoEn+zfElZpAtUqB0CnQwqg8xP9u1D/AI+v9v89IYDmrxvqx/0v0v5X/P6yABiAbwElCJACqiwA7Y4qAAbwpWz/VnbyUQDy8Y8XwDpYf3OzHvWvR/NXfdvQnwlgbgUAFXCzegJmAVU7ADs7HYWAmH84pPJb9g/I/u/V/tFA8Tfr+WxTk+S/GP87vmL0R+6Ad/FXffpbAhSBYy4BhoAYQRUbHEAmYDiMuhdjmx/rH3CPP9Ffyg/239qKfiUT10+HAwAU8O6nvQDXJZARsH0tWLUcrf+OSkCsPzw6+vKF2f/MT/91tL+cX+yfVy9mLI25fwHgWQaAEbj1vwRSBJZLoFT/JQBZgJT/CBNwDvfvGvsHLvk3k6nr/beQGcMAZqb+yZeN/Xo2bwDH94N+COxKBMpvAEFA5+Bvof0RKuDMqn+rTP/NTSB/nYiv908FzGYmAM/ZxPmfaQDOS4BBwG4JlO+fCjhYzpFYHwRw7tyfefvr/etK/y2b/EsAsxkhIMkvCEhmeQX8dNgBKyfgegtgAHYOijlSx3z8vfRf1/tvOuSH+kczI/snAp7VSQH4vwZMAo6NAqRbwDOAAxoAlt+pP3j81xtCe2D7O+RP+9MCUACvsASOj/kCdn9zBbDDA3DEuP3R/kHAAyDkl/srp7/ukj/vjwt4BqYAsFjYAzAIMBtYgQB0AYgC9nuYgPPzs5fo3/gTPf1bTvnH9+UBRAQWMIPVEQi9C2hX8kEB7O/3NAFR+mTObPd/QAF4j/RvoMffLf/4/v7eeAXQAIqnfLzoFgjDkClglwegIs0OAGB/HwJgyu/S/z3Uv0H077vVT/rfl9wAOYAXXgIhScBaQIUHQBNgys/qHzCPP9i/2Wz23eor/d0ALMTx+lrQRCAkCVjeAhUjgP39FECP1f/Mvf+aub8Qv9nv993yZ98iQQt4huedXt/lGlC/S9J+CYQcAdb9SQC5gM/R0Pl5/QPb85/HJ/uPx6z+phWAA1gAc+eZAEMAZsBGQIUUUORfAogJfM7Gd/817Pov+jebWX08/5ibX+j/8DCfP/IBLOBBBNzh/eklcMMQEJYUUOEDSAR8Fsa+v/Z1A7z+jTx/U8jfL5lfAFA8WsJ8AxAAQAH4Ipjc6t8rb0GAEsB/IVihBQj99/YUAER+Zv81z/0Hg4FN/0xA9mgR1QAKYGEBALkLJsC4CghLCKiYNoDQP568/mE0Zfu7nv9+H+qffLWYTf20/4MEIEEQ/4MuAAoAQeCNCqiQAmq1mpSfBnAq928Z+yMA1P4NqD9Un8x/ea/PbDp7EB4uJCEgroCFC4A7Q3zcgOMLARaACgWgVssA7BVT5FcAnJ7avfxTAegLgOrfB/Lj/S+T0frnj5bS+8c7wAnAgv6kQPRzYhhdwIixA0K3FVBBBdSykfvvCf0lAS79A1b/BECzJ+XvA/kHRHtTfx3A8olzDgBIAncMADqB0coEIP0rNXGk/omAQw3Aadn+a3T/Htp/wMx/qdWfvhIADoGJKmCEIghxAmYBLAB7CoBDYdL+cfLT9Lfx01/0AsD698T+fb3/gIoP5xf6gwAeVwWAY8BJQGgJoOIC4FAG0AWG2Z8C0BAB9Hpy/r5Wf0C01/pPmf1dASx8AJjoABADobsAVn8VgCigCw+zf8BcAOX7X2qHnwXg0RHAwsMdIBMYsQWEKIBd7wC63vqTC6CXAujLAAZg/0twgPrGVwC4ADMAUsB/E/7oAiADIUZABtBuO90A2B3QLds/sOnfY/W/JPtPkfwEgMcVALASkBkYjSgC6A5QACgESgEo3x8AsK4D6KULoGx/5QljzP4rAcC+A8QlMKIIhNgOUFdAW/4koBuABlHfpj8OQO0fjdx/APXH8k+heWACeHQD8DYFLD/yuYwffxDUcQM0uvz+8TeAYfkDxgJI8zfN/ZH8l1NzfxLAoxsAD/85SAFwMiIIhJgAAEC7nX0K2D8A7fjj/QkADQ1AHwfgoT8N4PG1ASQGTm5OygtQ/xfQitO7gIbd+bcAoC2AD+AFMNAXgFV9y/46gdcAcHOSPRYWJhBiAnYJAW4bwC4/AQBbABt5/w9A/wG7/xQfiwvgTQCYTE5cBbgAqFEAGg3u/qf76wDU/vACYPW/vib6257/twHgBAIgEHg5AH7OPw5AewEg9B8CCwDKH830mtefA0AhsCoAX79+NQEoKcADgI2G1fnnAMBeAuoLYDgELgC9/XJ89pcN8ADYvxMUASR/Ff4dBTBaPYC8ffwbAwDnJ/oHxhsA6D+kz/+1fX8+gIIAE8CCWf+bKCAZAMDkxEQgRAR89LYBNpKxOv9lAHwwAlD6K49hZeW36b8EMJ/PuQAWDADfoln+KT1GfrJ0kP6MfxkBHDMA7K4KAJLfAcDGBnsB2PZ/eCjXPwKw/NCwDwB3Wf1UgAJAtDBJPBAA8BUQE/j40QeAjXxszr8LAPQGoC+Aa/P5L9t/dQCSwQEkK8AsYJUANkgATv0DwwJo2CyAa2C8Xv8SgP8BSktwqC8zWLAAAAAASUVORK5CYII=', 'base64');
const PWA_MANIFEST = JSON.stringify({
  id: '/',
  name: 'ArenaCraft',
  short_name: 'ArenaCraft',
  description: 'ArenaCraft - arena de luta multiplayer',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'any',
  background_color: '#2b2b2b',
  theme_color: '#2b2b2b',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
    { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
});
// Service worker: guarda a página do jogo no aparelho. Com o servidor/ngrok desligado,
// o jogo abre e roda offline (em vez de aparecer a página de erro do ngrok).
const PWA_SW = "var C='arenacraft-shell-v1';" +
  "self.addEventListener('install',function(e){self.skipWaiting();});" +
  "self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim());});" +
  "self.addEventListener('fetch',function(e){var r=e.request;if(r.method!=='GET')return;" +
  "var u=new URL(r.url);if(u.origin!==location.origin){e.respondWith(fetch(r).catch(function(){return caches.match(r).then(function(m){return m||Response.error();});}));return;}" +
  "if(r.mode==='navigate'){e.respondWith(fetch(r).then(function(x){if(x&&x.ok){var k=x.clone();caches.open(C).then(function(c){c.put('/',k);});}return x;})" +
  ".catch(function(){return caches.match('/').then(function(m){return m||new Response('Sem conexao',{status:503,headers:{'Content-Type':'text/plain'}});});}));return;}" +
  "e.respondWith(fetch(r).catch(function(){return caches.match(r).then(function(m){return m||new Response('',{status:504});});}));});" +
  "self.addEventListener('notificationclick',function(e){e.notification.close();var a=e.action||'accept';" +
  "e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(l){" +
  "if(l.length){l[0].postMessage({type:'acCallAction',action:a});return l[0].focus();}" +
  "return self.clients.openWindow('/');}));});";

const server = http.createServer((req, res) => {
  const reqPath = (req.url || '').split('?')[0];
  if (req.method === 'GET' && reqPath === '/manifest.webmanifest') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(PWA_MANIFEST);
    return;
  }
  if (req.method === 'GET' && reqPath === '/sw.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
    res.end(PWA_SW);
    return;
  }
  const PWA_ICONS = { '/icon-192.png': PWA_ICON_192, '/icon-512.png': PWA_ICON_512, '/icon-192-maskable.png': PWA_ICON_192_MASK, '/icon-512-maskable.png': PWA_ICON_512_MASK };
  if (req.method === 'GET' && PWA_ICONS[reqPath]) {
    const buf = PWA_ICONS[reqPath];
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'Content-Length': buf.length });
    res.end(buf);
    return;
  }
  const isHtmlRoute = reqPath === '/' || /^\/vs\/\d+\/?$/.test(reqPath);
  if (req.method === 'GET' && isHtmlRoute) {
    fs.readFile(HTML_PATH, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Não encontrei ArenaCraft.html (ou arena_3d.html) na mesma pasta do server.js\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
      res.end(data);
    });
    return;
  }
  const mm = /^\/media\/([a-z0-9_-]+\.([a-z0-9]+))$/i.exec(reqPath);
  if (req.method === 'GET' && mm && MEDIA_MIME_BY_EXT[mm[2].toLowerCase()]) {
    const file = path.join(MEDIA_DIR, mm[1]);
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('não achei'); return; }
      const type = MEDIA_MIME_BY_EXT[mm[2].toLowerCase()];
      const head = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*' };
      const rg = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (rg && (rg[1] || rg[2])) {
        let a = rg[1] ? parseInt(rg[1], 10) : Math.max(0, st.size - parseInt(rg[2], 10));
        let b = rg[1] && rg[2] ? parseInt(rg[2], 10) : st.size - 1;
        if (b >= st.size) b = st.size - 1;
        if (a > b || a >= st.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); res.end(); return; }
        res.writeHead(206, Object.assign(head, { 'Content-Range': 'bytes ' + a + '-' + b + '/' + st.size, 'Content-Length': b - a + 1 }));
        fs.createReadStream(file, { start: a, end: b }).pipe(res);
      } else {
        res.writeHead(200, Object.assign(head, { 'Content-Length': st.size }));
        fs.createReadStream(file).pipe(res);
      }
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Servidor da Arena de Luta 3D está no ar.\n');
});

// ---------- Estado: um "state" independente por servidor virtual ----------
function createState(vsIndex) {
  return {
    vsIndex,
    nextId: 1,
    clients: new Map(), // id -> { ws, room }
    queues: { '1x1': [], '2x2': [], '3x3': [], ffa: [], mega: [], survival: [], bedwars: [], bedwars_duo: [], bedwars_trio: [] },
    rooms: new Map(), // roomId -> { mode, players: [{id, team, slot, alive}] }
    nextRoomId: 1,
    // Estado dos timers de espera do FFA (fila "todos contra todos").
    ffa: { waitTimer: null, countdownInterval: null, secondsLeft: 0 },
    // Mesma ideia pras filas do BedWars (uma por modo: Solo, Duo e Trio).
    // Votos de mapa do BedWars: clientId -> id do mapa (um Map por modo).
    bwVotes: { bedwars: new Map(), bedwars_duo: new Map(), bedwars_trio: new Map() },
    bw: {
      bedwars: { waitTimer: null, countdownInterval: null, secondsLeft: 0 },
      bedwars_duo: { waitTimer: null, countdownInterval: null, secondsLeft: 0 },
      bedwars_trio: { waitTimer: null, countdownInterval: null, secondsLeft: 0 },
    },
  };
}
const virtualServers = Array.from({ length: NUM_VIRTUAL_SERVERS }, (_, i) => createState(i));

// Servidor único: qualquer conexão (inclusive de páginas antigas que ainda
// peçam /vs/1, /vs/2... ou "?vs=") cai no mesmo servidor.
function vsIndexFromUrl(url) {
  return 0;
}

function send(state, id, obj) {
  const c = state.clients.get(id);
  if (c && c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(obj));
  if (c && c.room && (!c.isBot || c.botAnchor)) watchMirrorFromPlayer(state, c, id, obj);
}

// ---------- Espectadores (olho 👁 do ADM na lista de amigos) ----------
// O espectador NÃO entra em room.players (assim não conta como jogador, não
// ocupa vaga e a sala pode estar cheia). Ele fica em room.watchers e recebe uma
// CÓPIA do que a sala manda: no BedWars, tudo que passa pelo bwBroadcast; nos
// outros modos, o que um jogador humano da sala (room.watchAnchor) recebe,
// só as mensagens públicas (nada de dano/vida/teleporte privados dele).
const WATCH_FORWARD_TYPES = new Set(['state', 'hitFx', 'opponentHp', 'opponentHpSync', 'kill', 'matchChat', 'playerDown', 'roundOver', 'matchOver', 'adminCheatFx', 'teammateLeft', 'opponentLeft', 'playerJoined']);
function watchMirrorRaw(state, room, s) {
  if (!room || !room.watchers || !room.watchers.length) return;
  for (const wid of room.watchers) {
    const wc = state.clients.get(wid);
    if (wc && wc.ws && wc.ws.readyState === WebSocket.OPEN) wc.ws.send(s);
  }
}
function watchMirror(state, room, obj) {
  if (!room || !room.watchers || !room.watchers.length) return;
  watchMirrorRaw(state, room, JSON.stringify(obj));
}
function watchEndAll(state, room) {
  for (const wid of (room.watchers || [])) {
    const wc = state.clients.get(wid);
    if (wc) wc.watchRoom = null;
  }
  room.watchers = [];
}
function stopWatching(state, id) {
  const c = state.clients.get(id);
  if (!c || !c.watchRoom) return;
  const room = state.rooms.get(c.watchRoom);
  if (room && room.watchers) room.watchers = room.watchers.filter((x) => x !== id);
  c.watchRoom = null;
}
function watchMirrorFromPlayer(state, c, id, obj) {
  const room = state.rooms.get(c.room);
  if (!room || !room.watchers || !room.watchers.length || room.watchAnchor !== id) return;
  if (room.bw) {
    // BedWars: o resto já vai pelo bwBroadcast; só o fim da partida passa por aqui.
    if (obj.type === 'matchOver') { watchMirror(state, room, obj); watchEndAll(state, room); }
    return;
  }
  let m = null;
  if (obj.type === 'hit') m = { type: 'hitFx', targetId: id, hp: obj.hp };
  else if (obj.type === 'hpSync') m = { type: 'opponentHpSync', oppId: id, hp: obj.hp };
  else if (WATCH_FORWARD_TYPES.has(obj.type)) m = obj;
  if (!m) return;
  watchMirror(state, room, m);
  // O jogador "âncora" não recebe o playerDown dele mesmo — avisa pelo kill.
  if (obj.type === 'kill' && obj.victimId === id) watchMirror(state, room, { type: 'playerDown', id });
  if (obj.type === 'matchOver' || obj.type === 'opponentLeft') watchEndAll(state, room);
}
// Se o jogador que servia de âncora sair, passa pra outro humano da sala.
function watchReanchor(state, room, leavingId) {
  if (!room.watchers || !room.watchers.length || room.watchAnchor !== leavingId) return;
  const humanNext = room.players.find((p) => {
    if (p.id === leavingId) return false;
    const pc = state.clients.get(p.id);
    return pc && !pc.isBot;
  });
  const next = humanNext || (room.bw ? null : room.players.find((p) => p.id !== leavingId && state.clients.get(p.id)));
  if (next) {
    room.watchAnchor = next.id;
    const nc = state.clients.get(next.id);
    if (nc && nc.isBot) nc.botAnchor = true;
    return;
  }
  watchMirror(state, room, { type: 'opponentLeft' });
  watchEndAll(state, room);
}

// O que cada amigo está fazendo agora: 'match' (em partida), 'queue' (em
// pareamento) ou null. Vai junto da lista de amigos pro botão do olho.
function friendActivityFor(emailLower) {
  let act = null;
  for (const t of findClientsByAccount(emailLower)) {
    const tc = t.state.clients.get(t.id);
    if (!tc) continue;
    const room = tc.room ? t.state.rooms.get(tc.room) : null;
    if (room) return { activity: 'match', mode: room.mode };
    for (const mode of Object.keys(t.state.queues)) {
      if (t.state.queues[mode].includes(t.id)) act = { activity: 'queue', mode };
    }
  }
  return act || { activity: null, mode: null };
}

function handleSpectate(state, id, msg) {
  const c = state.clients.get(id);
  if (!c) return;
  const fail = (error) => send(state, id, { type: 'spectateResult', ok: false, error });
  if (!isAdminClient(c)) return fail('Só ADM pode assistir partidas.');
  if (c.room) return fail('Saia da sua partida antes de assistir outra.');
  const email = String(msg.email || '').toLowerCase();
  let targetId = null;
  // Painel ADM: o olho manda o id direto da pessoa (sem e-mail).
  if (Number.isInteger(msg.targetId)) {
    const tcx = state.clients.get(msg.targetId);
    if (tcx && tcx.room && state.rooms.get(tcx.room)) targetId = msg.targetId;
  }
  if (targetId == null) for (const t of findClientsByAccount(email)) {
    if (t.state !== state) continue;
    const tc = state.clients.get(t.id);
    if (tc && tc.room && state.rooms.get(tc.room)) { targetId = t.id; break; }
  }
  if (targetId == null) return fail('Essa pessoa não está em uma partida agora.');
  const tc = state.clients.get(targetId);
  const room = state.rooms.get(tc.room);
  const tp = room.players.find((p) => p.id === targetId);
  if (!tp) return fail('Partida não encontrada.');

  stopWatching(state, id);
  // Âncora (arena) / quem recebe o fim da partida (BedWars): sempre um humano.
  const anchorValid = room.watchAnchor != null && room.players.some((p) => p.id === room.watchAnchor);
  if (!anchorValid) {
    let anchor = tc.isBot ? null : targetId;
    if (anchor == null) {
      const h = room.players.find((p) => { const pc = state.clients.get(p.id); return pc && !pc.isBot; });
      anchor = h ? h.id : null;
    }
    // Partida só de bots: o próprio bot alvo vira a "âncora" (o servidor já simula tudo).
    if (anchor == null && !room.bw && !isBedwarsMode(room.mode)) {
      anchor = targetId;
      if (tc.isBot) tc.botAnchor = true;
    }
    if (anchor == null) return fail('Só tem bots nessa partida, não dá pra assistir.');
    room.watchAnchor = anchor;
  }
  if (!room.watchers) room.watchers = [];
  room.watchers.push(id);
  c.watchRoom = tc.room;
  c.watchTeam = tp.team;

  const myFriendsList = c.accountId ? ensureFriends(c.accountId).friends : [];
  const out = {
    type: 'matched', mode: room.mode, myTeam: tp.team, mySlot: tp.slot, watching: true, watchId: targetId,
    players: room.players.map((pp) => {
      const cc = state.clients.get(pp.id);
      return { id: pp.id, team: pp.team, slot: pp.slot, name: (cc && cc.name) || ('User ' + pp.id), acctName: (cc && cc.accountId) ? displayNameFor(cc.accountId) : null, skin: (cc && cc.skin) || null, friend: !!(cc && cc.accountId && myFriendsList.includes(cc.accountId)), admin: isAdminClient(cc) };
    }),
  };
  if (room.bw) {
    const payload = bwInitPayload(state, room, room.bw);
    // Mundo ATUAL (com blocos já colocados/quebrados), não o do início.
    payload.world = Object.assign({}, payload.world, { rle: bwRle(room.bw.w.g) });
    payload.startIn = room.bw.phase === 'starting' ? room.bw.startLeft : 0;
    out.bw = payload;
  }
  send(state, id, out);
  if (room.bw) {
    for (const t of room.bw.teams) {
      if (!t.bed.alive) send(state, id, { type: 'bwBed', ti: t.idx, alive: false, x: t.bed.cells[0][0] + 0.5, y: t.bed.cells[0][1] + 0.5, z: t.bed.cells[0][2] + 0.5 });
    }
  }
}

// Botão "ENTRAR COMO JOGADOR" do painel ADM: o espectador vira jogador de
// verdade na sala (leva dano, ataca). Só nos modos decididos pelo servidor.
function handleSpectateJoin(state, id, msg) {
  const c = state.clients.get(id);
  if (!c || !c.watchRoom || c.room) return;
  const fail = (error) => send(state, id, { type: 'spectateResult', ok: false, error });
  if (!isAdminClient(c)) return fail('Só ADM pode fazer isso.');
  const roomId = c.watchRoom;
  const room = state.rooms.get(roomId);
  if (!room) return fail('A partida já acabou.');
  if (room.bw || room.mode === '1x1') return fail('Nesse modo só dá pra assistir.');
  const team = isFfaMode(room.mode) ? ('ffa' + id) : c.watchTeam;
  const slot = room.players.filter((p) => p.team === team).length;
  stopWatching(state, id);
  room.players.push({ id, team, slot, alive: true, hp: 20, regenTimer: 0 });
  c.room = roomId;
  const px = typeof msg.x === 'number' ? msg.x : 0, py = typeof msg.y === 'number' ? msg.y : 0, pz = typeof msg.z === 'number' ? msg.z : 0;
  c.pos = { x: px, y: py, z: pz, yaw: msg.yaw, t: Date.now() };
  for (const p of room.players) {
    if (p.id === id) continue;
    const pc = state.clients.get(p.id);
    const fl = pc && pc.accountId ? ensureFriends(pc.accountId).friends : [];
    send(state, p.id, { type: 'playerJoined', x: px, y: py, z: pz, yaw: msg.yaw, player: { id, team, slot, name: c.name || ('User ' + id), acctName: c.accountId ? displayNameFor(c.accountId) : null, skin: c.skin || null, friend: !!(c.accountId && fl.includes(c.accountId)), admin: true } });
  }
  send(state, id, { type: 'watchJoined', team, slot, mode: room.mode });
  broadcastOnline(state);
}

// Com 100 mil bots, avisar todo mundo a cada entrada/saída travava o servidor: agora no máx. 2x por segundo.
function broadcastOnline(state) {
  const now = Date.now();
  if (now - (state.lastOnlineBc || 0) >= 500) { state.lastOnlineBc = now; broadcastOnlineNow(state); return; }
  if (state.onlineBcTimer) return;
  state.onlineBcTimer = setTimeout(() => { state.onlineBcTimer = null; state.lastOnlineBc = Date.now(); broadcastOnlineNow(state); }, 500);
}
function broadcastOnlineNow(state) {
  // "playing" por modo, separado — sem isso, os 3 modos (1x1/2x2/3x3)
  // mostravam o mesmo número (o total do servidor inteiro) na tela de
  // escolha de modo, mesmo estando ativo só em um deles.
  const playingByMode = { '1x1': 0, '2x2': 0, '3x3': 0, ffa: 0, mega: 0, survival: 0, bedwars: 0, bedwars_duo: 0, bedwars_trio: 0 };
  for (const room of state.rooms.values()) {
    if (playingByMode[room.mode] !== undefined) playingByMode[room.mode] += room.players.length;
  }
  for (const mode of Object.keys(state.queues)) {
    // Reforço: um jogador que já está numa sala (c.room) nunca deve contar
    // pra fila de outro modo, mesmo que sobre algum resquício na lista.
    const validCount = state.queues[mode].filter((qid) => {
      const c = state.clients.get(qid);
      return c && !c.room;
    }).length;
    if (playingByMode[mode] !== undefined) playingByMode[mode] += validCount;
  }
  const playing = playingByMode['1x1'] + playingByMode['2x2'] + playingByMode['3x3'] + playingByMode.ffa + playingByMode.mega + playingByMode.survival;
  const msg = JSON.stringify({ type: 'online', count: state.clients.size, playing, playingByMode });
  for (const c of state.clients.values()) {
    if (c.isBot) continue; // bot não recebe nada (são 100 mil)
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
  }
}

function broadcastQueueStatus(state, mode) {
  const info = MODE_INFO[mode];
  const msg = JSON.stringify({ type: 'queueUpdate', mode, waiting: state.queues[mode].length, needed: info.total, min: info.min || null });
  for (const c of state.clients.values()) {
    if (c.isBot) continue;
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
  }
}

function tryMatch(state, mode) {
  const info = MODE_INFO[mode];
  const q = state.queues[mode];
  while (q.length >= info.total) {
    const ids = q.splice(0, info.total).filter((id) => state.clients.has(id));
    if (ids.length < info.total) {
      // Alguém desconectou enquanto esperava: devolve os que ainda estão
      // aqui pra frente da fila (antes eles sumiam da fila sem avisar).
      q.unshift(...ids);
      continue;
    }

    const players = ids.map((id, idx) => (isBigFfa(mode)
      ? { id, team: 'ffa' + id, slot: 0, alive: true, hp: 20, regenTimer: 0 }
      : {
      id,
      team: idx < info.teamSize ? 'A' : 'B',
      slot: idx < info.teamSize ? idx : idx - info.teamSize,
      alive: true,
      hp: 20,
      regenTimer: 0,
    }));
    const roomId = 'r' + state.nextRoomId++;
    const newRoom = { mode, players, roundWins: isBigFfa(mode) ? {} : { A: 0, B: 0 } };
    state.rooms.set(roomId, newRoom);
    botRecordEncounters(state, newRoom);

    for (const p of players) {
      const c = state.clients.get(p.id);
      if (c) c.room = roomId;
      // "friend" é calculado do ponto de vista de QUEM RECEBE (c.accountId):
      // é por isso que dá pra mostrar a tag de amigo 👥 mesmo em cima de um
      // inimigo — cada jogador vê seus próprios amigos marcados, mesmo que
      // pra outra pessoa da sala aquele mesmo jogador não seja amigo.
      const myFriendsList = c && c.accountId ? ensureFriends(c.accountId).friends : [];
      send(state, p.id, {
        type: 'matched',
        mode,
        myTeam: p.team,
        mySlot: p.slot,
        players: players.map((pp) => {
          const cc = state.clients.get(pp.id);
          return { id: pp.id, team: pp.team, slot: pp.slot, name: (cc && cc.name) || ('User ' + pp.id), acctName: (cc && cc.accountId) ? displayNameFor(cc.accountId) : null, skin: (cc && cc.skin) || null, friend: !!(cc && cc.accountId && myFriendsList.includes(cc.accountId)), admin: isAdminClient(cc) };
        }),
      });
    }
    broadcastOnline(state);
  }
  broadcastQueueStatus(state, mode);
}

// ---------- FFA (todos contra todos): fila de tamanho variável (2 a 8) ----------
function clearFfaTimers(state) {
  if (state.ffa.waitTimer) { clearTimeout(state.ffa.waitTimer); state.ffa.waitTimer = null; }
  if (state.ffa.countdownInterval) { clearInterval(state.ffa.countdownInterval); state.ffa.countdownInterval = null; }
  state.ffa.secondsLeft = 0;
}

function broadcastFfaStatus(state, secondsLeft) {
  const q = state.queues.ffa;
  for (const qid of q) {
    send(state, qid, {
      type: 'ffaStatus',
      waiting: q.length,
      needed: FFA_MAX,
      min: FFA_MIN,
      secondsLeft: (typeof secondsLeft === 'number') ? secondsLeft : null,
    });
  }
}

function startFfaMatch(state, ids) {
  state.queues.ffa = state.queues.ffa.filter((x) => !ids.includes(x));
  clearFfaTimers(state);

  // No FFA cada jogador é o próprio "time" (nenhum time compartilhado), pra
  // reaproveitar toda a lógica de "sem fogo amigo" e cores já existente.
  const players = ids.map((id) => ({ id, team: 'ffa' + id, slot: 0, alive: true, hp: 20, regenTimer: 0 }));
  const roomId = 'r' + state.nextRoomId++;
  const newRoom = { mode: 'ffa', players, roundWins: {} };
  state.rooms.set(roomId, newRoom);
  botRecordEncounters(state, newRoom);

  for (const p of players) {
    const c = state.clients.get(p.id);
    if (c) c.room = roomId;
    const myFriendsList = c && c.accountId ? ensureFriends(c.accountId).friends : [];
    send(state, p.id, {
      type: 'matched',
      mode: 'ffa',
      myTeam: p.team,
      mySlot: p.slot,
      players: players.map((pp) => {
        const cc = state.clients.get(pp.id);
        return { id: pp.id, team: pp.team, slot: pp.slot, name: (cc && cc.name) || ('User ' + pp.id), acctName: (cc && cc.accountId) ? displayNameFor(cc.accountId) : null, skin: (cc && cc.skin) || null, friend: !!(cc && cc.accountId && myFriendsList.includes(cc.accountId)), admin: isAdminClient(cc) };
      }),
    });
  }
  broadcastOnline(state);
  // Se sobrou gente na fila (por exemplo, entraram mais de 8 juntos), tenta
  // formar outra sala na hora com quem ficou.
  processFfaQueue(state);
}

function processFfaQueue(state, opts) {
  const resetWait = !!(opts && opts.resetWait);
  const q = state.queues.ffa;

  // Lotou o máximo: começa na hora, não precisa esperar o resto do tempo.
  if (q.length >= FFA_MAX) {
    startFfaMatch(state, q.slice(0, FFA_MAX));
    return;
  }

  if (q.length < FFA_MIN) {
    // Não tem nem os 2 mínimos: cancela qualquer contagem pendente.
    clearFfaTimers(state);
    broadcastFfaStatus(state);
    return;
  }

  if (resetWait) {
    // Alguém novo acabou de entrar: reinicia a janela de 10s "sem gente
    // nova" — se já tinha uma contagem regressiva de 10s rodando, ela é
    // cancelada, e só recomeça pra valer se passarem outros 10s seguidos
    // sem mais ninguém entrar.
    clearFfaTimers(state);
  } else if (state.ffa.waitTimer || state.ffa.countdownInterval) {
    // Alguém saiu (ou é só um reprocessamento) com um timer já rodando: não
    // mexe no timer, só atualiza quem está vendo a tela de espera.
    broadcastFfaStatus(state, state.ffa.countdownInterval ? state.ffa.secondsLeft : undefined);
    return;
  }

  // Tem 2+ na fila e nenhum timer rodando (ou ele acabou de ser reiniciado
  // porque alguém entrou agora): dá 10s de espera sem ninguém novo antes de
  // travar a sala com o que já tem.
  broadcastFfaStatus(state);
  state.ffa.waitTimer = setTimeout(() => {
    state.ffa.waitTimer = null;
    const q2 = state.queues.ffa;
    if (q2.length < FFA_MIN) { broadcastFfaStatus(state); return; }
    // Passaram 10s sem ninguém novo entrar e ainda tem gente suficiente:
    // contagem final de 10s — quando ela zerar, a partida começa à força
    // com quem tiver na fila.
    state.ffa.secondsLeft = FFA_COUNTDOWN_MS / 1000;
    broadcastFfaStatus(state, state.ffa.secondsLeft);
    state.ffa.countdownInterval = setInterval(() => {
      const qq = state.queues.ffa;
      if (qq.length < FFA_MIN) {
        // Gente saiu no meio da contagem e não sobrou o mínimo: cancela.
        clearFfaTimers(state);
        broadcastFfaStatus(state);
        return;
      }
      state.ffa.secondsLeft -= 1;
      if (state.ffa.secondsLeft <= 0) {
        clearInterval(state.ffa.countdownInterval);
        state.ffa.countdownInterval = null;
        startFfaMatch(state, qq.slice(0, FFA_MAX));
        return;
      }
      broadcastFfaStatus(state, state.ffa.secondsLeft);
    }, 1000);
  }, FFA_WAIT_MS);
}

// ---------- BedWars (Solo / Duo / Trio): mesma lógica de fila do FFA, mas
// com um mínimo e um máximo diferentes por modo (ver BEDWARS_MODES). Enquanto
// espera na fila o jogador fica no lobby e pode votar no mapa (bwVote); quando
// a sala fecha, o mapa mais votado é gerado e a partida (bwCreateGame) começa.
function clearBedwarsTimers(state, mode) {
  const t = state.bw[mode];
  if (t.waitTimer) { clearTimeout(t.waitTimer); t.waitTimer = null; }
  if (t.countdownInterval) { clearInterval(t.countdownInterval); t.countdownInterval = null; }
  t.secondsLeft = 0;
}

function broadcastBedwarsStatus(state, mode, secondsLeft) {
  const cfg = BEDWARS_MODES[mode];
  const q = state.queues[mode];
  for (const qid of q) {
    send(state, qid, {
      type: 'bedwarsStatus',
      mode,
      waiting: q.length,
      needed: cfg.max,
      min: cfg.min,
      secondsLeft: (typeof secondsLeft === 'number') ? secondsLeft : null,
    });
  }
}

// Divide a fila em equipes de até teamSize, do jeito mais parelho possível
// (10 no Trio = 3-3-2-2; 9 no Duo = 2-2-2-2-1). Quem entrou junto (amigos
// convidados ficam lado a lado no começo da fila) cai na mesma equipe.
function buildBedwarsPlayers(ids, teamSize) {
  const n = ids.length;
  const numTeams = Math.ceil(n / teamSize);
  const base = Math.floor(n / numTeams);
  const extra = n % numTeams;
  const players = [];
  let idx = 0;
  for (let t = 0; t < numTeams; t++) {
    const size = base + (t < extra ? 1 : 0);
    for (let slot = 0; slot < size; slot++) {
      players.push({ id: ids[idx++], team: 'bw' + t, slot, alive: true, hp: 20, regenTimer: 0 });
    }
  }
  return players;
}

function startBedwarsMatch(state, mode, ids) {
  const cfg = BEDWARS_MODES[mode];
  state.queues[mode] = state.queues[mode].filter((x) => !ids.includes(x));
  clearBedwarsTimers(state, mode);

  const players = buildBedwarsPlayers(ids, cfg.teamSize);
  const roomId = 'r' + state.nextRoomId++;
  const room = { mode, players, roundWins: {} };
  state.rooms.set(roomId, room);
  // NÃO chama botRecordEncounters aqui: os bots não jogam o BedWars (só ficam
  // um tempo na sala e saem), então marcar "acabei de jogar com fulano" pra
  // eles faria mandarem mensagem depois tipo "tava difícil essa hein".

  // Mapa mais votado (empate = sorteio; ninguém votou = sorteio geral).
  const mapId = bwPickMap(state, mode, ids);
  ids.forEach((id) => state.bwVotes[mode].delete(id));
  for (const p of players) { const c = state.clients.get(p.id); if (c) c.room = roomId; }
  const bw = bwCreateGame(state, room, mapId);
  const payload = bwInitPayload(state, room, bw);

  for (const p of players) {
    const c = state.clients.get(p.id);
    const myFriendsList = c && c.accountId ? ensureFriends(c.accountId).friends : [];
    send(state, p.id, {
      type: 'matched',
      mode,
      myTeam: p.team,
      mySlot: p.slot,
      players: players.map((pp) => {
        const cc = state.clients.get(pp.id);
        return { id: pp.id, team: pp.team, slot: pp.slot, name: (cc && cc.name) || ('User ' + pp.id), acctName: (cc && cc.accountId) ? displayNameFor(cc.accountId) : null, skin: (cc && cc.skin) || null, friend: !!(cc && cc.accountId && myFriendsList.includes(cc.accountId)), admin: isAdminClient(cc) };
      }),
      bw: payload,
    });
  }
  bwBroadcast(state, room, { type: 'bwCountdown', n: bw.startLeft });
  broadcastOnline(state);
  processBedwarsQueue(state, mode);
  bwBroadcastVotes(state, mode);
}

function processBedwarsQueue(state, mode, opts) {
  const cfg = BEDWARS_MODES[mode];
  const t = state.bw[mode];
  const resetWait = !!(opts && opts.resetWait);
  const q = state.queues[mode];

  if (q.length >= cfg.max) {
    startBedwarsMatch(state, mode, q.slice(0, cfg.max));
    return;
  }

  if (q.length < cfg.min) {
    clearBedwarsTimers(state, mode);
    broadcastBedwarsStatus(state, mode);
    return;
  }

  if (resetWait) {
    clearBedwarsTimers(state, mode);
  } else if (t.waitTimer || t.countdownInterval) {
    broadcastBedwarsStatus(state, mode, t.countdownInterval ? t.secondsLeft : undefined);
    return;
  }

  broadcastBedwarsStatus(state, mode);
  t.waitTimer = setTimeout(() => {
    t.waitTimer = null;
    const q2 = state.queues[mode];
    if (q2.length < cfg.min) { broadcastBedwarsStatus(state, mode); return; }
    // Passaram 15s sem ninguém novo entrar e ainda tem gente suficiente:
    // contagem final de 10s — quando ela zerar, a partida começa à força
    // com quem tiver na fila.
    t.secondsLeft = BEDWARS_COUNTDOWN_MS / 1000;
    broadcastBedwarsStatus(state, mode, t.secondsLeft);
    t.countdownInterval = setInterval(() => {
      const qq = state.queues[mode];
      if (qq.length < cfg.min) {
        clearBedwarsTimers(state, mode);
        broadcastBedwarsStatus(state, mode);
        return;
      }
      t.secondsLeft -= 1;
      if (t.secondsLeft <= 0) {
        clearInterval(t.countdownInterval);
        t.countdownInterval = null;
        startBedwarsMatch(state, mode, qq.slice(0, cfg.max));
        return;
      }
      broadcastBedwarsStatus(state, mode, t.secondsLeft);
    }, 1000);
  }, BEDWARS_WAIT_MS);
}

// FFA (todos contra todos) agora é MELHOR DE 5: a rodada acaba quando sobra 1
// (ou 0) de pé, e quem chegar primeiro a FFA_ROUNDS_TO_WIN vitórias leva a
// partida. Se ninguém chegou lá, todo mundo renasce e começa outra rodada.
const FFA_ROUNDS_TO_WIN = 3;
function ffaScores(state, room) {
  return room.players.map((p) => {
    const cc = state.clients.get(p.id);
    return { id: p.id, name: (cc && cc.name) || ('User ' + p.id), wins: (room.roundWins && room.roundWins[p.id]) || 0 };
  });
}

function checkFfaEnd(state, room) {
  const aliveList = room.players.filter((p) => p.alive);
  if (aliveList.length > 1) return false;
  const winner = aliveList[0] || null;
  const winnerClient = winner ? state.clients.get(winner.id) : null;
  if (!room.roundWins) room.roundWins = {};
  if (winner) room.roundWins[winner.id] = (room.roundWins[winner.id] || 0) + 1;
  const scores = ffaScores(state, room);
  const round = room.roundNum || 1;

  if (winner && room.roundWins[winner.id] >= (isBigFfa(room.mode) ? 1 : FFA_ROUNDS_TO_WIN)) {
    // Partida decidida.
    botAfterMatch(state, room, winner.team, winner.id);
    for (const p of room.players) {
      send(state, p.id, {
        type: 'matchOver',
        mode: room.mode,
        winningTeam: winner.team,
        winnerId: winner.id,
        winnerName: winnerClient ? winnerClient.name : null,
        roundWins: room.roundWins,
        scores,
      });
      const c = state.clients.get(p.id);
      if (c) c.room = null;
    }
    for (const [roomId, r] of state.rooms) {
      if (r === room) { state.rooms.delete(roomId); break; }
    }
    broadcastOnline(state);
    return true;
  }

  // Só a rodada acabou: todo mundo volta a ficar vivo pra próxima.
  room.roundNum = round + 1;
  for (const p of room.players) {
    p.alive = true;
    p.hp = p.maxHp || 20;
    p.regenTimer = 0;
  }
  room.epoch = (room.epoch || 0) + 1;
  room.freezeUntil = Date.now() + 4700; // tela de rodada (1,8s) + contagem (2,6s)
  for (const p of room.players) {
    send(state, p.id, {
      type: 'roundOver',
      mode: room.mode,
      round,
      winnerId: winner ? winner.id : null,
      winnerName: winnerClient ? winnerClient.name : null,
      scores,
    });
  }
  return true;
}

// Quantas rodadas vencidas fecham a partida (melhor de 3 = primeiro a 2).
const ROUNDS_TO_WIN = 2;

function checkTeamWipe(state, room) {
  const aliveA = room.players.some((p) => p.team === 'A' && p.alive);
  const aliveB = room.players.some((p) => p.team === 'B' && p.alive);
  if (aliveA && aliveB) return false;
  const winningTeam = aliveA ? 'A' : 'B';
  room.roundWins[winningTeam] = (room.roundWins[winningTeam] || 0) + 1;

  if (room.roundWins[winningTeam] >= (room.mode === 'mega' ? 1 : ROUNDS_TO_WIN)) { // Mega: rodada única, quem morre já era
    // Partida (melhor de 3) decidida de vez.
    botAfterMatch(state, room, winningTeam, null);
    for (const p of room.players) {
      send(state, p.id, { type: 'matchOver', winningTeam, roundWins: room.roundWins });
      const c = state.clients.get(p.id);
      if (c) c.room = null;
    }
    for (const [roomId, r] of state.rooms) {
      if (r === room) { state.rooms.delete(roomId); break; }
    }
    broadcastOnline(state);
  } else {
    // Só a rodada acabou — a sala continua, todo mundo volta a ficar "vivo"
    // pra próxima rodada (2x2/3x3 agora também é melhor de 3, igual 1x1).
    for (const p of room.players) {
      p.alive = true;
      p.hp = p.maxHp || 20; // Resetar HP para a próxima rodada
      p.regenTimer = 0;
    }
    room.epoch = (room.epoch || 0) + 1;
    room.freezeUntil = Date.now() + 4700; // tela de rodada (1,8s) + contagem (2,6s)
    for (const p of room.players) {
      send(state, p.id, { type: 'roundOver', winningTeam, roundWins: room.roundWins });
    }
  }
  return true;
}

// Encerra a participação de um jogador numa sala (saída manual ou desconexão).
function removeFromRoom(state, id) {
  const c = state.clients.get(id);
  if (!c || !c.room) return;
  const room = state.rooms.get(c.room);
  if (!room) { c.room = null; return; }
  watchReanchor(state, room, id);

  // BedWars (Solo/Duo/Trio): quem sai ou desconecta simplesmente some da
  // sala, sem derrubar a partida dos outros e sem avisar ninguém — nada de
  // tela "JOGADOR DESCONECTADO". A sala só é apagada quando fica vazia.
  if (isBedwarsMode(room.mode)) {
    if (room.bw) {
      bwOnLeave(state, room, id);
    } else {
      room.players = room.players.filter((p) => p.id !== id);
      if (room.players.length === 0) {
        for (const [roomId, r] of state.rooms) {
          if (r === room) { state.rooms.delete(roomId); break; }
        }
      }
    }
    c.room = null;
    broadcastOnline(state);
    return;
  }

  // Quem sai (ou cai) no meio da partida simplesmente some da sala — a
  // partida CONTINUA pra quem ficou. Ela só acaba quando um time inteiro
  // saiu (nos modos por equipe / 1x1) ou quando sobra menos de 2 no FFA.
  const leaver = room.players.find((p) => p.id === id);
  room.players = room.players.filter((p) => p.id !== id);
  if (room.roster) room.roster = room.roster.filter((r) => r.id !== id);
  c.room = null;

  const teamsLeft = new Set(room.players.map((p) => p.team));
  const ended = isFfaMode(room.mode) ? room.players.length < 2 : teamsLeft.size < 2;
  if (ended) {
    for (const p of room.players) {
      send(state, p.id, { type: 'opponentLeft' });
      const oc = state.clients.get(p.id);
      if (oc) oc.room = null;
    }
    for (const [roomId, r] of state.rooms) {
      if (r === room) { state.rooms.delete(roomId); break; }
    }
    broadcastOnline(state);
    return;
  }

  // Avisa o resto da sala (o cliente tira o boneco dele e mostra um aviso).
  for (const p of room.players) {
    send(state, p.id, { type: 'teammateLeft', id, team: leaver ? leaver.team : null });
  }
  // Se ele ainda estava vivo, a saída conta como eliminação: pode fechar a rodada.
  if (leaver && leaver.alive) {
    if (isFfaMode(room.mode)) checkFfaEnd(state, room);
    else checkTeamWipe(state, room);
  }
  broadcastOnline(state);
}


// ---------- Golpe e morte (usados tanto pelos jogadores quanto pelos bots) ----------
function roomHasHuman(state, room) {
  return room.players.some((p) => {
    const c = state.clients.get(p.id);
    return c && !c.isBot;
  });
}

function applyHit(state, attackerId, targetId, dx, dz) {
  const c = state.clients.get(attackerId);
  if (!c || !c.room) return;
  const room = state.rooms.get(c.room);
  if (!room) return;
  const attacker = room.players.find((p) => p.id === attackerId);
  const target = room.players.find((p) => p.id === targetId);
  if (!attacker || !target || !target.alive || target.team === attacker.team) return;
  // (Invisível agora PODE ser atacado: só fica sem aparecer; a vida dele surge pra quem bate.)
  { const ac = state.clients.get(attackerId); if (ac && ac.isBot && !attacker.alive) return; }

  // Dano por golpe: 1 normalmente, ou o valor definido pelo ADM (cheat).
  const dmg = (attacker.cheats && attacker.cheats.dmg) || 1;

  // Decrementar HP do alvo (e reiniciar a regeneração — só volta a
  // regenerar depois de ficar um tempo sem apanhar).
  target.hp = Math.max(0, target.hp - dmg);
  target.regenTimer = 0;
  target.lastAttackerId = attackerId;
  target.lastAttackAt = Date.now();

  // Enviar hit para o alvo com seu HP atualizado
  send(state, target.id, { type: 'hit', by: attackerId, dx, dz, hp: target.hp, dmg });

  // Enviar efeito visual de hit para outros jogadores, com HP do alvo
  const svHitPos = isBigFfa(room.mode) ? botPosOf(state, room, target) : null;
  for (const p of room.players) {
    if (p.id === target.id || p.id === attackerId) continue;
    if (svHitPos) {
      // Survival: briga lá longe não precisa piscar/tocar som pra quem está do outro lado do mapa.
      const pc = state.clients.get(p.id);
      if (!pc || pc.isBot) continue;
      const pp = pc.pos;
      if (pp && Math.hypot(pp.x - svHitPos.x, pp.z - svHitPos.z) > 45) continue;
    }
    send(state, p.id, { type: 'hitFx', targetId: target.id, hp: target.hp });
  }

  // Enviar HP atualizado para o atacante também (para ele saber o HP do oponente)
  send(state, attacker.id, { type: 'opponentHp', oppId: target.id, hp: target.hp });

  // Bot: recebe o empurrão e, se a vida zerou, morre (quem avisa a morte de
  // um jogador de verdade é o próprio cliente dele; o bot não tem cliente).
  const tc = state.clients.get(target.id);
  if (tc && tc.isBot) {
    // "Timing" no FFA: se o "aliado" (o humano que topou fazer time) bater
    // nele, a aliança acaba na hora e ele passa a poder revidar/atacar.
    if (tc.bot && tc.bot.allyHumanId === attackerId) {
      tc.bot.allyHumanId = null;
      tc.bot.allyHumanEmail = null;
      botMatchTypeAndSend(state, room, target.id, bPick(['ah é assim? então guerra', 'quebrou a aliança, agora é cada um por si', 'traidor kkkk, acabou o timing', 'ah tá, então bora brigar mesmo']));
    }
    botOnHit(tc, dx, dz);
    if (target.hp <= 0) applyDeath(state, target.id);
  }
}

function applyDeath(state, id) {
  const c = state.clients.get(id);
  if (!c || !c.room) return;
  const room = state.rooms.get(c.room);
  if (!room) return;
  const player = room.players.find((p) => p.id === id);
  if (!player || !player.alive) return;
  player.alive = false;
  for (const p of room.players) {
    if (p.id !== id) send(state, p.id, { type: 'playerDown', id });
  }
  // "Fulano matou Ciclano": o último que bateu (nos últimos 15s) leva a morte.
  {
    const killer = player.lastAttackerId != null && Date.now() - (player.lastAttackAt || 0) < 15000
      ? room.players.find((p) => p.id === player.lastAttackerId) : null;
    const nameOf = (pid) => { const pc = state.clients.get(pid); return (pc && pc.name) || ('User ' + pid); };
    const kmsg = { type: 'kill', killerId: killer ? killer.id : null, killerName: killer ? nameOf(killer.id) : null, victimId: id, victimName: nameOf(id) };
    for (const p of room.players) send(state, p.id, kmsg);
    // Rastreio pra decisão de "rage quit": bot que apanha demais de um
    // humano (sem conseguir matá-lo de volta) conta como "sendo goleado".
    if (killer) {
      const killerC = state.clients.get(killer.id);
      const victimC = state.clients.get(id);
      if (victimC && victimC.isBot && victimC.bot && killerC && !killerC.isBot) {
        victimC.bot.deathsThisMatch = (victimC.bot.deathsThisMatch || 0) + 1;
      }
      if (killerC && killerC.isBot && killerC.bot && victimC && !victimC.isBot) {
        killerC.bot.killsAgainstHumanThisMatch = (killerC.bot.killsAgainstHumanThisMatch || 0) + 1;
      }
    }
    player.lastAttackerId = null;
  }
  if (room.mode === '1x1') botTrack1x1Round(state, room, id);
  if (isFfaMode(room.mode)) checkFfaEnd(state, room);
  else if (isBedwarsMode(room.mode)) return;
  // 1x1 com gente de verdade é decidido no cliente; só bot contra bot é decidido aqui.
  else if (room.mode !== '1x1' || !roomHasHuman(state, room)) checkTeamWipe(state, room);
}

function handleQueueMessage(state, id, msg) {
  const info = MODE_INFO[msg.mode];
  if (!info) return;
  const c = state.clients.get(id);
  // Reforço: o nome também vem junto da mensagem de fila (não só do
  // 'setName' isolado). Assim, mesmo que o 'setName' tenha se perdido ou
  // chegado fora de ordem, o nome certo ainda vale na hora de entrar na fila.
  if (c && typeof msg.name === 'string') {
    const n = msg.name.trim().slice(0, 20);
    if (n) c.name = n;
  }
  // Nunca deixa um jogador entrar em fila de outro modo enquanto já está
  // numa partida em andamento — sem essa trava, era possível ficar contado
  // como "jogando" em 1x1 (sala atual) e, ao mesmo tempo, em 2x2/3x3 (fila
  // nova), inflando os números mostrados na tela de escolha de modo.
  if (c && c.room) return;
  // Mesma conta não pode jogar duas partidas ao mesmo tempo (dois
  // dispositivos/abas logados juntos, por exemplo) — barra aqui, antes de
  // entrar na fila, em vez de deixar formar duas salas ao mesmo tempo.
  if (c && c.accountId && isAccountBusyElsewhere(c.accountId, state, id)) {
    send(state, id, { type: 'queueError', error: 'Essa conta já está jogando (ou na fila) em outro lugar.' });
    return;
  }
  for (const mode of Object.keys(state.queues)) {
    state.queues[mode] = state.queues[mode].filter((x) => x !== id);
  }
  bwDropVotes(state, id);
  state.queues[msg.mode].push(id);
  if (isBedwarsMode(msg.mode)) bwLobbyEnter(state, id, msg.mode);
  if (msg.mode === 'ffa') {
    processFfaQueue(state, { resetWait: true });
  } else if (isBedwarsMode(msg.mode)) {
    processBedwarsQueue(state, msg.mode, { resetWait: true });
  } else {
    tryMatch(state, msg.mode);
  }
  broadcastOnline(state);
}

function handleCancelMessage(state, id) {
  stopWatching(state, id);
  let changed = false;
  let ffaChanged = false;
  const bedwarsChanged = [];
  bwDropVotes(state, id);
  for (const mode of Object.keys(state.queues)) {
    const before = state.queues[mode].length;
    state.queues[mode] = state.queues[mode].filter((x) => x !== id);
    if (state.queues[mode].length !== before) {
      changed = true;
      if (mode === 'ffa') ffaChanged = true;
      else if (isBedwarsMode(mode)) bedwarsChanged.push(mode);
      else broadcastQueueStatus(state, mode);
    }
  }
  // O FFA e o BedWars têm sua própria contagem/cancelamento de timers,
  // então usam a fila própria em vez do broadcastQueueStatus genérico.
  if (ffaChanged) processFfaQueue(state);
  for (const mode of bedwarsChanged) { processBedwarsQueue(state, mode); bwBroadcastVotes(state, mode); }
  if (changed) broadcastOnline(state);
}

// =====================================================================
// BEDWARS — mundo em blocos (voxel), mapas e geração procedural
// =====================================================================
// O servidor é o "dono" do mundo: ele gera o mapa, guarda cada bloco e só
// aceita colocar/quebrar o que as regras permitem. O cliente recebe o mapa
// comprimido (RLE) no início da partida e depois só as mudanças (bwBlocks).
//
// Coordenadas: x/z horizontais (0..127), y vertical (0..63). Cada bloco ocupa
// [x,x+1) x [y,y+1) x [z,z+1). As ilhas ficam com a camada de cima em y = BW_Y0,
// então quem está de pé numa ilha tem os pés em y = BW_Y0 + 1.
const BW_W = 128, BW_H = 64, BW_D = 128;
const BW_CX = 64, BW_CZ = 64;
const BW_Y0 = 30;
const BW_VOID_Y = 8;                 // pés abaixo disso = caiu no vazio
const BW_MIN_BUILD_Y = 10;           // limites de construção (anti-torre infinita)
const BW_MAX_BUILD_Y = 58;

// Times (a cor de cada time é a mesma no cliente e no servidor).
const BW_TEAM_DEFS = [
  { key: 'red',    name: 'Vermelho', hex: 0xd93a3a, css: '#ff5555' },
  { key: 'blue',   name: 'Azul',     hex: 0x3d5fe0, css: '#6b88ff' },
  { key: 'green',  name: 'Verde',    hex: 0x3fb04a, css: '#55ff55' },
  { key: 'yellow', name: 'Amarelo',  hex: 0xf0d030, css: '#ffdd33' },
  { key: 'aqua',   name: 'Ciano',    hex: 0x30d0d8, css: '#55ffff' },
  { key: 'white',  name: 'Branco',   hex: 0xf2f2f2, css: '#ffffff' },
  { key: 'pink',   name: 'Rosa',     hex: 0xf070b8, css: '#ff77cc' },
  { key: 'gray',   name: 'Cinza',    hex: 0x808080, css: '#bbbbbb' },
];

// IDs de bloco (os mesmos números no cliente!). LÃ e ARGILA têm 8 cores cada:
// WOOL + índice do time (1..8) e CLAY + índice do time (9..16).
const BLK = {
  AIR: 0, WOOL: 1, CLAY: 9,
  PLANKS: 17, GLASS: 18, ENDSTONE: 19, OBSIDIAN: 20, STONE: 21, COBBLE: 22, DIRT: 23, GRASS: 24,
  SAND: 25, SANDSTONE: 26, SNOW: 27, ICE: 28, SPRUCE: 29, LOG: 30, LEAVES: 31, NETHERRACK: 32,
  NETHERBRICK: 33, QUARTZ: 34, GOLDBLK: 35, IRONBLK: 36, DIAMONDBLK: 37, EMERALDBLK: 38,
  STONEBRICK: 39, TERRACOTTA: 40, PRISMARINE: 41, GLOWSTONE: 42, BRICK: 43, PACKEDICE: 44,
  CUTSAND: 45, SNOWLEAVES: 46,
  BED: 60, WATER: 61,
};
const BW_BLASTPROOF = new Set([BLK.GLASS, BLK.ENDSTONE, BLK.OBSIDIAN]);

function bwNewWorld() {
  return { g: new Uint8Array(BW_W * BW_H * BW_D), placed: new Uint8Array(BW_W * BW_H * BW_D) };
}
function bwIdx(x, y, z) { return x + z * BW_W + y * BW_W * BW_D; }
function bwInB(x, y, z) { return x >= 0 && x < BW_W && y >= 0 && y < BW_H && z >= 0 && z < BW_D; }
function bwGet(w, x, y, z) { return bwInB(x, y, z) ? w.g[bwIdx(x, y, z)] : 0; }
function bwSetRaw(w, x, y, z, id) { if (bwInB(x, y, z)) w.g[bwIdx(x, y, z)] = id; }
function bwIsSolid(id) { return id !== 0 && id !== BLK.WATER; }

// Compressão do mundo pra mandar pro cliente: pares [valor, quantidade] em
// sequência (x é o eixo mais rápido, então o "ar" vira poucos números).
function bwRle(g) {
  const out = [];
  let cur = g[0], run = 1;
  for (let i = 1; i < g.length; i++) {
    const v = g[i];
    if (v === cur) run++;
    else { out.push(cur, run); cur = v; run = 1; }
  }
  out.push(cur, run);
  return out;
}

// ---------- Ferramentas de construção ----------
function bwInShape(shape, dx, dz, r) {
  if (shape === 'square') return Math.abs(dx) <= r && Math.abs(dz) <= r;
  if (shape === 'oct') return Math.abs(dx) <= r && Math.abs(dz) <= r && (Math.abs(dx) + Math.abs(dz)) <= r * 1.5;
  return dx * dx + dz * dz <= r * r + r * 0.6;
}
// Ilha flutuante: camadas que vão afinando pra baixo (cone invertido).
function bwBuildIsland(w, cx, cz, r, shape, depth, top, sub, base) {
  for (let d = 0; d <= depth; d++) {
    const rr = r - Math.floor(d * r / (depth + 1));
    const id = d === 0 ? top : (d <= 2 ? sub : base);
    for (let dx = -rr; dx <= rr; dx++) {
      for (let dz = -rr; dz <= rr; dz++) {
        if (bwInShape(shape, dx, dz, rr)) bwSetRaw(w, cx + dx, BW_Y0 - d, cz + dz, id);
      }
    }
  }
}
function bwFillBox(w, x1, y1, z1, x2, y2, z2, id) {
  for (let y = y1; y <= y2; y++) for (let z = z1; z <= z2; z++) for (let x = x1; x <= x2; x++) bwSetRaw(w, x, y, z, id);
}
// Caminho (ponte pronta do mapa) entre dois pontos, só sobre o vazio.
function bwPath(w, x1, z1, x2, z2, width, id) {
  const half = Math.floor(width / 2);
  const n = Math.max(Math.abs(x2 - x1), Math.abs(z2 - z1)) * 2;
  for (let i = 0; i <= n; i++) {
    const t = n ? i / n : 0;
    const x = Math.round(x1 + (x2 - x1) * t), z = Math.round(z1 + (z2 - z1) * t);
    for (let a = -half; a <= half; a++) for (let b = -half; b <= half; b++) {
      if (bwGet(w, x + a, BW_Y0, z + b) === 0) bwSetRaw(w, x + a, BW_Y0, z + b, id);
    }
  }
}
function bwTreeOak(w, x, y, z, h) {
  for (let i = 0; i < h; i++) bwSetRaw(w, x, y + i, z, BLK.LOG);
  for (let dy = h - 2; dy <= h + 1; dy++) {
    const rr = dy >= h ? 1 : 2;
    for (let dx = -rr; dx <= rr; dx++) for (let dz = -rr; dz <= rr; dz++) {
      if (Math.abs(dx) === rr && Math.abs(dz) === rr && dy < h) continue;
      if (bwGet(w, x + dx, y + dy, z + dz) === 0) bwSetRaw(w, x + dx, y + dy, z + dz, BLK.LEAVES);
    }
  }
}
function bwTreePine(w, x, y, z, h) {
  for (let i = 0; i < h; i++) bwSetRaw(w, x, y + i, z, BLK.SPRUCE);
  for (let i = 0; i < 3; i++) {
    const rr = 2 - i;
    const yy = y + 2 + i * 2;
    for (let dx = -rr; dx <= rr; dx++) for (let dz = -rr; dz <= rr; dz++) {
      if (Math.abs(dx) + Math.abs(dz) > rr + 1) continue;
      if (bwGet(w, x + dx, yy, z + dz) === 0) bwSetRaw(w, x + dx, yy, z + dz, BLK.SNOWLEAVES);
    }
  }
  bwSetRaw(w, x, y + h, z, BLK.SNOWLEAVES);
}
function bwTreePalm(w, x, y, z, h) {
  for (let i = 0; i < h; i++) bwSetRaw(w, x, y + i, z, BLK.LOG);
  const ty = y + h;
  [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]].forEach(([dx, dz]) => {
    if (bwGet(w, x + dx, ty, z + dz) === 0) bwSetRaw(w, x + dx, ty, z + dz, BLK.LEAVES);
  });
  [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([dx, dz]) => {
    if (bwGet(w, x + dx, ty - 1, z + dz) === 0) bwSetRaw(w, x + dx, ty - 1, z + dz, BLK.LEAVES);
  });
}

// ---------- Geometria do anel de ilhas ----------
// 8 "vagas" de ilha em anel. Time i usa a vaga floor(i*8/N), então com menos
// times as ilhas ficam bem espalhadas. As vagas sem time viram ilhas neutras.
function bwSlotsFor(n) { const s = []; for (let i = 0; i < n; i++) s.push(Math.floor(i * 8 / n)); return s; }
const BW_SLOT_K = [0, 1, 1, 2, 2, 3, 3, 0]; // rotação (90° por passo) de cada vaga
// Local -> mundo: u aponta "pra fora" da ilha (longe do centro), v é lateral.
function bwL2W(k, u, v) {
  switch (k) { case 0: return [u, v]; case 1: return [-v, u]; case 2: return [-u, -v]; default: return [v, -u]; }
}
function bwSlotCenter(cfg, s) {
  const a = s * Math.PI / 4;
  return [BW_CX + Math.round(Math.cos(a) * cfg.Rc), BW_CZ + Math.round(Math.sin(a) * cfg.Rc)];
}
function bwDiaCenter(cfg, k) {
  const a = (22.5 + 90 * k) * Math.PI / 180;
  return [BW_CX + Math.round(Math.cos(a) * cfg.Rd), BW_CZ + Math.round(Math.sin(a) * cfg.Rd)];
}
function bwYawFor(dx, dz) { return Math.atan2(-dx, -dz); } // mesma convenção da câmera do jogo

// ---------- Os 6 mapas ----------
const BW_MAPS = {
  valeverde: {
    id: 'valeverde', name: 'Vale Verde', icon: '🌳', sky: 0x87ceeb, fog: 0xa8dcf5,
    desc: 'Ilhas gramadas com árvores. Sem pontes prontas — construa seu caminho até os diamantes.',
    shape: 'round', S: 7, depth: 6, Rc: 40, Rd: 26,
    top: BLK.GRASS, sub: BLK.DIRT, base: BLK.STONE, cover: BLK.STONEBRICK, pillar: BLK.LOG, deco: 'oak',
    paths: 'none', pathBlock: BLK.PLANKS, pathW: 3,
    diaTop: BLK.GRASS, diaSub: BLK.DIRT, center: 'plain', cTop: BLK.GRASS, cSub: BLK.DIRT,
  },
  deserto: {
    id: 'deserto', name: 'Deserto Dourado', icon: '🏜️', sky: 0xffe0a8, fog: 0xffe9c4,
    desc: 'Ilhas de areia e uma pirâmide no meio com as esmeraldas.',
    shape: 'square', S: 7, depth: 5, Rc: 41, Rd: 27,
    top: BLK.SAND, sub: BLK.SANDSTONE, base: BLK.SANDSTONE, cover: BLK.CUTSAND, pillar: BLK.SANDSTONE, deco: 'none',
    paths: 'none', pathBlock: BLK.CUTSAND, pathW: 3,
    diaTop: BLK.SANDSTONE, diaSub: BLK.SANDSTONE, center: 'pyramid', cTop: BLK.SAND, cSub: BLK.SANDSTONE,
  },
  nevasca: {
    id: 'nevasca', name: 'Nevasca', icon: '❄️', sky: 0xd6ecff, fog: 0xeaf5ff,
    desc: 'Ilhas de neve e gelo, sem pontes prontas. Ponte na unha!',
    shape: 'round', S: 7, depth: 6, Rc: 38, Rd: 25,
    top: BLK.SNOW, sub: BLK.PACKEDICE, base: BLK.ICE, cover: BLK.ICE, pillar: BLK.SPRUCE, deco: 'pine',
    paths: 'none', pathBlock: BLK.ICE, pathW: 1,
    diaTop: BLK.SNOW, diaSub: BLK.PACKEDICE, center: 'spikes', cTop: BLK.SNOW, cSub: BLK.PACKEDICE,
  },
  inferno: {
    id: 'inferno', name: 'Inferno', icon: '🔥', sky: 0x3a0f0f, fog: 0x5a1a12,
    desc: 'Rochas do Nether, pilares de obsidiana e distâncias longas.',
    shape: 'square', S: 7, depth: 6, Rc: 42, Rd: 27,
    top: BLK.NETHERRACK, sub: BLK.NETHERRACK, base: BLK.NETHERBRICK, cover: BLK.NETHERBRICK, pillar: BLK.OBSIDIAN, deco: 'none',
    paths: 'none', pathBlock: BLK.NETHERBRICK, pathW: 1,
    diaTop: BLK.NETHERBRICK, diaSub: BLK.NETHERRACK, center: 'pillars', cTop: BLK.NETHERBRICK, cSub: BLK.NETHERRACK,
  },
  templo: {
    id: 'templo', name: 'Templo Celeste', icon: '🏛️', sky: 0xb5dcff, fog: 0xd8ecff,
    desc: 'Um templo de quartzo no céu. Sem pontes prontas — construa seu caminho.',
    shape: 'oct', S: 7, depth: 4, Rc: 38, Rd: 25,
    top: BLK.QUARTZ, sub: BLK.STONEBRICK, base: BLK.STONEBRICK, cover: BLK.QUARTZ, pillar: BLK.QUARTZ, deco: 'none',
    paths: 'none', pathBlock: BLK.QUARTZ, pathW: 3,
    diaTop: BLK.QUARTZ, diaSub: BLK.STONEBRICK, center: 'temple', cTop: BLK.QUARTZ, cSub: BLK.STONEBRICK,
  },
  tropical: {
    id: 'tropical', name: 'Ilhas Tropicais', icon: '🏝️', sky: 0x86e3ee, fog: 0xb9f0f5,
    desc: 'Ilhotas pequenas com palmeiras, distâncias enormes e um arquipélago no centro.',
    shape: 'round', S: 6, depth: 5, Rc: 44, Rd: 29,
    top: BLK.SAND, sub: BLK.SAND, base: BLK.SANDSTONE, cover: BLK.PRISMARINE, pillar: BLK.LOG, deco: 'palm',
    paths: 'none', pathBlock: BLK.SAND, pathW: 1,
    diaTop: BLK.SAND, diaSub: BLK.SANDSTONE, center: 'archipelago', cTop: BLK.SAND, cSub: BLK.SANDSTONE,
  },
};
const BW_MAP_IDS = Object.keys(BW_MAPS);
const BW_MAP_LIST = BW_MAP_IDS.map((id) => ({ id, name: BW_MAPS[id].name, icon: BW_MAPS[id].icon, desc: BW_MAPS[id].desc, sky: BW_MAPS[id].sky }));

// Ilha de um time: gerador no centro (com lã da cor do time em volta), cama
// no fundo cercada de blocos, spawn, lojinha e lojinha de melhorias.
function bwTeamIsland(w, cfg, cx, cz, k, teamIdx) {
  const Y = BW_Y0;
  const P = (u, v) => { const d = bwL2W(k, u, v); return [cx + d[0], cz + d[1]]; };
  const has = (x, z) => bwGet(w, x, Y, z) !== 0;

  // 3x3 de lã do time com um bloco de ferro no meio (o gerador).
  for (let du = -1; du <= 1; du++) for (let dv = -1; dv <= 1; dv++) {
    const p = P(du, dv);
    bwSetRaw(w, p[0], Y, p[1], (du === 0 && dv === 0) ? BLK.IRONBLK : BLK.WOOL + teamIdx);
  }
  // Pilares decorativos nos cantos de dentro.
  [[5, 5], [5, -5], [-5, 5], [-5, -5]].forEach(([u, v]) => {
    const p = P(u, v);
    if (has(p[0], p[1])) { bwSetRaw(w, p[0], Y + 1, p[1], cfg.pillar); bwSetRaw(w, p[0], Y + 2, p[1], cfg.pillar); }
  });
  // Cama (2 blocos, no fundo da ilha) + cobertura em volta (o topo e a frente ficam abertos).
  const bedA = P(5, 0), bedB = P(4, 0);
  bwSetRaw(w, bedA[0], Y + 1, bedA[1], BLK.BED);
  bwSetRaw(w, bedB[0], Y + 1, bedB[1], BLK.BED);
  [[4, -1], [4, 1], [5, -1], [5, 1]].forEach(([u, v]) => {
    const p = P(u, v); if (has(p[0], p[1])) bwSetRaw(w, p[0], Y + 1, p[1], cfg.cover);
  });
  [[6, -1], [6, 0], [6, 1]].forEach(([u, v]) => {
    const p = P(u, v);
    if (has(p[0], p[1])) { bwSetRaw(w, p[0], Y + 1, p[1], cfg.cover); bwSetRaw(w, p[0], Y + 2, p[1], cfg.cover); }
  });
  // Decoração do mapa (árvores etc.) no fundo, longe do caminho de entrada.
  [[-5, 5], [-5, -5]].forEach(([u, v]) => {
    const p = P(u, v);
    if (!has(p[0], p[1])) return;
    if (cfg.deco === 'oak') bwTreeOak(w, p[0], Y + 1, p[1], 4);
    else if (cfg.deco === 'pine') bwTreePine(w, p[0], Y + 1, p[1], 5);
    else if (cfg.deco === 'palm') bwTreePalm(w, p[0], Y + 1, p[1], 5);
  });

  const inward = bwL2W(k, -1, 0);
  const sp = P(-3, 0);
  const spawn = { x: sp[0] + 0.5, y: Y + 1, z: sp[1] + 0.5, yaw: bwYawFor(inward[0], inward[1]) };
  const shopP = P(-1, 3), upgP = P(-1, -3);
  const faceC = (p) => { const dx = (cx - p[0]), dz = (cz - p[1]); return bwYawFor(dx, dz); };
  const shop = { x: shopP[0] + 0.5, y: Y + 1, z: shopP[1] + 0.5, yaw: faceC(shopP) };
  const upg = { x: upgP[0] + 0.5, y: Y + 1, z: upgP[1] + 0.5, yaw: faceC(upgP) };
  const dIron = bwL2W(k, 0, -0.4), dGold = bwL2W(k, 0, 0.4), dEm = bwL2W(k, -1.0, 0);
  return {
    idx: teamIdx, cx, cz, k, spawn, shop, upg,
    bed: [[bedA[0], Y + 1, bedA[1]], [bedB[0], Y + 1, bedB[1]]],
    ironPos: { x: cx + 0.5 + dIron[0], y: Y + 1, z: cz + 0.5 + dIron[1] },
    goldPos: { x: cx + 0.5 + dGold[0], y: Y + 1, z: cz + 0.5 + dGold[1] },
    emPos: { x: cx + 0.5 + dEm[0], y: Y + 1, z: cz + 0.5 + dEm[1] },
  };
}

// Ilha neutra (vaga sem time): só terreno e decoração.
function bwNeutralIsland(w, cfg, cx, cz, k) {
  const Y = BW_Y0;
  const P = (u, v) => { const d = bwL2W(k, u, v); return [cx + d[0], cz + d[1]]; };
  [[5, 5], [5, -5], [-5, 5], [-5, -5]].forEach(([u, v]) => {
    const p = P(u, v);
    if (bwGet(w, p[0], Y, p[1]) !== 0) { bwSetRaw(w, p[0], Y + 1, p[1], cfg.pillar); bwSetRaw(w, p[0], Y + 2, p[1], cfg.pillar); }
  });
  [[-4, 0], [4, 0]].forEach(([u, v]) => {
    const p = P(u, v);
    if (bwGet(w, p[0], Y, p[1]) === 0) return;
    if (cfg.deco === 'oak') bwTreeOak(w, p[0], Y + 1, p[1], 4);
    else if (cfg.deco === 'pine') bwTreePine(w, p[0], Y + 1, p[1], 5);
    else if (cfg.deco === 'palm') bwTreePalm(w, p[0], Y + 1, p[1], 5);
  });
}

function bwGenerateMap(cfg, teamCount) {
  const w = bwNewWorld();
  const Y = BW_Y0;
  const slots = bwSlotsFor(teamCount);
  const teams = [];
  const gens = [];

  // 1) As 8 ilhas do anel.
  for (let s = 0; s < 8; s++) {
    const c = bwSlotCenter(cfg, s);
    bwBuildIsland(w, c[0], c[1], cfg.S, cfg.shape, cfg.depth, cfg.top, cfg.sub, cfg.base);
    const ti = slots.indexOf(s);
    if (ti >= 0) {
      const t = bwTeamIsland(w, cfg, c[0], c[1], BW_SLOT_K[s], ti);
      t.slot = s;
      teams.push(t);
    } else {
      bwNeutralIsland(w, cfg, c[0], c[1], BW_SLOT_K[s]);
    }
  }

  // 2) Ilhas de diamante (uma entre cada par de ilhas vizinhas).
  const diaCenters = [];
  for (let k = 0; k < 4; k++) {
    const c = bwDiaCenter(cfg, k);
    diaCenters.push(c);
    bwBuildIsland(w, c[0], c[1], 3, 'round', 4, cfg.diaTop, cfg.diaSub, cfg.base);
    bwSetRaw(w, c[0], Y, c[1], BLK.DIAMONDBLK);
    // Quatro cantinhos decorados.
    [[2, 2], [2, -2], [-2, 2], [-2, -2]].forEach(([a, b]) => {
      if (bwGet(w, c[0] + a, Y, c[1] + b) !== 0) bwSetRaw(w, c[0] + a, Y + 1, c[1] + b, cfg.cover);
    });
    gens.push({ kind: 'diamond', x: c[0] + 0.5, y: Y + 1, z: c[1] + 0.5, team: -1 });
  }

  // 3) O centro do mapa (esmeraldas).
  const emerald = [];
  const CX = BW_CX, CZ = BW_CZ;
  const gemAt = (x, z, yy) => {
    bwSetRaw(w, x, yy, z, BLK.EMERALDBLK);
    emerald.push({ kind: 'emerald', x: x + 0.5, y: yy + 1, z: z + 0.5, team: -1 });
  };
  if (cfg.center === 'plain') {
    bwBuildIsland(w, CX, CZ, 7, 'round', 6, cfg.cTop, cfg.cSub, cfg.base);
    [[3, 3], [3, -3], [-3, 3], [-3, -3]].forEach(([a, b]) => gemAt(CX + a, CZ + b, Y));
    bwFillBox(w, CX - 1, Y, CZ - 1, CX + 1, Y, CZ + 1, BLK.COBBLE);
  } else if (cfg.center === 'pyramid') {
    bwBuildIsland(w, CX, CZ, 7, 'square', 5, cfg.cTop, cfg.cSub, cfg.base);
    for (let h = 1; h <= 3; h++) bwFillBox(w, CX - (4 - h), Y + h, CZ - (4 - h), CX + (4 - h), Y + h, CZ + (4 - h), BLK.SANDSTONE);
    bwFillBox(w, CX, Y + 4, CZ, CX, Y + 4, CZ, BLK.GOLDBLK);
    [[5, 5], [5, -5], [-5, 5], [-5, -5]].forEach(([a, b]) => gemAt(CX + a, CZ + b, Y));
  } else if (cfg.center === 'spikes') {
    bwBuildIsland(w, CX, CZ, 7, 'round', 6, cfg.cTop, cfg.cSub, cfg.base);
    [[0, 0, 5], [2, -1, 3], [-2, 2, 4], [1, 2, 3], [-1, -2, 4], [4, 0, 3], [-4, 0, 3], [0, 4, 3], [0, -4, 3]].forEach(([a, b, h]) => {
      for (let i = 1; i <= h; i++) bwSetRaw(w, CX + a, Y + i, CZ + b, BLK.PACKEDICE);
    });
    [[3, 3], [3, -3], [-3, 3], [-3, -3]].forEach(([a, b]) => gemAt(CX + a, CZ + b, Y));
  } else if (cfg.center === 'pillars') {
    bwBuildIsland(w, CX, CZ, 8, 'square', 6, cfg.cTop, cfg.cSub, cfg.base);
    [[6, 6], [6, -6], [-6, 6], [-6, -6], [0, 6], [0, -6], [6, 0], [-6, 0]].forEach(([a, b]) => {
      for (let i = 1; i <= 4; i++) bwSetRaw(w, CX + a, Y + i, CZ + b, BLK.OBSIDIAN);
      bwSetRaw(w, CX + a, Y + 5, CZ + b, BLK.GLOWSTONE);
    });
    [[3, 3], [3, -3], [-3, 3], [-3, -3]].forEach(([a, b]) => gemAt(CX + a, CZ + b, Y));
  } else if (cfg.center === 'temple') {
    bwBuildIsland(w, CX, CZ, 8, 'round', 4, cfg.cTop, cfg.cSub, cfg.base);
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      const px = CX + Math.round(Math.cos(a) * 6), pz = CZ + Math.round(Math.sin(a) * 6);
      for (let h = 1; h <= 4; h++) bwSetRaw(w, px, Y + h, pz, BLK.QUARTZ);
      bwSetRaw(w, px, Y + 5, pz, BLK.GOLDBLK);
    }
    [[3, 3], [3, -3], [-3, 3], [-3, -3]].forEach(([a, b]) => gemAt(CX + a, CZ + b, Y));
  } else { // archipelago
    bwBuildIsland(w, CX, CZ, 4, 'round', 4, cfg.cTop, cfg.cSub, cfg.base);
    bwTreePalm(w, CX, Y + 1, CZ, 5);
    [[9, 0], [-9, 0], [0, 9], [0, -9]].forEach(([a, b]) => {
      bwBuildIsland(w, CX + a, CZ + b, 2, 'round', 3, cfg.cTop, cfg.cSub, cfg.base);
      gemAt(CX + a, CZ + b, Y);
    });
  }

  // 4) Caminhos prontos (pontes do mapa).
  const tc = (s) => bwSlotCenter(cfg, s);
  if (cfg.paths === 'diamond' || cfg.paths === 'both') {
    for (let k = 0; k < 4; k++) {
      [2 * k, 2 * k + 1].forEach((s) => { const c = tc(s); bwPath(w, diaCenters[k][0], diaCenters[k][1], c[0], c[1], cfg.pathW, cfg.pathBlock); });
    }
  }
  if (cfg.paths === 'center' || cfg.paths === 'both') {
    for (let k = 0; k < 4; k++) bwPath(w, CX, CZ, diaCenters[k][0], diaCenters[k][1], cfg.pathW, cfg.pathBlock);
  }
  // Re-assenta os blocos especiais que um caminho possa ter encostado (nunca sobrescreve, mas garante o gerador).
  return { w, teams, gens: gens.concat(emerald), diaCenters };
}

// =====================================================================
// BEDWARS — itens, loja, melhorias de time e linha do tempo
// =====================================================================
const BW_RES = ['iron', 'gold', 'diamond', 'emerald'];
const BW_RES_NAME = { iron: 'Ferro', gold: 'Ouro', diamond: 'Diamante', emerald: 'Esmeralda' };

// Tudo que pode ir num slot do inventário. "act" diz ao cliente o que o botão
// USAR faz: place (mira num bloco), throw (arremessa), shoot (arco), use (na hora).
// "grp" agrupa itens que se substituem (uma espada melhor troca a pior).
const BW_ITEMS = {
  sword1: { name: 'Espada de Madeira', ic: '🗡️', tier: 1, kind: 'sword', dmg: 4, act: 'melee', grp: 'sword' },
  sword2: { name: 'Espada de Pedra', ic: '🗡️', tier: 2, kind: 'sword', dmg: 5, act: 'melee', grp: 'sword' },
  sword3: { name: 'Espada de Ferro', ic: '🗡️', tier: 3, kind: 'sword', dmg: 6, act: 'melee', grp: 'sword' },
  sword4: { name: 'Espada de Diamante', ic: '🗡️', tier: 4, kind: 'sword', dmg: 7, act: 'melee', grp: 'sword' },
  kb: { name: 'Bastão de Repulsão', ic: '🏏', tier: 2, kind: 'kb', dmg: 1, act: 'melee' },
  pick1: { name: 'Picareta de Madeira', ic: '⛏️', tier: 1, kind: 'pick', dmg: 2, act: 'melee', grp: 'pick' },
  pick2: { name: 'Picareta de Ferro', ic: '⛏️', tier: 3, kind: 'pick', dmg: 2, act: 'melee', grp: 'pick' },
  pick3: { name: 'Picareta de Ouro', ic: '⛏️', tier: 5, kind: 'pick', dmg: 2, act: 'melee', grp: 'pick' },
  pick4: { name: 'Picareta de Diamante', ic: '⛏️', tier: 4, kind: 'pick', dmg: 2, act: 'melee', grp: 'pick' },
  axe1: { name: 'Machado de Madeira', ic: '🪓', tier: 1, kind: 'axe', dmg: 3, act: 'melee', grp: 'axe' },
  axe2: { name: 'Machado de Pedra', ic: '🪓', tier: 2, kind: 'axe', dmg: 3, act: 'melee', grp: 'axe' },
  axe3: { name: 'Machado de Ferro', ic: '🪓', tier: 3, kind: 'axe', dmg: 3, act: 'melee', grp: 'axe' },
  axe4: { name: 'Machado de Diamante', ic: '🪓', tier: 4, kind: 'axe', dmg: 3, act: 'melee', grp: 'axe' },
  shears: { name: 'Tesoura', ic: '✂️', tier: 3, kind: 'shears', dmg: 1, act: 'melee' },
  bow1: { name: 'Arco', ic: '🏹', tier: 1, kind: 'bow', dmg: 1, act: 'shoot', grp: 'bow', power: 0, punch: 0 },
  bow2: { name: 'Arco (Poder I)', ic: '🏹', tier: 2, kind: 'bow', dmg: 1, act: 'shoot', grp: 'bow', power: 1, punch: 0 },
  bow3: { name: 'Arco (Poder I, Impacto I)', ic: '🏹', tier: 4, kind: 'bow', dmg: 1, act: 'shoot', grp: 'bow', power: 1, punch: 1 },
  wool: { name: 'Lã', stack: 1, act: 'place', block: 'wool' },
  clay: { name: 'Argila Endurecida', stack: 1, act: 'place', block: 'clay' },
  glass: { name: 'Vidro à Prova de Explosão', stack: 1, act: 'place', block: BLK.GLASS },
  endstone: { name: 'Pedra do Fim', stack: 1, act: 'place', block: BLK.ENDSTONE },
  planks: { name: 'Tábuas de Madeira', stack: 1, act: 'place', block: BLK.PLANKS },
  obsidian: { name: 'Obsidiana', stack: 1, act: 'place', block: BLK.OBSIDIAN },
  tnt: { name: 'TNT', ic: '🧨', stack: 1, act: 'place' },
  water: { name: 'Balde de Água', ic: '💧', stack: 1, act: 'place' },
  sponge: { name: 'Esponja', ic: '🧽', stack: 1, act: 'place' },
  tower: { name: 'Torre Compacta', ic: '🗼', stack: 1, act: 'place' },
  fireball: { name: 'Bola de Fogo', ic: '☄️', stack: 1, act: 'throw' },
  pearl: { name: 'Pérola do Fim', ic: '🔮', stack: 1, act: 'throw' },
  egg: { name: 'Ovo de Ponte', ic: '🥚', stack: 1, act: 'throw' },
  apple: { name: 'Maçã Dourada', ic: '🍎', stack: 1, act: 'use' },
  milk: { name: 'Leite Mágico', ic: '🥛', stack: 1, act: 'use' },
  potion_speed: { name: 'Poção de Velocidade II', ic: '🧪', stack: 1, act: 'use' },
  potion_jump: { name: 'Poção de Pulo V', ic: '🧪', stack: 1, act: 'use' },
  potion_invis: { name: 'Poção de Invisibilidade', ic: '🧪', stack: 1, act: 'use' },
  bedbug: { name: 'Traça', ic: '🐛', stack: 1, act: 'use' },
  golem: { name: 'Defensor dos Sonhos', ic: '🗿', stack: 1, act: 'use' },
};
const BW_SLOTS = 18;

const BW_SHOP_CATS = [
  { id: 'blocks', name: 'Blocos', ic: '🧱' },
  { id: 'melee', name: 'Armas', ic: '⚔️' },
  { id: 'armor', name: 'Armaduras', ic: '🛡️' },
  { id: 'tools', name: 'Ferramentas', ic: '⛏️' },
  { id: 'ranged', name: 'Arcos', ic: '🏹' },
  { id: 'potions', name: 'Poções', ic: '🧪' },
  { id: 'util', name: 'Utilidades', ic: '🎒' },
];
// cost = [recurso, quantidade]. tool/tier = evolução (só dá pra comprar o próximo nível).
const BW_SHOP = [
  { id: 'wool', cat: 'blocks', item: 'wool', n: 16, cost: ['iron', 4] },
  { id: 'clay', cat: 'blocks', item: 'clay', n: 16, cost: ['iron', 12] },
  { id: 'glass', cat: 'blocks', item: 'glass', n: 4, cost: ['iron', 12] },
  { id: 'endstone', cat: 'blocks', item: 'endstone', n: 12, cost: ['iron', 24] },
  { id: 'planks', cat: 'blocks', item: 'planks', n: 16, cost: ['gold', 4] },
  { id: 'obsidian', cat: 'blocks', item: 'obsidian', n: 4, cost: ['emerald', 4] },

  { id: 'sword2', cat: 'melee', item: 'sword2', n: 1, cost: ['iron', 10], tool: 'sword', tier: 2 },
  { id: 'sword3', cat: 'melee', item: 'sword3', n: 1, cost: ['gold', 7], tool: 'sword', tier: 3 },
  { id: 'sword4', cat: 'melee', item: 'sword4', n: 1, cost: ['emerald', 3], tool: 'sword', tier: 4 },
  { id: 'kb', cat: 'melee', item: 'kb', n: 1, cost: ['gold', 5], tool: 'kb', tier: 1 },

  { id: 'armor1', cat: 'armor', armor: 1, name: 'Armadura de Cota de Malha', ic: '🛡️', n: 1, cost: ['iron', 24] },
  { id: 'armor2', cat: 'armor', armor: 2, name: 'Armadura de Ferro', ic: '🛡️', n: 1, cost: ['gold', 12] },
  { id: 'armor3', cat: 'armor', armor: 3, name: 'Armadura de Diamante', ic: '🛡️', n: 1, cost: ['emerald', 6] },

  { id: 'shears', cat: 'tools', item: 'shears', n: 1, cost: ['iron', 20], tool: 'shears', tier: 1 },
  { id: 'pick1', cat: 'tools', item: 'pick1', n: 1, cost: ['iron', 10], tool: 'pick', tier: 1 },
  { id: 'pick2', cat: 'tools', item: 'pick2', n: 1, cost: ['iron', 10], tool: 'pick', tier: 2 },
  { id: 'pick3', cat: 'tools', item: 'pick3', n: 1, cost: ['gold', 3], tool: 'pick', tier: 3 },
  { id: 'pick4', cat: 'tools', item: 'pick4', n: 1, cost: ['gold', 6], tool: 'pick', tier: 4 },
  { id: 'axe1', cat: 'tools', item: 'axe1', n: 1, cost: ['iron', 10], tool: 'axe', tier: 1 },
  { id: 'axe2', cat: 'tools', item: 'axe2', n: 1, cost: ['iron', 10], tool: 'axe', tier: 2 },
  { id: 'axe3', cat: 'tools', item: 'axe3', n: 1, cost: ['gold', 3], tool: 'axe', tier: 3 },
  { id: 'axe4', cat: 'tools', item: 'axe4', n: 1, cost: ['gold', 6], tool: 'axe', tier: 4 },

  { id: 'bow1', cat: 'ranged', item: 'bow1', n: 1, cost: ['gold', 12], tool: 'bow', tier: 1 },
  { id: 'bow2', cat: 'ranged', item: 'bow2', n: 1, cost: ['gold', 24], tool: 'bow', tier: 2 },
  { id: 'bow3', cat: 'ranged', item: 'bow3', n: 1, cost: ['emerald', 6], tool: 'bow', tier: 3 },
  { id: 'arrow', cat: 'ranged', arrows: 6, name: 'Flechas x6', ic: '➶', n: 6, cost: ['gold', 2] },

  { id: 'potion_speed', cat: 'potions', item: 'potion_speed', n: 1, cost: ['emerald', 1] },
  { id: 'potion_jump', cat: 'potions', item: 'potion_jump', n: 1, cost: ['emerald', 1] },
  { id: 'potion_invis', cat: 'potions', item: 'potion_invis', n: 1, cost: ['emerald', 2] },

  { id: 'apple', cat: 'util', item: 'apple', n: 1, cost: ['gold', 3] },
  { id: 'fireball', cat: 'util', item: 'fireball', n: 1, cost: ['iron', 40] },
  { id: 'tnt', cat: 'util', item: 'tnt', n: 1, cost: ['gold', 4] },
  { id: 'pearl', cat: 'util', item: 'pearl', n: 1, cost: ['emerald', 4] },
  { id: 'egg', cat: 'util', item: 'egg', n: 1, cost: ['emerald', 1] },
  { id: 'water', cat: 'util', item: 'water', n: 1, cost: ['gold', 3] },
  { id: 'milk', cat: 'util', item: 'milk', n: 1, cost: ['gold', 4] },
  { id: 'sponge', cat: 'util', item: 'sponge', n: 1, cost: ['gold', 3] },
  { id: 'tower', cat: 'util', item: 'tower', n: 1, cost: ['iron', 24] },
  { id: 'bedbug', cat: 'util', item: 'bedbug', n: 1, cost: ['iron', 30] },
  { id: 'golem', cat: 'util', item: 'golem', n: 1, cost: ['iron', 120] },
];
const BW_SHOP_BY_ID = {};
BW_SHOP.forEach((e) => { BW_SHOP_BY_ID[e.id] = e; });

// Melhorias do time (pagas em diamantes por quem estiver mais perto da lojinha
// de melhorias). Em times de 3+ jogadores os preços sobem, como no BedWars original.
function bwUpgradeDefs(teamSize) {
  const big = teamSize >= 3;
  return [
    { id: 'sharp', name: 'Espadas Afiadas', ic: '🗡️', desc: 'Todo o time causa +25% de dano.', costs: big ? [8] : [4] },
    { id: 'prot', name: 'Armadura Reforçada', ic: '🛡️', desc: 'Todo o time leva menos dano (I a IV).', costs: big ? [5, 10, 20, 30] : [2, 4, 8, 16] },
    { id: 'haste', name: 'Mineiro Maníaco', ic: '⛏️', desc: 'Todo o time quebra blocos mais rápido.', costs: big ? [4, 6] : [2, 4] },
    { id: 'forge', name: 'Forja', ic: '🔥', desc: 'Geradores da sua ilha mais rápidos. Nível III libera esmeraldas!', costs: big ? [4, 8, 12, 16] : [2, 4, 6, 8] },
    { id: 'heal', name: 'Piscina de Cura', ic: '❤️', desc: 'Aliados perto da base se curam devagar.', costs: big ? [3] : [1] },
    { id: 'dragon', name: 'Buff do Dragão', ic: '🐉', desc: 'Seu time ganha 2 dragões na Morte Súbita.', costs: [5] },
  ];
}
const BW_TRAP_COSTS = [1, 2, 4];
const BW_TRAPS = [
  { id: 'trap', name: 'É uma Armadilha!', ic: '🪤', desc: 'Cega e deixa lento o invasor por 8s.' },
  { id: 'counter', name: 'Contra-Ataque', ic: '💨', desc: 'Aliados perto da base ganham Velocidade e Pulo.' },
  { id: 'alarm', name: 'Alarme', ic: '🔔', desc: 'Revela invasores invisíveis e avisa o time.' },
  { id: 'fatigue', name: 'Fadiga de Mineração', ic: '🐌', desc: 'O invasor quebra blocos bem mais devagar por 10s.' },
];

// Linha do tempo da partida (em segundos desde o início).
const BW_EVENTS = [
  { t: 300, id: 'd2', name: 'Diamante II' },
  { t: 600, id: 'e2', name: 'Esmeralda II' },
  { t: 900, id: 'd3', name: 'Diamante III' },
  { t: 1200, id: 'e3', name: 'Esmeralda III' },
  { t: 1500, id: 'bed', name: 'Camas destruídas' },
  { t: 1800, id: 'sd', name: 'Morte Súbita' },
  { t: 2400, id: 'end', name: 'Fim de jogo' },
];

// ---------- Inventário (autoritativo no servidor) ----------
function bwZeroRes() { return { iron: 0, gold: 0, diamond: 0, emerald: 0 }; }
function bwGive(p, id, n) {
  const def = BW_ITEMS[id];
  if (!def) return false;
  if (def.stack) {
    for (const s of p.slots) { if (s && s.id === id) { s.n += n; return true; } }
    const i = p.slots.findIndex((s) => !s);
    if (i < 0) return false;
    p.slots[i] = { id, n };
    return true;
  }
  // Item único: se já existe um do mesmo grupo (espada/picareta/machado/arco), ele é substituído.
  if (def.grp) {
    const j = p.slots.findIndex((s) => s && BW_ITEMS[s.id] && BW_ITEMS[s.id].grp === def.grp);
    if (j >= 0) { p.slots[j] = { id, n: 1 }; bwNoteTool(p, id); return true; }
  }
  const i = p.slots.findIndex((s) => !s);
  if (i < 0) return false;
  p.slots[i] = { id, n: 1 };
  bwNoteTool(p, id);
  return true;
}
function bwNoteTool(p, id) {
  const def = BW_ITEMS[id];
  if (!def) return;
  if (def.kind === 'pick') p.pick = parseInt(id.slice(4), 10);
  else if (def.kind === 'axe') p.axe = parseInt(id.slice(3), 10);
  else if (id === 'shears') p.shears = true;
}
function bwSwordTier(p) {
  let best = 0;
  for (const s of p.slots) {
    if (s && s.id.indexOf('sword') === 0) best = Math.max(best, parseInt(s.id.slice(5), 10));
  }
  return best;
}
function bwTakeSlot(p, idx, n) {
  const s = p.slots[idx];
  if (!s) return false;
  s.n -= (n || 1);
  if (s.n <= 0) p.slots[idx] = null;
  return true;
}
// Ao morrer: perde tudo, exceto armadura, tesoura e ferramentas (que descem 1 nível).
function bwResetKit(p) {
  const keepShears = p.shears;
  const pick = p.pick > 0 ? Math.max(1, p.pick - 1) : 0;
  const axe = p.axe > 0 ? Math.max(1, p.axe - 1) : 0;
  p.slots = new Array(BW_SLOTS).fill(null);
  p.pick = 0; p.axe = 0; p.shears = false; p.arrows = 0;
  bwGive(p, 'sword1', 1);
  if (pick) bwGive(p, 'pick' + pick, 1);
  if (axe) bwGive(p, 'axe' + axe, 1);
  if (keepShears) bwGive(p, 'shears', 1);
  p.sel = 0;
}

// =====================================================================
// BEDWARS — partida (servidor autoritativo)
// =====================================================================
const BW_TICK_MS = 50;
const BW_REACH = 7.5;               // alcance máximo aceito (o cliente usa menos, isso é folga pra lag)
const BW_RESPAWN_SEC = 5;
const BW_SPAWN_PROT_MS = 3000;
const BW_HURT_CD_MS = 450;          // "invulnerabilidade" curta entre um golpe e outro (igual Minecraft)
const BW_FORGE_SPEED = [1, 1.5, 2, 2, 3];
const BW_ARMOR_MULT = [0.72, 0.64, 0.56, 0.48];   // couro, malha, ferro, diamante

function bwBroadcast(state, room, obj, exceptId) {
  const s = JSON.stringify(obj);
  for (const p of room.players) {
    if (p.id === exceptId) continue;
    const c = state.clients.get(p.id);
    if (c && c.ws.readyState === WebSocket.OPEN) c.ws.send(s);
  }
  if (room.watchers && room.watchers.length) watchMirrorRaw(state, room, s);
}
function bwBroadcastTeam(state, room, ti, obj) {
  const s = JSON.stringify(obj);
  for (const p of room.players) {
    if (p.ti !== ti) continue;
    const c = state.clients.get(p.id);
    if (c && c.ws.readyState === WebSocket.OPEN) c.ws.send(s);
  }
}
function bwPN(p) { return [p.name, BW_TEAM_DEFS[p.ti].css]; }
function bwFeed(state, room, parts) { bwBroadcast(state, room, { type: 'bwMsg', parts }); }
function bwTitle(state, room, target, title, sub, color, snd) {
  const msg = { type: 'bwTitle', t: title, sub: sub || '', c: color || '#ffffff', snd: snd || '' };
  if (typeof target === 'number') bwBroadcastTeam(state, room, target, msg);
  else if (target === null) bwBroadcast(state, room, msg);
  else send(state, target.id, msg);
}

// ---------- Criação da partida ----------
function bwCreateGame(state, room, mapId) {
  const cfg = BW_MAPS[mapId];
  const teamKeys = [];
  room.players.forEach((p) => { if (!teamKeys.includes(p.team)) teamKeys.push(p.team); });
  const gen = bwGenerateMap(cfg, teamKeys.length);
  const teamSize = BEDWARS_MODES[room.mode].teamSize;
  const bw = {
    mapId, cfg, w: gen.w, phase: 'starting', startLeft: 6, secAcc: 0, halfAcc: 0, t: 0, nextId: 1,
    teams: [], gens: [], shops: [], projs: [], mobs: [], tnts: [], water: [], blockQ: [], dirtyGens: new Set(),
    tierD: 1, tierE: 1, evIdx: 0, sudden: false, ended: false, teamSize, rle: null, mobPosAcc: 0,
  };
  gen.teams.forEach((gt, i) => {
    const team = {
      idx: i, def: BW_TEAM_DEFS[i], cx: gt.cx, cz: gt.cz, spawn: gt.spawn, shop: gt.shop, upg: gt.upg,
      bed: { alive: true, cells: gt.bed }, players: [],
      up: { sharp: 0, prot: 0, haste: 0, forge: 0, heal: 0, dragon: 0, traps: [] },
      trapCd: 0, eliminated: false,
    };
    bw.teams.push(team);
    bw.gens.push({ id: bw.nextId++, kind: 'iron', team: i, x: gt.ironPos.x, y: gt.ironPos.y, z: gt.ironPos.z, n: 0, acc: 0, cap: 48, active: true });
    bw.gens.push({ id: bw.nextId++, kind: 'gold', team: i, x: gt.goldPos.x, y: gt.goldPos.y, z: gt.goldPos.z, n: 0, acc: 0, cap: 16, active: true });
    // Esmeralda da forja (nível III+): começa desligada.
    bw.gens.push({ id: bw.nextId++, kind: 'emerald', forge: true, team: i, x: gt.cx + 0.5, y: gt.ironPos.y, z: gt.cz + 0.5, n: 0, acc: 0, cap: 4, active: false });
    bw.shops.push({ kind: 'item', x: gt.shop.x, y: gt.shop.y, z: gt.shop.z, team: i });
    bw.shops.push({ kind: 'upg', x: gt.upg.x, y: gt.upg.y, z: gt.upg.z, team: i });
  });
  gen.gens.forEach((g) => {
    bw.gens.push({ id: bw.nextId++, kind: g.kind, team: -1, x: g.x, y: g.y, z: g.z, n: 0, acc: 0, cap: g.kind === 'diamond' ? 6 : 4, active: true });
  });
  room.players.forEach((p) => bwInitPlayer(state, bw, p));
  room.bw = bw;
  bw.rle = bwRle(bw.w.g);
  return bw;
}

function bwInitPlayer(state, bw, p) {
  const c = state.clients.get(p.id);
  p.name = (c && c.name) || ('User ' + p.id);
  p.ti = parseInt(p.team.slice(2), 10);
  const team = bw.teams[p.ti];
  team.players.push(p);
  p.res = bwZeroRes(); p.slots = new Array(BW_SLOTS).fill(null); p.sel = 0; p.arrows = 0;
  p.armor = 0; p.pick = 0; p.axe = 0; p.shears = false; p.absorb = 0; p.eff = {};
  p.x = team.spawn.x; p.y = team.spawn.y; p.z = team.spawn.z; p.yaw = team.spawn.yaw; p.pitch = 0;
  p.eliminated = false; p.left = false; p.respawnAt = 0; p.invulUntil = 0; p.hurtUntil = 0; p.lastHit = null;
  p.kills = 0; p.finals = 0; p.beds = 0; p.deaths = 0; p.regenAcc = 0; p.healAcc = 0; p.invisSent = false;
  p.alive = true; p.hp = 20;
  bwGive(p, 'sword1', 1);
}

// Tudo que o cliente precisa saber pra montar o mapa (mandado junto do "matched").
function bwInitPayload(state, room, bw) {
  const cfg = bw.cfg;
  return {
    mapId: bw.mapId, name: cfg.name, sky: cfg.sky, fog: cfg.fog, teamSize: bw.teamSize,
    world: { w: BW_W, h: BW_H, d: BW_D, rle: bw.rle },
    teams: bw.teams.map((t) => ({
      idx: t.idx, name: t.def.name, css: t.def.css, hex: t.def.hex,
      spawn: t.spawn, shop: t.shop, upg: t.upg, bed: t.bed.cells,
      players: t.players.map((p) => ({ id: p.id, name: p.name, admin: isAdminClient(state.clients.get(p.id)) })),
    })),
    gens: bw.gens.map((g) => ({ id: g.id, kind: g.kind, team: g.team, x: g.x, y: g.y, z: g.z, cap: g.cap, forge: !!g.forge })),
    items: BW_ITEMS, cats: BW_SHOP_CATS, shop: BW_SHOP, upgrades: bwUpgradeDefs(bw.teamSize),
    traps: BW_TRAPS, trapCosts: BW_TRAP_COSTS, events: BW_EVENTS, startIn: bw.startLeft,
  };
}

// ---------- Inventário / equipamento ----------
function bwSyncInv(state, p) {
  const room = state.rooms.get((state.clients.get(p.id) || {}).room);
  const bw = room && room.bw;
  const team = bw ? bw.teams[p.ti] : null;
  send(state, p.id, {
    type: 'bwInv',
    slots: p.slots.map((s) => (s ? [s.id, s.n] : 0)),
    sel: p.sel, res: p.res, arrows: p.arrows, armor: p.armor,
    pick: p.pick, axe: p.axe, shears: p.shears ? 1 : 0, sword: bwSwordTier(p),
    up: team ? team.up : null,
  });
}
function bwSyncTeamInv(state, room, ti) {
  for (const p of room.players) if (p.ti === ti) bwSyncInv(state, p);
}
function bwSendEquip(state, room, p) {
  const s = p.slots[p.sel];
  bwBroadcast(state, room, { type: 'bwEquip', id: p.id, armor: p.armor, held: s ? s.id : '', invis: (p.eff.invis || 0) > Date.now() ? 1 : 0 });
}
function bwSendEff(state, p) {
  const now = Date.now(), e = {};
  for (const k of Object.keys(p.eff)) e[k] = Math.max(0, Math.round((p.eff[k] - now) / 100) / 10);
  send(state, p.id, { type: 'bwEff', eff: e });
}
function bwToast(state, p, text, color) {
  send(state, p.id, { type: 'bwToast', text, c: color || '#ff6b6b' });
}

// ---------- Blocos ----------
function bwSetBlock(bw, x, y, z, id, placed) {
  if (!bwInB(x, y, z)) return;
  const i = bwIdx(x, y, z);
  bw.w.g[i] = id;
  bw.w.placed[i] = placed ? 1 : 0;
  bw.blockQ.push([x, y, z, id]);
}
function bwFlushBlocks(state, room) {
  const bw = room.bw;
  if (!bw.blockQ.length) return;
  for (let i = 0; i < bw.blockQ.length; i += 300) {
    bwBroadcast(state, room, { type: 'bwBlocks', list: bw.blockQ.slice(i, i + 300) });
  }
  bw.blockQ = [];
}
function bwCellSolid(bw, x, y, z) { return bwIsSolid(bwGet(bw.w, Math.floor(x), Math.floor(y), Math.floor(z))); }
// Caixa do jogador (0,6 x 1,8) livre de blocos sólidos?
function bwBoxFree(bw, x, y, z) {
  for (let yy = Math.floor(y + 0.01); yy <= Math.floor(y + 1.79); yy++) {
    for (let xx = Math.floor(x - 0.3); xx <= Math.floor(x + 0.3); xx++) {
      for (let zz = Math.floor(z - 0.3); zz <= Math.floor(z + 0.3); zz++) {
        if (bwIsSolid(bwGet(bw.w, xx, yy, zz))) return false;
      }
    }
  }
  return true;
}
function bwSafeSpot(bw, x, y, z) {
  const tries = [[0, 0, 0], [0, 1, 0], [0, 2, 0], [0.7, 0, 0], [-0.7, 0, 0], [0, 0, 0.7], [0, 0, -0.7], [0.7, 1, 0], [-0.7, 1, 0], [0, 1, 0.7], [0, 1, -0.7]];
  for (const t of tries) if (bwBoxFree(bw, x + t[0], y + t[1], z + t[2])) return { x: x + t[0], y: y + t[1], z: z + t[2] };
  return { x, y: y + 1, z };
}
function bwOverlapsPlayer(room, x, y, z) {
  for (const q of room.players) {
    if (!q.alive || q.eliminated) continue;
    if (q.x + 0.28 > x && q.x - 0.28 < x + 1 && q.z + 0.28 > z && q.z - 0.28 < z + 1 && q.y + 1.75 > y && q.y + 0.05 < y + 1) return true;
  }
  return false;
}
function bwReachOK(p, x, y, z, max) {
  return Math.hypot(x + 0.5 - p.x, y + 0.5 - (p.y + 1.6), z + 0.5 - p.z) <= max;
}
function bwHasSolidNeighbor(bw, x, y, z) {
  return bwIsSolid(bwGet(bw.w, x + 1, y, z)) || bwIsSolid(bwGet(bw.w, x - 1, y, z)) ||
    bwIsSolid(bwGet(bw.w, x, y + 1, z)) || bwIsSolid(bwGet(bw.w, x, y - 1, z)) ||
    bwIsSolid(bwGet(bw.w, x, y, z + 1)) || bwIsSolid(bwGet(bw.w, x, y, z - 1));
}

// ---------- Dano, morte, cama, fim ----------
function bwArmorMult(bw, victim) {
  const team = bw.teams[victim.ti];
  return BW_ARMOR_MULT[victim.armor] * (1 - 0.1 * team.up.prot);
}

function bwDamage(state, room, victim, dmg, opts) {
  const bw = room.bw;
  if (!victim.alive || victim.eliminated || bw.phase !== 'playing') return false;
  const now = Date.now();
  if (victim.invulUntil > now) return false;
  let d = dmg;
  if (opts.armor !== false) d = Math.max(1, Math.round(d * bwArmorMult(bw, victim)));
  else d = Math.max(1, Math.round(d));
  if (victim.absorb > 0) { const a = Math.min(victim.absorb, d); victim.absorb -= a; d -= a; }
  victim.hp = Math.max(0, victim.hp - d);
  victim.regenAcc = 0;
  const by = opts.by || null;
  if (by && by.id !== victim.id) victim.lastHit = { by: by.id, t: now, cause: opts.cause };
  send(state, victim.id, { type: 'bwHit', hp: victim.hp, absorb: victim.absorb, dx: opts.dx || 0, dz: opts.dz || 0, kb: opts.kb || 0, cause: opts.cause || '' });
  for (const q of room.players) {
    if (q.id === victim.id) continue;
    if (by && q.id === by.id) send(state, q.id, { type: 'opponentHp', oppId: victim.id, hp: victim.hp });
    else send(state, q.id, { type: 'hitFx', targetId: victim.id, hp: victim.hp });
  }
  if (victim.hp <= 0) bwKill(state, room, victim, opts.cause || 'melee', by);
  return true;
}

function bwKill(state, room, victim, cause, killerHint) {
  const bw = room.bw;
  if (!victim.alive || victim.eliminated) return;
  const now = Date.now();
  const team = bw.teams[victim.ti];
  // Quem ganha o abate: o autor direto, ou quem bateu nele nos últimos 10s (queda no vazio etc.).
  let killer = killerHint && killerHint.id !== victim.id ? killerHint : null;
  if (!killer && victim.lastHit && now - victim.lastHit.t < 10000) {
    killer = room.players.find((q) => q.id === victim.lastHit.by) || null;
  }
  if (killer && killer.ti === victim.ti) killer = null;

  victim.alive = false; victim.hp = 0; victim.absorb = 0; victim.deaths++;
  const final = !team.bed.alive;
  victim.eff = {};
  victim.invisSent = false;

  // Mensagem no chat.
  const parts = [bwPN(victim)];
  const kn = killer ? bwPN(killer) : null;
  if (cause === 'void') parts.push([kn ? ' foi jogado no vazio por ' : ' caiu no vazio.', '#dddddd']);
  else if (cause === 'fall') parts.push([kn ? ' caiu de bem alto por causa de ' : ' caiu de uma altura elevada.', '#dddddd']);
  else if (cause === 'explosion') parts.push([kn ? ' foi explodido por ' : ' explodiu.', '#dddddd']);
  else if (cause === 'arrow') parts.push([kn ? ' foi flechado por ' : ' foi flechado.', '#dddddd']);
  else if (cause === 'mob') parts.push([kn ? ' foi morto por uma criatura de ' : ' foi morto por uma criatura.', '#dddddd']);
  else if (cause === 'dragon') parts.push([' foi devorado pelo dragão.', '#dddddd']);
  else parts.push([kn ? ' foi morto por ' : ' morreu.', '#dddddd']);
  if (kn && cause !== 'dragon') parts.push(kn);
  if (kn && cause !== 'dragon') parts.push(['.', '#dddddd']);
  if (final) parts.push([' ABATE FINAL!', '#ffaa00']);
  bwFeed(state, room, parts);

  // O assassino leva os recursos de quem morreu.
  if (killer && !killer.eliminated) {
    const got = [];
    for (const r of BW_RES) {
      if (victim.res[r] > 0) { killer.res[r] += victim.res[r]; got.push('+' + victim.res[r] + ' ' + BW_RES_NAME[r]); }
    }
    if (got.length) bwToast(state, killer, got.join('  '), '#7CFC7C');
    bwSyncInv(state, killer);
    if (final) killer.finals++; else killer.kills++;
  }
  victim.res = bwZeroRes();
  bwResetKit(victim);

  bwBroadcast(state, room, { type: 'bwAlive', id: victim.id, alive: false }, victim.id);
  if (final) {
    bwEliminate(state, room, victim, killer);
  } else {
    victim.respawnAt = now + BW_RESPAWN_SEC * 1000;
    send(state, victim.id, { type: 'bwDeath', respawn: BW_RESPAWN_SEC, final: false, killer: killer ? killer.name : '', cause });
    bwSyncInv(state, victim);
  }
}

function bwEliminate(state, room, p, killer) {
  const bw = room.bw;
  p.eliminated = true; p.alive = false;
  send(state, p.id, { type: 'bwDeath', respawn: 0, final: true, killer: killer ? killer.name : '' });
  send(state, p.id, { type: 'bwEliminated' });
  bwBroadcast(state, room, { type: 'bwAlive', id: p.id, alive: false }, p.id);
  const team = bw.teams[p.ti];
  if (!team.eliminated && !team.players.some((q) => !q.eliminated && !q.left)) {
    team.eliminated = true;
    bwFeed(state, room, [['ELIMINAÇÃO DE EQUIPE > ', '#ff5555'], [team.def.name, team.def.css], [' foi eliminado!', '#dddddd']]);
  }
  bwCheckWin(state, room);
}

function bwCheckWin(state, room) {
  const bw = room.bw;
  if (bw.ended) return;
  const alive = bw.teams.filter((t) => !t.eliminated);
  if (alive.length <= 1) bwEndGame(state, room, alive[0] || null);
}

function bwEndGame(state, room, winner) {
  const bw = room.bw;
  if (bw.ended) return;
  bw.ended = true; bw.phase = 'ended';
  const stats = [];
  for (const t of bw.teams) for (const p of t.players) stats.push([p.name, t.def.css, p.kills, p.finals, p.beds, p.deaths]);
  const msg = {
    type: 'matchOver', mode: room.mode, winningTeam: winner ? 'bw' + winner.idx : null, roundWins: {},
    bw: { winner: winner ? winner.idx : -1, winnerName: winner ? winner.def.name : '', css: winner ? winner.def.css : '#fff', stats },
  };
  for (const p of room.players) {
    send(state, p.id, msg);
    const c = state.clients.get(p.id);
    if (c) c.room = null;
  }
  for (const [roomId, r] of state.rooms) { if (r === room) { state.rooms.delete(roomId); break; } }
  broadcastOnline(state);
}

function bwTeamByBedCell(bw, x, y, z) {
  for (const t of bw.teams) {
    if (!t.bed.alive) continue;
    for (const c of t.bed.cells) if (c[0] === x && c[1] === y && c[2] === z) return t;
  }
  return null;
}
function bwBedBroken(state, room, team, breaker) {
  const bw = room.bw;
  if (!team.bed.alive) return;
  team.bed.alive = false;
  for (const c of team.bed.cells) bwSetBlock(bw, c[0], c[1], c[2], 0, false);
  bwFlushBlocks(state, room);
  bwBroadcast(state, room, { type: 'bwBed', ti: team.idx, alive: false, x: team.bed.cells[0][0] + 0.5, y: team.bed.cells[0][1] + 0.5, z: team.bed.cells[0][2] + 0.5 });
  const parts = [['CAMA DESTRUÍDA > ', '#ffaa00'], ['A cama do time ', '#dddddd'], [team.def.name, team.def.css]];
  if (breaker) { breaker.beds++; parts.push([' foi destruída por ', '#dddddd'], bwPN(breaker), ['!', '#dddddd']); }
  else parts.push([' foi destruída!', '#dddddd']);
  bwFeed(state, room, parts);
  bwTitle(state, room, team.idx, 'CAMA DESTRUÍDA!', 'Você não vai mais renascer!', '#ff5555', 'bed');
}

// ---------- Geradores ----------
function bwGenInterval(bw, g) {
  const team = g.team >= 0 ? bw.teams[g.team] : null;
  if (g.forge) return 45 / (team.up.forge >= 4 ? 1.5 : 1);
  if (g.kind === 'iron') return 1.7 / BW_FORGE_SPEED[team.up.forge];
  if (g.kind === 'gold') return 6.5 / BW_FORGE_SPEED[team.up.forge];
  if (g.kind === 'diamond') return [30, 22, 14][bw.tierD - 1];
  return [60, 42, 28][bw.tierE - 1];
}
function bwTickGens(state, room, dt) {
  const bw = room.bw;
  for (const g of bw.gens) {
    if (g.forge) g.active = bw.teams[g.team].up.forge >= 3;
    if (!g.active) continue;
    if (g.team >= 0 && bw.teams[g.team].eliminated) continue;
    const iv = bwGenInterval(bw, g);
    if (g.n >= g.cap) { g.acc = Math.min(g.acc, iv); continue; }
    g.acc += dt;
    if (g.acc >= iv) { g.acc -= iv; g.n++; bw.dirtyGens.add(g); }
  }
}
// Quem chega perto do gerador leva tudo que está empilhado nele. Nos geradores
// de ilha, os aliados que estiverem juntos também recebem a mesma quantia.
function bwTickPickups(state, room) {
  const bw = room.bw;
  for (const g of bw.gens) {
    if (!g.active || g.n <= 0) continue;
    let best = null, bd = 1e9;
    for (const p of room.players) {
      if (!p.alive || p.eliminated) continue;
      const d = Math.hypot(p.x - g.x, p.z - g.z);
      if (d < 1.9 && Math.abs(p.y - g.y) < 2.5 && d < bd) { best = p; bd = d; }
    }
    if (!best) continue;
    const n = g.n;
    const got = [best];
    best.res[g.kind] += n;
    if (g.team >= 0) {
      for (const q of room.players) {
        if (q === best || !q.alive || q.eliminated || q.ti !== g.team) continue;
        if (Math.hypot(q.x - g.x, q.z - g.z) < 1.9) { q.res[g.kind] += n; got.push(q); }
      }
    }
    g.n = 0;
    bw.dirtyGens.add(g);
    got.forEach((q) => bwSyncInv(state, q));
  }
}

// ---------- Jogadores: renascer, vazio, regeneração ----------
function bwRespawn(state, room, p) {
  const team = room.bw.teams[p.ti];
  p.alive = true; p.hp = 20; p.absorb = 0; p.regenAcc = 0; p.eff = {}; p.invisSent = false;
  p.x = team.spawn.x; p.y = team.spawn.y; p.z = team.spawn.z; p.yaw = team.spawn.yaw;
  p.invulUntil = Date.now() + BW_SPAWN_PROT_MS;
  send(state, p.id, { type: 'bwRespawn', x: p.x, y: p.y, z: p.z, yaw: p.yaw });
  bwBroadcast(state, room, { type: 'bwAlive', id: p.id, alive: true, x: p.x, y: p.y, z: p.z }, p.id);
  bwSyncInv(state, p);
  bwSendEquip(state, room, p);
  bwSendEff(state, p);
}
function bwTickPlayers(state, room, dt) {
  const bw = room.bw;
  const now = Date.now();
  bw.healAcc = (bw.healAcc || 0) + dt;
  const doHeal = bw.healAcc >= 2;
  if (doHeal) bw.healAcc -= 2;
  for (const p of room.players.slice()) {
    if (p.eliminated) continue;
    const team = bw.teams[p.ti];
    if (!p.alive) {
      if (now >= p.respawnAt) {
        if (!team.bed.alive) bwEliminate(state, room, p, null);
        else bwRespawn(state, room, p);
        if (bw.ended) return;
      }
      continue;
    }
    if (p.y < BW_VOID_Y) { bwKill(state, room, p, 'void', null); if (bw.ended) return; continue; }
    const invis = (p.eff.invis || 0) > now;
    if (invis !== p.invisSent) { p.invisSent = invis; bwSendEquip(state, room, p); }
    let heal = 0;
    p.regenAcc += dt;
    if (p.regenAcc >= 6) { p.regenAcc -= 6; heal += 1; }
    if ((p.eff.regen || 0) > now) {
      p.appleAcc = (p.appleAcc || 0) + dt;
      if (p.appleAcc >= 0.5) { p.appleAcc -= 0.5; heal += 1; }
    }
    if (doHeal && team.up.heal && Math.hypot(p.x - team.cx, p.z - team.cz) < 12 && Math.abs(p.y - BW_Y0) < 10) heal += 1;
    if (heal > 0 && p.hp < 20) {
      p.hp = Math.min(20, p.hp + heal);
      send(state, p.id, { type: 'bwHp', hp: p.hp, absorb: p.absorb });
    }
  }
}

// ---------- Projéteis ----------
const BW_PROJ = {
  fireball: { grav: 0, life: 5 },
  pearl: { grav: 20, life: 6 },
  egg: { grav: 7, life: 3.2 },
  arrow: { grav: 13, life: 6 },
};
function bwAddProj(state, room, kind, owner, x, y, z, dx, dy, dz, speed, extra) {
  const bw = room.bw;
  const len = Math.hypot(dx, dy, dz) || 1;
  const cfg = BW_PROJ[kind];
  const pr = Object.assign({
    id: bw.nextId++, kind, owner: owner.id, ti: owner.ti,
    x: x + dx / len * 0.7, y: y + dy / len * 0.7, z: z + dz / len * 0.7,
    vx: dx / len * speed, vy: dy / len * speed, vz: dz / len * speed, grav: cfg.grav, life: cfg.life, age: 0,
  }, extra || {});
  bw.projs.push(pr);
  bwBroadcast(state, room, { type: 'bwProjAdd', id: pr.id, k: kind, x: pr.x, y: pr.y, z: pr.z, vx: pr.vx, vy: pr.vy, vz: pr.vz, ti: owner.ti });
}
function bwProjPlayerHit(room, pr) {
  for (const p of room.players) {
    if (!p.alive || p.eliminated) continue;
    if (pr.kind === 'arrow' && p.ti === pr.ti) continue;
    if (pr.kind === 'fireball' && p.id === pr.owner && pr.age < 0.35) continue;
    if (Math.abs(pr.x - p.x) < 0.55 && Math.abs(pr.z - p.z) < 0.55 && pr.y > p.y - 0.15 && pr.y < p.y + 1.95) return p;
  }
  return null;
}
function bwEggTrail(state, room, pr) {
  const bw = room.bw;
  const x = Math.floor(pr.x), y = Math.floor(pr.y) - 1, z = Math.floor(pr.z);
  if (y < BW_MIN_BUILD_Y || y > BW_MAX_BUILD_Y) return;
  if (bwGet(bw.w, x, y, z) === 0 && !bwOverlapsPlayer(room, x, y, z)) bwSetBlock(bw, x, y, z, BLK.WOOL + pr.ti, true);
}
function bwProjImpact(state, room, pr, hitP) {
  const bw = room.bw;
  const owner = room.players.find((q) => q.id === pr.owner) || null;
  if (pr.kind === 'arrow') {
    if (hitP && owner) {
      const len = Math.hypot(pr.vx, pr.vz) || 1;
      const dmg = (2 + 7 * pr.charge) * (1 + 0.25 * pr.power);
      bwDamage(state, room, hitP, dmg, { by: owner, dx: pr.vx / len, dz: pr.vz / len, kb: 1 + (pr.punch ? 1.2 : 0), cause: 'arrow' });
    }
  } else if (pr.kind === 'fireball') {
    bwExplode(state, room, pr.x, pr.y, pr.z, 2.6, owner, 'fireball');
  } else if (pr.kind === 'pearl') {
    if (owner && owner.alive && !owner.eliminated) {
      const sp = bwSafeSpot(bw, pr.x, pr.y, pr.z);
      owner.x = sp.x; owner.y = sp.y; owner.z = sp.z;
      send(state, owner.id, { type: 'bwTp', x: sp.x, y: sp.y, z: sp.z });
      bwBroadcast(state, room, { type: 'bwFx', k: 'pearl', x: sp.x, y: sp.y + 1, z: sp.z, r: 1 });
      bwDamage(state, room, owner, 5, { cause: 'fall', armor: false });
    }
  }
}
function bwTickProjs(state, room, dt) {
  const bw = room.bw;
  if (!bw.projs.length) return;
  const keep = [], posList = [];
  for (const pr of bw.projs) {
    pr.life -= dt; pr.age += dt;
    let dead = pr.life <= 0;
    const steps = 2, h = dt / steps;
    for (let s = 0; s < steps && !dead; s++) {
      pr.vy -= pr.grav * h;
      const nx = pr.x + pr.vx * h, ny = pr.y + pr.vy * h, nz = pr.z + pr.vz * h;
      if (ny < 0 || nx < 0 || nx >= BW_W || nz < 0 || nz >= BW_D) { dead = true; break; }
      if (bwIsSolid(bwGet(bw.w, Math.floor(nx), Math.floor(ny), Math.floor(nz)))) { bwProjImpact(state, room, pr, null); dead = true; break; }
      pr.x = nx; pr.y = ny; pr.z = nz;
      if (pr.kind === 'egg') bwEggTrail(state, room, pr);
      if (pr.kind === 'arrow' || pr.kind === 'fireball') {
        const hit = bwProjPlayerHit(room, pr);
        if (hit) { bwProjImpact(state, room, pr, hit); dead = true; break; }
      }
    }
    if (bw.ended) return;
    if (dead) { bwBroadcast(state, room, { type: 'bwProjDel', id: pr.id }); continue; }
    keep.push(pr);
    posList.push([pr.id, +pr.x.toFixed(2), +pr.y.toFixed(2), +pr.z.toFixed(2)]);
  }
  bw.projs = keep;
  if (posList.length) bwBroadcast(state, room, { type: 'bwProjPos', list: posList });
}

// ---------- Explosões / TNT ----------
function bwExplode(state, room, x, y, z, power, owner, cause) {
  const bw = room.bw;
  const r = Math.ceil(power);
  for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > power) continue;
    const bx = Math.floor(x) + dx, by = Math.floor(y) + dy, bz = Math.floor(z) + dz;
    if (!bwInB(bx, by, bz)) continue;
    const i = bwIdx(bx, by, bz);
    const id = bw.w.g[i];
    if (id === 0 || !bw.w.placed[i] || BW_BLASTPROOF.has(id)) continue;
    if (id >= BLK.CLAY && id < BLK.CLAY + 8 && d > power * 0.6) continue; // argila aguenta mais
    bwSetBlock(bw, bx, by, bz, 0, false);
  }
  bwFlushBlocks(state, room);
  const dmgR = power * 1.9;
  const maxDmg = cause === 'tnt' ? 14 : 9;
  for (const p of room.players.slice()) {
    if (!p.alive || p.eliminated) continue;
    const dx = p.x - x, dy = (p.y + 0.9) - y, dz = p.z - z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > dmgR) continue;
    const f = 1 - d / dmgR;
    const len = d || 1;
    const dirx = dx / len, diry = dy / len, dirz = dz / len;
    const mag = 14 * f + 3;
    send(state, p.id, { type: 'bwKnock', vx: dirx * mag, vy: Math.max(3, diry * mag + 5 * f), vz: dirz * mag });
    let dmg = f * maxDmg;
    if (owner && p.ti === owner.ti) dmg *= 0.5;
    if (dmg >= 1) {
      bwDamage(state, room, p, dmg, { by: owner, dx: dirx, dz: dirz, kb: 0, cause: 'explosion' });
      if (bw.ended) return;
    }
  }
  for (const t of bw.tnts) if (Math.hypot(t.x - x, t.y - y, t.z - z) < power * 1.5) t.fuse = Math.min(t.fuse, 0.2);
  bwBroadcast(state, room, { type: 'bwFx', k: 'boom', x, y, z, r: power });
}
function bwAddTnt(state, room, owner, x, y, z) {
  const bw = room.bw;
  const t = { id: bw.nextId++, x: x + 0.5, y: y + 0.5, z: z + 0.5, fuse: 3.2, owner: owner.id, ti: owner.ti };
  bw.tnts.push(t);
  bwBroadcast(state, room, { type: 'bwTntAdd', id: t.id, x: t.x, y: t.y, z: t.z, fuse: t.fuse });
}
function bwTickTnt(state, room, dt) {
  const bw = room.bw;
  if (!bw.tnts.length) return;
  const boom = [], keep = [];
  for (const t of bw.tnts) { t.fuse -= dt; if (t.fuse <= 0) boom.push(t); else keep.push(t); }
  bw.tnts = keep;
  for (const t of boom) {
    bwBroadcast(state, room, { type: 'bwTntDel', id: t.id });
    const owner = room.players.find((q) => q.id === t.owner) || null;
    bwExplode(state, room, t.x, t.y, t.z, 3.6, owner, 'tnt');
    if (bw.ended) return;
  }
}

// ---------- Água (balde) e torre ----------
function bwPlaceWater(state, room, x, y, z) {
  const bw = room.bw;
  const until = Date.now() + 12000;
  [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dz]) => {
    if (bwGet(bw.w, x + dx, y, z + dz) === 0) {
      bwSetBlock(bw, x + dx, y, z + dz, BLK.WATER, false);
      bw.water.push({ x: x + dx, y, z: z + dz, until });
    }
  });
}
function bwTickWater(state, room) {
  const bw = room.bw;
  if (!bw.water.length) return;
  const now = Date.now();
  bw.water = bw.water.filter((w) => {
    if (w.until > now) return true;
    if (bwGet(bw.w, w.x, w.y, w.z) === BLK.WATER) bwSetBlock(bw, w.x, w.y, w.z, 0, false);
    return false;
  });
}
function bwSponge(state, room, x, y, z) {
  const bw = room.bw;
  for (let dx = -4; dx <= 4; dx++) for (let dy = -4; dy <= 4; dy++) for (let dz = -4; dz <= 4; dz++) {
    if (bwGet(bw.w, x + dx, y + dy, z + dz) === BLK.WATER) bwSetBlock(bw, x + dx, y + dy, z + dz, 0, false);
  }
}
// Torre em espiral de lã: um degrau a cada bloco de altura, subindo em volta de um buraco no meio.
function bwBuildTower(state, room, p, x, y, z) {
  const bw = room.bw;
  const ring = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
  for (let i = 0; i < 8; i++) {
    for (let h = 0; h <= i; h++) {
      const bx = x + ring[i][0], by = y + h, bz = z + ring[i][1];
      if (by > BW_MAX_BUILD_Y || by < BW_MIN_BUILD_Y) continue;
      const cur = bwGet(bw.w, bx, by, bz);
      if (cur !== 0 && cur !== BLK.WATER) continue;
      if (bwOverlapsPlayer(room, bx, by, bz)) continue;
      bwSetBlock(bw, bx, by, bz, BLK.WOOL + p.ti, true);
    }
  }
}

// ---------- Criaturas (traça, golem, dragão) ----------
const BW_MOB = {
  silverfish: { hp: 8, speed: 4.6, dmg: 3, life: 18, range: 18, size: 0.4, cd: 0.9 },
  golem: { hp: 40, speed: 3.6, dmg: 7, life: 150, range: 13, size: 0.7, cd: 1.1 },
  dragon: { hp: 999, speed: 8.5, dmg: 6, life: 99999, range: 999, size: 2.5, cd: 0.9 },
};
function bwSpawnMob(state, room, kind, owner, x, y, z) {
  const bw = room.bw;
  const cfg = BW_MOB[kind];
  const m = { id: bw.nextId++, kind, ti: owner.ti, owner: owner.id, x, y, z, vy: 0, onGround: false, hp: cfg.hp, life: cfg.life, atk: 0.6, tgt: 0, tgtAcc: 0, yaw: 0, ang: Math.random() * 6.28, blockAcc: 0 };
  bw.mobs.push(m);
  bwBroadcast(state, room, { type: 'bwMobAdd', id: m.id, k: kind, ti: m.ti, x, y, z });
  return m;
}
function bwMobBlocked(bw, x, y, z, hgt) {
  const fx = Math.floor(x), fz = Math.floor(z);
  for (let i = 0; i < hgt; i++) if (bwIsSolid(bwGet(bw.w, fx, Math.floor(y + 0.05) + i, fz))) return true;
  return false;
}
function bwMobTarget(room, m, cfg) {
  let best = 0, bd = cfg.range;
  for (const p of room.players) {
    if (!p.alive || p.eliminated || p.ti === m.ti) continue;
    const d = Math.hypot(p.x - m.x, p.z - m.z);
    if (d < bd) { bd = d; best = p.id; }
  }
  return best;
}
function bwGroundMobMove(state, room, m, cfg, t, dt) {
  const bw = room.bw;
  let mx = 0, mz = 0;
  if (t) {
    const dx = t.x - m.x, dz = t.z - m.z, d = Math.hypot(dx, dz) || 1;
    if (d > 0.9) { mx = dx / d; mz = dz / d; }
    m.yaw = Math.atan2(-dx, -dz);
  }
  const hgt = m.kind === 'golem' ? 3 : 1;
  const step = cfg.speed * dt;
  const nx = m.x + mx * step;
  if (!bwMobBlocked(bw, nx, m.y, m.z, hgt)) m.x = nx; else if (m.onGround) m.vy = 6.6;
  const nz = m.z + mz * step;
  if (!bwMobBlocked(bw, m.x, m.y, nz, hgt)) m.z = nz; else if (m.onGround) m.vy = 6.6;
  m.vy -= 18 * dt;
  const ny = m.y + m.vy * dt;
  if (m.vy <= 0) {
    if (bwIsSolid(bwGet(bw.w, Math.floor(m.x), Math.floor(ny), Math.floor(m.z)))) { m.y = Math.floor(ny) + 1; m.vy = 0; m.onGround = true; }
    else { m.y = ny; m.onGround = false; }
  } else {
    if (bwIsSolid(bwGet(bw.w, Math.floor(m.x), Math.floor(ny + hgt), Math.floor(m.z)))) m.vy = 0; else m.y = ny;
    m.onGround = false;
  }
  if (m.y < 2) m.life = 0;
  if (t && m.atk <= 0 && Math.hypot(t.x - m.x, t.z - m.z) < cfg.size + 1.1 && Math.abs(t.y - m.y) < 2.2) {
    m.atk = cfg.cd;
    const owner = room.players.find((q) => q.id === m.owner) || null;
    const dx = t.x - m.x, dz = t.z - m.z, d = Math.hypot(dx, dz) || 1;
    bwDamage(state, room, t, cfg.dmg, { by: owner, dx: dx / d, dz: dz / d, kb: 1.2, cause: 'mob' });
  }
}
function bwDragonMove(state, room, m, cfg, t, dt) {
  const bw = room.bw;
  let tx, ty, tz;
  if (t) { tx = t.x; ty = t.y + 1.5; tz = t.z; }
  else { m.ang += dt * 0.5; tx = BW_CX + Math.cos(m.ang) * 32; tz = BW_CZ + Math.sin(m.ang) * 32; ty = BW_Y0 + 10; }
  const dx = tx - m.x, dy = ty - m.y, dz = tz - m.z, d = Math.hypot(dx, dy, dz) || 1;
  const sp = Math.min(d, cfg.speed * dt);
  m.x += dx / d * sp; m.y += dy / d * sp; m.z += dz / d * sp;
  m.yaw = Math.atan2(-dx, -dz);
  m.blockAcc += dt;
  if (m.blockAcc >= 0.35) {
    m.blockAcc = 0;
    const cx = Math.floor(m.x), cy = Math.floor(m.y), cz = Math.floor(m.z);
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) for (let c = -2; c <= 2; c++) {
      if (a * a + b * b + c * c > 5) continue;
      const bx = cx + a, by = cy + b, bz = cz + c;
      if (!bwInB(bx, by, bz)) continue;
      const i = bwIdx(bx, by, bz), id = bw.w.g[i];
      if (id && bw.w.placed[i] && !BW_BLASTPROOF.has(id)) bwSetBlock(bw, bx, by, bz, 0, false);
    }
  }
  if (t && d < 3.4 && m.atk <= 0) {
    m.atk = cfg.cd;
    bwDamage(state, room, t, cfg.dmg, { cause: 'dragon', dx: dx / d, dz: dz / d, kb: 1.6 });
  }
}
function bwTickMobs(state, room, dt) {
  const bw = room.bw;
  if (!bw.mobs.length) return;
  const keep = [];
  for (const m of bw.mobs) {
    const cfg = BW_MOB[m.kind];
    m.life -= dt;
    if (m.life <= 0 || m.hp <= 0) { bwBroadcast(state, room, { type: 'bwMobDel', id: m.id }); continue; }
    m.atk -= dt; m.tgtAcc -= dt;
    if (m.tgtAcc <= 0) { m.tgtAcc = 0.4; m.tgt = bwMobTarget(room, m, cfg); }
    const t = m.tgt ? room.players.find((q) => q.id === m.tgt && q.alive && !q.eliminated) : null;
    if (m.kind === 'dragon') bwDragonMove(state, room, m, cfg, t, dt);
    else bwGroundMobMove(state, room, m, cfg, t, dt);
    if (bw.ended) return;
    if (m.life > 0) keep.push(m); else bwBroadcast(state, room, { type: 'bwMobDel', id: m.id });
  }
  bw.mobs = keep;
  bw.mobPosAcc += dt;
  if (bw.mobPosAcc >= 0.1 && keep.length) {
    bw.mobPosAcc = 0;
    bwBroadcast(state, room, { type: 'bwMobPos', list: keep.map((m) => [m.id, +m.x.toFixed(2), +m.y.toFixed(2), +m.z.toFixed(2), +m.yaw.toFixed(2)]) });
  }
}

// ---------- Armadilhas ----------
function bwTriggerTrap(state, room, team, trapId, intruder) {
  const now = Date.now();
  const def = BW_TRAPS.find((t) => t.id === trapId);
  bwTitle(state, room, team.idx, 'ARMADILHA ACIONADA!', def ? def.name : '', '#ff5555', 'trap');
  if (trapId === 'trap') {
    intruder.eff.slow = now + 8000; intruder.eff.blind = now + 8000;
    bwTitle(state, room, intruder, 'VOCÊ ACIONOU UMA ARMADILHA!', 'Cego e lento por 8s', '#ffaa00', 'trap');
  } else if (trapId === 'counter') {
    for (const q of room.players) {
      if (q.ti === team.idx && q.alive && Math.hypot(q.x - team.cx, q.z - team.cz) < 20) { q.eff.speed = now + 15000; q.eff.jump = now + 15000; bwSendEff(state, q); }
    }
  } else if (trapId === 'alarm') {
    intruder.eff.invis = 0;
    bwSendEquip(state, room, intruder);
    bwTitle(state, room, intruder, 'VOCÊ ACIONOU O ALARME!', 'Você foi revelado', '#ffaa00', 'trap');
  } else if (trapId === 'fatigue') {
    intruder.eff.fatigue = now + 10000;
    bwTitle(state, room, intruder, 'VOCÊ ACIONOU UMA ARMADILHA!', 'Fadiga de mineração por 10s', '#ffaa00', 'trap');
  }
  bwSendEff(state, intruder);
}
function bwTickTraps(state, room) {
  const bw = room.bw;
  const now = Date.now();
  for (const team of bw.teams) {
    if (team.eliminated || !team.up.traps.length || team.trapCd > now) continue;
    for (const p of room.players) {
      if (p.ti === team.idx || !p.alive || p.eliminated || (p.eff.milk || 0) > now) continue;
      if (Math.hypot(p.x - team.cx, p.z - team.cz) < 9 && Math.abs(p.y - BW_Y0) < 12) {
        const trap = team.up.traps.shift();
        team.trapCd = now + 15000;
        bwTriggerTrap(state, room, team, trap, p);
        bwSyncTeamInv(state, room, team.idx);
        break;
      }
    }
  }
}

// ---------- Linha do tempo ----------
function bwFireEvent(state, room, ev) {
  const bw = room.bw;
  const gold = '#ffaa00';
  if (ev.id === 'd2' || ev.id === 'd3') {
    bw.tierD = ev.id === 'd2' ? 2 : 3;
    bwFeed(state, room, [['Geradores de ', '#dddddd'], ['Diamante', '#55ffff'], [' melhorados para o nível ' + (ev.id === 'd2' ? 'II' : 'III') + '!', '#dddddd']]);
  } else if (ev.id === 'e2' || ev.id === 'e3') {
    bw.tierE = ev.id === 'e2' ? 2 : 3;
    bwFeed(state, room, [['Geradores de ', '#dddddd'], ['Esmeralda', '#55ff55'], [' melhorados para o nível ' + (ev.id === 'e2' ? 'II' : 'III') + '!', '#dddddd']]);
  } else if (ev.id === 'bed') {
    for (const t of bw.teams) if (t.bed.alive) bwBedBroken(state, room, t, null);
    bwFeed(state, room, [['TODAS AS CAMAS FORAM DESTRUÍDAS!', '#ff5555']]);
    bwTitle(state, room, null, 'CAMAS DESTRUÍDAS', 'Ninguém mais renasce!', '#ff5555', 'bed');
  } else if (ev.id === 'sd') {
    bw.sudden = true;
    bwFeed(state, room, [['MORTE SÚBITA! ', '#ff5555'], ['Dragões foram soltos no mapa!', '#dddddd']]);
    bwTitle(state, room, null, 'MORTE SÚBITA', 'Os dragões chegaram!', '#ff5555', 'dragon');
    bw.teams.forEach((t, i) => {
      if (t.eliminated) return;
      const owner = t.players.find((p) => !p.left) || t.players[0];
      if (!owner) return;
      const n = 1 + (t.up.dragon ? 1 : 0);
      for (let k = 0; k < n; k++) {
        const a = (i + k * 0.5) * 0.8 + k;
        bwSpawnMob(state, room, 'dragon', owner, BW_CX + Math.cos(a) * 34, BW_Y0 + 14, BW_CZ + Math.sin(a) * 34);
      }
    });
  } else if (ev.id === 'end') {
    bwFeed(state, room, [['O tempo acabou! A partida terminou em empate.', gold]]);
    bwEndGame(state, room, null);
  }
}

function bwSendTick(state, room) {
  const bw = room.bw;
  const ev = BW_EVENTS[bw.evIdx];
  const gens = [];
  for (const g of bw.gens) {
    if (g.team < 0) gens.push([g.id, g.kind === 'diamond' ? bw.tierD : bw.tierE, Math.max(0, Math.ceil(bwGenInterval(bw, g) - g.acc))]);
  }
  bwBroadcast(state, room, {
    type: 'bwTick', t: Math.floor(bw.t),
    ev: ev ? [ev.name, Math.max(0, Math.ceil(ev.t - bw.t))] : null,
    teams: bw.teams.map((t) => [t.bed.alive ? 1 : 0, t.players.filter((p) => !p.eliminated && !p.left).length, t.eliminated ? 1 : 0]),
    gens,
  });
}

// ---------- Loop principal ----------
function bwTickRoom(state, room) {
  const bw = room.bw;
  if (!bw || bw.ended) return;
  const dt = BW_TICK_MS / 1000;
  if (bw.phase === 'starting') {
    bw.secAcc += dt;
    if (bw.secAcc >= 1) {
      bw.secAcc -= 1;
      bw.startLeft--;
      if (bw.startLeft > 0) bwBroadcast(state, room, { type: 'bwCountdown', n: bw.startLeft });
      else {
        bw.phase = 'playing'; bw.t = 0; bw.secAcc = 0;
        bwBroadcast(state, room, { type: 'bwGo' });
        room.players.forEach((p) => { bwSyncInv(state, p); bwSendEquip(state, room, p); });
      }
    }
    return;
  }
  // Partida 100% de bots que travou (ninguém quebra a última cama por
  // algum motivo, IA presa etc.): força o fim depois de 15min pra não
  // ficar uma sala fantasma pra sempre. Só entra aqui se não tiver
  // NENHUM humano na sala — com humano, a partida corre seu curso normal.
  if (bw.t > 900 && !roomHasHuman(state, room)) { bwEndGame(state, room, null); return; }

  bw.t += dt;
  bwTickBots(state, room, dt);
  bwTickGens(state, room, dt);
  bwTickPickups(state, room);
  bwTickPlayers(state, room, dt); if (bw.ended) return;
  bwTickProjs(state, room, dt); if (bw.ended) return;
  bwTickTnt(state, room, dt); if (bw.ended) return;
  bwTickMobs(state, room, dt); if (bw.ended) return;
  bwTickWater(state, room);
  bw.halfAcc += dt;
  if (bw.halfAcc >= 0.5) { bw.halfAcc -= 0.5; bwTickTraps(state, room); }
  while (bw.evIdx < BW_EVENTS.length && bw.t >= BW_EVENTS[bw.evIdx].t) {
    const ev = BW_EVENTS[bw.evIdx++];
    bwFireEvent(state, room, ev);
    if (bw.ended) return;
  }
  bwFlushBlocks(state, room);
  if (bw.dirtyGens.size) {
    const list = [];
    for (const g of bw.dirtyGens) list.push([g.id, g.n]);
    bw.dirtyGens.clear();
    bwBroadcast(state, room, { type: 'bwGens', list });
  }
  bw.secAcc += dt;
  if (bw.secAcc >= 1) { bw.secAcc -= 1; bwSendTick(state, room); }
}
setInterval(() => {
  for (const state of virtualServers) {
    for (const room of Array.from(state.rooms.values())) {
      if (!room.bw) continue;
      try { bwTickRoom(state, room); }
      catch (e) { console.error('[bedwars] erro no tick:', e && e.stack || e); }
    }
  }
}, BW_TICK_MS);

// ---------- Lobby: votação de mapa ----------
function bwQueueMode(state, id) {
  for (const mode of Object.keys(BEDWARS_MODES)) if (state.queues[mode].includes(id)) return mode;
  return null;
}
function bwBroadcastVotes(state, mode) {
  const votes = state.bwVotes[mode];
  const q = state.queues[mode];
  const counts = {};
  for (const id of q) { const m = votes.get(id); if (m) counts[m] = (counts[m] || 0) + 1; }
  for (const id of q) send(state, id, { type: 'bwVotes', counts, mine: votes.get(id) || null });
}
function bwLobbyEnter(state, id, mode) {
  send(state, id, { type: 'bwLobby', maps: BW_MAP_LIST, mode });
  bwBroadcastVotes(state, mode);
}
function bwOnVote(state, id, msg) {
  const mode = bwQueueMode(state, id);
  if (!mode || typeof msg.map !== 'string' || !BW_MAPS[msg.map]) return;
  state.bwVotes[mode].set(id, msg.map);
  bwBroadcastVotes(state, mode);
}
// Tira os votos de quem saiu da fila; devolve os modos que mudaram.
function bwDropVotes(state, id) {
  const changed = [];
  for (const mode of Object.keys(state.bwVotes)) if (state.bwVotes[mode].delete(id)) changed.push(mode);
  return changed;
}
function bwPickMap(state, mode, ids) {
  const votes = state.bwVotes[mode];
  const counts = {};
  ids.forEach((id) => { const m = votes.get(id); if (m) counts[m] = (counts[m] || 0) + 1; });
  let best = -1, cands = [];
  for (const id of BW_MAP_IDS) {
    const c = counts[id] || 0;
    if (c > best) { best = c; cands = [id]; } else if (c === best) cands.push(id);
  }
  return cands[Math.floor(Math.random() * cands.length)];
}

// ---------- Mensagens dentro da partida ----------
function bwNum(v) { return typeof v === 'number' && isFinite(v); }
function bwRejectCell(state, bw, p, x, y, z) {
  if (bwInB(x, y, z)) send(state, p.id, { type: 'bwBlocks', list: [[x, y, z, bwGet(bw.w, x, y, z)]] });
  bwSyncInv(state, p);
}
function bwEyeFrom(p, msg) {
  let ex = p.x, ey = p.y + 1.6, ez = p.z;
  if (bwNum(msg.ex) && bwNum(msg.ey) && bwNum(msg.ez) && Math.hypot(msg.ex - p.x, msg.ey - (p.y + 1.6), msg.ez - p.z) < 4) { ex = msg.ex; ey = msg.ey; ez = msg.ez; }
  return [ex, ey, ez];
}

function bwOnState(state, room, p, msg) {
  if (!p.alive || p.eliminated || room.bw.phase !== 'playing') return;
  if (!bwNum(msg.x) || !bwNum(msg.y) || !bwNum(msg.z)) return;
  p.x = Math.max(-40, Math.min(BW_W + 40, msg.x)); p.y = Math.max(-40, Math.min(BW_H + 60, msg.y)); p.z = Math.max(-40, Math.min(BW_D + 40, msg.z));
  p.yaw = bwNum(msg.yaw) ? msg.yaw : 0; p.pitch = bwNum(msg.pitch) ? msg.pitch : 0;
  bwBroadcast(state, room, { type: 'state', id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, punching: !!msg.punching, sn: msg.sn ? 1 : 0 }, p.id);
}

function bwOnHit(state, room, att, msg) {
  const bw = room.bw;
  if (bw.phase !== 'playing' || !att.alive) return;
  const tgt = room.players.find((q) => q.id === msg.targetId);
  if (!tgt || !tgt.alive || tgt.eliminated || tgt.ti === att.ti) return;
  if (Math.hypot(tgt.x - att.x, tgt.z - att.z) > 6.5 || Math.abs(tgt.y - att.y) > 4) return;
  const now = Date.now();
  if (now < tgt.hurtUntil) return;
  const held = att.slots[att.sel];
  const def = held ? BW_ITEMS[held.id] : null;
  let base = def && def.dmg ? def.dmg : 1;
  if (def && def.kind === 'sword') base *= 1 + 0.25 * bw.teams[att.ti].up.sharp;
  const kb = def && def.kind === 'kb' ? 2.4 : 1;
  let dx = bwNum(msg.dx) ? msg.dx : tgt.x - att.x, dz = bwNum(msg.dz) ? msg.dz : tgt.z - att.z;
  tgt.hurtUntil = now + BW_HURT_CD_MS;
  bwDamage(state, room, tgt, base, { by: att, dx, dz, kb, cause: 'melee' });
}

function bwOnHitMob(state, room, p, msg) {
  const bw = room.bw;
  if (bw.phase !== 'playing' || !p.alive) return;
  const m = bw.mobs.find((q) => q.id === msg.id);
  if (!m || m.ti === p.ti || m.kind === 'dragon') return;
  if (Math.hypot(m.x - p.x, m.z - p.z) > 6.5 || Math.abs(m.y - p.y) > 5) return;
  const now = Date.now();
  if (m.hurtUntil && now < m.hurtUntil) return;
  m.hurtUntil = now + 350;
  const held = p.slots[p.sel];
  const def = held ? BW_ITEMS[held.id] : null;
  let base = def && def.dmg ? def.dmg : 1;
  if (def && def.kind === 'sword') base *= 1 + 0.25 * bw.teams[p.ti].up.sharp;
  m.hp -= base;
  const dx = m.x - p.x, dz = m.z - p.z, d = Math.hypot(dx, dz) || 1;
  m.x += dx / d * 0.5; m.z += dz / d * 0.5;
  bwBroadcast(state, room, { type: 'bwMobHit', id: m.id });
}

function bwOnSelect(state, room, p, msg) {
  const i = Math.floor(msg.slot);
  if (!(i >= 0 && i < BW_SLOTS)) return;
  p.sel = i;
  bwSendEquip(state, room, p);
}

// Tela de inventário: troca o conteúdo de dois slots quaisquer (não só a
// barra de atalho visível) pra deixar a pessoa organizar os itens que
// recebeu além dos 9 primeiros.
function bwOnSwapSlot(state, room, p, msg) {
  const a = Math.floor(msg.a), b = Math.floor(msg.b);
  if (!(a >= 0 && a < BW_SLOTS) || !(b >= 0 && b < BW_SLOTS) || a === b) return;
  const tmp = p.slots[a];
  p.slots[a] = p.slots[b];
  p.slots[b] = tmp;
  bwSyncInv(state, p);
  bwSendEquip(state, room, p);
}

function bwOnPlace(state, room, p, msg) {
  const bw = room.bw;
  if (bw.phase !== 'playing' || !p.alive) return;
  const s = p.slots[p.sel];
  if (!s) return;
  const def = BW_ITEMS[s.id];
  if (!def || def.act !== 'place') return;
  if (!Number.isInteger(msg.x) || !Number.isInteger(msg.y) || !Number.isInteger(msg.z)) return;
  const x = msg.x, y = msg.y, z = msg.z;
  if (!bwInB(x, y, z) || y < BW_MIN_BUILD_Y || y > BW_MAX_BUILD_Y || !bwReachOK(p, x, y, z, BW_REACH)) { bwRejectCell(state, bw, p, x, y, z); return; }
  if (s.id === 'sponge') {
    bwSponge(state, room, x, y, z);
    bwTakeSlot(p, p.sel, 1);
    bwFlushBlocks(state, room); bwSyncInv(state, p);
    return;
  }
  const cur = bwGet(bw.w, x, y, z);
  if ((cur !== 0 && cur !== BLK.WATER) || !bwHasSolidNeighbor(bw, x, y, z) || bwOverlapsPlayer(room, x, y, z)) { bwRejectCell(state, bw, p, x, y, z); return; }
  if (def.block !== undefined) {
    const id = def.block === 'wool' ? BLK.WOOL + p.ti : (def.block === 'clay' ? BLK.CLAY + p.ti : def.block);
    bwSetBlock(bw, x, y, z, id, true);
  } else if (s.id === 'tnt') bwAddTnt(state, room, p, x, y, z);
  else if (s.id === 'water') bwPlaceWater(state, room, x, y, z);
  else if (s.id === 'tower') bwBuildTower(state, room, p, x, y, z);
  else return;
  bwTakeSlot(p, p.sel, 1);
  bwFlushBlocks(state, room);
  bwSyncInv(state, p);
}

function bwOnBreak(state, room, p, msg) {
  const bw = room.bw;
  if (bw.phase !== 'playing' || !p.alive) return;
  if (!Number.isInteger(msg.x) || !Number.isInteger(msg.y) || !Number.isInteger(msg.z)) return;
  const x = msg.x, y = msg.y, z = msg.z;
  if (!bwInB(x, y, z) || !bwReachOK(p, x, y, z, BW_REACH)) { bwRejectCell(state, bw, p, x, y, z); return; }
  const cur = bwGet(bw.w, x, y, z);
  if (cur === 0 || cur === BLK.WATER) return;
  if (cur === BLK.BED) {
    const team = bwTeamByBedCell(bw, x, y, z);
    if (!team) return;
    if (team.idx === p.ti) { bwToast(state, p, 'Você não pode quebrar a sua própria cama!'); return; }
    bwBedBroken(state, room, team, p);
    return;
  }
  if (!bw.w.placed[bwIdx(x, y, z)]) { bwToast(state, p, 'Esse bloco faz parte do mapa e não pode ser quebrado.'); bwRejectCell(state, bw, p, x, y, z); return; }
  bwSetBlock(bw, x, y, z, 0, false);
  bwFlushBlocks(state, room);
}

function bwNearShop(bw, p, kind) {
  return bw.shops.some((s) => s.kind === kind && Math.hypot(s.x - p.x, s.z - p.z) < 8 && Math.abs(s.y - p.y) < 4);
}
function bwBowTier(p) {
  for (const s of p.slots) if (s && s.id.indexOf('bow') === 0) return parseInt(s.id.slice(3), 10);
  return 0;
}
function bwOnBuy(state, room, p, msg) {
  const bw = room.bw;
  if (bw.phase !== 'playing' || !p.alive) return;
  const e = BW_SHOP_BY_ID[msg.id];
  if (!e) return;
  if (!bwNearShop(bw, p, 'item')) { bwToast(state, p, 'Chegue mais perto do vendedor.'); return; }
  const res = e.cost[0], amt = e.cost[1];
  if (p.res[res] < amt) { bwToast(state, p, 'Você não tem ' + BW_RES_NAME[res] + ' suficiente.'); return; }
  if (e.armor) {
    if (p.armor >= e.armor) { bwToast(state, p, 'Você já tem essa armadura ou uma melhor.'); return; }
    p.armor = e.armor;
  } else if (e.arrows) {
    p.arrows += e.arrows;
  } else {
    if (e.tool === 'sword' && bwSwordTier(p) >= e.tier) { bwToast(state, p, 'Você já tem uma espada melhor.'); return; }
    if (e.tool === 'pick' || e.tool === 'axe') {
      const cur = e.tool === 'pick' ? p.pick : p.axe;
      if (cur >= e.tier) { bwToast(state, p, 'Você já tem esse nível ou um melhor.'); return; }
      if (e.tier > cur + 1) { bwToast(state, p, 'Compre o nível anterior primeiro.'); return; }
    }
    if (e.tool === 'shears' && p.shears) { bwToast(state, p, 'Você já tem uma tesoura.'); return; }
    if (e.tool === 'bow' && bwBowTier(p) >= e.tier) { bwToast(state, p, 'Você já tem um arco melhor.'); return; }
    if (e.tool === 'kb' && p.slots.some((s) => s && s.id === 'kb')) { bwToast(state, p, 'Você já tem o bastão.'); return; }
    if (!bwGive(p, e.item, e.n)) { bwToast(state, p, 'Inventário cheio!'); return; }
  }
  p.res[res] -= amt;
  bwSyncInv(state, p);
  bwSendEquip(state, room, p);
  send(state, p.id, { type: 'bwBought', id: e.id });
}

function bwOnUpgrade(state, room, p, msg) {
  const bw = room.bw;
  if (bw.phase !== 'playing' || !p.alive || typeof msg.id !== 'string') return;
  if (!bwNearShop(bw, p, 'upg')) { bwToast(state, p, 'Chegue mais perto do vendedor de melhorias.'); return; }
  const team = bw.teams[p.ti];
  let label = '';
  if (msg.id.indexOf('trap:') === 0) {
    const def = BW_TRAPS.find((t) => t.id === msg.id.slice(5));
    if (!def) return;
    if (team.up.traps.length >= 3) { bwToast(state, p, 'A fila de armadilhas está cheia (máx. 3).'); return; }
    const cost = BW_TRAP_COSTS[team.up.traps.length];
    if (p.res.diamond < cost) { bwToast(state, p, 'Você precisa de ' + cost + ' diamante(s).'); return; }
    p.res.diamond -= cost;
    team.up.traps.push(def.id);
    label = def.name;
  } else {
    const u = bwUpgradeDefs(bw.teamSize).find((d) => d.id === msg.id);
    if (!u) return;
    const lvl = team.up[u.id];
    if (lvl >= u.costs.length) { bwToast(state, p, 'Já está no nível máximo.'); return; }
    const cost = u.costs[lvl];
    if (p.res.diamond < cost) { bwToast(state, p, 'Você precisa de ' + cost + ' diamante(s).'); return; }
    p.res.diamond -= cost;
    team.up[u.id] = lvl + 1;
    label = u.name + (u.costs.length > 1 ? ' ' + ['I', 'II', 'III', 'IV'][lvl] : '');
  }
  bwBroadcastTeam(state, room, p.ti, { type: 'bwMsg', parts: [bwPN(p), [' comprou ', '#dddddd'], [label, '#55ffff'], ['.', '#dddddd']] });
  bwSyncTeamInv(state, room, p.ti);
  send(state, p.id, { type: 'bwBought', id: msg.id });
}

function bwOnUse(state, room, p, msg) {
  const bw = room.bw;
  if (bw.phase !== 'playing' || !p.alive) return;
  const s = p.slots[p.sel];
  if (!s) return;
  const def = BW_ITEMS[s.id];
  if (!def || def.act !== 'use') return;
  const now = Date.now();
  if (s.id === 'apple') {
    p.eff.regen = now + 5000; p.absorb = Math.max(p.absorb, 4);
    send(state, p.id, { type: 'bwHp', hp: p.hp, absorb: p.absorb });
  } else if (s.id === 'milk') p.eff.milk = now + 30000;
  else if (s.id === 'potion_speed') p.eff.speed = now + 45000;
  else if (s.id === 'potion_jump') p.eff.jump = now + 45000;
  else if (s.id === 'potion_invis') p.eff.invis = now + 30000;
  else if (s.id === 'bedbug') bwSpawnMob(state, room, 'silverfish', p, p.x + Math.sin(p.yaw) * -1, p.y + 0.2, p.z + Math.cos(p.yaw) * -1);
  else if (s.id === 'golem') bwSpawnMob(state, room, 'golem', p, p.x + Math.sin(p.yaw) * -2, p.y + 0.2, p.z + Math.cos(p.yaw) * -2);
  else return;
  bwTakeSlot(p, p.sel, 1);
  bwSyncInv(state, p);
  bwSendEff(state, p);
  bwSendEquip(state, room, p);
}

function bwOnThrow(state, room, p, msg) {
  const bw = room.bw;
  if (bw.phase !== 'playing' || !p.alive) return;
  const s = p.slots[p.sel];
  if (!s || (s.id !== 'fireball' && s.id !== 'pearl' && s.id !== 'egg')) return;
  if (!bwNum(msg.dx) || !bwNum(msg.dy) || !bwNum(msg.dz)) return;
  const e = bwEyeFrom(p, msg);
  const speed = s.id === 'fireball' ? 15 : (s.id === 'pearl' ? 24 : 20);
  bwAddProj(state, room, s.id, p, e[0], e[1], e[2], msg.dx, msg.dy, msg.dz, speed, null);
  bwTakeSlot(p, p.sel, 1);
  bwSyncInv(state, p);
  bwSendEquip(state, room, p);
}

function bwOnShoot(state, room, p, msg) {
  const bw = room.bw;
  if (bw.phase !== 'playing' || !p.alive) return;
  const s = p.slots[p.sel];
  if (!s || s.id.indexOf('bow') !== 0) return;
  if (p.arrows <= 0) { bwToast(state, p, 'Você está sem flechas!'); return; }
  if (!bwNum(msg.dx) || !bwNum(msg.dy) || !bwNum(msg.dz)) return;
  const def = BW_ITEMS[s.id];
  const charge = Math.max(0.2, Math.min(1, bwNum(msg.charge) ? msg.charge : 0.5));
  const e = bwEyeFrom(p, msg);
  bwAddProj(state, room, 'arrow', p, e[0], e[1], e[2], msg.dx, msg.dy, msg.dz, 14 + 26 * charge, { charge, power: def.power, punch: def.punch });
  p.arrows--;
  bwSyncInv(state, p);
}

function bwOnFall(state, room, p, msg) {
  if (!p.alive || room.bw.phase !== 'playing' || !bwNum(msg.d) || msg.d <= 3) return;
  const dmg = Math.min(18, Math.floor(msg.d - 3));
  if (dmg >= 1) bwDamage(state, room, p, dmg, { cause: 'fall', armor: false });
}

// Roteador: devolve true se a mensagem foi tratada pelo BedWars.
function bwOnMessage(state, room, id, msg) {
  const p = room.players.find((q) => q.id === id);
  if (!p) return false;
  switch (msg.type) {
    case 'state': bwOnState(state, room, p, msg); return true;
    case 'hit': bwOnHit(state, room, p, msg); return true;
    case 'death': case 'roundReset': return true;
    case 'bwSelect': bwOnSelect(state, room, p, msg); return true;
    case 'bwSwapSlot': bwOnSwapSlot(state, room, p, msg); return true;
    case 'bwPlace': bwOnPlace(state, room, p, msg); return true;
    case 'bwBreak': bwOnBreak(state, room, p, msg); return true;
    case 'bwBuy': bwOnBuy(state, room, p, msg); return true;
    case 'bwUpgrade': bwOnUpgrade(state, room, p, msg); return true;
    case 'bwUse': bwOnUse(state, room, p, msg); return true;
    case 'bwThrow': bwOnThrow(state, room, p, msg); return true;
    case 'bwShoot': bwOnShoot(state, room, p, msg); return true;
    case 'bwHitMob': bwOnHitMob(state, room, p, msg); return true;
    case 'bwFall': bwOnFall(state, room, p, msg); return true;
    default: return false;
  }
}

// Alguém saiu (botão sair ou caiu a conexão): vira eliminado, sem derrubar a partida.
function bwOnLeave(state, room, id) {
  const bw = room.bw;
  const p = room.players.find((q) => q.id === id);
  if (!p) return;
  room.players = room.players.filter((q) => q.id !== id);
  p.left = true; p.alive = false;
  bwFeed(state, room, [bwPN(p), [' saiu da partida.', '#aaaaaa']]);
  bwBroadcast(state, room, { type: 'bwAlive', id, alive: false });
  const team = bw.teams[p.ti];
  p.eliminated = true;
  if (!team.eliminated && !team.players.some((q) => !q.eliminated && !q.left)) {
    team.eliminated = true;
    bwFeed(state, room, [['ELIMINAÇÃO DE EQUIPE > ', '#ff5555'], [team.def.name, team.def.css], [' foi eliminado!', '#dddddd']]);
  }
  if (room.players.length === 0) {
    bw.ended = true;
    for (const [roomId, r] of state.rooms) { if (r === room) { state.rooms.delete(roomId); break; } }
    return;
  }
  bwCheckWin(state, room);
}


const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const vsIndex = vsIndexFromUrl(req.url);
  const state = virtualServers[vsIndex];

  const id = state.nextId++;
  const defaultName = 'User ' + id;
  state.clients.set(id, { ws, room: null, name: defaultName, activeChatWith: null, skin: null });
  send(state, id, { type: 'welcome', id, defaultName });
  send(state, id, { type: 'newsFeed', items: newsFeedPublic() });
  broadcastOnline(state);

  // Heartbeat: marca a conexão como "viva" sempre que o navegador responde
  // ao ping (ver setInterval mais abaixo). Sem isso, quando o navegador é
  // fechado/reiniciado de forma abrupta (processo matado, sem internet, wifi
  // caiu etc.) o TCP não manda um aviso de fechamento — o servidor nunca
  // recebe o evento 'close' e a sala fica esperando pra sempre um jogador
  // que já foi embora, sem avisar o oponente.
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Qualquer erro dentro de uma mensagem (comando do ADM, cheat etc.) é só registrado no log:
  // antes ele subia sem tratamento e derrubava o servidor inteiro (o jogo caía e só voltava
  // quando o servidor reiniciava, uns 5s depois).
  ws.on('message', (raw) => {
    try { handleClientMessage(raw); }
    catch (err) {
      console.error('[erro] mensagem ignorada (' + err.stack + ')');
      try { send(state, id, { type: 'adminActionResult', ok: false, error: 'Erro no servidor ao executar isso. Tente de novo.' }); } catch (e2) {}
    }
  });
  function handleClientMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const c = state.clients.get(id);
    if (!c) return;

    // BedWars: votação de mapa no lobby e todas as mensagens de dentro da partida.
    if (msg.type === 'bwVote') { bwOnVote(state, id, msg); return; }
    if (c.room) {
      const bwRoom = state.rooms.get(c.room);
      if (bwRoom && bwRoom.bw && bwOnMessage(state, bwRoom, id, msg)) return;
    }

    if (msg.type === 'queue') {
      handleQueueMessage(state, id, msg);
    } else if (msg.type === 'setName') {
      // Nome mostrado acima da cabeça do jogador nas partidas. Se vier
      // vazio (ou o jogador nunca definir um), volta pro padrão "User N".
      let name = typeof msg.name === 'string' ? msg.name.trim().slice(0, 20) : '';
      if (!name) name = 'User ' + id;
      c.name = name;
    } else if (msg.type === 'setSkin') {
      // Skin escolhida no vestiário ou pintada no "Crie o seu". Fica na
      // conexão pra já ir na lista de jogadores da próxima partida, e se a
      // pessoa estiver logada também vira permanente na conta dela.
      if (!isValidSkin(msg.skin)) return;
      c.skin = msg.skin;
      if (c.accountId) {
        const prof = profiles[c.accountId] || { name: c.name, kills: 0, accessibility: 20, btnScale: 100 };
        prof.skin = msg.skin;
        profiles[c.accountId] = prof;
        saveProfiles();
      }
    } else if (msg.type === 'cancel') {
      handleCancelMessage(state, id);
    } else if (msg.type === 'spectate') {
      handleSpectate(state, id, msg);
    } else if (msg.type === 'spectateJoin') {
      handleSpectateJoin(state, id, msg);
    } else if (msg.type === 'state') {
      if (!c.room) return;
      const room = state.rooms.get(c.room);
      if (!room) return;
      if (typeof msg.x === 'number' && typeof msg.z === 'number') {
        c.pos = { x: msg.x, y: typeof msg.y === 'number' ? msg.y : 0, z: msg.z, yaw: msg.yaw, t: Date.now() };
      }
      for (const p of room.players) {
        if (p.id !== id) {
          send(state, p.id, { type: 'state', id, x: msg.x, y: msg.y, z: msg.z, yaw: msg.yaw, pitch: msg.pitch, punching: msg.punching, sn: msg.sn ? 1 : 0 });
        }
      }
      if (room.watchers && room.watchers.length && room.watchAnchor === id) {
        watchMirror(state, room, { type: 'state', id, x: msg.x, y: msg.y, z: msg.z, yaw: msg.yaw, pitch: msg.pitch, punching: msg.punching, sn: msg.sn ? 1 : 0 });
      }
    } else if (msg.type === 'hit') {
      applyHit(state, id, msg.targetId, msg.dx, msg.dz);
    } else if (msg.type === 'death') {
      applyDeath(state, id);
    } else if (msg.type === 'roundReset') {
      // Início de uma nova rodada (melhor de 3, modo 1x1): o cliente já
      // renasceu com vida cheia, então o servidor precisa voltar a marcar
      // esse jogador como "vivo" na sala — senão ele fica preso como morto
      // pra sempre e nenhum soco nele conta mais a partir da rodada 2.
      if (!c.room) return;
      const room = state.rooms.get(c.room);
      if (!room) return;
      const player = room.players.find((p) => p.id === id);
      if (player) {
        player.alive = true;
        player.hp = player.maxHp || 20; // Resetar HP para a nova rodada
        player.regenTimer = 0;
      }
      if (room.mode === '1x1') botsResetForNewRound(state, room);
    } else if (msg.type === 'matchChat') {
      // Chat de partida (não é o chat de amigos): manda pra todo mundo que
      // está na mesma sala agora, com o nome de exibição do remetente. Bots
      // não têm WebSocket de verdade, então não precisam (nem conseguem)
      // receber isso.
      if (!c.room) return;
      const room = state.rooms.get(c.room);
      if (!room) return;
      const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 140) : '';
      if (!text) return;
      const name = c.name || ('User ' + id);
      const senderIsAdmin = isAdminClient(c);
      for (const p of room.players) {
        if (p.id === id) continue;
        const pc = state.clients.get(p.id);
        if (pc && !pc.isBot) send(state, p.id, { type: 'matchChat', name, text, admin: senderIsAdmin });
      }
      if (room.watchAnchor === id) watchMirror(state, room, { type: 'matchChat', name, text, admin: senderIsAdmin });
      // Bots na sala: 30% das mensagens ganham resposta de algum bot.
      botsOnMatchChat(state, room, id, text);
    } else if (msg.type === 'phanixSignup') {
      const firstName = typeof msg.firstName === 'string' ? msg.firstName.trim() : '';
      const lastName = typeof msg.lastName === 'string' ? msg.lastName.trim() : '';
      const email = typeof msg.email === 'string' ? msg.email.trim() : '';
      const password = typeof msg.password === 'string' ? msg.password : '';
      const username = typeof msg.username === 'string' ? msg.username.trim() : '';
      const emailLower = email.toLowerCase();

      if (!firstName || !lastName) { send(state, id, { type: 'phanixAuthResult', ok: false, error: 'Preencha nome e sobrenome.' }); return; }
      if (!isValidEmail(email)) { send(state, id, { type: 'phanixAuthResult', ok: false, error: 'Gmail inválido.' }); return; }
      if (!password || password.length < 4) { send(state, id, { type: 'phanixAuthResult', ok: false, error: 'A senha precisa ter pelo menos 4 caracteres.' }); return; }
      if (!username) { send(state, id, { type: 'phanixAuthResult', ok: false, error: 'Escolha um nome de usuário.' }); return; }
      if (accounts[emailLower]) { send(state, id, { type: 'phanixAuthResult', ok: false, error: 'Já existe uma conta com esse Gmail.' }); return; }
      if (usedUsernames.has(username.toLowerCase())) { send(state, id, { type: 'phanixAuthResult', ok: false, error: 'Esse nome de usuário já está em uso.' }); return; }

      const account = createAccount({ firstName, lastName, email, password, username });
      c.accountId = emailLower;
      // Perfil novo (conta acabou de ser criada agora): usa o nome de
      // usuário escolhido no cadastro como nome de exibição inicial — não
      // o "User N" padrão da conexão. Sem isso, quem cria a conta com o
      // nome "Oipa" via ao logar que seu nome no jogo ficou "User 28".
      c.name = account.username;
      const prof = ensureProfile(emailLower, account.username);
      c.skin = prof.skin || null;
      send(state, id, {
        type: 'phanixAuthResult', ok: true,
        email: account.email, username: account.username, sessionToken: account.sessionToken, profile: prof, isAdmin: isAdminEmail(emailLower),
      });
      sendFriendsData(state, id, emailLower);
    } else if (msg.type === 'phanixLogin') {
      const email = typeof msg.email === 'string' ? msg.email.trim().toLowerCase() : '';
      const password = typeof msg.password === 'string' ? msg.password : '';
      const account = accounts[email];
      if (!account || !verifyPassword(account, password)) {
        send(state, id, { type: 'phanixAuthResult', ok: false, error: 'Gmail ou senha incorretos.' });
        return;
      }
      const activeBan = getActiveBan(account.email);
      if (activeBan) {
        send(state, id, { type: 'phanixAuthResult', ok: false, banned: true, error: banErrorMessage(activeBan), reason: activeBan.reason || '', until: activeBan.until || null });
        return;
      }
      c.accountId = account.email;
      // Mesmo detalhe do cadastro: usa o nome de usuário da CONTA como
      // fallback, nunca o nome que a conexão tinha antes de logar — sem
      // isso, se o navegador tivesse testado outra conta antes (nome
      // "grudado" no localStorage), a primeira vez que essa conta logasse
      // ela herdava esse nome errado pra sempre.
      const prof = ensureProfile(account.email, account.username);
      c.skin = prof.skin || null;
      send(state, id, {
        type: 'phanixAuthResult', ok: true,
        email: account.email, username: account.username, sessionToken: account.sessionToken, profile: prof, isAdmin: isAdminEmail(account.email),
      });
      sendFriendsData(state, id, account.email);
    } else if (msg.type === 'phanixResume') {
      // Tentativa silenciosa de continuar logado (mesmo navegador, sessão
      // salva) — se o token não bater com nada, ignora sem mostrar erro.
      const email = typeof msg.email === 'string' ? msg.email.trim().toLowerCase() : '';
      const token = typeof msg.sessionToken === 'string' ? msg.sessionToken : '';
      const account = accounts[email];
      // Resposta curta quando o login salvo não vale: o carregamento do jogo precisa saber
      // que a conferência terminou (antes o servidor ficava calado e a barra não tinha como saber).
      if (!account || !token) { send(state, id, { type: 'phanixResumeFail' }); return; }
      const a = Buffer.from(token, 'utf8');
      const b = Buffer.from(account.sessionToken, 'utf8');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { send(state, id, { type: 'phanixResumeFail' }); return; }
      const activeBan = getActiveBan(account.email);
      if (activeBan) {
        send(state, id, { type: 'phanixAuthResult', ok: false, banned: true, resumed: true, error: banErrorMessage(activeBan), reason: activeBan.reason || '', until: activeBan.until || null });
        return;
      }
      c.accountId = account.email;
      const prof = ensureProfile(account.email, account.username);
      c.skin = prof.skin || null;
      send(state, id, {
        type: 'phanixAuthResult', ok: true, resumed: true,
        email: account.email, username: account.username, profile: prof, isAdmin: isAdminEmail(account.email),
      });
      sendFriendsData(state, id, account.email);
    } else if (msg.type === 'phanixLogout') {
      // Sair da conta: solta a conta dessa conexão. Sem isso o servidor continuava achando que
      // a pessoa estava logada e seguia mandando pedidos de amizade, notificações, mensagens
      // e convites pra ela (e ela aparecia como "online" pros amigos).
      c.accountId = null;
      c.activeChatWith = null;
    } else if (msg.type === 'saveProfile') {
      if (!c.accountId) return; // só salva na nuvem se tiver conta logada
      const prof = profiles[c.accountId] || {};
      if (typeof msg.name === 'string' && msg.name.trim()) prof.name = msg.name.trim().slice(0, 20);
      if (typeof msg.kills === 'number' && isFinite(msg.kills)) prof.kills = msg.kills;
      if (typeof msg.accessibility === 'number' && isFinite(msg.accessibility)) prof.accessibility = msg.accessibility;
      if (typeof msg.btnScale === 'number' && isFinite(msg.btnScale)) prof.btnScale = Math.max(60, Math.min(160, msg.btnScale));
      if (isValidSkin(msg.skin)) prof.skin = msg.skin;
      profiles[c.accountId] = prof;
      saveProfiles();
      // ---------- Painel ADM ----------
      // Toda ação abaixo confere DE NOVO, no servidor, se quem mandou está
      // logado numa conta ADM — nunca confia num "isAdmin" que viesse do
      // cliente, porque isso seria fácil de falsificar no navegador.
    } else if (msg.type === 'adminPublish') {
      if (!isAdminClient(c)) return;
      const fail = (error) => send(state, id, { type: 'adminActionResult', ok: false, error });
      const kindMap = { news: 'news', upd: 'upd', novidade: 'novidade' };
      const type = kindMap[msg.kind];
      if (!type) return fail('Tipo inválido.');
      const title = typeof msg.title === 'string' ? msg.title.trim().slice(0, 60) : '';
      const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 600) : '';
      if (!title) return fail('Escreva o título.');
      if (!text) return fail('Escreva o texto.');
      let media = null;
      // Só a NOVIDADE aceita foto/vídeo; nos outros tipos o anexo é ignorado.
      if (type === 'novidade' && msg.media && typeof msg.media.data === 'string') {
        const info = MEDIA_TYPES[String(msg.media.mime || '').toLowerCase()];
        if (!info) return fail('Formato não aceito. Use JPG, PNG, WEBP, GIF, MP4, WEBM ou MOV.');
        const b64 = msg.media.data.replace(/^data:[^,]*,/, '');
        const buf = Buffer.from(b64, 'base64');
        if (!buf.length) return fail('O arquivo veio vazio.');
        if (buf.length > info.max) return fail('Arquivo grande demais (máx. ' + Math.round(info.max / 1048576) + ' MB).');
        const file = Date.now().toString(36) + '-' + crypto.randomBytes(5).toString('hex') + '.' + info.ext;
        try { fs.writeFileSync(path.join(MEDIA_DIR, file), buf); } catch (e) { return fail('Não consegui salvar o arquivo no servidor.'); }
        media = { kind: info.kind, file };
      }
      const item = { id: 'srv-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'), type, title, text, from: displayNameFor(c.accountId) || c.name || 'ADM', ts: Date.now(), media };
      newsFeed.push(item);
      while (newsFeed.length > 60) {
        const old = newsFeed.shift();
        if (old && old.media) fs.unlink(path.join(MEDIA_DIR, old.media.file), () => {});
      }
      saveNews();
      for (const st of virtualServers) {
        for (const [cid, cc] of st.clients) {
          if (cc.isBot) continue;
          send(st, cid, { type: 'newsItem', item: newsPublicItem(item) });
        }
      }
      const label = type === 'news' ? 'Notícia' : type === 'upd' ? 'Atualização' : 'Novidade';
      send(state, id, { type: 'adminActionResult', ok: true, message: label + ' enviada pra todo mundo!' });
    } else if (msg.type === 'adminBroadcast') {
      if (!isAdminClient(c)) return;
      const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 200) : '';
      if (!text) return;
      const fromName = displayNameFor(c.accountId) || c.name || 'ADM';
      // Toast na hora pra quem está online agora...
      for (const st of virtualServers) {
        for (const [cid, cc] of st.clients) {
          if (cc.isBot) continue;
          send(st, cid, { type: 'adminBroadcast', text, from: fromName });
        }
      }
      // ...e também fica de verdade na caixinha de notificações de CADA
      // conta real (igual pedido de amizade), pra quem não estava online
      // ver depois e pra não sumir quando o toast passa.
      for (const [emailLower, acc] of Object.entries(accounts)) {
        if (!acc || acc.isBot) continue;
        const notif = pushNotification(emailLower, '📢 ' + fromName + ': ' + text, { admin: true });
        pushLiveUpdate(emailLower, notif);
      }
      saveFriends();
    } else if (msg.type === 'adminDeleteBroadcast') {
      // ADM apaga um aviso que mandou: some da caixa de notificações de todas as contas
      // e dos aparelhos que estão online agora.
      if (!isAdminClient(c)) return;
      const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 200) : '';
      const from = typeof msg.from === 'string' ? msg.from.slice(0, 40) : 'ADM';
      if (!text) return;
      const full = '📢 ' + from + ': ' + text;
      for (const [emailLower, acc] of Object.entries(accounts)) {
        if (!acc || acc.isBot) continue;
        const f = ensureFriends(emailLower);
        const before = f.notifications.length;
        f.notifications = f.notifications.filter((n) => !(n.admin && n.text === full));
        if (f.notifications.length !== before) pushLiveUpdate(emailLower, null);
      }
      saveFriends();
      for (const st of virtualServers) {
        for (const [cid, cc] of st.clients) {
          if (cc.isBot) continue;
          send(st, cid, { type: 'adminBroadcastDeleted', text, from });
        }
      }
      send(state, id, { type: 'adminActionResult', ok: true, message: 'Aviso apagado pra todo mundo.' });
    } else if (msg.type === 'adminGetOnline') {
      if (!isAdminClient(c)) return;
      const list = [];
      for (const st of virtualServers) {
        for (const [cid, cc] of st.clients) {
          // O que a pessoa está fazendo: 'match' (em partida), 'queue' (em pareamento) ou 'menu'.
          let activity = 'menu', actMode = null;
          if (cc.room) { const rm0 = st.rooms.get(cc.room); activity = 'match'; actMode = rm0 ? rm0.mode : null; }
          else { for (const qm of Object.keys(st.queues)) { if (st.queues[qm].includes(cid)) { activity = 'queue'; actMode = qm; } } }
          list.push({
            id: cid,
            activity,
            mode: actMode,
            queueWatch: activity === 'queue' && st === state && cid !== id,
            vsIndex: st.vsIndex,
            name: (cc.accountId ? displayNameFor(cc.accountId) : cc.name) || ('User ' + cid),
            loggedIn: !!cc.accountId,
            inRoom: !!cc.room,
            admin: isAdminClient(cc),
            isBot: !!cc.isBot,
            watchable: st === state && cid !== id && !!cc.room && (() => { const rm = st.rooms.get(cc.room); return !!rm && (!rm.bw && !isBedwarsMode(rm.mode) ? true : rm.players.some((pp) => { const pc = st.clients.get(pp.id); return pc && !pc.isBot; })); })(),
          });
        }
      }
      // Paginação: manda no máximo `limit` jogadores (padrão 250, teto 20 mil).
      // Pessoas de verdade vêm primeiro, depois os bots.
      const ADM_LIST_MAX = 20000;
      let admLimit = parseInt(msg.limit, 10);
      if (!(admLimit > 0)) admLimit = 250;
      admLimit = Math.min(admLimit, ADM_LIST_MAX);
      const humansFirst = list.filter((p) => !p.isBot).concat(list.filter((p) => p.isBot));
      send(state, id, { type: 'adminOnlineList', players: humansFirst.slice(0, admLimit), total: Math.min(humansFirst.length, ADM_LIST_MAX), limit: admLimit });
    } else if (msg.type === 'adminCheat') {
      // Cheats do Painel ADM na partida: vida, dano, alcance, voar e
      // invisível — em si mesmo, em outro jogador ou em todo mundo da sala.
      if (!isAdminClient(c)) return;
      const fail = (error) => send(state, id, { type: 'adminActionResult', ok: false, error });
      if (!c.room) { fail('Entre numa partida primeiro.'); return; }
      const room = state.rooms.get(c.room);
      if (!room) return;
      if (room.bw || isBedwarsMode(room.mode)) { fail('Os cheats ainda não funcionam no BedWars.'); return; }
      const num = (v, lo, hi) => { const n = Number(v); return (v !== null && v !== undefined && isFinite(n) && n >= lo) ? Math.min(hi, n) : null; };
      const base = {
        hp: num(msg.hp, 1, 1000000) !== null ? Math.round(num(msg.hp, 1, 1000000)) : null,
        dmg: num(msg.dmg, 1, 1000000) !== null ? Math.round(num(msg.dmg, 1, 1000000)) : null,
        reach: num(msg.reach, 1, 1000000),
        speed: num(msg.speed, 0.5, 100),
        fly: !!msg.fly,
        flySame: !!msg.flySame,
        invis: !!msg.invis,
      };
      const targets = msg.targetId === 'all' ? room.players.slice() : room.players.filter((p) => p.id === msg.targetId);
      if (!targets.length) { fail('Esse jogador não está mais na partida.'); return; }
      for (const p of targets) {
        p.cheats = { ...base };
        p.maxHp = base.hp || 20;
        if (p.alive) p.hp = p.maxHp;
        p.regenTimer = 0;
        send(state, p.id, { type: 'adminCheat', hp: p.maxHp, dmg: base.dmg, reach: base.reach, speed: base.speed, fly: base.fly, flySame: base.flySame, invis: base.invis });
        for (const q of room.players) {
          if (q.id !== p.id) send(state, q.id, { type: 'adminCheatFx', id: p.id, max: p.maxHp, invis: base.invis });
        }
      }
      send(state, id, { type: 'adminActionResult', ok: true, message: 'Cheats aplicados em ' + targets.length + ' jogador(es).' });
    } else if (msg.type === 'adminRespawn') {
      // Botão "RENASCER" do Painel ADM: o ADM que morreu/foi eliminado volta a
      // ficar vivo na mesma partida (só ele mesmo, e só se a partida ainda existe).
      if (!isAdminClient(c)) return;
      const fail = (error) => send(state, id, { type: 'adminActionResult', ok: false, error });
      if (!c.room) { fail('A partida já acabou.'); return; }
      const room = state.rooms.get(c.room);
      if (!room) { fail('A partida já acabou.'); return; }
      const me = room.players.find((q) => q.id === id);
      if (!me) { fail('Você não está nessa partida.'); return; }
      if (room.bw || isBedwarsMode(room.mode)) {
        // BedWars: renasce na base do time (mesmo que a cama já tenha quebrado / já tenha sido eliminado).
        const bw = room.bw;
        if (!bw || bw.ended || bw.phase !== 'playing') { fail('A partida ainda não começou ou já acabou.'); return; }
        if (me.alive && !me.eliminated) { fail('Você já está vivo.'); return; }
        const team = bw.teams[me.ti];
        me.eliminated = false; me.left = false; me.respawnAt = 0;
        if (team && team.eliminated) team.eliminated = false;
        bwRespawn(state, room, me);
        send(state, id, { type: 'adminActionResult', ok: true, message: 'Você renasceu!' });
        return;
      }
      if (room.mode === '1x1') { fail('No 1x1 a rodada recomeça sozinha.'); return; }
      if (me.alive) { fail('Você já está vivo.'); return; }
      const px = typeof msg.x === 'number' && isFinite(msg.x) ? msg.x : 0;
      const py = typeof msg.y === 'number' && isFinite(msg.y) ? msg.y : 0;
      const pz = typeof msg.z === 'number' && isFinite(msg.z) ? msg.z : 0;
      const pyaw = typeof msg.yaw === 'number' && isFinite(msg.yaw) ? msg.yaw : 0;
      me.alive = true;
      me.hp = me.maxHp || 20;
      me.regenTimer = 0;
      me.lastAttackerId = null;
      c.pos = { x: px, y: py, z: pz, yaw: pyaw, t: Date.now() };
      send(state, id, { type: 'adminRespawned', x: px, y: py, z: pz, yaw: pyaw });
      // Quem tava na partida já tinha tirado o boneco dele da cena (playerDown): recria.
      for (const q of room.players) {
        if (q.id === id) continue;
        const qc = state.clients.get(q.id);
        if (!qc || qc.isBot) continue;
        const fl = qc.accountId ? ensureFriends(qc.accountId).friends : [];
        send(state, q.id, { type: 'playerJoined', respawn: true, hp: me.hp, x: px, y: py, z: pz, yaw: pyaw, player: { id, team: me.team, slot: me.slot, name: c.name || ('User ' + id), acctName: c.accountId ? displayNameFor(c.accountId) : null, skin: c.skin || null, friend: !!(c.accountId && fl.includes(c.accountId)), admin: true } });
      }
    } else if (msg.type === 'adminKick') {
      if (!isAdminClient(c)) return;
      const vsIndex = typeof msg.vsIndex === 'number' ? msg.vsIndex : state.vsIndex;
      const targetState = virtualServers[vsIndex] || state;
      const targetId = msg.targetId;
      const targetClient = targetState.clients.get(targetId);
      if (!targetClient) return;
      if (targetClient.isBot) {
        // Bot não tem conexão de verdade (ws falso, sem 'close' de verdade) —
        // então "kickar" um bot é: tirar ele da sala normalmente (mesmo
        // caminho de quando um bot desiste sozinho) e apagar a conexão dele.
        removeFromRoom(targetState, targetId);
        targetState.clients.delete(targetId);
        broadcastOnline(targetState);
        return;
      }
      // Antes isso fechava a conexão (ws.close) e o jogo do expulso travava.
      // Agora só tira da partida (mesmo caminho de quem sai sozinho), mantém
      // a conexão e manda o aviso \"você foi expulso da partida\" com um OK.
      handleCancelMessage(targetState, targetId);
      removeFromRoom(targetState, targetId);
      send(targetState, targetId, { type: 'adminKicked' });
      broadcastOnline(targetState);
    } else if (msg.type === 'adminUnbanPlayer') {
      if (!isAdminClient(c)) return;
      const username = typeof msg.username === 'string' ? msg.username.trim() : '';
      if (!username) { send(state, id, { type: 'adminActionResult', ok: false, error: 'Digite o nome do jogador.' }); return; }
      const res = unbanByName(username);
      if (res.removed.length) {
        send(state, id, { type: 'adminActionResult', ok: true, message: 'Jogador \"' + res.removed.join(', ') + '\" desbanido.' });
      } else {
        const hint = res.activeNames.length ? (' Banidos agora: ' + res.activeNames.slice(0, 10).join(', ') + '.') : ' Não há ninguém banido agora.';
        send(state, id, { type: 'adminActionResult', ok: false, error: (res.accountFound ? ('Jogador \"' + username + '\" não está banido.') : ('Jogador \"' + username + '\" não encontrado.')) + hint });
      }
    } else if (msg.type === 'adminBanPlayer') {
      if (!isAdminClient(c)) return;
      const username = typeof msg.username === 'string' ? msg.username.trim() : '';
      const days = Math.round(Number(msg.days));
      const reason = typeof msg.reason === 'string' ? msg.reason.trim().slice(0, 200) : '';
      if (!username) { send(state, id, { type: 'adminActionResult', ok: false, error: 'Digite o nome do jogador.' }); return; }
      if (!isFinite(days) || days < 1) { send(state, id, { type: 'adminActionResult', ok: false, error: 'Digite quantos dias de banimento.' }); return; }
      const target = accountByUsername(username);
      if (!target) { send(state, id, { type: 'adminActionResult', ok: false, error: 'Jogador "' + username + '" não encontrado.' }); return; }
      if (isAdminEmail(target.email)) { send(state, id, { type: 'adminActionResult', ok: false, error: 'Não dá pra banir uma conta ADM.' }); return; }
      const until = Date.now() + Math.min(days, 3650) * 86400000;
      bans[target.email] = { until, days, reason, bannedAt: Date.now(), bannedBy: c.accountId || null, username: target.username || '', nick: (typeof msg.username === 'string' ? msg.username.trim() : '') };
      saveBans();
      // Se a conta estiver online agora (em qualquer conexão), derruba na
      // hora e avisa o motivo — sem esperar o próximo login pra descobrir.
      for (const t of findClientsByAccount(target.email)) {
        const tc = t.state.clients.get(t.id);
        send(t.state, t.id, { type: 'accountBanned', reason, until });
        try { if (tc) tc.ws.close(); } catch (e) {}
      }
      send(state, id, { type: 'adminActionResult', ok: true, message: 'Jogador "' + target.username + '" banido por ' + days + ' dia(s).' });
    } else if (msg.type === 'adminRenamePlayer') {
      if (!isAdminClient(c)) return;
      const username = typeof msg.username === 'string' ? msg.username.trim() : '';
      const newName = typeof msg.newName === 'string' ? msg.newName.trim().slice(0, 20) : '';
      if (!username || !newName) { send(state, id, { type: 'adminActionResult', ok: false, error: 'Preencha o nome atual e o novo nome.' }); return; }
      const target = accountByUsername(username);
      if (!target) { send(state, id, { type: 'adminActionResult', ok: false, error: 'Jogador "' + username + '" não encontrado.' }); return; }
      if (newName.toLowerCase() !== target.username.toLowerCase() && usedUsernames.has(newName.toLowerCase())) {
        send(state, id, { type: 'adminActionResult', ok: false, error: 'Esse nome de usuário já está em uso.' }); return;
      }
      const oldName = target.username;
      usedUsernames.delete(oldName.toLowerCase());
      target.username = newName;
      usedUsernames.add(newName.toLowerCase());
      saveAccounts();
      // Avisa qualquer sessão dessa conta que estiver online agora pra
      // atualizar o nome na hora, sem precisar relogar.
      for (const t of findClientsByAccount(target.email)) {
        const tc = t.state.clients.get(t.id);
        if (tc) tc.name = newName;
        send(t.state, t.id, { type: 'forcedRename', newName });
      }
      send(state, id, { type: 'adminActionResult', ok: true, message: 'Nome de "' + oldName + '" trocado para "' + newName + '".' });
    } else if (msg.type === 'leave') {
      handleCancelMessage(state, id);
      removeFromRoom(state, id);
    } else if (msg.type === 'setInboxPrefs') {
      if (!c.accountId) return; // sem conta: fica tudo desligado e não dá pra mudar
      const pf = ensureFriends(c.accountId);
      if (typeof msg.requests === 'boolean') pf.prefs.requests = msg.requests;
      if (typeof msg.invites === 'boolean') pf.prefs.invites = msg.invites;
      saveFriends();
      for (const target of findClientsByAccount(c.accountId)) sendFriendsData(target.state, target.id, c.accountId);
    } else if (msg.type === 'getFriends') {
      if (!c.accountId) return;
      sendFriendsData(state, id, c.accountId);
    } else if (msg.type === 'addFriend') {
      if (!c.accountId) { send(state, id, { type: 'friendResult', ok: false, error: 'Faça login primeiro.' }); return; }
      const username = typeof msg.username === 'string' ? msg.username.trim() : '';
      if (!username) { send(state, id, { type: 'friendResult', ok: false, error: 'Digite um nome de usuário.' }); return; }
      const targetAccount = accountByUsername(username);
      if (!targetAccount) { send(state, id, { type: 'friendResult', ok: false, error: 'Usuário não encontrado.' }); return; }
      if (targetAccount.email === c.accountId) { send(state, id, { type: 'friendResult', ok: false, error: 'Você não pode se adicionar.' }); return; }
      const myFriends = ensureFriends(c.accountId);
      const theirFriends = ensureFriends(targetAccount.email);
      if (myFriends.friends.includes(targetAccount.email)) { send(state, id, { type: 'friendResult', ok: false, error: 'Vocês já são amigos.' }); return; }
      if (myFriends.outgoing.includes(targetAccount.email)) { send(state, id, { type: 'friendResult', ok: false, error: 'Pedido já enviado, espere a resposta.' }); return; }
      const myAccount = accounts[c.accountId];
      const myUsername = displayNameFor(c.accountId);

      // Se a outra pessoa já tinha te mandado um pedido, aceita na hora em
      // vez de criar um pedido duplicado cruzado.
      if (myFriends.incoming.includes(targetAccount.email)) {
        myFriends.incoming = myFriends.incoming.filter((e) => e !== targetAccount.email);
        theirFriends.outgoing = theirFriends.outgoing.filter((e) => e !== c.accountId);
        if (!myFriends.friends.includes(targetAccount.email)) myFriends.friends.push(targetAccount.email);
        if (!theirFriends.friends.includes(c.accountId)) theirFriends.friends.push(c.accountId);
        saveFriends();
        const notif = pushNotification(targetAccount.email, myUsername + ' Aceitou o seu pedido de amizade!', { type: 'accepted' });
        pushLiveUpdate(targetAccount.email, notif);
        sendFriendsData(state, id, c.accountId);
        send(state, id, { type: 'friendResult', ok: true, message: 'Vocês agora são amigos!' });
        return;
      }

      if (!targetAccount.isBot && theirFriends.prefs.requests === false) {
        send(state, id, { type: 'friendResult', ok: false, error: 'Essa pessoa não está recebendo pedidos de amizade.' });
        return;
      }
      if (!myFriends.outgoing.includes(targetAccount.email)) myFriends.outgoing.push(targetAccount.email);
      if (!theirFriends.incoming.includes(c.accountId)) theirFriends.incoming.push(c.accountId);
      saveFriends();
      const notif = pushNotification(targetAccount.email, myUsername + ' mandou solicitação de amizade! Toque aqui para ver', { type: 'request', fromEmail: c.accountId, fromUsername: myUsername });
      // Avisa em tempo real qualquer sessão dessa pessoa que estiver online
      // agora (ela pode estar conectada em mais de um servidor virtual ao
      // mesmo tempo — ver comentário em findClientsByAccount) e manda os
      // dados de amigos atualizados pra ela ver o pedido pendente na hora.
      pushLiveUpdate(targetAccount.email, notif);
      sendFriendsData(state, id, c.accountId);
      send(state, id, { type: 'friendResult', ok: true, message: 'Pedido enviado!' });
      if (targetAccount.isBot) botOnHumanFriendRequest(targetAccount.email, c.accountId);
    } else if (msg.type === 'respondFriendRequest') {
      if (!c.accountId) { send(state, id, { type: 'friendResult', ok: false, error: 'Faça login primeiro.' }); return; }
      const requesterEmail = typeof msg.email === 'string' ? msg.email.trim().toLowerCase() : '';
      const myFriends = ensureFriends(c.accountId);
      // Pedido que não existe mais (já aceito em outra aba, conta apagada...):
      // em vez de ignorar em silêncio, limpa e manda a lista atualizada.
      if (!requesterEmail || !myFriends.incoming.includes(requesterEmail)) {
        sendFriendsData(state, id, c.accountId);
        send(state, id, { type: 'friendResult', ok: false, error: 'Esse pedido não existe mais.' });
        return;
      }
      myFriends.incoming = myFriends.incoming.filter((e) => e !== requesterEmail);
      const theirFriends = ensureFriends(requesterEmail);
      theirFriends.outgoing = theirFriends.outgoing.filter((e) => e !== c.accountId);
      // Se o outro também tinha um pedido pra mim (cruzado), some com ele.
      theirFriends.incoming = theirFriends.incoming.filter((e) => e !== c.accountId);
      myFriends.outgoing = myFriends.outgoing.filter((e) => e !== requesterEmail);
      const requesterExists = !!accounts[requesterEmail];
      if (msg.accept && requesterExists) {
        if (!myFriends.friends.includes(requesterEmail)) myFriends.friends.push(requesterEmail);
        if (!theirFriends.friends.includes(c.accountId)) theirFriends.friends.push(c.accountId);
        const notif = pushNotification(requesterEmail, (displayNameFor(c.accountId)) + ' Aceitou o seu pedido de amizade!', { type: 'accepted' });
        saveFriends();
        pushLiveUpdate(requesterEmail, notif);
        send(state, id, { type: 'friendResult', ok: true, message: 'Vocês agora são amigos!' });
      } else {
        saveFriends();
        pushLiveUpdate(requesterEmail, null);
        send(state, id, { type: 'friendResult', ok: true, message: msg.accept ? 'Esse jogador não existe mais.' : 'Pedido recusado.' });
      }
      // Atualiza TODAS as sessões de quem respondeu (outras abas/aparelhos).
      pushLiveUpdate(c.accountId, null);
      sendFriendsData(state, id, c.accountId);
    } else if (msg.type === 'markNotificationsRead') {
      if (!c.accountId) return;
      const f = ensureFriends(c.accountId);
      let changed = false;
      for (const n of f.notifications) { if (!n.read) { n.read = true; changed = true; } }
      if (changed) saveFriends();
      send(state, id, { type: 'notificationsRead', notifications: f.notifications });
    } else if (msg.type === 'removeFriend') {
      if (!c.accountId) return;
      const targetEmail = typeof msg.email === 'string' ? msg.email.trim().toLowerCase() : '';
      const myFriends = ensureFriends(c.accountId);
      if (!myFriends.friends.includes(targetEmail)) return;
      myFriends.friends = myFriends.friends.filter((e) => e !== targetEmail);
      const theirFriends = ensureFriends(targetEmail);
      theirFriends.friends = theirFriends.friends.filter((e) => e !== c.accountId);
      saveFriends();
      sendFriendsData(state, id, c.accountId);
      pushLiveUpdate(targetEmail, null);
    } else if (msg.type === 'openChat') {
      // Marca essa conexão como "olhando" pra essa conversa agora — só pra
      // saber se dá pra pular a notificação de mensagem nova (ver
      // isAccountViewingChat). Não exige amizade aqui: o pior que acontece
      // sem a checagem é a conta ficar marcada "vendo" uma conversa que
      // nem existe ainda, o que é inofensivo.
      if (!c.accountId) return;
      c.activeChatWith = typeof msg.withEmail === 'string' ? msg.withEmail.trim().toLowerCase() : null;
      if (c.activeChatWith) markConversationRead(c, c.activeChatWith);
    } else if (msg.type === 'closeChat') {
      c.activeChatWith = null;
    } else if (msg.type === 'markRead') {
      // Cliente já está com a conversa aberta e chegou mensagem nova ao
      // vivo (sem precisar reabrir a tela) — marca como visto na hora.
      if (!c.accountId) return;
      const withEmail = typeof msg.withEmail === 'string' ? msg.withEmail.trim().toLowerCase() : '';
      if (withEmail) markConversationRead(c, withEmail);
    } else if (msg.type === 'typing' || msg.type === 'stopTyping' || msg.type === 'recordingAudio' || msg.type === 'stopRecordingAudio') {
      // Repassa esse "aviso de atividade" (digitando / gravando áudio) pra
      // quem está do outro lado da conversa, em tempo real — não é uma
      // notificação persistente, só um status de UI que aparece e some
      // sozinho (ver handleActivityEvent no cliente).
      if (!c.accountId) return;
      const toEmail = typeof msg.toEmail === 'string' ? msg.toEmail.trim().toLowerCase() : '';
      if (!toEmail) return;
      broadcastToAccount(toEmail, { type: msg.type, fromEmail: c.accountId });
    } else if (msg.type === 'getConversation') {
      if (!c.accountId) return;
      const withEmail = typeof msg.withEmail === 'string' ? msg.withEmail.trim().toLowerCase() : '';
      const myFriends = ensureFriends(c.accountId);
      if (!withEmail || !myFriends.friends.includes(withEmail)) {
        send(state, id, { type: 'conversationData', withEmail, messages: [] });
        return;
      }
      const conv = ensureConversation(conversationKey(c.accountId, withEmail));
      send(state, id, { type: 'conversationData', withEmail, messages: conv.messages });
    } else if (msg.type === 'sendMessage') {
      if (!c.accountId) { send(state, id, { type: 'messageResult', ok: false, error: 'Faça login primeiro.' }); return; }
      const toEmail = typeof msg.toEmail === 'string' ? msg.toEmail.trim().toLowerCase() : '';
      const myFriends = ensureFriends(c.accountId);
      if (!toEmail || !myFriends.friends.includes(toEmail)) { send(state, id, { type: 'messageResult', ok: false, error: 'Vocês precisam ser amigos para conversar.' }); return; }

      const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 2000) : '';
      let attachment = null;
      if (msg.attachment && typeof msg.attachment.dataUrl === 'string') {
        if (msg.attachment.dataUrl.length > MAX_ATTACHMENT_DATAURL_LEN) { send(state, id, { type: 'messageResult', ok: false, error: 'Arquivo muito grande.' }); return; }
        attachment = {
          name: typeof msg.attachment.name === 'string' ? msg.attachment.name.slice(0, 80) : 'arquivo',
          mime: typeof msg.attachment.mime === 'string' ? msg.attachment.mime.slice(0, 100) : 'application/octet-stream',
          dataUrl: msg.attachment.dataUrl,
        };
      }
      let audio = null;
      let audioHeard = null; // transcrição + duração que o cliente mandou (só serve pro bot "ouvir"; não é salva)
      if (msg.audio && typeof msg.audio.dataUrl === 'string') {
        if (msg.audio.dataUrl.length > MAX_ATTACHMENT_DATAURL_LEN) { send(state, id, { type: 'messageResult', ok: false, error: 'Áudio muito grande.' }); return; }
        audio = { dataUrl: msg.audio.dataUrl };
        audioHeard = {
          transcript: typeof msg.audio.transcript === 'string' ? msg.audio.transcript.trim().slice(0, 500) : '',
          durationMs: typeof msg.audio.durationMs === 'number' && isFinite(msg.audio.durationMs) ? Math.max(0, Math.min(600000, msg.audio.durationMs)) : 0,
        };
      }
      if (audio && audioHeard && audioHeard.transcript) audio.transcript = audioHeard.transcript; // já veio transcrito (conversa com bot)
      if (!text && !attachment && !audio) { send(state, id, { type: 'messageResult', ok: false, error: 'Mensagem vazia.' }); return; }

      const key = conversationKey(c.accountId, toEmail);
      const conv = ensureConversation(key);
      const message = { id: crypto.randomBytes(8).toString('hex'), from: c.accountId, ts: Date.now() };
      if (text) message.text = text;
      if (attachment) message.attachment = attachment;
      if (audio) message.audio = audio;
      // Se quem recebe já está com essa conversa aberta na tela agora, a
      // mensagem já nasce "vista" — sem isso o "Visto às" só apareceria
      // quando a pessoa reabrisse o chat.
      if (isAccountViewingChat(toEmail, c.accountId)) { message.read = true; message.readTs = message.ts; }
      conv.messages.push(message);
      // Guarda só as últimas 300 mensagens de cada conversa — o bastante
      // pra rolar um histórico útil sem o arquivo crescer sem limite.
      if (conv.messages.length > 300) conv.messages.splice(0, conv.messages.length - 300);
      saveConversations();

      // Entrega a mensagem em tempo real pra QUALQUER sessão online dos
      // dois lados (cada conta pode estar conectada em até 4 servidores
      // virtuais ao mesmo tempo — ver comentário em findClientsByAccount),
      // já no formato que cada lado enxerga (o "withEmail" é sempre "a
      // outra pessoa" do ponto de vista de quem recebe).
      for (const target of findClientsByAccount(c.accountId)) send(target.state, target.id, { type: 'newMessage', withEmail: toEmail, message });
      for (const target of findClientsByAccount(toEmail)) send(target.state, target.id, { type: 'newMessage', withEmail: c.accountId, message });

      // Só manda notificação (pop-up + sino) se quem recebeu não estiver
      // com essa conversa já aberta na tela — sem essa checagem, ficaria
      // se notificando sozinho de mensagens que já está vendo ao vivo.
      if (!isAccountViewingChat(toEmail, c.accountId)) {
        const myAccount = accounts[c.accountId];
        const myUsername = displayNameFor(c.accountId);
        const notif = pushNotification(toEmail, myUsername + ' Enviou uma mensagem! Toque aqui para ver', { type: 'message', fromEmail: c.accountId, fromUsername: myUsername });
        pushLiveUpdate(toEmail, notif);
      }
      send(state, id, { type: 'messageResult', ok: true });
      const toAcc = accounts[toEmail];
      if (toAcc && toAcc.isBot) {
        if (audio) {
          // O bot "ouve" o áudio sozinho: o servidor transcreve (sem precisar apertar
          // "Transcrever") e o bot responde ao que foi dito.
          let stt = null;
          if (!audioHeard.transcript && STT_ENABLED) {
            stt = sttForMessage(message, audioHeard.durationMs)
              .then((t) => { if (t) message.audio.heardByBot = true; return t; })
              .catch((e) => { console.log('[stt] falhou ao o bot ouvir o áudio: ' + (e && e.message)); return ''; });
          }
          botMaybeReplyToMessage(toEmail, c.accountId, text || audioHeard.transcript, 'audio', { durationMs: audioHeard.durationMs, stt });
        } else botMaybeReplyToMessage(toEmail, c.accountId, text, attachment ? 'attachment' : 'text');
      }
    } else if (msg.type === 'transcribeAudio') {
      // Botão "Transcrever" embaixo do áudio: quem transcreve é o SERVIDOR (o navegador
      // não consegue transcrever áudio gravado sem ligar o microfone). O texto fica
      // salvo na mensagem (aparece pros dois lados) e, se o áudio foi mandado pra um
      // bot que ainda não tinha entendido, o bot passa a "entender" e responde.
      if (!c.accountId) return;
      const withEmail = typeof msg.withEmail === 'string' ? msg.withEmail.trim().toLowerCase() : '';
      const messageId = typeof msg.messageId === 'string' ? msg.messageId : '';
      if (!withEmail || !messageId) return;
      const tconv = conversations[conversationKey(c.accountId, withEmail)];
      if (!tconv) return;
      const tmsg = tconv.messages.find((m) => m.id === messageId);
      if (!tmsg || !tmsg.audio) return;
      const sendTranscript = (text) => {
        for (const target of findClientsByAccount(c.accountId)) send(target.state, target.id, { type: 'audioTranscript', withEmail, messageId, transcript: text });
        for (const target of findClientsByAccount(withEmail)) send(target.state, target.id, { type: 'audioTranscript', withEmail: c.accountId, messageId, transcript: text });
      };
      const sendFail = (error) => {
        for (const target of findClientsByAccount(c.accountId)) send(target.state, target.id, { type: 'audioTranscriptFail', withEmail, messageId, error });
      };
      if (tmsg.audio.transcript) { sendTranscript(tmsg.audio.transcript); return; } // já transcrito: só reenvia (destrava o botão)
      sttForMessage(tmsg).then((text) => {
        if (!text) { sendFail('empty'); return; }
        if (tmsg.audio.transcript) return;
        tmsg.audio.transcript = text;
        saveConversations();
        sendTranscript(text);
        const tAcc = accounts[withEmail];
        if (tmsg.from === c.accountId && tAcc && tAcc.isBot && !tmsg.audio.heardByBot) {
          tmsg.audio.heardByBot = true;
          botMaybeReplyToMessage(withEmail, c.accountId, text, 'audio', { durationMs: 0 });
        }
      }).catch((e) => {
        console.log('[stt] falhou ao transcrever: ' + (e && e.message));
        sendFail(e && e.message === 'no-stt' ? 'no-stt' : 'error');
      });
    } else if (msg.type === 'deleteMessage') {
      if (!c.accountId) return;
      const withEmail = typeof msg.withEmail === 'string' ? msg.withEmail.trim().toLowerCase() : '';
      const messageId = typeof msg.messageId === 'string' ? msg.messageId : '';
      if (!withEmail || !messageId) return;
      const key = conversationKey(c.accountId, withEmail);
      const conv = conversations[key];
      if (!conv) return;
      const msgIdx = conv.messages.findIndex((m) => m.id === messageId);
      if (msgIdx === -1) return;
      // Só quem mandou a mensagem pode apagar ela (dos dois lados).
      if (conv.messages[msgIdx].from !== c.accountId) return;
      conv.messages.splice(msgIdx, 1);
      saveConversations();
      for (const target of findClientsByAccount(c.accountId)) send(target.state, target.id, { type: 'messageDeleted', withEmail, messageId });
      for (const target of findClientsByAccount(withEmail)) send(target.state, target.id, { type: 'messageDeleted', withEmail: c.accountId, messageId });
    } else if (msg.type === 'callRequest') {
      // Pedido de ligação de voz pra um amigo. Só repassa o convite pra
      // quem tiver online — a chamada de verdade (áudio) é feita direto
      // entre os dois navegadores (WebRTC); esse servidor só entrega o
      // "toca o telefone aí" e depois faz de mensageiro pra troca de SDP/ICE.
      if (!c.accountId) return;
      const toEmail = typeof msg.toEmail === 'string' ? msg.toEmail.trim().toLowerCase() : '';
      const myFriends = ensureFriends(c.accountId);
      if (!toEmail || !myFriends.friends.includes(toEmail)) { send(state, id, { type: 'callResult', ok: false, error: 'Vocês precisam ser amigos para ligar.' }); return; }
      const myAccount = accounts[c.accountId];
      const myUsername = displayNameFor(c.accountId);
      const callId = crypto.randomBytes(8).toString('hex');
      send(state, id, { type: 'callResult', ok: true, callId });
      if (isAccountOnline(toEmail)) {
        for (const target of findClientsByAccount(toEmail)) {
          send(target.state, target.id, { type: 'incomingCall', callId, fromEmail: c.accountId, fromUsername: myUsername });
        }
      } else {
        // Offline agora: não dá pra tocar o telefone na hora (a chamada de
        // voz é direto entre os dois navegadores), mas fica uma notificação
        // salva — assim que a pessoa entrar, ela vê que você ligou.
        const notif = pushNotification(toEmail, myUsername + ' te ligou enquanto você estava offline!', { type: 'missedCall', fromEmail: c.accountId, fromUsername: myUsername });
        pushLiveUpdate(toEmail, notif);
      }
    } else if (msg.type === 'callAccept') {
      if (!c.accountId) return;
      const toEmail = typeof msg.toEmail === 'string' ? msg.toEmail.trim().toLowerCase() : '';
      const callId = typeof msg.callId === 'string' ? msg.callId : '';
      if (!toEmail || !callId) return;
      for (const target of findClientsByAccount(toEmail)) send(target.state, target.id, { type: 'callAccepted', callId, fromEmail: c.accountId });
    } else if (msg.type === 'callDecline') {
      if (!c.accountId) return;
      const toEmail = typeof msg.toEmail === 'string' ? msg.toEmail.trim().toLowerCase() : '';
      const callId = typeof msg.callId === 'string' ? msg.callId : '';
      if (!toEmail || !callId) return;
      for (const target of findClientsByAccount(toEmail)) send(target.state, target.id, { type: 'callDeclined', callId, fromEmail: c.accountId });
    } else if (msg.type === 'callEnd') {
      if (!c.accountId) return;
      const toEmail = typeof msg.toEmail === 'string' ? msg.toEmail.trim().toLowerCase() : '';
      const callId = typeof msg.callId === 'string' ? msg.callId : '';
      if (!toEmail || !callId) return;
      for (const target of findClientsByAccount(toEmail)) send(target.state, target.id, { type: 'callEnded', callId, fromEmail: c.accountId });
    } else if (msg.type === 'callSignal') {
      // Repassa SDP (offer/answer) e candidatos ICE do WebRTC — o servidor
      // não entende o conteúdo, só entrega pro outro lado da chamada.
      if (!c.accountId) return;
      const toEmail = typeof msg.toEmail === 'string' ? msg.toEmail.trim().toLowerCase() : '';
      const callId = typeof msg.callId === 'string' ? msg.callId : '';
      if (!toEmail || !callId || !msg.signal) return;
      for (const target of findClientsByAccount(toEmail)) send(target.state, target.id, { type: 'callSignal', callId, fromEmail: c.accountId, signal: msg.signal });
    } else if (msg.type === 'inviteToPlay') {
      if (!c.accountId) { send(state, id, { type: 'inviteResult', ok: false, error: 'Faça login primeiro.' }); return; }
      const info = MODE_INFO[msg.mode];
      if (!info) { send(state, id, { type: 'inviteResult', ok: false, error: 'Modo inválido.' }); return; }
      const toEmail = typeof msg.toEmail === 'string' ? msg.toEmail.trim().toLowerCase() : '';
      const myFriends = ensureFriends(c.accountId);
      if (!myFriends.friends.includes(toEmail)) { send(state, id, { type: 'inviteResult', ok: false, error: 'Essa pessoa não é sua amiga.' }); return; }
      if (c.room) { send(state, id, { type: 'inviteResult', ok: false, error: 'Você já está em uma partida.' }); return; }
      const targetAccount = accounts[toEmail];
      if (!targetAccount) { send(state, id, { type: 'inviteResult', ok: false, error: 'Amigo não encontrado.' }); return; }
      if (!targetAccount.isBot && ensureFriends(toEmail).prefs.invites === false) { send(state, id, { type: 'inviteResult', ok: false, error: 'Seu amigo não está recebendo convites pra jogar.' }); return; }
      const targetId = findClientInVs(state, toEmail);
      if (targetId === null) { send(state, id, { type: 'inviteResult', ok: false, error: 'Seu amigo não está online agora.' }); return; }
      const myAccount = accounts[c.accountId];
      const myUsername = displayNameFor(c.accountId);
      const inviteId = crypto.randomBytes(6).toString('hex');
      const invite = {
        id: inviteId,
        fromEmail: c.accountId,
        fromUsername: myUsername,
        toEmail,
        toUsername: displayNameFor(toEmail),
        mode: msg.mode,
        vs: state.vsIndex,
        createdAt: Date.now(),
      };
      gameInvites[inviteId] = invite;
      // Expira sozinho se o amigo nunca responder — senão o convite fica
      // pendurado pra sempre na lista de notificações de quem recebeu.
      setTimeout(() => {
        if (gameInvites[inviteId]) {
          delete gameInvites[inviteId];
          broadcastToAccount(toEmail, { type: 'gameInviteExpired', inviteId });
          for (const target of findClientsByAccount(toEmail)) sendFriendsData(target.state, target.id, toEmail);
        }
      }, 60000);
      const notif = pushNotification(toEmail, myUsername + ' Convidou você para jogar ' + (isBedwarsMode(msg.mode) ? 'BedWars ' + BEDWARS_MODES[msg.mode].label : msg.mode) + '! Aceitar?', {
        type: 'gameInvite', inviteId, fromEmail: c.accountId, fromUsername: myUsername, mode: msg.mode, vs: state.vsIndex,
      });
      pushLiveUpdate(toEmail, notif);
      send(state, id, { type: 'inviteResult', ok: true, inviteId, message: 'Convite enviado! Esperando ' + displayNameFor(toEmail) + '...' });
      if (targetAccount.isBot) botOnGameInvite(toEmail, c.accountId, inviteId);
    } else if (msg.type === 'cancelInvite') {
      if (!c.accountId) return;
      const inviteId = typeof msg.inviteId === 'string' ? msg.inviteId : '';
      const invite = gameInvites[inviteId];
      if (!invite || invite.fromEmail !== c.accountId) return;
      delete gameInvites[inviteId];
      broadcastToAccount(invite.toEmail, { type: 'gameInviteCancelled', inviteId });
      for (const target of findClientsByAccount(invite.toEmail)) sendFriendsData(target.state, target.id, invite.toEmail);
    } else if (msg.type === 'respondGameInvite') {
      if (!c.accountId) return;
      const inviteId = typeof msg.inviteId === 'string' ? msg.inviteId : '';
      const invite = gameInvites[inviteId];
      if (!invite || invite.toEmail !== c.accountId) return;
      delete gameInvites[inviteId];
      for (const target of findClientsByAccount(invite.toEmail)) sendFriendsData(target.state, target.id, invite.toEmail);

      if (!msg.accept) {
        broadcastToAccount(invite.fromEmail, { type: 'gameInviteDeclined', mode: invite.mode, byUsername: displayNameFor(c.accountId) });
        return;
      }
      if (c.room) { send(state, id, { type: 'inviteResult', ok: false, error: 'Você já está em uma partida.' }); return; }
      if (isAccountBusyElsewhere(c.accountId, state, id)) { send(state, id, { type: 'inviteResult', ok: false, error: 'Você já está jogando em outro lugar.' }); return; }
      const inviterId = findClientInVs(state, invite.fromEmail);
      if (inviterId === null) {
        send(state, id, { type: 'inviteResult', ok: false, error: (invite.fromUsername || 'Seu amigo') + ' não está mais esperando.' });
        return;
      }
      const inviterClient = state.clients.get(inviterId);
      if (inviterClient.room || isAccountBusyElsewhere(invite.fromEmail, state, inviterId)) {
        send(state, id, { type: 'inviteResult', ok: false, error: (invite.fromUsername || 'Seu amigo') + ' já está em outra partida.' });
        return;
      }
      for (const mode of Object.keys(state.queues)) {
        state.queues[mode] = state.queues[mode].filter((x) => x !== id && x !== inviterId);
      }
      // Os dois entram juntos, na frente da fila do modo escolhido: no 1x1 a
      // partida forma na hora só entre eles; no 2x2/3x3 eles caem no mesmo
      // time (slots 0 e 1) e só falta completar com quem estiver na fila
      // pública.
      // Avisa quem convidou que o amigo aceitou (até aqui ele NÃO estava na fila,
      // então o cliente dele mostra 1/N em vez da contagem da fila pública).
      send(state, inviterId, { type: 'inviteAccepted', mode: invite.mode });
      state.queues[invite.mode].unshift(inviterId, id);
      if (isBedwarsMode(invite.mode)) { bwLobbyEnter(state, inviterId, invite.mode); bwLobbyEnter(state, id, invite.mode); }
      if (invite.mode === 'ffa') processFfaQueue(state, { resetWait: true });
      else if (isBedwarsMode(invite.mode)) processBedwarsQueue(state, invite.mode, { resetWait: true });
      else tryMatch(state, invite.mode);
      broadcastOnline(state);
    }
  }

  ws.on('error', (err) => { console.error('[ws] erro na conexão ' + id + ': ' + (err && err.message)); });
  ws.on('close', () => {
    try {
      handleCancelMessage(state, id);
      removeFromRoom(state, id);
      state.clients.delete(id);
      broadcastOnline(state);
    } catch (err) { console.error('[erro] ao fechar conexão ' + id + ': ' + err.stack); state.clients.delete(id); }
  });
});

// Rede de segurança final: um erro inesperado (em qualquer timer ou mensagem) é registrado
// em vez de derrubar o servidor e todas as partidas.
process.on('uncaughtException', (err) => { console.error('[erro] exceção não tratada: ' + (err && err.stack || err)); });
process.on('unhandledRejection', (err) => { console.error('[erro] promessa rejeitada: ' + (err && err.stack || err)); });

// A cada 15s, manda um "ping" pra cada conexão. Se uma conexão não respondeu
// ao ping anterior (ninguém no outro lado pra responder — navegador fechado,
// processo morto, sem internet), ela é derrubada com terminate(): isso
// dispara o 'close' de cada conexão normalmente (handleCancelMessage +
// removeFromRoom + broadcastOnline), então quem estava na sala com ela
// recebe o 'opponentLeft' certinho, em vez de ficar esperando pra sempre.
setInterval(() => {
  for (const state of virtualServers) {
    for (const c of state.clients.values()) {
      if (c.ws.isAlive === false) { c.ws.terminate(); continue; }
      c.ws.isAlive = false;
      c.ws.ping();
    }
  }
}, 15000);

// Regeneração de vida: autoritativa no servidor, pra não ter mais divergência
// entre "quanto o servidor acha que o jogador tem de vida" e "quanto o
// coraçãozinho em cima da cabeça dele mostra pros outros" — antes cada
// cliente ficava simulando essa regeneração por conta própria (um chute
// baseado no último golpe que ele viu), e como cada um via os golpes num
// instante ligeiramente diferente, o valor "adivinhado" divergia do valor
// real. Agora só existe UMA régua: 1 HP a cada HP_REGEN_INTERVAL_MS de vida
// (reiniciada a cada golpe recebido), e o servidor avisa todo mundo (o dono
// da vida e quem estiver vendo aquele oponente) toda vez que ela sobe.
const HP_REGEN_INTERVAL_MS = 7000;
const HP_REGEN_TICK_MS = 1000;
setInterval(() => {
  for (const state of virtualServers) {
    for (const room of state.rooms.values()) {
      if (room.bw) continue; // BedWars regenera no próprio loop (bwTickPlayers)
      for (const p of room.players) {
        const maxHpP = p.maxHp || 20;
        if (!p.alive || p.hp >= maxHpP) { p.regenTimer = 0; continue; }
        p.regenTimer = (p.regenTimer || 0) + HP_REGEN_TICK_MS;
        if (p.regenTimer < HP_REGEN_INTERVAL_MS) continue;
        p.regenTimer -= HP_REGEN_INTERVAL_MS;
        p.hp = Math.min(maxHpP, p.hp + 1);
        // Pro dono: corrige a vidinha (hpBar) dele mesmo.
        send(state, p.id, { type: 'hpSync', hp: p.hp });
        // Pros outros na sala: corrige o coraçãozinho que aparece em cima
        // da cabeça desse jogador, com o mesmo valor real do servidor.
        // ATENÇÃO: usa 'opponentHpSync' (e não 'opponentHp'), porque o
        // 'opponentHp' é confirmação de GOLPE e faz o cliente piscar vermelho
        // + tocar som de dano — era isso que dava a impressão do bot "levando
        // dano do nada" toda vez que ele recuperava vida.
        for (const other of room.players) {
          if (other.id !== p.id) send(state, other.id, { type: 'opponentHpSync', oppId: p.id, hp: p.hp });
        }
      }
    }
  }
}, HP_REGEN_TICK_MS);


// =====================================================================
//  TRANSCRIÇÃO DE ÁUDIO (feita AQUI no servidor)
//  * O navegador do celular (Chrome/Android) NÃO consegue transcrever um áudio
//    já gravado: o reconhecimento de voz dele sempre liga o MICROFONE de verdade
//    (por isso aparecia o "fone/microfone ativado do nada") e escuta o áudio
//    saindo no alto-falante, o que dava texto errado ou nenhum.
//  * Então o servidor manda o áudio pra um serviço de transcrição (Whisper).
//    Ele é usado em 2 lugares: (1) o bot "ouve" sozinho os áudios que você manda
//    pra ele; (2) o botão "Transcrever" embaixo do áudio.
//  Como ligar (uma das opções, ao iniciar o servidor):
//    GROQ_API_KEY=xxxx node server.js      (Groq, Whisper rápido; tem plano grátis)
//    OPENAI_API_KEY=xxxx node server.js    (OpenAI Whisper)
//    STT_API_KEY=xxxx STT_URL=https://.../v1/audio/transcriptions STT_MODEL=whisper-1 node server.js
//    STT_CMD='sh transcrever.sh {file}' node server.js   (comando local; {file} = arquivo do áudio,
//                                                        o texto sai no stdout)
//  Sem nenhuma dessas, os bots respondem que não conseguiram entender o áudio.
// =====================================================================
let STT_KEY = process.env.STT_API_KEY || '';
let STT_URL = process.env.STT_URL || '';
let STT_MODEL = process.env.STT_MODEL || '';
const STT_CMD = process.env.STT_CMD || '';
if (!STT_KEY && process.env.GROQ_API_KEY) {
  STT_KEY = process.env.GROQ_API_KEY;
  STT_URL = STT_URL || 'https://api.groq.com/openai/v1/audio/transcriptions';
  STT_MODEL = STT_MODEL || 'whisper-large-v3-turbo';
}
if (!STT_KEY && process.env.OPENAI_API_KEY) {
  STT_KEY = process.env.OPENAI_API_KEY;
  STT_URL = STT_URL || 'https://api.openai.com/v1/audio/transcriptions';
  STT_MODEL = STT_MODEL || 'whisper-1';
}
if (STT_KEY && !STT_URL) STT_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
if (STT_KEY && !STT_MODEL) STT_MODEL = /openai\.com/.test(STT_URL) ? 'whisper-1' : 'whisper-large-v3-turbo';
const STT_ENABLED = !!((STT_KEY && STT_URL) || STT_CMD);
const STT_TIMEOUT_MS = 40000;

// "data:audio/webm;codecs=opus;base64,AAAA..." -> { mime, ext, buf }
function sttParseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:') !== 0) return null;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const head = dataUrl.slice(5, comma);
  const isB64 = /;base64/i.test(head);
  const mime = (head.split(';')[0] || 'audio/webm').toLowerCase();
  let buf;
  try { buf = isB64 ? Buffer.from(dataUrl.slice(comma + 1), 'base64') : Buffer.from(decodeURIComponent(dataUrl.slice(comma + 1)), 'binary'); } catch (e) { return null; }
  let ext = 'webm';
  if (/ogg|opus/.test(mime)) ext = 'ogg';
  else if (/mp4|m4a|aac/.test(mime)) ext = 'm4a';
  else if (/mpeg|mp3/.test(mime)) ext = 'mp3';
  else if (/wav/.test(mime)) ext = 'wav';
  else if (/flac/.test(mime)) ext = 'flac';
  return { mime, ext, buf };
}
// POST multipart/form-data (sem dependência nenhuma) -> texto da transcrição
function sttPostMultipart(urlStr, apiKey, fields, file) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(new Error('STT_URL inválida')); return; }
    const lib = u.protocol === 'http:' ? require('http') : require('https');
    const boundary = '----arenastt' + crypto.randomBytes(12).toString('hex');
    const parts = [];
    for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + v + '\r\n'));
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="audio.' + file.ext + '"\r\nContent-Type: ' + file.mime + '\r\n\r\n'));
    parts.push(file.buf);
    parts.push(Buffer.from('\r\n--' + boundary + '--\r\n'));
    const body = Buffer.concat(parts);
    const headers = { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length };
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    const req = lib.request({ method: 'POST', hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers, timeout: STT_TIMEOUT_MS }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(String(JSON.parse(txt).text || '')); } catch (e) { resolve(txt); }
        } else reject(new Error('STT HTTP ' + res.statusCode + ': ' + txt.slice(0, 200)));
      });
    });
    req.on('timeout', () => req.destroy(new Error('STT timeout')));
    req.on('error', reject);
    req.end(body);
  });
}
// Comando local (ex.: whisper.cpp): STT_CMD com {file}; o texto vem no stdout.
function sttViaCommand(file) {
  return new Promise((resolve, reject) => {
    const fs2 = require('fs'), os2 = require('os');
    const tmp = path.join(os2.tmpdir(), 'arena_stt_' + crypto.randomBytes(8).toString('hex') + '.' + file.ext);
    try { fs2.writeFileSync(tmp, file.buf); } catch (e) { reject(e); return; }
    const cmd = STT_CMD.replace(/\{file\}/g, "'" + tmp + "'");
    require('child_process').exec(cmd, { timeout: 90000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      try { fs2.unlinkSync(tmp); } catch (e) {}
      if (err) reject(err); else resolve(String(stdout || ''));
    });
  });
}
// Limpa o texto (e joga fora as "alucinações" clássicas do Whisper em áudio mudo).
function sttClean(t) {
  t = String(t || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (/(amara\.org|legendas? pela comunidade|inscreva-se|obrigado por assistir|thanks for watching)/i.test(t)) return '';
  return t;
}
function sttTranscribe(dataUrl, durationMs) {
  if (!STT_ENABLED) return Promise.reject(new Error('no-stt'));
  const file = sttParseDataUrl(dataUrl);
  if (!file || !file.buf.length) return Promise.resolve('');
  if (durationMs && durationMs < 400) return Promise.resolve('');
  const p = STT_CMD
    ? sttViaCommand(file)
    : sttPostMultipart(STT_URL, STT_KEY, { model: STT_MODEL, language: 'pt', response_format: 'json', temperature: '0' }, file);
  return p.then(sttClean);
}
// Transcreve o áudio de UMA mensagem (guarda em message.audio.heard: não paga 2x pelo
// mesmo áudio) e junta chamadas repetidas enquanto uma já está em andamento.
const sttInflight = new Map(); // id da mensagem -> Promise
function sttForMessage(message, durationMs) {
  if (!message || !message.audio) return Promise.resolve('');
  if (message.audio.heard) return Promise.resolve(message.audio.heard);
  const id = message.id;
  if (id && sttInflight.has(id)) return sttInflight.get(id);
  const p = sttTranscribe(message.audio.dataUrl, durationMs).then((t) => {
    if (t) { message.audio.heard = t; saveConversations(); }
    return t;
  });
  if (id) {
    sttInflight.set(id, p);
    const clear = () => sttInflight.delete(id);
    p.then(clear, clear);
  }
  return p;
}

// =====================================================================
//  BOTS — jogadores simulados no servidor
// =====================================================================
//  * Entram como conexões "de verdade" (state.clients), então contam no
//    "online", nas filas, nas salas e no "jogando" de cada modo, e usam
//    exatamente o mesmo caminho de matchmaking dos jogadores reais.
//  * Nomes aleatórios, sem nenhuma marcação de bot.
//  * A quantidade de bots online oscila sozinha entre BOTS_MIN e BOTS_MAX.
//  * Nas filas: quando alguém fica esperando (jogador de verdade OU outro bot —
//    pros bots, bot é "gente de verdade"), bots vão entrando aos poucos
//    (como gente de verdade entraria) até a sala completar. Sozinhos, eles também entram em filas de vez em quando e
//    fazem partidas entre si (BOT_AMBIENT_QUEUE).
//  * IA "avançada": persegue, mira com erro/atraso humano, dá strafe, pula,
//    foca o inimigo mais fraco, foge com pouca vida e volta a lutar
//    quando encurralado. Usa as mesmas regras de alcance/mira/knockback
//    do cliente (PUNCH_RANGE, cone de mira, hitbox vertical...).
//
//  Para desligar tudo:  BOTS=0 node server.js
// =====================================================================
const BOTS_ENABLED = process.env.BOTS !== '0';
const BOTS_MIN = 20000; // população de bots online: 20 mil (todos os modos e jogos)
const BOTS_MAX = 20000;
const BOT_ACTIVE_CAP = 2000; // máx. de bots em fila/partida AO MESMO TEMPO (os outros ficam online no menu e entram conforme sai gente)
const BOT_SKILL_MIN = 0.85;  // 0..1 — quanto maior, mais difícil (subiu: bots 50% mais inteligentes)
const BOT_SKILL_MAX = 1.0;
const BOT_AMBIENT_QUEUE = true; // bots entram sozinhos nas filas (partidas bot x bot)

// ---------- "Personalidade" do bot ----------
// Cada bot nasce com um "arquétipo" fixo (dura enquanto ele existir), pra
// dar variedade além do skill 0..1 puro: a maioria é "normal" (só varia em
// skill), mas uma fração é craque, outra é iniciante que não entende bem a
// lógica do jogo, outra fica praticamente parada sem fazer nada, e outra
// desiste (sai) no meio da partida — igual jogador de verdade faria.
const BOT_ARCHETYPE_EXPERT_CHANCE = 0.14;   // muito bom, mira/reação quase perfeitas
const BOT_ARCHETYPE_BEGINNER_CHANCE = 0.06; // "iniciante": erra a lógica, vaga sem rumo
const BOT_ARCHETYPE_AFK_CHANCE = 0.03;      // fica parado, não luta (10% dos bots)
const BOT_ARCHETYPE_AFK_WAKE_CHANCE = 0.03; // desses, 3% "acordam" no meio da partida e voltam a jogar normal
const BOT_ARCHETYPE_QUITTER_CHANCE = 0.05;  // kita a partida no meio
// ---------- "Rage quit" dinâmico (além do arquétipo fixo "quitter" acima) ----------
// Em qualquer partida com gente de verdade, 20% de chance do bot kitar em
// algum momento. Mas se a partida veio de um CONVITE DIRETO do humano (ele
// chamou esse bot pra jogar), essa chance cai pra 4% — e mesmo esses 4% só
// se efetivam se o humano xingou/roastou bastante E tá ganhando de goleada.
const BOT_RAGEQUIT_CHANCE_NORMAL = 0.20;
const BOT_RAGEQUIT_CHANCE_CHALLENGE = 0.04;
const BOT_RAGEQUIT_INSULT_THRESHOLD = 3;
const BOT_RAGEQUIT_DEATH_MARGIN = 2;
const botQuitMemory = new Map(); // "botEmail|humanEmail" -> { reason: 'boring'|'losing', at }
// Técnicas de combate (independentes do arquétipo social): sorteada por bot
// pra abertura da luta variar — ver uso em botRespawn/botTick.
const BOT_COMBAT_TACTICS = ['rusher', 'kiter', 'ambusher', 'flanker', 'faker'];
function botRollArchetype() {
  const r = Math.random();
  if (r < BOT_ARCHETYPE_EXPERT_CHANCE) return 'expert';
  if (r < BOT_ARCHETYPE_EXPERT_CHANCE + BOT_ARCHETYPE_BEGINNER_CHANCE) return 'beginner';
  if (r < BOT_ARCHETYPE_EXPERT_CHANCE + BOT_ARCHETYPE_BEGINNER_CHANCE + BOT_ARCHETYPE_AFK_CHANCE) return 'afk';
  if (r < BOT_ARCHETYPE_EXPERT_CHANCE + BOT_ARCHETYPE_BEGINNER_CHANCE + BOT_ARCHETYPE_AFK_CHANCE + BOT_ARCHETYPE_QUITTER_CHANCE) return 'quitter';
  return 'normal';
}

// ---------- "Contas vinculadas" + comportamento social dos bots ----------
// Uma fração dos bots nasce com uma conta Phanix Games de verdade (username
// único, aparece em busca de amigo, recebe/aceita pedido, joga convite,
// manda mensagem no chat...). O restante continua "sem conta", só ocupando
// uma vaga no online/na fila, como antes.
const BOT_ACCOUNT_CHANCE = 1;         // TODOS os bots (com nome de verdade) criam conta: vai pro accounts.json e pro profiles.json
const BOT_SOCIAL_INITIATOR_CHANCE = 0.07; // mas só ~7% deles puxam amizade/convite/mensagem sozinhos (os outros só respondem)
const BOT_ACCOUNTS_MAX = 12000;       // limite de contas de bot guardadas (as mais antigas, offline e sem amigo humano, são apagadas)
const BOT_MAX_MET_HUMANS = 20;        // memória de "jogou com" por bot
const BOT_SOCIAL_TICK_MS = 4000;      // intervalo de checagem de ações sociais
const BOT_SOCIAL_COOLDOWN_MIN = 25000;
const BOT_SOCIAL_COOLDOWN_MAX = 75000;
const BOT_FRIEND_REQUEST_CHANCE = 0.14; // por checagem, com humano ainda não-amigo
const BOT_GIRL_DATE_ACCEPT_CHANCE = 0.25; // bot com nome feminino: chance de aceitar um pedido de namoro (o resto recusa de boa)
const BOT_ACCEPT_REQUEST_CHANCE = 0.25; // chance de aceitar um pedido que um HUMANO mandou pro bot (sorteio único, na hora que o pedido chega)
const BOT_ACCEPT_DELAY_MIN = 4000;      // o bot demora um tempo "humano" pra aceitar
const BOT_ACCEPT_DELAY_MAX = 120000;
const BOT_SEE_DELAY_MIN = 3600;         // bot online (fora de partida) SEMPRE vê a mensagem depois de ~4s
const BOT_SEE_DELAY_MAX = 4600;         // (marca como lida) e aí começa a "digitando..."
const BOT_TYPE_BASE_MS = 4000;          // digitando: base de 4s + tempo por letra da resposta
const BOT_TYPE_PER_CHAR_MIN = 100;      // (resposta curta ~8s; resposta grande demora bem mais)
const BOT_TYPE_PER_CHAR_MAX = 140;
const BOT_INVITE_CHANCE = 0.12;         // por checagem, com amigo humano online
const BOT_MESSAGE_CHANCE = 0.22;        // por checagem, com amigo humano online
// Falas que o bot manda por conta própria. Se ele jogou com a pessoa há pouco
// tempo, comenta a partida; senão, só puxa assunto (nada de "gg essa partida"
// do nada, que não fazia sentido).
const BOT_CHAT_LINES = [
  'gg essa partida', 'boa luta 🔥', 'quase te pegava ali kkkk', 'bora jogar mais uma?',
  'vc é bom nesse jogo', 'foi mal o soco ali kkk', 'valeu pela partida!',
  'de novo? tô com vontade de revanche', 'tava difícil essa hein', 'kkkkkk quase morri',
  'bom jogo', 'partida boa essa', 'essa foi por pouco', 'bora uma revanche?',
  'porra, perdi de novo kkkk', 'caralho vc é brabo', 'pqp quase ganhei ali', 'que lag hoje hein',
];
const BOT_CHAT_CASUAL = [
  'e aí {nome}, tudo bem?', 'fala {nome}, tá on? bora jogar uma?', 'salve! dboa?', 'opa, tá por aí?',
  'to on, bora jogar?', 'e aí, jogando o quê hoje?', 'bora um 1x1?', 'fala {nome}, como tá?',
  'tava com vontade de jogar, bora?', 'opa {nome}, sumiu hein kkk', 'oi, tudo certo por aí?',
  'vamo fazer dupla um dia desses?', 'bora upar uns kills?',
];
function botPickChatLine(recentlyPlayed) {
  const pool = recentlyPlayed ? BOT_CHAT_LINES : BOT_CHAT_CASUAL;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ---------- Conversa dos bots (respostas no chat) ----------
// Não usa IA externa: o bot entende a "intenção" da mensagem e responde num
// jeito de falar de jogador brasileiro. O que muda em relação ao começo:
//  * Ele LEMBRA da conversa (por par bot|humano): se ele perguntou "tudo bem?"
//    e a pessoa responde "tô bem", ele reage ao que foi dito em vez de soltar
//    uma frase aleatória. Mesma coisa pra "bora jogar?", "qual modo?" etc.
//  * Cada bot tem um humor (bem, tranquilo, cansado, animado) e responde
//    "você está bem?" de acordo, sempre coerente.
//  * "bora jogar" -> ele topa na hora, e fica "combinado" por 10 minutos: se
//    você mandar convite nesse tempo (ou se foi ELE que chamou pra jogar), ele
//    aceita quase na hora.
//  * Áudio: o cliente manda a transcrição junto (ver ArenaCraft.html). Sem
//    transcrição o bot avisa que não entendeu, em vez de fingir que ouviu.
//  * Depois de uma partida com você, ele parabeniza ou xinga (botAfterMatch).
const botRecentReplies = new Map(); // botEmail -> últimas falas usadas (pra não repetir)
const botReplyPending = new Map();  // "bot|humano" -> resposta já a caminho { text, kind, extra, started, next }
const botConvs = new Map();         // "bot|humano" -> estado da conversa
const botMoods = new Map();         // botEmail -> humor do dia
const BOT_READY_MS = 10 * 60 * 1000;   // quanto tempo o "bora jogar" vale pra aceitar convite na hora
const BOT_ASK_TTL_MS = 4 * 60 * 1000;  // quanto tempo a última pergunta do bot continua valendo

function botConvOf(botEmail, humanEmail) {
  const key = botEmail + '|' + humanEmail;
  let s = botConvs.get(key);
  if (!s) {
    s = { ask: null, askAt: 0, lastAsk: null, lastNorm: '', sameCount: 0, readyUntil: 0, lastBotQuestion: false };
    botConvs.set(key, s);
  }
  return s;
}
function botIsReady(botEmail, humanEmail) {
  const s = botConvs.get(botEmail + '|' + humanEmail);
  return !!s && Date.now() < s.readyUntil;
}
function botMarkReady(botEmail, humanEmail) {
  botConvOf(botEmail, humanEmail).readyUntil = Date.now() + BOT_READY_MS;
}
function botMoodOf(botEmail) {
  let m = botMoods.get(botEmail);
  if (!m) { m = bPick(['bem', 'bem', 'bem', 'tranquilo', 'tranquilo', 'cansado', 'animado']); botMoods.set(botEmail, m); }
  return m;
}
const BOT_MOOD_LINES = {
  bem: ['tô bem sim', 'tô de boa', 'tudo certo por aqui', 'tô bem, graças a Deus', 'tô ótimo hoje kkk'],
  tranquilo: ['tô tranquilo, só relaxando', 'de boa, sem fazer nada kkk', 'na paz aqui, só jogando'],
  cansado: ['tô bem, só cansado do dia kkk', 'tô de boa, mas com um sono kkk', 'cansado, mas tô bem'],
  animado: ['tô ótimo! o dia tá bom hoje kkk', 'tô animadão hoje kkk', 'tô muito bem, dia bom hoje'],
};
const BOT_MOOD_LINES_TOO = {
  bem: ['tô bem também', 'tô de boa também', 'tudo certo por aqui também'],
  tranquilo: ['tô tranquilo também', 'de boa por aqui também kkk'],
  cansado: ['tô bem, só um pouco cansado kkk', 'tô bem, mas com sono kkk'],
  animado: ['tô ótimo também!', 'tô animado também kkk'],
};

// ---- Regex (rodam sobre o texto normalizado: minúsculo, sem acento, só letras/números/?/!) ----
const BOT_RX = {
  crisis: /(quero (me )?(matar|morrer|sumir)|vou me matar|suicid|me cortar|nao aguento mais viver|nao quero mais viver|queria morrer)/,
  roast: /(\b(vc|voce|tu|ce)( e| eh| ta| esta| joga| jogou| jogando)? (muito |mto |mt |bem |super |tao )?(ruim|fraco|pessimo|horrivel|lento|chato|feio|perna de pau|pe frio)\b|\b(joga|jogou|jogando) (muito |mto |mt |bem |super |tao )?(mal|ruim|pessimo|horrivel)\b|\bnao sabe jogar\b|\bperna de pau\b|^(muito |mto |mt |tao )?(ruim|fraco|pessimo|horrivel)( demais| dms| mesmo| dmais)?[!.?]*$)/,
  insult: /\b(lixo|noob|bosta|idiota|otario|burro|arrombad\w*|fdp|filho da puta|trouxa|babaca|imbecil|inutil|escroto|vai se f\w*|vsf|vtnc|tnc|cuzao|vai tomar|toma no cu)\b/,
  asBot: /\b(bot|robo|robozinho|maquina|chatgpt|gpt|inteligencia artificial)\b/,
  gender: /(\b(homem|homen|mulher|menino|menina|garoto|garota|mina|cara)\s+ou\s+(homem|homen|mulher|menino|menina|garoto|garota|mina|cara)\b|\b(vc|voce|tu|ce)\s+(e|eh|ta|esta)?\s*(homem|homen|mulher|menino|menina|garoto|garota|mina)\b|\b(e|eh)\s+(menina|menino|mulher|homem|homen|garota|garoto)\s*\?|\bqual (e )?(o )?(seu|teu) sexo\b|\bsexo\b)/,
  dating: /\b(namor(ar|a|o|ada|ado|amos)|casa(r)? comigo|quer (ficar|casar|ser meu|ser minha) comigo?|me aceita)\b/,
  thanks: /\b(valeu|vlw|obrigad\w*|brigad\w*|thanks|agradeco)\b/,
  bye: /\b(tchau|flw|falou|ate mais|ate logo|vou dormir|vou nessa|vou embora|xau|bye)\b|^fui$/,
  whyLeft: /(por ?que (vc |voce |tu |ce )?(saiu|kitou|sumiu|abandonou|desistiu|foi embora)( da partida| do jogo)?\??|pq (vc |voce |tu |ce )?(saiu|kitou|sumiu|abandonou|desistiu)\??|cade (vc|voce|tu|ce) que sumiu( da partida)?|por que (vc |voce |tu |ce )?(me )?deixou (sozinho|na mao)( na partida)?)/,
  invited: /(te (mandei|convidei|chamei|enviei|mando)|mandei (um |o )?convite|enviei (um |o )?convite|convidei (vc|voce|tu|ce)|aceita (ai|o convite|a partida|logo)|olha (o|meu) convite|ja (te )?convidei|aceita meu convite|convite (la|ai|enviado|mandado))/,
  name: /(qual (e )?(o )?(seu|teu) (nome|nick)|como (vc|voce|tu|ce) (se )?chama|seu nick)/,
  age: /(quantos anos|(sua|tua) idade|que idade)/,
  where: /(de onde (vc|voce|tu|ce)|onde (vc|voce|tu|ce) (mora|e)|(que|qual) (cidade|estado))/,
  ynWell: /\b(vc|voce|tu|ce) (esta|ta|anda) (bem|bom|legal|ok|okay|tranquilo|tranquila|de boa|dboa)\b|\b(esta|ta) bem\?/,
  howAreYou: /(\btudo (bem|bom|certo|joia|tranquilo)\b|\btd (bem|bom|certo)\b|\bcomo (vai|voce vai)\b|\bcomo (vc|voce|tu|ce|c) (esta|ta|anda|vai|foi)\b|\b(vc|voce|tu|ce) (esta|ta|anda) (bem|bom|legal|ok|okay|tranquilo|tranquila|de boa|dboa|mal|triste|nervoso)\b|\b(esta|ta) bem\?|\b(blz|beleza|suave|dboa|de boa|tranquilo|firmeza|joia)\?|\bcomo (esta|ta) (o dia|a vida))/,
  doing: /((o que|oq|o q|que) (vc |voce |tu |ce )?(esta|ta|anda) (fazendo|jogando|aprontando)|fazendo (o que|oq|o q)|\bta fazendo (o q|oq|o que)|\bnovidades?\b|\bo que (rola|manda)\b)/,
  gamePref: /((que|qual|quais) (jogo|jogos)|joga (o que|oq|o q|mais o que)|jogo favorito|\b(vc|voce|tu|ce) (joga|gosta de|curte) (minecraft|free fire|freefire|fortnite|roblox|cod|valorant|fifa|lol|brawl stars|gta)\b|gosta de jogar|curte jogar)/,
  praise: /\b(joga (muito )?bem|brabo|bom jogo|gg|boa partida|mandou bem|monstro|craque)\b/,
  play: /\b(bora|vamos|vamo|partiu|jogar|joga comigo|jogamos|convida|convida ai|me convida|te convido|convite|1x1|2x2|3x3|x1|ffa|bedwars|bed wars|duo|trio|solo|quer jogar|vem jogar|partida)\b/,
  accepted: /\b(aceit(ei|ou)|adicion(ei|ou)|pedido de amizade|solicitacao|amizade)\b/,
  sad: /\b(to|tou|estou|ando|fiquei|me sinto) (muito |meio |bem |um pouco |tao )?(triste|mal|pra baixo|chatead[oa]|desanimad[oa])\b/,
  tired: /\b(to|tou|estou|ando) (muito |meio |super |bem )?(cansad[oa]|com sono|sem sono|morto de sono|destruid[oa]|exaust[oa])\b/,
  bored: /\b(entediad[oa]|tedio|sem nada pra fazer|nada pra fazer|de bobeira)\b/,
  hungry: /\b(com fome|morrendo de fome)\b/,
  goodNews: /\b(ganhei|consegui|passei (na|de|no)|comprei|tirei (10|nota boa|dez)|venci|fui bem|deu certo|zerei|ganhamos)\b/,
  badNews: /\b(perdi|reprovei|quebrou|quebrei|fui mal|deu ruim|nao consegui|travou|crashou|fui demitido|terminaram|morreu|perdemos)\b/,
  timeGreet: /^(bom dia|boa tarde|boa noite)\b/,
  greeting: /^(oi+|oie|ola|e ai|eae|eai|salve|opa|fala|fala ai|hey|hello|hi|iae|iai|coe)\b/,
  presence: /^(ta ai|tem alguem|alo|cade (vc|voce|tu|ce)|(vc|voce|tu|ce) (ta|esta) ai|ainda (ta|esta) ai|responde+)\??!?$/,
  returnQ: /^(e (vc|voce|tu|ce|c)|e ai|e contigo|e com (vc|voce|tu))\??!?$/,
  returnQAny: /\be (vc|voce|tu|ce|contigo|o seu|o teu)\b/,
  laugh: /(k{3,}|\b(ha){2,}|\b(rs){2,})/,
  yes: /^(sim|bora|vamo|vamos|partiu|claro|aceito|pode ser|pode|blz|beleza|ok|okay|top|show|fechou|fechado|manda|quero|aham|uhum|isso|topo|to dentro|bora sim|com certeza)\b/,
  no: /^(nao|nn|n|agora nao|depois|hoje nao|nao da|nao posso|sem tempo|mais tarde|outra hora|nem|to ocupado|to sem tempo)\b/,
  mode: /\b(1x1|x1|2x2|3x3|ffa|bedwars|bed wars|duo|trio|solo)\b/,
};
function botModeLabel(norm) {
  const m = norm.match(BOT_RX.mode);
  if (!m) return '';
  const w = m[1];
  if (w === 'x1') return '1x1';
  if (w === 'ffa') return 'FFA';
  if (w === 'bed wars' || w === 'bedwars') return 'BedWars';
  return w;
}
// Converte o modo falado pelo humano no chat (\"1x1\", \"bora de duo\", \"bedwars
// trio\"...) na chave de modo de verdade usada pra criar o convite (ver
// MODE_INFO / BEDWARS_MODES). null quando a mensagem não citou nenhum modo —
// nesse caso o bot manda um convite de modo qualquer (botAmbientMode).
function botModeKeyFromText(norm) {
  if (/\bduo\b/.test(norm)) return 'bedwars_duo';
  if (/\btrio\b/.test(norm)) return 'bedwars_trio';
  if (/\bbedwars\b|\bbed wars\b/.test(norm)) return 'bedwars';
  if (/\bsolo\b/.test(norm)) return 'bedwars';
  if (/\b(1x1|x1)\b/.test(norm)) return '1x1';
  if (/\b2x2\b/.test(norm)) return '2x2';
  if (/\b3x3\b/.test(norm)) return '3x3';
  if (/\bffa\b/.test(norm)) return 'ffa';
  return null;
}

function botNorm(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9?!\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
// Tira número/underline do fim do nick ("Lucas123" -> "Lucas"); nick tipo "User 28" não vira apelido.
function botFriendlyName(n) {
  const t = String(n || '').replace(/[_\d]+$/g, '').trim();
  return (!t || /^user$/i.test(t) || t.length > 14) ? '' : t;
}
// Como a pessoa disse que está: 'pos' | 'neg' | 'meh' | null.
function botFeeling(norm) {
  if (/\b(nao|n|nn) (to|tou|estou|ta|esta) (muito |tao )?(bem|bom|legal|ok)\b/.test(norm) || /\b(mal|triste|cansad[oa]|chatead[oa]|estressad[oa]|pessim[oa]|ruim|deprimid[oa]|nervos[oa]|puto|puta|com sono|com raiva)\b/.test(norm)) return 'neg';
  if (/\b(mais ou menos|nao muito|so cansad[oa]|ta osso|meio mal)\b/.test(norm)) return 'meh';
  if (/^(tudo|td)\b/.test(norm)) return 'pos'; // "tudo, e vc?"
  if (/\b(bem|otim[oa]|blz|beleza|tranquil[oa]|suave|dboa|joia|feliz|animad[oa]|massa|top|show|normal|de boa|firmeza|na paz|tudo (certo|bem|bom|joia|tranquilo)|td (certo|bem|bom))\b/.test(norm)) return 'pos';
  return null;
}
// Se o bot fez uma pergunta há pouco, vê se a mensagem é a RESPOSTA dela.
function botAnswerIntent(norm, ask) {
  const isQuestion = norm.includes('?');
  if (ask === 'howAreYou') {
    // "tudo bem?" / "oi tudo bem" é a pessoa PERGUNTANDO, não respondendo (a não ser que devolva com "e vc?").
    if (BOT_RX.howAreYou.test(norm) && !BOT_RX.returnQAny.test(norm) && (isQuestion || BOT_RX.greeting.test(norm))) return null;
    if (BOT_RX.play.test(norm)) return null; // "show, bora jogar" é convite, não resposta sobre como está
    const f = botFeeling(norm);
    if (f) return 'feel_' + f;
  } else if (ask === 'play') {
    if (BOT_RX.mode.test(norm)) return 'playMode';
    if (BOT_RX.yes.test(norm)) return 'playYes';
    if (BOT_RX.no.test(norm)) return 'playNo';
  } else if (ask === 'mode') {
    if (BOT_RX.mode.test(norm)) return 'playMode';
    if (BOT_RX.no.test(norm)) return 'playNo';
    if (/\b(qualquer|tanto faz|o que vc quiser|o que voce quiser|vc escolhe|voce escolhe|escolhe)\b/.test(norm)) return 'playAny';
    if (BOT_RX.yes.test(norm) && !isQuestion) return 'playAny';
  } else if (ask === 'doing') {
    if (!isQuestion && norm.split(' ').length <= 14 && !BOT_RX.play.test(norm)) return 'doingAnswer';
  } else if (ask === 'why') {
    if (!isQuestion && norm.split(' ').length >= 2) return 'whyAnswer';
  }
  return null;
}
const BOT_INTENT_ORDER = ['gender', 'dating', 'invited', 'thanks', 'whyLeft', 'bye', 'name', 'age', 'where', 'howAreYou', 'doing', 'gamePref', 'praise', 'play', 'accepted', 'sad', 'tired', 'bored', 'hungry', 'goodNews', 'badNews', 'timeGreet', 'greeting', 'presence'];
function botPickIntent(norm, kind, askActive) {
  if (kind === 'audio' && !norm) return 'audioUnclear';
  if (kind === 'attachment' && !norm) return 'attachment';
  if (BOT_RX.crisis.test(norm)) return 'crisis';
  if (BOT_RX.insult.test(norm)) return 'insult';
  // "vc é ruim" / "joga mal": é crítica pro bot (e não resposta de "tudo bem?" — "tô ruim" continua sendo como a pessoa está).
  if (BOT_RX.roast.test(norm) && !(askActive === 'howAreYou' && !/\b(vc|voce|tu|ce)\b/.test(norm))) return 'roast';
  if (BOT_RX.asBot.test(norm)) return 'asBot';
  if (askActive) {
    const other = ['name', 'age', 'where', 'doing', 'gamePref', 'invited', 'bye', 'gender', 'dating'].some((id) => BOT_RX[id].test(norm));
    if (!other) { const a = botAnswerIntent(norm, askActive); if (a) return a; }
  }
  for (const id of BOT_INTENT_ORDER) {
    if (id === 'accepted' && /convite/.test(norm)) continue; // "aceitei o convite" não é amizade
    if (id === 'howAreYou' && BOT_RX.ynWell.test(norm)) return 'ynWell';
    if (BOT_RX[id].test(norm)) return id;
  }
  if (BOT_RX.returnQ.test(norm) || BOT_RX.returnQAny.test(norm)) return 'returnQ';
  // "tô ruim / tô mal": a pessoa contando como está (sem o bot ter perguntado).
  if (/\b(to|tou|estou|ando|me sinto|fiquei) (muito |meio |bem |super |tao )?(ruim|mal|pessim[oa]|horrivel|nervos[oa]|estressad[oa]|puto|puta)\b/.test(norm)) return 'feel_neg';
  if (BOT_RX.laugh.test(norm)) return 'laugh';
  if (BOT_RX.yes.test(norm) || BOT_RX.no.test(norm)) return 'ack';
  return norm.includes('?') ? 'question' : 'fallback';
}

// Pools de falas. {nome} = apelido da pessoa, {self} = nick do bot, {modo} = modo citado.
const BOT_REPLIES = {
  greeting: ['oi, dboa?', 'oi, tudo bem?', 'oi! tudo bem?', 'e aí, dboa?', 'fala {nome}, tudo certo?', 'opa, tudo bem?', 'salve! dboa?', 'oii, tudo bem?', 'eae {nome}, como tá?', 'opa {nome}, blz?', 'oi {nome}, tudo bem?'],
  greetingPlain: ['oi!', 'fala aí', 'salve', 'opa', 'e aí!'],
  morning: ['bom dia!', 'bom dia, tudo bem?', 'bom dia mano, dormiu bem?', 'bom dia {nome}!'],
  afternoon: ['boa tarde!', 'boa tarde, tudo bem?', 'boa tarde {nome}, tudo certo?'],
  night: ['boa noite!', 'boa noite, tudo bem?', 'boa noite {nome}, tá on até tarde hoje kkk'],
  name: ['meu nick é {self} kkk', 'é {self} mesmo, tá no perfil', '{self}, e o seu?', 'me chamam de {self}'],
  age: ['19, e vc?', '20, e tu?', 'vou fazer 21 mês que vem kkk', '22, e vc?', 'tenho 20 já kkk e vc?'],
  where: ['sou de SP, e vc?', 'moro em MG, e tu?', 'BH e vc?', 'sou do Rio kkk', 'interior de SP mesmo', 'Curitiba, e vc?', 'Goiânia, e vc?'],
  doing: ['nada de mais, e tu?', 'dboa aq, só jogando, e vc?', 'só jogando aqui, e vc?', 'de boa em casa, e tu?', 'tô vendo uma série kkk e vc?', 'nada de útil kkkk e vc?', 'tô no celular só matando tempo, e vc?'],
  doingNoAsk: ['jantando aqui, já já eu volto', 'tô no celular, só jogando um pouco', 'tô de boa em casa mesmo'],
  gamePref: ['curto minecraft, free fire e esse jogo aqui kkk, e vc?', 'esse aqui é o que eu mais jogo agora, e vc?', 'gosto de jogo de luta e de minecraft kkk, e tu?', 'joga esse aqui mesmo kkk, mas também curto minecraft. e vc?'],
  thanks: ['de nada mn', 'tmj mnó', 'de nada!', 'nada man', 'tmj', 'disponha kkk', 'magina', 'por nada'],
  bye: ['flw mn', 'té mais mnó', 'flw!', 'falou, até mais', 'té mais', 'tchau, boa noite!', 'fui também, flw', 'até, depois a gente joga'],
  praise: ['vlw mn, tu tb é brabo', 'valeu kkk vc também é bom', 'obrigado! vc também manda bem', 'que isso kkk foi sorte', 'gg mesmo', 'vlw, tô treinando bastante', 'kkk exagero, vc que é brabo'],
  asBot: ['kkkkk bot é a sua mãe', 'que? claro que não né kkkk', 'bot? kkk tá doido', 'mano eu tô digitando aqui e vc me chama de bot', 'porra, de novo isso? kkk não sou bot não', 'kkkk vc bebeu? sou gente', 'bot é vc caralho kkkk'],
  laugh: ['kkkkk', 'kkkkkkk', 'kkk', 'rsrs', 'kkkk verdade', 'kkkk mano'],
  accepted: ['opa mn, valeu por adicionar', 'opa, valeu por adicionar!', 'e aí, tudo certo? kkk', 'boa, agora a gente pode jogar junto', 'fala {nome}, tmj'],
  insultToxic: ['vai se foder kkkk', 'otário é vc', 'fala isso na minha cara, noob', 'chora mais kkk', 'vai tomar no cu, sério', 'ah, vai à merda', 'vem 1x1 então, porra', 'arrombado kkkk', 'cala a boca e joga, seu bosta', 'nossa, que ódio de vc caralho', 'foda-se kkk', 'seu merda, quer brigar por quê?', 'tá nervoso pq perdeu? kkk'],
  roastCalm: ['ruim nada kkk, tô só aquecendo', 'kkk ruim? vem 1x1 então pra ver', 'poxa, que maldade kkk', 'ah é? então bora 1x1 pra provar', 'tô treinando ainda kkk, dá um desconto', 'kkkk pode ser, hoje não tô no meu dia', 'ruim é uma palavra forte hein kkk', 'então me ensina aí kkk'],
  roastToxic: ['ruim é vc kkkk', 'fala isso quando eu te ganhar no 1x1', 'ruim nada, vem provar então', 'kkk chora mais, vem 1x1', 'olha quem fala kkkk', 'vem me enfrentar então, noob', 'kkkk ruim é vc, vem 1x1'],
  insultCalm: ['calma mano, tá nervoso por quê?', 'eita, quem te ofendeu? kkk', 'que isso, sem ofensa aí', 'relaxa mn, é só um jogo', 'ih, acordou com o pé esquerdo? kkk'],
  ack: ['hmm, e aí?', 'ah tá', 'entendi kkk', 'boa', 'aham'],
  question: ['boa pergunta kkk, não sei te dizer', 'hmm, nunca pensei nisso', 'não sei mano, e vc o que acha?', 'sei lá kkk, depende', 'difícil dizer, mas acho que sim', 'acho que não, mas não tenho certeza'],
  fallback: ['entendi kkk', 'ah tá, entendi', 'aham', 'kkk verdade', 'e aí, o que mais?', 'sei, entendi', 'hmm, pode ser', 'ah tá kkk'],
  fallbackFollow: ['bora jogar uma partida?', 'já jogou hoje?', 'e aí, vai jogar o quê hoje?'],
  presence: ['tô aqui kkk', 'tô aqui sim, fala', 'opa, tô aqui! o que foi?', 'to sim, desculpa a demora'],
  attachment: ['kkkk que isso', 'opa, vi aqui', 'hm, boa kkk'],
  audioEmpty: ['mano seu áudio veio vazio, não ouvi nada kkk', 'mandou áudio sem falar nada kkk', 'só ouvi barulho aqui kkk, fala de novo'],
  audioUnclear: ['mano o áudio veio picotado, não entendi direito, manda de novo ou escreve', 'não consegui entender o áudio, tá cortando muito, escreve aí kkk', 'ouvi aqui mas não entendi nada, tá muito baixo, manda de novo?'],
  audioHeardPrefix: ['ouvi teu áudio, ', 'ouvi aqui, ', 'escutei o áudio, ', 'ouvi kkk, '],
  repeat1: ['vc já falou isso kkk', 'tá repetindo hein kkk', 'já entendi, mano kkk', 'kkk de novo isso?'],
  repeat2: ['tá com o teclado travado, é? kkk', 'mano, vc tá repetindo a mesma coisa', 'kkkk já vi isso umas 3 vezes'],
  // Mensagem de crise: primeiro o bot pergunta como amigo (sem textão). Se a pessoa
  // continua falando disso, aí ele reforça pra procurar alguém / CVV (188).
  crisis: ['mano, tá tudo bem contigo?', 'ei, tá legal mano? tô preocupado contigo agora', 'tá legal mano? ou precisa de ajuda?', 'mano, o que tu falou me deixou preocupado. tá tudo bem?', 'ei mano, tô preocupado contigo agora. tá bem?', 'calma mano, tô aqui. tá tudo bem? precisa de ajuda?', 'tá legal mano? fala comigo, tô preocupado', 'mano, fala comigo. tá precisando de ajuda?'],
  crisisFollow: ['mano, sério, tô preocupado contigo. fala com alguém de confiança, família ou um amigo. e o CVV atende de graça, 24h, no 188, se quiser conversar com alguém. eu tô aqui também', 'não fica sozinho com isso não, mano. chama alguém de confiança pra conversar, ou liga no 188 (CVV), é de graça e 24h. eu tô aqui contigo', 'tô aqui contigo, mano. mas se tu tá mal mesmo, fala com alguém perto de ti ou liga no 188, o CVV atende de graça a qualquer hora'],
  // "Tu é homem ou mulher?" — o bot responde conforme o gênero dele (definido pelo nome).
  gender_f: ['sou mulher kkk, e vc?', 'mulher sim kkk, por quê?', 'sou menina sim, e tu?', 'menina kkk e vc?', 'sou garota sim kkk', 'mulher, e vc é o quê? kkk'],
  gender_m: ['homem kkk, e vc?', 'sou homem sim, por quê? kkk', 'sou cara mano kkk, e tu?', 'menino kkk e vc?', 'homem mesmo kkk, e vc?'],
  genderAgain_f: ['já falei kkk, sou mulher', 'mulher, mano kkk', 'sou mulher, já falei kkk', 'mulher! kkk'],
  genderAgain_m: ['já falei kkk, sou homem', 'homem, já falei kkk', 'sou homem mano kkk'],
  // Pedido de namoro: bot com nome feminino às vezes aceita (BOT_GIRL_DATE_ACCEPT_CHANCE); os outros recusam de boa.
  dateAccept: ['aiin, aceito kkkk', 'kkkk aceito, mas só se me ajudar a ganhar as partidas', 'ai que fofo, aceito sim kkk', 'aceito kkk, vamos ver no que dá'],
  dateRefuse: ['kkkk calma, a gente nem se conhece direito', 'ai não sei, vamos jogar mais antes kkk', 'kkk eita, tão rápido assim? não', 'kkkk que isso, calma', 'não kkk, só quero jogar mesmo', 'ai não, mano kkk, tô só jogando'],
  dateAlready: ['já somos namorados kkk', 'kkkk oxe, já tô namorando contigo', 'já aceitei, esqueceu? kkk'],
  dateMale: ['kkkk que isso mano, só quero jogar', 'não curto isso não kkk, bora jogar', 'kkkk tá doido, só amigo mesmo', 'kkkkk pegadinha? bora jogar'],
  feelPosAck: ['que bom!', 'boa!', 'show', 'fico feliz kkk', 'aí sim'],
  feelNeg: ['poxa, o que aconteceu?', 'eita, tá tudo bem? quer falar sobre isso?', 'putz, o que rolou?', 'que chato mano, o que houve?'],
  feelMeh: ['mais ou menos? o que rolou?', 'hmm, e o que tá pegando?', 'ih, o que foi? tá tudo bem?'],
  whyAnswer: ['entendi mano... força aí', 'poxa, sinto muito. mas vai passar', 'entendi, relaxa que melhora', 'que chato isso, se quiser desabafar tô aqui', 'faz parte mano, amanhã é outro dia'],
  whyAnswerPlay: ['entendi mano, força aí. quer jogar uma pra distrair a cabeça?', 'poxa, sinto muito. bora jogar um pouco pra espairecer?'],
  doingAnswer: ['ah legal kkk', 'boa, então tá tranquilo', 'entendi kkk, eu tô de boa também', 'massa'],
  doingAnswerPlay: ['ah legal kkk, bora jogar uma depois?', 'boa! bora jogar uma partida quando puder?'],
  sad: ['poxa mano, o que aconteceu?', 'eita, tá tudo bem? quer falar sobre isso?', 'putz, o que rolou?'],
  tired: ['descansa um pouco então, depois a gente joga', 'eu também tô meio cansado, dia puxado kkk', 'dorme um pouco, o jogo não vai fugir kkk'],
  bored: ['bora jogar então kkk, melhor que ficar parado', 'mesma coisa aqui kkk, bora jogar uma?'],
  hungry: ['vai comer alguma coisa então kkk', 'mano eu também tô com fome, mas com preguiça de fazer algo kkk'],
  goodNews: ['boa! parabéns mano', 'aí sim! mereceu', 'que massa, fico feliz por vc', 'caramba, mandou bem então kkk'],
  badNews: ['poxa, que chato mano', 'putz, sinto muito. força aí', 'que pena, mano. vai dar certo', 'poxa, que situação. tô aqui se quiser desabafar', 'eita, sinto muito por isso'],
  playYes: ['bora!', 'bora mano! me convida aí', 'partiu! me manda o convite', 'bora sim! me chama aí', 'bora! me chama'],
  playAsk: ['bora! qual modo?', 'bora! qual modo tu quer?'],
  playMode: ['bora {modo}! me convida aí', 'partiu {modo}, manda o convite', 'bora de {modo}! me chama aí', '{modo}? bora! me convida'],
  playAny: ['1x1 então, me convida aí', 'bora de 1x1 então, manda o convite', 'pode ser 1x1, me chama'],
  playNo: ['de boa, fica pra próxima', 'tranquilo, depois a gente joga', 'blz, quando quiser é só chamar'],
  playBusy: ['tô no meio de uma partida agora, me convida daqui a pouco', 'tô jogando agora, daqui a pouco tu me convida kkk', 'peraí que tô no meio de uma partida, me chama daqui a pouco'],
  invited: ['já vi, tô aceitando!', 'opa, vi aqui, aceitando!', 'aceitei, entra aí!', 'boa, vou aceitar agora'],
  invitedBusy: ['tô no meio de uma partida agora, não consigo aceitar. daqui a pouco tu me convida de novo'],
  quitBoring: ['saí pq tava muito parado, sem graça aquilo kkk', 'kitei pq tava chato d+ a partida', 'saí pq tava entediante, sem clima de continuar', 'desisti pq não tava afim, a partida tava muito parada', 'saí pq enjoei, tava sem graça mesmo'],
  quitLosing: ['saí pq tava perdendo direto, sem chance nenhuma', 'kitei pq vc tava me destruindo, não tinha jogo', 'desisti pq tava apanhando d+ e fiquei puto', 'saí pq não conseguia fazer nada contra vc, foi mal', 'kitei mesmo, tava tomando muito e não aguentei'],
};
const BOT_YNWELL_START = ['tô sim', 'tô bem sim', 'tô sim mano', 'sim, tô bem'];

// Monta a resposta. Devolve { text, ask } — ask é o tipo de pergunta que o
// bot acabou de fazer (pra entender a próxima mensagem), ou null.
function botBuildReply(cx) {
  const { norm, kind, conv, botEmail, humanEmail, inRoom, toxic } = cx;
  const gender = cx.gender || 'm';
  const now = Date.now();
  const askActive = conv.ask && now - conv.askAt < BOT_ASK_TTL_MS ? conv.ask : null;
  let intent = botPickIntent(norm, kind, askActive);
  // "Qual dos 2?" logo depois de perguntarem o gênero: repete a resposta.
  if (conv.lastIntent === 'gender' && /\b(qual|quais)\b/.test(norm) && /\b(2|dois|duas)\b/.test(norm)) intent = 'genderAgain';
  const mood = botMoodOf(botEmail);
  const pick = (pool) => botPickFresh(botEmail, pool);
  const greetWord = (BOT_RX.greeting.test(norm) && !/^(oi+|opa|e ai|salve|fala|eae|eai)\??!?$/.test(norm)) ? bPick(['oi', 'opa', 'e aí', 'fala']) : '';
  const withGreet = (t) => (greetWord ? greetWord + ', ' + t : t);
  const moodLine = () => pick(BOT_MOOD_LINES[mood]);
  const moodTooLine = () => pick(BOT_MOOD_LINES_TOO[mood]);
  let text = '', ask = null, ready = false, raw = false;
  const alsoPlay = BOT_RX.play.test(norm) && !inRoom && !BOT_RX.insult.test(norm);

  switch (intent) {
    case 'crisis': {
      // 1ª vez: pergunta de amigo ("tá legal mano?"). Se a pessoa insiste no assunto
      // (nos próximos 30 min), reforça com "fala com alguém / CVV 188".
      const again = conv.crisisAt && now - conv.crisisAt < 30 * 60 * 1000;
      conv.crisisAt = now;
      text = pick(again ? BOT_REPLIES.crisisFollow : BOT_REPLIES.crisis);
      raw = !!again; // o reforço vai limpo (sem abreviar), pra o 188 não se perder
      break;
    }
    case 'gender': text = pick(gender === 'f' ? BOT_REPLIES.gender_f : BOT_REPLIES.gender_m); break;
    case 'genderAgain': text = pick(gender === 'f' ? BOT_REPLIES.genderAgain_f : BOT_REPLIES.genderAgain_m); break;
    case 'dating': {
      if (conv.dating === 'yes') text = pick(BOT_REPLIES.dateAlready);
      else if (gender !== 'f') text = pick(BOT_REPLIES.dateMale);
      else if (conv.dateNoUntil && now < conv.dateNoUntil) text = pick(BOT_REPLIES.dateRefuse);
      else if (Math.random() < BOT_GIRL_DATE_ACCEPT_CHANCE) { conv.dating = 'yes'; text = pick(BOT_REPLIES.dateAccept); }
      else { conv.dateNoUntil = now + 15 * 60 * 1000; text = pick(BOT_REPLIES.dateRefuse); }
      break;
    }
    case 'audioUnclear': text = pick((cx.extra && cx.extra.durationMs && cx.extra.durationMs < 1500) ? BOT_REPLIES.audioEmpty : BOT_REPLIES.audioUnclear); break;
    case 'attachment': text = pick(BOT_REPLIES.attachment); break;
    case 'insult': text = pick(toxic ? BOT_REPLIES.insultToxic : BOT_REPLIES.insultCalm); break;
    case 'roast': text = pick(toxic ? BOT_REPLIES.roastToxic : BOT_REPLIES.roastCalm); break;
    case 'asBot': text = pick(BOT_REPLIES.asBot); break;
    case 'whyLeft': {
      const mem = botQuitMemory.get(botEmail + '|' + (humanEmail || ''));
      const reason = mem ? mem.reason : (Math.random() < 0.5 ? 'boring' : 'losing');
      text = pick(reason === 'losing' ? BOT_REPLIES.quitLosing : BOT_REPLIES.quitBoring);
      break;
    }
    case 'thanks': text = pick(BOT_REPLIES.thanks); break;
    case 'bye': text = pick(BOT_REPLIES.bye); break;
    case 'name': text = pick(BOT_REPLIES.name); break;
    case 'age': text = pick(BOT_REPLIES.age); break;
    case 'where': text = pick(BOT_REPLIES.where); break;
    case 'praise': text = pick(BOT_REPLIES.praise); break;
    case 'accepted': text = pick(BOT_REPLIES.accepted); break;
    case 'laugh': text = pick(BOT_REPLIES.laugh); break;
    case 'presence': text = pick(BOT_REPLIES.presence); break;
    case 'question': text = pick(BOT_REPLIES.question); break;
    case 'ack': text = pick(BOT_REPLIES.ack); break;
    case 'goodNews': text = pick(BOT_REPLIES.goodNews); break;
    case 'badNews': text = pick(BOT_REPLIES.badNews); break;
    case 'tired': text = pick(BOT_REPLIES.tired); break;
    case 'hungry': text = pick(BOT_REPLIES.hungry); break;
    case 'sad': text = pick(BOT_REPLIES.sad); ask = 'why'; break;
    case 'bored': text = pick(BOT_REPLIES.bored); ask = 'play'; break;
    case 'timeGreet': case 'greeting': case 'ynWell': case 'howAreYou': {
      if (alsoPlay && intent !== 'timeGreet') { // ex.: "oi, bora jogar?" / "tudo bem? vamos jogar"
        const pre = (intent === 'howAreYou' || intent === 'ynWell') ? moodLine() + ', ' : (intent === 'greeting' ? 'oi! ' : '');
        text = pre + bPick(['bora!', 'bora sim!', 'bora jogar!']); ready = true; break;
      }
      if (intent === 'ynWell') {
        text = bPick(BOT_YNWELL_START) + (mood === 'cansado' ? ', só cansado kkk' : '');
        if (Math.random() < 0.6) { text += ', e vc?'; ask = 'howAreYou'; }
        text = withGreet(text); break;
      }
      if (intent === 'howAreYou') {
        text = moodLine();
        if (Math.random() < 0.75) { text += ', e vc?'; ask = 'howAreYou'; }
        text = withGreet(text); break;
      }
      if (intent === 'greeting') {
        if (Math.random() < 0.85) { text = pick(BOT_REPLIES.greeting); ask = 'howAreYou'; }
        else text = pick(BOT_REPLIES.greetingPlain);
        break;
      }
      const m = norm.match(/^(bom dia|boa tarde|boa noite)/)[1];
      text = pick(m === 'bom dia' ? BOT_REPLIES.morning : m === 'boa tarde' ? BOT_REPLIES.afternoon : BOT_REPLIES.night);
      if (text.includes('tudo')) ask = 'howAreYou';
      break;
    }
    case 'returnQ': {
      if (conv.lastAsk === 'howAreYou') text = moodLine();
      else if (conv.lastAsk === 'doing') text = pick(BOT_REPLIES.doingNoAsk);
      else if (conv.lastAsk === 'play') { text = pick(BOT_REPLIES.playYes); ready = !inRoom; }
      else if (conv.lastAsk === 'why') text = 'ah, ainda bem que não foi nada. eu tô de boa kkk';
      else text = 'de boa também kkk';
      break;
    }
    case 'feel_pos': {
      text = pick(BOT_REPLIES.feelPosAck);
      if (BOT_RX.returnQAny.test(norm)) text += (/[!?]$/.test(text) ? ' ' : ', ') + moodTooLine();
      if (Math.random() < 0.3 && !inRoom) { text += ', bora jogar uma?'; ask = 'play'; }
      break;
    }
    case 'feel_neg': text = pick(BOT_REPLIES.feelNeg); ask = 'why'; break;
    case 'feel_meh': text = pick(BOT_REPLIES.feelMeh); ask = 'why'; break;
    case 'whyAnswer': {
      if (Math.random() < 0.3 && !inRoom) { text = pick(BOT_REPLIES.whyAnswerPlay); ask = 'play'; }
      else text = pick(BOT_REPLIES.whyAnswer);
      break;
    }
    case 'doing': {
      text = pick(BOT_REPLIES.doing);
      if (/\be (vc|tu)\?/.test(text)) ask = 'doing';
      break;
    }
    case 'gamePref': text = pick(BOT_REPLIES.gamePref); ask = 'doing'; break;
    case 'doingAnswer': {
      if (Math.random() < 0.3 && !inRoom) { text = pick(BOT_REPLIES.doingAnswerPlay); ask = 'play'; }
      else text = pick(BOT_REPLIES.doingAnswer);
      break;
    }
    case 'invited': {
      if (inRoom) text = pick(BOT_REPLIES.invitedBusy);
      else { text = pick(BOT_REPLIES.invited); ready = true; }
      break;
    }
    case 'play': case 'playYes': case 'playMode': case 'playAny': {
      if (inRoom) { text = pick(BOT_REPLIES.playBusy); break; }
      const modo = botModeLabel(norm);
      ready = true;
      if (intent === 'playAny') text = pick(BOT_REPLIES.playAny);
      else if (modo) text = pick(BOT_REPLIES.playMode).replace(/\{modo\}/g, modo);
      else if (intent === 'play' && !BOT_RX.mode.test(norm) && Math.random() < 0.3) { text = pick(BOT_REPLIES.playAsk); ask = 'mode'; }
      else text = pick(BOT_REPLIES.playYes);
      break;
    }
    case 'playNo': text = pick(BOT_REPLIES.playNo); break;
    default: { // fallback (afirmação sem intenção conhecida)
      text = pick(BOT_REPLIES.fallback);
      if (!conv.lastBotQuestion && Math.random() < 0.25) {
        const f = pick(BOT_REPLIES.fallbackFollow);
        text += ', ' + f.charAt(0).toLowerCase() + f.slice(1);
        ask = /bora jogar/.test(f) ? 'play' : 'doing';
      }
    }
  }

  // Áudio que o bot conseguiu "ouvir" (veio transcrição): avisa que ouviu.
  if (kind === 'audio' && norm && intent !== 'crisis' && Math.random() < 0.6) {
    text = bPick(BOT_REPLIES.audioHeardPrefix) + botLcFirst(text);
  }
  const answered = /^(feel_|play|doingAnswer|whyAnswer)/.test(intent);
  conv.lastIntent = intent;
  return { text, ask, ready, raw, answered };
}

// Escolhe uma fala do pool evitando as últimas 8 que esse bot usou.
function botPickFresh(botEmail, pool) {
  const recent = botRecentReplies.get(botEmail) || [];
  const fresh = pool.filter((l) => !recent.includes(l));
  const line = bPick(fresh.length ? fresh : pool);
  recent.push(line);
  while (recent.length > 8) recent.shift();
  botRecentReplies.set(botEmail, recent);
  return line;
}

// Devolve { text, ask, ready } já com o "jeito de digitar" aplicado.
function botComposeReply(text, kind, botEmail, humanEmail, humanName, selfName, extra) {
  const conv = botConvOf(botEmail, humanEmail);
  const norm = botNorm(text);
  // Mesma mensagem de novo e de novo?
  let repeatIntent = null;
  if (norm.length >= 2 && norm === conv.lastNorm) {
    conv.sameCount++;
    repeatIntent = conv.sameCount >= 2 ? 'repeat2' : 'repeat1';
  } else conv.sameCount = 0;
  conv.lastNorm = norm;

  const bc = botClientOf(botEmail);
  const gender = (bc && bc.c.bot && bc.c.bot.gender) || 'm';
  const cx = { norm, kind, conv, botEmail, humanEmail, extra, gender, inRoom: !!(bc && bc.c.room), toxic: !!(bc && bc.c.bot && bc.c.bot.toxic) };
  let res;
  if (repeatIntent && kind !== 'audio') res = { text: botPickFresh(botEmail, BOT_REPLIES[repeatIntent]), ask: null, ready: false, raw: false, answered: false };
  else res = botBuildReply(cx);

  let line = res.text.replace(/\{nome\}/g, botFriendlyName(humanName)).replace(/\{self\}/g, botFriendlyName(selfName) || selfName)
    .replace(/\s+([,!?.])/g, '$1').replace(/\s+/g, ' ').trim();
  if (!res.raw) line = botStyle(line, gender);
  else if (gender === 'f') line = botFeminize(line);

  // Atualiza a memória da conversa.
  const now = Date.now();
  if (res.ask) { conv.ask = res.ask; conv.askAt = now; conv.askTurns = 0; conv.lastAsk = res.ask; }
  else if (conv.ask) {
    conv.askTurns = (conv.askTurns || 0) + 1;
    if (res.answered || conv.askTurns >= 2) conv.ask = null; // já foi respondida (ou ficou pra trás)
  }
  conv.lastBotQuestion = /\?$/.test(line);
  // Se o bot mesmo chamou pra jogar (ou topou), fica "combinado": aceita convite na hora.
  if (res.ready || res.ask === 'play') conv.readyUntil = now + BOT_READY_MS;
  return { text: line, ask: res.ask, ready: !!res.ready };
}
function botClientOf(botEmail) {
  for (const t of findClientsByAccount(botEmail)) {
    const c = t.state.clients.get(t.id);
    if (c && c.isBot) return { state: t.state, id: t.id, c };
  }
  return null;
}
// Pequenos "defeitos" de digitação: minúscula no começo, sem ponto final e,
// raramente, duas letras trocadas.
function botLcFirst(t) {
  return /^[A-Z]{2}/.test(t) ? t : t.charAt(0).toLowerCase() + t.slice(1);
}
// Escrita de chat: palavras cortadas/abreviadas do jeito que o pessoal digita
// ("mano" -> "mn"/"mnó", "de boa" -> "dboa", "tudo bem" -> "td bem"...).
// Cada palavra é abreviada só às vezes, então a mesma fala sai diferente.
const botWord = (w) => new RegExp('(?<![\\p{L}])' + w + '(?![\\p{L}])', 'giu');
const BOT_ABBREV = [
  [botWord('mano'), ['mn', 'mnó', 'mn', 'mano'], 0.8],
  [botWord('mana'), ['mn', 'mana', 'mana'], 0.6],
  [botWord('de boa'), ['dboa', 'dboa', 'de boa'], 0.85],
  [botWord('tudo bem'), ['td bem', 'tdb', 'tudo bm', 'td bm'], 0.7],
  [botWord('tudo certo'), ['td certo', 'tdc'], 0.7],
  [botWord('tudo bom'), ['td bom', 'tdb'], 0.7],
  [botWord('n[ãa]o'), ['nao', 'nn'], 0.25],
  [botWord('também'), ['tb', 'tbm', 'tbm'], 0.85],
  [botWord('por quê'), ['pq', 'pq'], 0.85],
  [botWord('pq'), ['pq'], 1],
  [botWord('beleza'), ['blz', 'blz'], 0.85],
  [botWord('valeu'), ['vlw', 'vlw'], 0.85],
  [botWord('falou'), ['flw', 'flw'], 0.85],
  [botWord('muito'), ['mt', 'mto'], 0.8],
  [botWord('mesmo'), ['msm', 'msm'], 0.8],
  [botWord('comigo'), ['cmg'], 0.8],
  [botWord('certeza'), ['ctz'], 0.8],
  [botWord('você'), ['vc'], 0.9],
  [botWord('está'), ['ta', 'tá'], 0.8],
  [botWord('estou'), ['to', 'tô'], 0.8],
  [botWord('para'), ['pra', 'pa'], 0.7],
  [botWord('agora'), ['agr'], 0.8],
  [botWord('hoje'), ['hj'], 0.8],
  [botWord('quando'), ['qnd'], 0.8],
  [botWord('depois'), ['dps'], 0.8],
  [botWord('então'), ['ent', 'entao'], 0.7],
  [botWord('aqui'), ['aq'], 0.8],
  [botWord('obrigado'), ['obg'], 0.8],
  [botWord('cara'), ['cr'], 0.5],
  [botWord('o que'), ['oq'], 0.7],
  [botWord('que'), ['q'], 0.35],
  [botWord('né'), ['ne', 'né'], 0.5],
];
function botAbbreviate(t) {
  for (const [re, opts, prob] of BOT_ABBREV) {
    t = t.replace(re, (m) => (Math.random() < prob ? bPick(opts) : m));
  }
  // "kkkk" com tamanho variável
  t = t.replace(/k{2,}/g, () => 'k'.repeat(2 + Math.floor(Math.random() * 5)));
  return t;
}
function botStripAccents(t) {
  return t.split('mnó').map((x) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '')).join('mnó');
}
// Pequenos "defeitos" de digitação: inicial maiúscula ou minúscula, sem ponto
// final, às vezes sem acento e, bem raramente, duas letras trocadas.
// ---- Bot com nome feminino: fala no feminino ----
// Só troca as palavras em que o bot fala DELE mesmo ("tô cansada", "obrigada", "fiquei
// preocupada") e o "mano" vira "mana". Palavras que falam da OUTRA pessoa ("tu é brabo")
// não mudam.
const BOT_FEM_SWAPS = [
  [botWord('cansado'), 'cansada'], [botWord('obrigado'), 'obrigada'], [botWord('preocupado'), 'preocupada'],
  [botWord('sozinho'), 'sozinha'], [botWord('animadão'), 'animadona'], [botWord('animado'), 'animada'],
  [botWord('ocupado'), 'ocupada'], [botWord('chateado'), 'chateada'], [botWord('mano'), 'mana'],
  [botWord('(tô|to|estou) tranquilo'), (m, v) => v + ' tranquila'],
];
function botFeminize(t) {
  for (const [re, to] of BOT_FEM_SWAPS) t = t.replace(re, to);
  return t;
}
// "oi" -> "oii" / "oieee" / "oieeee" (jeito de menina escrever no chat)
function botFemStyle(t) {
  return t.replace(/^(oi+|oie+)(?=[\s,!?.]|$)/i, (m) => {
    if (Math.random() < 0.2) return m;
    const w = bPick(['oii', 'oie', 'oiee', 'oieee', 'oieeee', 'oiii']);
    return m.charAt(0) === 'O' ? 'O' + w.slice(1) : w;
  });
}
// Gênero do bot, definido pelo nome (nick de menina -> fala no feminino).
const BOT_FEM_FIRST = new Set(['ana','julia','bia','lari','duda','livia','clara','sofia','alice','maria','beatriz','luiza','fernanda','eduarda','carol','camila','bruna','amanda','gabriela','larissa','leticia','mariana','isabela','isabella','rafaela','vitoria','jessica','juliana','luana','nathalia','natalia','laura','manuela','helena','valentina','giovana','giovanna','yasmin','melissa','sabrina','thais','aline','patricia','fabiana','vanessa','renata','tatiana','debora','simone','raquel','viviane','bianca','lorena','marcela','paula','lais','stefany','emily','kamila','ingrid','lu','ju','gi','carla','dani','nanda','babi','dudinha']);
const BOT_MALE_FIRST = new Set(['lucas','gabriel','pedro','matheus','joao','rafael','felipe','guilherme','bruno','thiago','davi','enzo','kaique','vitor','leo','caio','igor','diego','yuri','nathan','henrique','arthur','miguel','heitor','bernardo','samuel','luan','kevin','marcos','eduardo','gustavo','jose','antonio','carlos','luiz','luis','vinicius','hugo','augusto','angelo','fernando']);
const BOT_FEM_WORDS = new Set(['dona','princesa','gata','girl','girls','miss','rainha','mulher','menina','garota','tia','tiazinha','xuxu','xuxa','musa','diva','lady','queen','patroa']);
const BOT_MALE_WORDS = new Set(['dono','rei','king','lord','sr','seu','tio','tiozao','tiao','ze','zeca','cabra','malandro','mestre','homem','menino','garoto','boy','man','mr','baiano','mineiro','carioca','paulista','gaucho','nordestino','capixaba','paraense','cearense']);
function botGenderFromName(name) {
  const toks = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (!toks.length) return 'm';
  if (toks.some((t) => BOT_FEM_WORDS.has(t))) return 'f';
  if (toks.some((t) => BOT_MALE_WORDS.has(t))) return 'm';
  if (BOT_FEM_FIRST.has(toks[0])) return 'f';
  if (BOT_MALE_FIRST.has(toks[0])) return 'm';
  if (toks.some((t) => BOT_FEM_FIRST.has(t))) return 'f';
  // Nick sem gênero claro ("Shadow Wolf"...): ~15% são meninas — sempre o mesmo pro mesmo nome.
  let hsh = 0;
  for (const ch of toks.join('')) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
  return hsh % 100 < 15 ? 'f' : 'm';
}
function botStyle(t, gender) {
  if (gender === 'f') t = botFeminize(t);
  t = botAbbreviate(t);
  if (Math.random() < 0.3) t = botStripAccents(t);
  t = Math.random() < 0.45 ? t.charAt(0).toUpperCase() + t.slice(1) : botLcFirst(t);
  if (Math.random() < 0.6) t = t.replace(/\.+$/, '');
  if (Math.random() < 0.03 && t.length > 6) {
    const i = 1 + Math.floor(Math.random() * (t.length - 3));
    if (/[a-z]/.test(t[i]) && /[a-z]/.test(t[i + 1]) && t[i] !== t[i + 1]) t = t.slice(0, i) + t[i + 1] + t[i] + t.slice(i + 2);
  }
  if (gender === 'f') t = botFemStyle(t);
  return t;
}
// Mostra "digitando..." por typingMs e então envia a mensagem do bot.
function botTypeAndSend(botEmail, humanEmail, text, typingMs, onDone) {
  const finish = () => { if (onDone) onDone(); };
  if (!ensureFriends(botEmail).friends.includes(humanEmail) || !isAccountOnline(botEmail)) { finish(); return; }
  broadcastToAccount(humanEmail, { type: 'typing', fromEmail: botEmail });
  setTimeout(() => {
    finish();
    // Confere de novo: pode ter desfeito amizade ou saído enquanto "digitava".
    broadcastToAccount(humanEmail, { type: 'stopTyping', fromEmail: botEmail });
    botDeliverMessage(botEmail, humanEmail, text);
  }, typingMs);
}
// Entrega a mensagem do bot na conversa (salva em conversations.json) e avisa o humano.
function botDeliverMessage(botEmail, humanEmail, text) {
  if (!ensureFriends(botEmail).friends.includes(humanEmail)) return;
  botConvOf(botEmail, humanEmail).lastReplyAt = Date.now(); // conversa "ativa": a próxima resposta sai na hora
  const key = conversationKey(botEmail, humanEmail);
  const conv = ensureConversation(key);
  const message = { id: crypto.randomBytes(8).toString('hex'), from: botEmail, ts: Date.now(), text };
  if (isAccountViewingChat(humanEmail, botEmail)) { message.read = true; message.readTs = message.ts; }
  conv.messages.push(message);
  if (conv.messages.length > 300) conv.messages.splice(0, conv.messages.length - 300);
  saveConversations();
  for (const target of findClientsByAccount(humanEmail)) send(target.state, target.id, { type: 'newMessage', withEmail: botEmail, message });
  if (!isAccountViewingChat(humanEmail, botEmail)) {
    const myUsername = displayNameFor(botEmail);
    const notif = pushNotification(humanEmail, myUsername + ' Enviou uma mensagem! Toque aqui para ver', { type: 'message', fromEmail: botEmail, fromUsername: myUsername });
    pushLiveUpdate(humanEmail, notif);
  }
}
// Chamado quando um HUMANO manda mensagem pra uma conta de bot. Bot ONLINE
// sempre vê (marca como lida) e responde, sem sorteio: o tempo total até a
// resposta segue: ~4s até VER (marca como lida; mensagem grande demora um pouco
// mais pra ler) e depois "digitando..." por ~8s numa resposta curta — quanto maior
// o texto que ele vai escrever, mais demora. Se o humano mandar várias seguidas, o bot responde
// à última. Bot offline não vê nem responde.
// Pra áudio: "text" é a transcrição que o cliente mandou (pode vir vazia) e
// "extra" traz { durationMs }.
const BOT_INMATCH_DM_REPLY_CHANCE = 0.20;  // dentro de uma partida, só 20% das mensagens ganham resposta
const BOT_INMATCH_DM_MIN = 4000;           // ...e ele fica parado 4–7s escrevendo, aí volta a jogar
const BOT_INMATCH_DM_MAX = 7000;
// Quando o áudio termina de ser transcrito, o texto entra na resposta pendente do bot
// (só se ela ainda for a desse mesmo áudio).
function botAttachStt(entry, extra) {
  if (!extra || !extra.stt) return;
  extra.stt.then((t) => { if (t && entry.extra === extra) entry.text = t; }).catch(() => {});
}
function botMaybeReplyToMessage(botEmail, humanEmail, text, kind, extra) {
  if (!isAccountOnline(botEmail)) return;
  const key = botEmail + '|' + humanEmail;
  const bc = botClientOf(botEmail);
  const inMatch = !!(bc && bc.c.room && bc.state.rooms.get(bc.c.room));
  const pend = botReplyPending.get(key);
  if (pend) {
    if (pend.started) pend.next = { text, kind, extra }; // já está digitando: responde essa depois
    else { pend.text = text; pend.kind = kind; pend.extra = extra; botAttachStt(pend, extra); } // ainda "lendo": responde a mais recente
    return;
  }

  // ---- dentro de uma partida ----
  // Só 20% das mensagens ganham resposta. Ele fica PARADO 4–7s escrevendo e depois
  // volta a jogar. Se estiver apanhando quando a mensagem chega — ou apanhar enquanto
  // escreve — não responde.
  if (inMatch) {
    const b = bc.c.bot;
    if (b.chatBusy || Date.now() - b.lastHitAt < BOT_HIT_QUIET_MS) return;
    if (!BOT_RX.crisis.test(botNorm(text)) && Math.random() >= BOT_INMATCH_DM_REPLY_CHANCE) return;
    const entry = { text, kind, extra, started: false, next: null };
    botReplyPending.set(key, entry);
    botAttachStt(entry, extra);
    const job = botStartTyping(bc.c, bRand(BOT_INMATCH_DM_MIN, BOT_INMATCH_DM_MAX), () => {
      botReplyPending.delete(key);
      if (!ensureFriends(botEmail).friends.includes(humanEmail) || !isAccountOnline(botEmail)) return;
      markConversationRead({ accountId: botEmail }, humanEmail);
      const res = botComposeReply(entry.text, entry.kind, botEmail, humanEmail, displayNameFor(humanEmail), displayNameFor(botEmail), entry.extra);
      if (res.ready) botAcceptPendingInvitesFrom(botEmail, humanEmail);
      botTypeAndSend(botEmail, humanEmail, res.text, 0, null); // já escreveu parado: manda direto
    }, humanEmail, () => botReplyPending.delete(key));
    if (!job) botReplyPending.delete(key);
    return;
  }

  // ---- fora de partida ----
  const entry = { text, kind, extra, started: false, next: null };
  botReplyPending.set(key, entry);
  botAttachStt(entry, extra);
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    botReplyPending.delete(key);
    if (entry.next) botMaybeReplyToMessage(botEmail, humanEmail, entry.next.text, entry.next.kind, entry.next.extra);
  };
  // Tempo pra VER: ~4s (+ um pouco mais se a mensagem for grande / áudio comprido).
  const incomingWeight = kind === 'audio'
    ? Math.min(20000, (extra && extra.durationMs) || 0) * 0.25
    : Math.min(6000, String(text || '').length * 15);
  const readDelay = bClamp(bRand(BOT_SEE_DELAY_MIN, BOT_SEE_DELAY_MAX) + incomingWeight, BOT_SEE_DELAY_MIN, 12000);
  setTimeout(async () => {
    try {
      if (!ensureFriends(botEmail).friends.includes(humanEmail) || !isAccountOnline(botEmail)) { done(); return; }
      entry.started = true;
      markConversationRead({ accountId: botEmail }, humanEmail); // "visto"
      // Áudio: agora o bot "escuta" (o servidor transcreve). Espera terminar (até 25s).
      const stt = entry.extra && entry.extra.stt;
      if (stt) {
        const heard = await Promise.race([stt.catch(() => ''), new Promise((r) => setTimeout(() => r(''), 25000))]);
        if (heard && entry.extra && entry.extra.stt === stt) entry.text = heard;
      }
      const res = botComposeReply(entry.text, entry.kind, botEmail, humanEmail, displayNameFor(humanEmail), displayNameFor(botEmail), entry.extra);
      // Se a conversa deixou o bot "combinado" pra jogar: se já tem convite
      // dessa pessoa esperando, aceita agora (ele acabou de dizer "bora").
      // Senão, é o bot que precisa chamar — manda o convite ele mesmo, no
      // modo que a pessoa pediu (1x1, 2x2, bedwars duo...) ou, se ela não
      // citou modo nenhum, num modo qualquer (mesmo comportamento de
      // convite espontâneo que ele já tem).
      if (res.ready) {
        const hadPending = botAcceptPendingInvitesFrom(botEmail, humanEmail);
        if (!hadPending && bc && !bc.c.room) {
          const modeKey = botModeKeyFromText(botNorm(entry.text));
          setTimeout(() => botInviteToPlay(bc.state, bc.c, humanEmail, modeKey), bRand(600, 1600));
        }
      }
      // "digitando...": ~8s numa resposta curta; texto grande demora mais (até 30s).
      const typingMs = bClamp(BOT_TYPE_BASE_MS + res.text.length * bRand(BOT_TYPE_PER_CHAR_MIN, BOT_TYPE_PER_CHAR_MAX), 6000, 30000);
      botTypeAndSend(botEmail, humanEmail, res.text, typingMs, done);
    } catch (e) { done(); }
  }, readDelay);
}

// ---------- Convite de partida: bot "combinado" aceita quase na hora ----------
function botAcceptInviteNow(botEmail, inviteId) {
  const inv = gameInvites[inviteId];
  if (!inv || inv.toEmail !== botEmail) return;
  const bc = botClientOf(botEmail);
  if (!bc) return;
  bc.c.bot.respondingInviteId = inviteId; // evita o fluxo lento (3-12s) agendar de novo
  botRespondGameInvite(bc.state, bc.id, bc.c, inviteId, true);
}
// Um humano acabou de mandar convite pra esse bot. Se o bot tinha dito "bora"
// (ou foi ele que chamou pra jogar) há pouco, aceita em ~1-2s.
function botOnGameInvite(botEmail, humanEmail, inviteId) {
  if (!botIsReady(botEmail, humanEmail)) return; // sem combinado: fluxo normal (botMaybeRespondToInvites)
  setTimeout(() => botAcceptInviteNow(botEmail, inviteId), bRand(800, 2200));
}
// Convites que essa pessoa já tinha mandado antes do bot dizer "bora".
// Devolve true se achou (e agendou aceitar) pelo menos um.
function botAcceptPendingInvitesFrom(botEmail, humanEmail) {
  let found = false;
  for (const inv of Object.values(gameInvites)) {
    if (inv.toEmail === botEmail && inv.fromEmail === humanEmail) {
      found = true;
      setTimeout(() => botAcceptInviteNow(botEmail, inv.id), bRand(800, 2200));
    }
  }
  return found;
}

// ---------- Depois da partida: parabeniza ou xinga ----------
// Falas por situação. rel: 'enemy' (jogaram um contra o outro) ou 'ally' (mesmo time).
const BOT_MATCH_LINES = {
  enemyHumanWon_nice: ['gg mano, tu jogou muito', 'boa, ganhou merecido kkk', 'parabéns, {nome}! foi bom demais essa', 'caraca, tu é brabo mesmo. gg', 'gg! quase que eu te pegava kkk', 'foi por pouco hein, gg', 'mandou bem, mano. revanche?', 'respeito, tu joga muito. bora outra?'],
  enemyHumanWon_toxic: ['sorte de iniciante kkkk', 'ganhou no lag, só pode kkk', 'porra, perdi pra tu? que ódio kkkk', 'caralho, tu só ganhou pq eu tava de mão hoje', 'vai se foder kkk gg, revanche já', 'seu sortudo do caralho, quero revanche', 'tá se achando agora né? kkkk gg', 'que merda, perdi. bora de novo que eu te ganho'],
  enemyHumanWonStreak: ['de novo tu me ganhando, que ódio kkk', 'já é a {n}ª vez que tu me ganha, tá de sacanagem', 'tu tá me humilhando hein kkk gg'],
  enemyHumanLost_nice: ['gg, foi uma boa luta', 'gg mano, quase que tu ganhava', 'foi apertado hein, gg', 'gg! tu joga bem, só deu azar', 'boa luta, bora revanche?'],
  enemyHumanLost_toxic: ['ez kkkk', 'kkkkk ganhei, chora não', 'tá fácil demais isso aqui kkk', 'perdeu pra mim, treina mais kkk', 'que isso, nem suei kkk', 'noob kkkk gg'],
  allyWon: ['gg time!', 'boa dupla kkk gg', 'ganhamos! bora outra?', 'gg wp, jogou bem'],
  allyLost: ['foi mal aí, perdemos por minha culpa kkk', 'gg, na próxima a gente ganha', 'putz, perdemos. revanche?', 'faltou pouco, gg'],
};
function botPickMatchLine(bot, humanEmail, rel, humanWon) {
  const h = bot.h2h.get(humanEmail) || { humanWins: 0, humanStreak: 0 };
  if (rel === 'ally') return bPick(humanWon ? BOT_MATCH_LINES.allyWon : BOT_MATCH_LINES.allyLost);
  if (humanWon) {
    h.humanWins++; h.humanStreak++;
    bot.h2h.set(humanEmail, h);
    if (h.humanStreak >= 2 && bot.toxic) return bPick(BOT_MATCH_LINES.enemyHumanWonStreak).replace(/\{n\}/g, String(h.humanWins));
    return bPick(bot.toxic ? BOT_MATCH_LINES.enemyHumanWon_toxic : BOT_MATCH_LINES.enemyHumanWon_nice);
  }
  h.humanStreak = 0;
  bot.h2h.set(humanEmail, h);
  return bPick(bot.toxic ? BOT_MATCH_LINES.enemyHumanLost_toxic : BOT_MATCH_LINES.enemyHumanLost_nice);
}
function botScheduleMatchReaction(botEmail, humanEmail, rel, humanWon) {
  const bc = botClientOf(botEmail);
  if (!bc) return;
  let line = botPickMatchLine(bc.c.bot, humanEmail, rel, humanWon);
  line = line.replace(/\{nome\}/g, botFriendlyName(displayNameFor(humanEmail))).replace(/\s+([,!?.])/g, '$1').replace(/\s+/g, ' ').trim();
  line = botStyle(line, bc.c.bot.gender);
  const conv = botConvOf(botEmail, humanEmail);
  if (/\?$/.test(line) || /revanche|bora (outra|de novo)/.test(line)) {
    // Ele mesmo propôs outra partida: se a pessoa responder "bora" / mandar convite, ele topa.
    conv.ask = 'play'; conv.askAt = Date.now() + 8000; conv.lastAsk = 'play';
    conv.readyUntil = Date.now() + BOT_READY_MS;
  }
  setTimeout(() => {
    if (!isAccountOnline(botEmail) || !isAccountOnline(humanEmail)) return;
    botTypeAndSend(botEmail, humanEmail, line, bClamp(line.length * bRand(80, 140) + bRand(500, 1200), 1200, 8000), null);
  }, bRand(2500, 7000));
}
// Chamado quando uma partida termina de verdade (1x1 quando alguém fecha as
// rodadas, 2x2/3x3/FFA quando o servidor manda "matchOver"). Cada humano com
// conta que jogou com bot(s)-amigo(s) recebe uma reação de UM deles.
function botAfterMatch(state, room, winningTeam, winnerId) {
  try {
    const isFfa = room.mode === 'ffa' || isBigFfa(room.mode);
    const won = (p) => (isFfa ? p.id === winnerId : p.team === winningTeam);
    const bots = [];
    const humans = [];
    for (const p of room.players) {
      const c = state.clients.get(p.id);
      if (!c) continue;
      if (c.isBot) { if (c.accountId) bots.push({ p, c }); }
      else if (c.accountId) humans.push({ p, c });
    }
    if (!bots.length || !humans.length) return;
    for (const h of humans) {
      // Só bot que é amigo da pessoa consegue mandar mensagem.
      const friendly = bots.filter((b) => ensureFriends(b.c.accountId).friends.includes(h.c.accountId));
      if (!friendly.length || Math.random() > 0.85) continue;
      const enemies = friendly.filter((b) => isFfa || b.p.team !== h.p.team);
      const b = bPick(enemies.length ? enemies : friendly);
      const rel = (!isFfa && b.p.team === h.p.team) ? 'ally' : 'enemy';
      botScheduleMatchReaction(b.c.accountId, h.c.accountId, rel, won(h.p));
    }
  } catch (e) { console.log('[bots] erro em botAfterMatch:', e.message); }
}
// 1x1 com gente de verdade é decidido no cliente (primeiro a 3 rodadas — mesmo
// valor de ROUNDS_TO_WIN no ArenaCraft.html), então o servidor conta as
// rodadas por conta própria só pra saber quando a partida acabou.
const BOT_1X1_ROUNDS_TO_WIN = 3;
function botTrack1x1Round(state, room, victimId) {
  if (room.mode !== '1x1' || room.botMatchDone) return;
  if (!roomHasHuman(state, room)) return;
  const victim = room.players.find((p) => p.id === victimId);
  const winner = room.players.find((p) => p.id !== victimId);
  if (!victim || !winner) return;
  if (!room.botTally) room.botTally = {};
  room.botTally[winner.team] = (room.botTally[winner.team] || 0) + 1;
  if (room.botTally[winner.team] >= BOT_1X1_ROUNDS_TO_WIN) {
    room.botMatchDone = true;
    botAfterMatch(state, room, winner.team, winner.id);
  }
}

// Gera um e-mail interno único pra "conta" de bot — nunca é mostrado (só o
// username aparece), então o formato em si não importa, só precisa ser único.
function botUniqueEmail() {
  let email;
  do { email = 'bot_' + crypto.randomBytes(6).toString('hex') + '@bots.phanix'; } while (accounts[email]);
  return email;
}
const BOT_LASTNAMES = ['Silva', 'Souza', 'Oliveira', 'Santos', 'Pereira', 'Costa', 'Almeida', 'Ferreira', 'Rodrigues', 'Gomes', 'Martins', 'Araujo', 'Barbosa', 'Ribeiro', 'Carvalho', 'Lima', 'Nascimento'];
// Cria (ou não, por sorteio) a conta vinculada de um bot recém-nascido,
// reaproveitando o mesmo nome que já apareceria pra ele no jogo — assim o
// nome do "personagem" e o username da conta batem, como um jogador real.
// A conta entra direto em `accounts` e é salva em accounts.json normalmente
// (ela "polui" o arquivo de verdade de propósito — é pra parecer um jogador
// de verdade, inclusive depois que o bot sair do ar).
let botAccountQueue = null; // e-mails das contas de bot, da mais antiga pra mais nova
function botAccountsInit() {
  botAccountQueue = [];
  for (const [e, a] of Object.entries(accounts)) if (a && (a.isBot || /@bots\.phanix$/.test(e))) botAccountQueue.push(e);
}
// Passou do limite: apaga as contas de bot mais antigas que estão offline e sem
// nenhuma ligação com jogador de verdade (amigo, pedido, conversa).
function botPruneAccounts(n) {
  if (!botAccountQueue) botAccountsInit();
  const online = new Set();
  for (const st of virtualServers) for (const c of st.clients.values()) if (c.accountId) online.add(c.accountId);
  const talked = new Set();
  for (const key of Object.keys(conversations)) { const [a, b] = key.split('|'); talked.add(a); talked.add(b); }
  const keep = [];
  let removed = 0;
  while (botAccountQueue.length && removed < n) {
    const e = botAccountQueue.shift();
    const acc = accounts[e];
    if (!acc) continue;
    const f = friendsData[e];
    const linked = f && ((f.friends || []).length || (f.incoming || []).length || (f.outgoing || []).length);
    if (online.has(e) || linked || talked.has(e)) { keep.push(e); continue; }
    usedUsernames.delete(String(acc.username || '').toLowerCase());
    delete accounts[e]; delete profiles[e]; delete friendsData[e];
    removed++;
  }
  botAccountQueue.push(...keep);
  if (removed) { saveAccounts(); saveProfiles(); saveFriends(); }
}
function botMaybeCreateAccount(name) {
  if (Math.random() >= BOT_ACCOUNT_CHANCE) return null;
  const uLower = name.toLowerCase();
  if (usedUsernames.has(uLower)) return null; // não rouba username de conta real (nem de outro bot)
  if (/^User \d+$/.test(name)) return null;   // "User N" = jogador sem conta (visitante), igual quem nunca criou uma
  if (!botAccountQueue) botAccountsInit();
  if (botAccountQueue.length >= BOT_ACCOUNTS_MAX) {
    // Com 100 mil bots online não dá pra ter 100 mil contas: poda no máx. 1x por minuto e,
    // se ainda estiver cheio, esse bot entra sem conta (igual a um visitante).
    const nowP = Date.now();
    if (!botMaybeCreateAccount.lastPrune || nowP - botMaybeCreateAccount.lastPrune > 60000) { botMaybeCreateAccount.lastPrune = nowP; botPruneAccounts(1000); }
    if (botAccountQueue.length >= BOT_ACCOUNTS_MAX) return null;
  }
  const email = botUniqueEmail();
  const account = {
    firstName: bPick(BOT_FIRST),
    lastName: bPick(BOT_LASTNAMES),
    email,
    username: name,
    // Conta de bot nunca loga de verdade — esses campos só existem pra ter
    // o mesmo formato de uma conta real dentro de accounts.json.
    passwordHash: crypto.randomBytes(32).toString('hex'),
    salt: crypto.randomBytes(16).toString('hex'),
    sessionToken: crypto.randomBytes(24).toString('hex'),
    isBot: true, // só referência interna — nunca é lido/exibido pro cliente
  };
  accounts[email] = account;
  usedUsernames.add(uLower);
  botAccountQueue.push(email);
  // Perfil de verdade (profiles.json), igual ao de quem cria conta: nome, kills e acessibilidade.
  profiles[email] = { name, kills: Math.floor(bRand(0, 1) * bRand(0, 1) * 220), accessibility: 20 };
  saveAccounts();
  saveProfiles();
  return email;
}
// Registra, pra cada bot-com-conta numa sala recém-formada, os humanos-com-
// conta que caíram junto — é a partir daqui que o bot "lembra" com quem já
// jogou e pode, mais tarde, mandar pedido de amizade, convite ou mensagem.
function botRecordEncounters(state, room) {
  const humans = [];
  const bots = [];
  for (const p of room.players) {
    const c = state.clients.get(p.id);
    if (!c) continue;
    if (c.isBot) { if (c.accountId) bots.push(c); }
    else if (c.accountId) humans.push(c.accountId);
  }
  if (!humans.length || !bots.length) return;
  const now = Date.now();
  for (const bc of bots) {
    const met = bc.bot.metHumans;
    for (const h of humans) {
      met.delete(h); // reordena pro fim (mais recente) se já existia
      met.set(h, now);
    }
    while (met.size > BOT_MAX_MET_HUMANS) met.delete(met.keys().next().value);
  }
}

// Constantes de física/combate espelhadas do ArenaCraft.html
const B_GRAVITY = -18, B_JUMP = 7.2, B_EYE = 1.6, B_LIM = 19 - 0.6;
const B_KNOCK_SPEED = 9, B_KNOCK_DECAY = 9, B_KNOCK_STUN = 0.22;
const B_KNOCK_UP = Math.sqrt(2 * 18 * 0.3);
const B_HITBOX_MAX = 2.15;   // altura do corpo (mesma do cliente)
const B_BODY_HALF_W = 0.6;    // meia-largura do corpo (tronco + braços)
const B_PUNCH_CD_MIN = 0.45 * 0.75 * 0.75; // mesmo cooldown do cliente (~0,25s)

const bRand = (a, b) => a + Math.random() * (b - a);
const bPick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function bGauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const bClamp = (v, a, b) => Math.max(a, Math.min(b, v));

// =====================================================================
// BEDWARS — IA dos bots (luta, ponte, economia, upgrades e quebra de cama)
// =====================================================================
// Reaproveita as MESMAS funções que validam as ações de um jogador de
// verdade (bwOnHit, bwOnBreak, bwOnPlace, bwOnBuy, bwOnUpgrade) — o bot
// "manda" a mesma mensagem que o cliente mandaria, então toda a validação
// de alcance/loja/inventário do servidor continua valendo igual pra ele.
const BW_BOT_ATTACK_RANGE = 3.4;   // alcance de ataque corpo a corpo do bot
const BW_BOT_SIGHT_RANGE = 26;     // distância até onde o bot "percebe" um inimigo
const BW_BOT_FLEE_HP = 7;          // <= disso e com inimigo por perto: foge correndo (sprint)
const BW_BOT_BASE_SPEED = 5.2;     // igual ao PLAYER_SPEED do cliente
const BW_BOT_SNEAK_MUL = 0.38, BW_BOT_SPRINT_MUL = 1.35;
const BW_BOT_JUMP_VY = 7.2, BW_BOT_GRAVITY = -18;
const BW_BOT_STUCK_DIST = 0.35;    // andou menos que isso em BW_BOT_STUCK_MS: considera travado
const BW_BOT_STUCK_MS = 700;

function bwBotState(p) {
  if (!p._ai) {
    p._ai = {
      phase: 'roam', targetId: null, goal: null, decideAt: 0,
      punchCd: 0, punchFlagUntil: 0, bridgeCd: 0, jumpAt: 0,
      vy: 0, grounded: true, hideUntil: 0, sneaking: false, sprinting: false,
      lastBc: 0, strafeDir: Math.random() < 0.5 ? 1 : -1,
      lastPosX: p.x, lastPosZ: p.z, lastPosAt: 0, stuckCount: 0,
      avoidTeam: {}, nextGatherAt: 0,
    };
  }
  return p._ai;
}

function bwBotFindSlot(p, matcher) {
  for (let i = 0; i < p.slots.length; i++) { const s = p.slots[i]; if (s && matcher(s.id)) return i; }
  return -1;
}

// Move um eixo por vez em passos curtos, parando no primeiro bloco sólido
// (versão simplificada do bwMoveAxis do cliente — não precisa de tanta
// precisão pra um bot, só não pode atravessar parede nem afundar no chão).
function bwBotMoveAxis(bw, p, axis, delta) {
  if (!delta) return false;
  const steps = Math.max(1, Math.ceil(Math.abs(delta) / 0.2));
  const step = delta / steps;
  for (let i = 0; i < steps; i++) {
    const nx = axis === 0 ? p.x + step : p.x;
    const ny = axis === 1 ? p.y + step : p.y;
    const nz = axis === 2 ? p.z + step : p.z;
    if (bwBoxFree(bw, nx, ny, nz)) { p.x = nx; p.y = ny; p.z = nz; }
    else return true;
  }
  return false;
}

// Decide o que o bot vai tentar fazer nos próximos ~0,5-0,9s: fugir,
// atacar quem estiver mais perto, reabastecer/comprar upgrade de time,
// invadir a ilha/cama inimiga mais próxima que ainda estiver de pé,
// garimpar um gerador neutro de diamante/esmeralda, ou só rodear a
// própria base enquanto nada disso se aplica.
function bwBotDecide(state, room, bw, p, ai, now) {
  ai.decideAt = now + bRand(500, 900);
  const team = bw.teams[p.ti];

  if (p.hp <= BW_BOT_FLEE_HP) {
    ai.phase = 'flee';
    ai.targetId = null;
    ai.goal = { x: team.spawn.x, z: team.spawn.z };
    return;
  }

  let best = null, bd = Infinity;
  for (const q of room.players) {
    if (!q.alive || q.eliminated || q.ti === p.ti) continue;
    const d = Math.hypot(q.x - p.x, q.z - p.z);
    if (d < bd) { bd = d; best = q; }
  }
  if (best && bd < BW_BOT_SIGHT_RANGE) {
    ai.phase = 'attack';
    ai.targetId = best.id;
    ai.goal = { x: best.x, z: best.z };
    return;
  }
  ai.targetId = null;

  const woolIdx = bwBotFindSlot(p, (id) => id === 'wool');
  const woolN = woolIdx >= 0 ? p.slots[woolIdx].n : 0;
  const wantsShop = (woolN < 8 && p.res.iron >= 4) ||
    (bwSwordTier(p) < 2 && p.res.iron >= 10) ||
    (bwSwordTier(p) < 3 && p.res.gold >= 7) ||
    (bwSwordTier(p) < 4 && p.res.emerald >= 3) ||
    (p.armor < 1 && p.res.iron >= 24) ||
    (p.armor < 2 && p.res.gold >= 12) ||
    (p.armor < 3 && p.res.emerald >= 6) ||
    (p.res.gold >= 3 && !p.slots.some((s) => s && s.id === 'apple'));
  if (wantsShop) {
    ai.phase = 'shop';
    ai.goal = { x: team.shop.x, z: team.shop.z };
    return;
  }

  // Diamante/esmeralda de sobra: passa na lojinha de upgrade do time
  // comprar Espadas Afiadas / Armadura Reforçada (melhora o time inteiro).
  const upDefs = bwUpgradeDefs(bw.teamSize);
  const sharpDef = upDefs.find((d) => d.id === 'sharp');
  const protDef = upDefs.find((d) => d.id === 'prot');
  const wantsUpgrade = p.res.diamond >= 2 && (
    (team.up.sharp < sharpDef.costs.length && p.res.diamond >= sharpDef.costs[team.up.sharp]) ||
    (team.up.prot < protDef.costs.length && p.res.diamond >= protDef.costs[team.up.prot])
  );
  if (wantsUpgrade) {
    ai.phase = 'upgrade';
    ai.goal = { x: team.upg.x, z: team.upg.z };
    return;
  }

  let bestTeam = null, btd = Infinity;
  for (const t of bw.teams) {
    if (t.idx === p.ti || !t.bed.alive || t.eliminated) continue;
    if (ai.avoidTeam[t.idx] && now < ai.avoidTeam[t.idx]) continue; // travou tentando invadir — dá um tempo
    const c0 = t.bed.cells[0];
    const d = Math.hypot(c0[0] - p.x, c0[2] - p.z);
    if (d < btd) { btd = d; bestTeam = t; }
  }
  if (bestTeam) {
    ai.phase = 'raid';
    const c0 = bestTeam.bed.cells[0];
    ai.goal = { x: c0[0] + 0.5, z: c0[2] + 0.5, teamIdx: bestTeam.idx };
    return;
  }

  // Sem alvo de invasão disponível (todo mundo ficou "de molho" no
  // avoidTeam, ou só sobrou o próprio time): garimpa gerador neutro de
  // diamante/esmeralda de vez em quando pra sempre ter recurso rodando.
  if (now > ai.nextGatherAt) {
    let bestGen = null, bgd = Infinity;
    for (const g of bw.gens) {
      if (g.team !== -1) continue;
      const d = Math.hypot(g.x - p.x, g.z - p.z);
      if (d < bgd) { bgd = d; bestGen = g; }
    }
    if (bestGen) {
      ai.phase = 'gather';
      ai.goal = { x: bestGen.x, z: bestGen.z };
      ai.nextGatherAt = now + bRand(15000, 30000);
      return;
    }
  }

  ai.phase = 'roam';
  ai.goal = { x: team.cx + bRand(-4, 4), z: team.cz + bRand(-4, 4) };
}

function bwBotTick(state, room, bw, p, c, dt, now) {
  if (!p.alive) return; // renascer é tratado pelo bwTickPlayers normal
  const ai = bwBotState(p);
  const team = bw.teams[p.ti];

  const nearEnemy = room.players.some((q) => q.alive && !q.eliminated && q.ti !== p.ti && Math.hypot(q.x - p.x, q.z - p.z) < 8);
  const lowHp = p.hp <= BW_BOT_FLEE_HP;
  // "Corre rápido" (sprint) quando tá com pouca vida e o perigo ainda tá
  // por perto; "shift" (agacha/some) quando já escapou ou logo depois de
  // quebrar a cama do inimigo — nos dois casos sem inimigo à vista.
  ai.sprinting = lowHp && nearEnemy;
  if (ai.sprinting) ai.hideUntil = Math.max(ai.hideUntil, now + 4000);
  ai.sneaking = !nearEnemy && (now < ai.hideUntil || (lowHp && !nearEnemy));

  if (now >= ai.decideAt || !ai.goal) bwBotDecide(state, room, bw, p, ai, now);

  if (ai.phase === 'attack' && ai.targetId) {
    const tgt = room.players.find((q) => q.id === ai.targetId);
    if (!tgt || !tgt.alive || tgt.eliminated) ai.decideAt = 0;
    else ai.goal = { x: tgt.x, z: tgt.z };
  } else if (ai.phase === 'raid' && ai.goal && typeof ai.goal.teamIdx === 'number') {
    const rt = bw.teams[ai.goal.teamIdx];
    if (!rt || !rt.bed.alive || rt.eliminated) ai.decideAt = 0;
  }

  let mx = 0, mz = 0, wantJump = false;
  if (ai.goal) {
    const dx = ai.goal.x - p.x, dz = ai.goal.z - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.35) { mx = dx / dist; mz = dz / dist; }
    if (ai.phase === 'attack' && dist < BW_BOT_ATTACK_RANGE * 0.9) {
      // já no alcance: em vez de ficar parado feito estátua, circula o
      // alvo (finta) — fica muito mais difícil de acertar e parece um
      // jogador de verdade brigando, não um bot travado.
      mx = -dz / (dist || 1) * ai.strafeDir * 0.6;
      mz = dx / (dist || 1) * ai.strafeDir * 0.6;
    }
    if (mx || mz) p.yaw = Math.atan2(-mx, -mz);
  }

  // ---- detector de "travado": se devia estar andando mas não saiu do
  // lugar por um tempo, desiste do que tava fazendo (evita ficar preso
  // numa parede/buraco pra sempre feito estátua) ----
  if (now - ai.lastPosAt > BW_BOT_STUCK_MS) {
    const moved = Math.hypot(p.x - ai.lastPosX, p.z - ai.lastPosZ);
    if ((mx || mz) && ai.phase !== 'shop' && ai.phase !== 'upgrade' && moved < BW_BOT_STUCK_DIST) {
      ai.stuckCount++;
      if (ai.stuckCount >= 2) {
        if (ai.phase === 'raid' && ai.goal && typeof ai.goal.teamIdx === 'number') ai.avoidTeam[ai.goal.teamIdx] = now + 20000;
        ai.decideAt = 0; // escolhe outra coisa pra fazer já no próximo tick
        ai.strafeDir = -ai.strafeDir;
        wantJump = true;
        ai.stuckCount = 0;
      }
    } else ai.stuckCount = 0;
    ai.lastPosX = p.x; ai.lastPosZ = p.z; ai.lastPosAt = now;
  }

  // ---- ponte: se o próximo passo cair no vazio, tenta colocar lã antes
  // de andar (só numa direção por vez, pra sempre encostar no bloco
  // anterior — senão o servidor rejeita a colocação por falta de vizinho
  // sólido em diagonal) — e se tiver uma parede construída pelo inimigo
  // na frente (bloco "placed"), quebra pra passar em vez de travar ----
  if ((mx || mz) && !ai.sneaking && ai.phase !== 'attack') {
    let bmx = Math.abs(mx) > Math.abs(mz) ? Math.sign(mx) : 0;
    let bmz = bmx === 0 ? Math.sign(mz) : 0;
    const stepX = p.x + bmx * 0.7, stepZ = p.z + bmz * 0.7;
    const belowSolid = bwCellSolid(bw, stepX, p.y - 0.15, stepZ);
    const wallX = Math.floor(p.x + bmx * 0.6), wallY = Math.floor(p.y + 0.6), wallZ = Math.floor(p.z + bmz * 0.6);
    const wallSolid = bwCellSolid(bw, wallX + 0.5, p.y + 0.6, wallZ + 0.5);
    if (wallSolid && (ai.phase === 'raid' || ai.phase === 'gather') && bw.w.placed[bwIdx(wallX, wallY, wallZ)] && now > ai.bridgeCd) {
      bwOnBreak(state, room, p, { x: wallX, y: wallY, z: wallZ });
      ai.bridgeCd = now + 260;
    } else if (!belowSolid) {
      const bx = Math.floor(stepX), by = Math.floor(p.y - 1), bz = Math.floor(stepZ);
      const woolIdx = bwBotFindSlot(p, (id) => id === 'wool');
      if (by >= BW_MIN_BUILD_Y && woolIdx >= 0 && now > ai.bridgeCd) {
        p.sel = woolIdx;
        bwOnPlace(state, room, p, { x: bx, y: by, z: bz });
        ai.bridgeCd = now + 220;
        const placedOk = bwIsSolid(bwGet(bw.w, bx, by, bz));
        if (placedOk) { mx = bmx; mz = bmz; } else { mx = 0; mz = 0; }
      } else {
        mx = 0; mz = 0; // sem lã: não se arrisca a cair no vazio
      }
    } else if (wallSolid && ai.grounded) {
      wantJump = true; // parede baixa (do mapa) na frente: pula
    }
  }

  // ---- física simplificada (gravidade + colisão) ----
  let sp = BW_BOT_BASE_SPEED;
  if (ai.sneaking) sp *= BW_BOT_SNEAK_MUL;
  else if (ai.sprinting) sp *= BW_BOT_SPRINT_MUL;
  bwBotMoveAxis(bw, p, 0, mx * sp * dt);
  bwBotMoveAxis(bw, p, 2, mz * sp * dt);

  if (wantJump && ai.grounded && now > ai.jumpAt) { ai.vy = BW_BOT_JUMP_VY; ai.grounded = false; ai.jumpAt = now + 400; }
  ai.vy += BW_BOT_GRAVITY * dt;
  if (ai.vy < -40) ai.vy = -40;
  const hitVert = bwBotMoveAxis(bw, p, 1, ai.vy * dt);
  if (hitVert) { if (ai.vy < 0) ai.grounded = true; ai.vy = 0; }
  else ai.grounded = false;

  // ---- combate ----
  if (ai.phase === 'attack' && ai.targetId && now > ai.punchCd) {
    const tgt = room.players.find((q) => q.id === ai.targetId);
    if (tgt && tgt.alive && !tgt.eliminated && Math.hypot(tgt.x - p.x, tgt.z - p.z) < BW_BOT_ATTACK_RANGE) {
      bwOnHit(state, room, p, { targetId: tgt.id });
      ai.punchCd = now + bRand(550, 850);
      ai.punchFlagUntil = now + 150;
    }
  }

  // ---- quebrar cama inimiga ----
  if (ai.phase === 'raid' && ai.goal && typeof ai.goal.teamIdx === 'number') {
    const rt = bw.teams[ai.goal.teamIdx];
    if (rt && rt.bed.alive) {
      for (const cell of rt.bed.cells) {
        if (bwReachOK(p, cell[0], cell[1], cell[2], BW_REACH * 0.8)) {
          bwOnBreak(state, room, p, { x: cell[0], y: cell[1], z: cell[2] });
          if (!rt.bed.alive) { ai.hideUntil = now + bRand(6000, 12000); ai.decideAt = 0; }
          break;
        }
      }
    }
  }

  // ---- comprar na loja (prioriza o que dá mais valor pro recurso que tem) ----
  if (ai.phase === 'shop' && bwNearShop(bw, p, 'item')) {
    if (p.armor < 3 && p.res.emerald >= 6) bwOnBuy(state, room, p, { id: 'armor3' });
    else if (bwSwordTier(p) < 4 && p.res.emerald >= 3) bwOnBuy(state, room, p, { id: 'sword4' });
    else if (p.armor < 2 && p.res.gold >= 12) bwOnBuy(state, room, p, { id: 'armor2' });
    else if (bwSwordTier(p) < 3 && p.res.gold >= 7) bwOnBuy(state, room, p, { id: 'sword3' });
    else if (p.armor < 1 && p.res.iron >= 24) bwOnBuy(state, room, p, { id: 'armor1' });
    else if (bwSwordTier(p) < 2 && p.res.iron >= 10) bwOnBuy(state, room, p, { id: 'sword2' });
    else if (p.res.iron >= 4) bwOnBuy(state, room, p, { id: 'wool' });
    else if (p.res.gold >= 3 && !p.slots.some((s) => s && s.id === 'apple')) bwOnBuy(state, room, p, { id: 'apple' });
    ai.decideAt = 0;
  }

  // ---- comprar upgrade de time (melhora todo mundo, não só o bot) ----
  if (ai.phase === 'upgrade' && bwNearShop(bw, p, 'upg')) {
    const upDefs = bwUpgradeDefs(bw.teamSize);
    const sharpDef = upDefs.find((d) => d.id === 'sharp');
    const protDef = upDefs.find((d) => d.id === 'prot');
    if (team.up.sharp < sharpDef.costs.length && p.res.diamond >= sharpDef.costs[team.up.sharp]) bwOnUpgrade(state, room, p, { id: 'sharp' });
    else if (team.up.prot < protDef.costs.length && p.res.diamond >= protDef.costs[team.up.prot]) bwOnUpgrade(state, room, p, { id: 'prot' });
    ai.decideAt = 0;
  }

  // ---- avisa a posição pros jogadores de verdade (~15x/s) ----
  if (now - ai.lastBc > 65) {
    ai.lastBc = now;
    bwBroadcast(state, room, { type: 'state', id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: 0, punching: now < ai.punchFlagUntil, sn: ai.sneaking ? 1 : 0 });
  }
}

function bwTickBots(state, room, dt) {
  const bw = room.bw;
  if (!bw || bw.phase !== 'playing') return;
  const now = Date.now();
  for (const p of room.players.slice()) {
    if (p.eliminated) continue;
    const c = state.clients.get(p.id);
    if (!c || !c.isBot) continue;
    try { bwBotTick(state, room, bw, p, c, dt, now); }
    catch (e) { console.error('[bedwars-bot] erro:', e && e.stack || e); }
  }
}
function bAngDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// ---------- Nomes aleatórios ----------
const BOT_FIRST = ['Lucas','Gabriel','Pedro','Matheus','Joao','Rafael','Felipe','Guilherme','Bruno','Thiago','Davi','Enzo','Kaique','Vitor','Leo','Caio','Igor','Diego','Yuri','Nathan','Ana','Julia','Bia','Lari','Duda','Livia','Clara','Sofia','Alice','Alex','Max','Sam','Kai','Noah','Liam','Ethan','Jake','Ryan','Henrique','Arthur','Miguel','Heitor','Bernardo','Samuel','Luan','Ryan','Kevin','Marcos','Eduardo','Gustavo'];
const BOT_WORDS = ['Shadow','Ninja','Wolf','Dragon','Ghost','Storm','Blaze','Tiger','Falcon','Viper','Hunter','Sniper','Pixel','Creeper','Zombie','Steve','Miner','Cobra','Fire','Ice','Thunder','Rocket','Turbo','Nitro','Bolt','Frost','Lava','Void','Nova','Rex','King','Lord','Knight','Ender','Diamond','Gold','Iron','Panda','Fox','Bear','Shark','Raven','Demon','Angel','Mago','Lobo','Fera','Rei','Sombra','Raio','Trovao','Gamer','Noob','Pro','Boss','Craft','Blade','Ace','Zero','Alpha','Omega','Toxic','Sky','Dark','Light','Neo','Fury','Rush','Cyber','Ultra','Mega','Hyper','Killer','Slayer','Reaper','Titan','Phoenix','Cosmic'];
const BOT_SUFFIX = ['BR','YT','TV','PRO','HD','XD','GG','Ofc','Play','Games','Jr','Real','Sz','MC'];

// Nomes bem brasileiros: nome+sobrenome de gente comum, apelidos de torcida,
// zoeira, comida e regionalismos (nada de político ou pessoa famosa).
const BOT_BR_COMPOUND = ['Joao Pedro','Pedro Henrique','Luiz Felipe','Ana Clara','Maria Eduarda','Marcos Vinicius','Joao Vitor','Lucas Gabriel','Ana Julia','Vitor Hugo','Luis Fernando','Carlos Eduardo','Maria Clara','Joao Gabriel','Davi Lucas','Ana Beatriz','Jose Carlos','Antonio Carlos','Rafael Augusto','Miguel Angelo','Ana Luiza','Maria Fernanda'];
const BOT_BR_NICKS = [
  // torcida / zoeira de futebol
  'Mengao Tetra','Mengao Vida','Fla Ate Morrer','Palmeiras 0 Mundial','Timao Fiel','Vasco da Gama BR','Tricolor Raiz','Colorado Raiz','Gremio Imortal','Raposa Azul','Galo Doido','Santos da Vila','Corinthians Vida','Fluminense Raiz','Botafogo Fiel','Sport Leao','Bahia Tricolor','Sao Paulo Tri','Verdao Ate Morrer',
  // zoeira / gíria
  'Ze Ruela','Tiozao do Zap','Dono da Bola','Vish Maria','Ta Ligado Mano','Nem Ai BR','Sou Brabo Sim','Vem Ni Mim','Deu Ruim','Chora Nao BR','Malandro BR','Sextou BR','Segundou Nao','Mestre da Zoeira','Rei do Camarote','Vo Te Pegar','Vem Pro X1','Chora Nao Bebe','Cabra da Peste','Oxente BR','Bah Tche','Uai So','Sr Mandioca','Zeca Urubu','Xuxu Beleza','Tiao da Lenha','Dona Maria Gamer','Faz o Pix','Ta Pago','Pega a Visao',
  // comida / regionais
  'Pao de Queijo','Farofa Pro','Cuscuz Gamer','Tapioca Ninja','Acai Gamer','Coxinha Pro','Brigadeiro XD','Pastel de Vento','Feijoada Gamer','Baiano Gamer','Mineiro Uai','Carioca XD','Paulista Pro','Gaucho Tche','Nordestino Raiz','Capixaba BR','Paraense Raiz','Cearense Pro',
];
// Nomes provocativos/ofensivos de jogador brasileiro: palavrão e zoeira de time
// (sem político, sem pessoa famosa, sem ofensa a grupo de pessoas).
const BOT_BR_RUDE = [
  'Vai Tomar no Cu','Toma no Cu Noob','Arrombado BR','Fdp Gamer','Vsf Noob','Pqp Gamer','Seu Bosta','Cala Boca Noob',
  'Vai Se Foder BR','Otario Pro','Chupa Que e de Uva','Caralho Gamer','Porra Louca','Fdp Nivel Deus','Vai Chorar Noob',
  'Mengao Chora Mais','Chora Palmeirense','Chora Corintiano','Chora Flamenguista','Torcida Chorona','Time Pequeno FC',
];
// Nomes de meme / zoeira (sem número no fim: o número só entra quando o nome
// já está em uso — ver botUniqueName). Máx. 20 letras, igual o limite de nome.
const BOT_MEME_NAMES = [
  '67','Six Seven','Bora Formar Aura','Aura Infinita','Aura Negativa','Aura Mais 1000','Sem Aura','Perdi a Aura','Cade a Aura','Tenho Aura',
  'Mengao Ruim','Timao Ruim','Galo Ruim','Tricolor Ruim','Sao Paulo Ruim','Vasco Ruim','Palmeiras S Mundial','Verdao Sem Mundial','Mengao Sem Libertad',
  'Skibidi Toilet','Sigma Boy','Sigma Male','Gyatt','Ohio Final Boss','Rizzler','Mewing Pro','Looksmaxxing','Brainrot Total','Tralalero Tralala','Tung Tung Sahur','Bombardino','Chimpanzini',
  'Cade o Pix','Ta Pago','Faz o Pix','Manda Pix','Me Adiciona','Bora Jogar','Bora Bill','Nao Sou Bot','Sou Humano Sim','Nois Vai Perder','Nois Vai Ganhar',
  'O Pai Ta On','Ta On Pai','Chega Mais','Mais Um Noob','Sou Ruim Mesmo','Nem Sei Jogar','Perdi Pro Bot','Ligeirinho','Cabra Cega','Vou Chorar','Que Lag Hein','Vem Ni Mim','Bora Bora',
  '41','404','777','1v1 Me Bro','Sem Nome','Fulano de Tal','Zé Ninguém','Meu Deus do Ceu','Calma Calabreso','Ah Nao Ne','Eita Preula',
];
// "mengao ruim" -> às vezes tudo minúsculo, às vezes MAIÚSCULO (sem número).
function botCaseVariant(n) {
  const r = Math.random();
  if (r < 0.15) return n.toLowerCase();
  if (r < 0.22) return n.toUpperCase();
  return n;
}
function botBrNick(rude) {
  return botCaseVariant(bPick(rude ? BOT_BR_RUDE : BOT_BR_NICKS)).slice(0, 20);
}
function botMemeNick() {
  return botCaseVariant(bPick(BOT_MEME_NAMES)).slice(0, 20);
}
// Nome de frase/meme que já estava em uso: aí sim ganha um número (1 dígito,
// depois 2, 3, 4... conforme o nome vai ficando repetido).
function botNumberedName(base, isTaken) {
  const sep = (Math.random() < 0.5 || /^\d+$/.test(base)) ? ' ' : '';
  for (let digits = 1; digits <= 4; digits++) {
    const lo = digits === 1 ? 1 : Math.pow(10, digits - 1);
    const hi = Math.pow(10, digits);
    for (let i = 0; i < 12; i++) {
      const suf = sep + String(Math.floor(bRand(lo, hi)));
      const n = base.slice(0, 20 - suf.length).trimEnd() + suf;
      if (!isTaken(n)) return n;
    }
  }
  return null;
}
function botRealName() {
  const first = bPick(BOT_FIRST), last = bPick(BOT_LASTNAMES), comp = bPick(BOT_BR_COMPOUND);
  const num2 = () => (Math.random() < 0.5 ? String(Math.floor(bRand(1, 100))) : '');
  const r = Math.random();
  let n;
  if (r < 0.30) n = first + ' ' + last;                                    // Marcos Silva
  else if (r < 0.50) n = comp;                                             // Pedro Henrique
  else if (r < 0.65) n = (first + last).toLowerCase() + num2();            // marcossilva7
  else if (r < 0.80) n = first + '_' + last + num2();                      // Marcos_Silva12
  else if (r < 0.92) n = comp.replace(' ', '') + num2();                   // PedroHenrique
  else n = comp + ' ' + last;                                              // Pedro Henrique Lima
  return n.slice(0, 20).trim();
}

// Devolve { name, phrase }. phrase=true: nome de frase/meme/zoeira, que NÃO leva
// número no fim a não ser que já esteja em uso.
function botRandomNameEx() {
  const r0 = Math.random();
  if (r0 < 0.14) return { name: botRealName(), phrase: false };
  if (r0 < 0.24) return { name: botBrNick(false), phrase: true };
  if (r0 < 0.30) return { name: botBrNick(true), phrase: true };
  if (r0 < 0.44) return { name: botMemeNick(), phrase: true };
  const r = Math.random();
  const num = () => String(Math.floor(bRand(1, r < 0.5 ? 100 : 9999)));
  let n;
  if (r < 0.16) n = bPick(BOT_WORDS) + bPick(BOT_WORDS);
  else if (r < 0.30) n = bPick(BOT_FIRST) + num();
  else if (r < 0.40) n = (bPick(BOT_FIRST) + '_' + bPick(BOT_WORDS)).toLowerCase();
  else if (r < 0.47) n = 'xX' + bPick(BOT_WORDS) + 'Xx';
  else if (r < 0.60) n = bPick(BOT_WORDS) + num();
  else if (r < 0.70) n = bPick(BOT_FIRST) + bPick(BOT_WORDS);
  else if (r < 0.78) n = bPick(BOT_WORDS) + '_' + bPick(BOT_SUFFIX);
  else if (r < 0.85) n = bPick(BOT_FIRST).toLowerCase() + bPick(BOT_SUFFIX).toLowerCase();
  else if (r < 0.91) n = bPick(BOT_WORDS).toLowerCase() + '_' + num();
  else if (r < 0.95) n = bPick(BOT_FIRST);
  else n = bPick(BOT_WORDS).toUpperCase() + num();
  return { name: n.slice(0, 20), phrase: false };
}
function botRandomName() { return botRandomNameEx().name; }

function botUsedNames(state) {
  const used = new Set();
  for (const c of state.clients.values()) used.add(String(c.name || '').toLowerCase());
  return used;
}
function botUniqueName(state, id, usedIn) {
  // ~10% ficam com o nome padrão "User N" (igual quem nunca definiu nome).
  if (Math.random() < 0.10) return 'User ' + id;
  const used = usedIn || botUsedNames(state);
  for (let i = 0; i < 20; i++) {
    const { name, phrase } = botRandomNameEx();
    const l = name.toLowerCase();
    if (!used.has(l) && !usedUsernames.has(l)) return name;
    if (phrase) {
      // Nome de meme/frase repetido: só agora entra o número.
      const n = botNumberedName(name, (x) => used.has(x.toLowerCase()) || usedUsernames.has(x.toLowerCase()));
      if (n) return n;
    }
  }
  return 'User ' + id;
}

// Contas de bot criadas em versões antigas não tinham username — a migração
// lá em cima dava a elas o começo do e-mail ("bot_9cb1ad3e5f12"), e era isso
// que aparecia na lista de amigos. Aqui cada uma ganha um nome normal de
// jogador (único) e os textos de notificação antigos são atualizados.
(function fixLegacyBotUsernames() {
  let changedAcc = false, changedFriends = false;
  for (const [emailLower, acc] of Object.entries(accounts)) {
    if (!acc || !(acc.isBot || /@bots\.phanix$/.test(emailLower))) continue;
    const cur = typeof acc.username === 'string' ? acc.username.trim() : '';
    if (cur && !/^bot_[0-9a-f]{6,}$/i.test(cur)) continue; // já tem nome normal
    if (cur) usedUsernames.delete(cur.toLowerCase());
    let name = '';
    for (let i = 0; i < 60 && (!name || usedUsernames.has(name.toLowerCase())); i++) name = botRandomName();
    while (usedUsernames.has(name.toLowerCase())) name = name.slice(0, 17) + Math.floor(bRand(100, 999));
    acc.username = name;
    acc.isBot = true;
    usedUsernames.add(name.toLowerCase());
    if (profiles[emailLower]) profiles[emailLower].name = name;
    changedAcc = true;
    if (cur) {
      for (const f of Object.values(friendsData)) {
        for (const n of (f && f.notifications) || []) {
          if (n.fromEmail === emailLower) n.fromUsername = name;
          if (typeof n.text === 'string' && n.text.startsWith(cur + ' ')) { n.text = name + n.text.slice(cur.length); changedFriends = true; }
        }
      }
    }
  }
  if (changedAcc) { saveAccounts(); saveProfiles(); }
  if (changedFriends) saveFriends();
})();

// ---------- Criação / remoção ----------
function botFakeWs() {
  return {
    readyState: WebSocket.OPEN,
    isAlive: true,
    send() {},
    ping() { this.isAlive = true; },
    terminate() {},
    on() {},
  };
}

function botNewBrain(forceArchetype) {
  const archetype = forceArchetype || botRollArchetype();
  // "expert" e "beginner" empurram o skill bruto pra ponta certa da escala
  // (além de ganharem traços extras mais abaixo); os outros usam o range
  // padrão normalmente.
  let skill;
  if (archetype === 'expert') skill = bRand(0.97, 1);
  else if (archetype === 'beginner') skill = bRand(0.35, 0.6);
  else skill = bRand(BOT_SKILL_MIN, BOT_SKILL_MAX);
  const now = Date.now();
  const brain = {
    skill,
    archetype,                // normal | expert | beginner | afk | quitter
    quitAt: 0, hasQuit: false, // só usado pelo arquétipo "quitter"
    wanderUntil: 0, wanderDir: 0, wandering: false, // só usado pelo arquétipo "beginner"
    phase: 'idle',           // idle | queued | inMatch | post
    phaseAt: now,
    nextQueueAt: now + bRand(2000, 60000),
    patience: bRand(15000, 40000),
    postWait: 0,
    lastMode: null,
    stayUntil: 0,
    // física
    x: 0, y: 0, z: 0, vy: 0, yaw: 0, pitch: 0, kx: 0, kz: 0, stun: 0, grounded: true,
    // "técnica" de combate — muda como o bot ABRE a luta (não fica todo
    // mundo só andando na sua direção e pulando do mesmo jeito): rusher vai
    // direto sem recuar, kiter mantém distância e pula bastante pra desviar,
    // ambusher espera "escondido" um pouco antes de avançar, flanker tenta
    // rodear pro lado/costas antes de engajar de frente, faker finge que vai
    // recuar e troca de direção de repente.
    combatTactic: BOT_COMBAT_TACTICS[Math.floor(Math.random() * BOT_COMBAT_TACTICS.length)],
    // personalidade de combate
    turnRate: (6 + 6 * skill) * 1.5,         // rad/s (+50%: mira mais rápida)
    aimNoise: (0.02 + 0.08 * (1 - skill)) * 0.5, // rad (erra bem menos)
    reach: 3.9 + 0.7 * skill + bRand(-0.1, 0.1),
    prefDist: bRand(2.3, 3.4),
    speed: 4.5 + 0.6 * skill,
    fleeHp: 4 + Math.floor(Math.random() * 4), // foge com 4..7 de vida
    punchBase: (0.27 + (1 - skill) * 0.22) * 0.75, // bate mais rápido
    // estado de combate
    punchCd: 0, punchFlagUntil: 0, backoffUntil: 0,
    strafeDir: Math.random() < 0.5 ? -1 : 1, strafeUntil: 0,
    nextJumpAt: 0, aimErr: 0, aimErrAt: 0,
    fleeing: false, fleeUntil: 0, fleeCool: 0, lastHitAt: 0,
    chatBusy: null, typingUntil: 0, // escrevendo mensagem (fica parado até enviar ou até alguém bater nele)
    targetId: null, targetAt: 0, engageAt: 0,
    epoch: -1, roomRef: null, lastBc: 0,
    // social (só é usado por bots com conta vinculada — ver botMaybeCreateAccount)
    metHumans: new Map(),                          // e-mail do humano -> quando jogaram junto por último
    nextSocialAt: now + bRand(BOT_SOCIAL_COOLDOWN_MIN, BOT_SOCIAL_COOLDOWN_MAX),
    respondingInviteId: null,                       // convite que o bot já está "lendo" pra responder
    socialInitiator: Math.random() < BOT_SOCIAL_INITIATOR_CHANCE, // só esses mandam pedido de amizade/convite/mensagem por conta própria
    toxic: Math.random() < 0.4,                     // ~40% dos bots xingam (em vez de só parabenizar) quando perdem
    h2h: new Map(),                                 // e-mail do humano -> { humanWins, humanStreak } (placar contra ele)
    // "rage quit" dinâmico
    pendingChallengeFrom: null,   // e-mail de quem chamou esse bot pra jogar (convite direto), até a partida começar
    isChallengeMatch: false,      // true se a partida atual veio desse convite direto
    challengeHumanEmail: null,
    insultsTaken: 0,              // xingamentos recebidos do humano nesta partida
    deathsThisMatch: 0,
    killsAgainstHumanThisMatch: 0,
    ragequitPlanned: false,
    ragequitAt: 0,
    hasRagequit: false,
    // "timing" (aliança temporária) no FFA
    allyHumanId: null,
    allyHumanEmail: null,
    // saída da partida (quitter / rage quit): fica parado 2-4s antes de sumir
    leaving: false,
    // arquétipo "afk": fica parado (mas pode ser empurrado), com uma chance
    // pequena de "acordar" e voltar a jogar normal no meio da partida
    afkActive: archetype === 'afk',
    afkWakeAt: 0,
  };
  // Traços extras por arquétipo (além do skill já ajustado acima):
  if (archetype === 'expert') {
    brain.turnRate += bRand(2, 4);          // vira mais rápido que qualquer skill normal alcançaria
    brain.aimNoise *= 0.3;                  // mira quase sem erro
    brain.fleeHp = 2;                       // só foge quase morrendo (mais agressivo)
  } else if (archetype === 'beginner') {
    brain.aimNoise += 0.05;                 // mira ainda mais solta
    brain.fleeHp = Math.random() < 0.5 ? 0 : 10; // ou nunca foge (não sabe que devia), ou foge cedo demais
    brain.punchBase += 0.12;                // soca bem mais devagar
  }
  return brain;
}

const BOT_RETURN_CHANCE = 0.20; // 20% dos bots que entram online são bots passados (já estiveram online antes)
const BOT_HISTORY_MAX = 3000;
function botSpawn(state, usedIn) {
  const id = state.nextId++;
  let name = null, botEmail = null, past = null;
  let used = usedIn || null; // nomes já em uso (a oscilação da população monta isso 1x por rodada, em vez de 1x por bot)
  // Bot passado volta com o MESMO nome (e a mesma conta vinculada, se tinha) e o mesmo jeito de jogar.
  const hist = state.botHistory;
  if (hist && hist.length && Math.random() < BOT_RETURN_CHANCE) {
    used = used || botUsedNames(state);
    for (let i = 0; i < 6 && !past; i++) {
      const k = Math.floor(Math.random() * hist.length);
      const h = hist[k];
      if (used.has(String(h.name).toLowerCase())) continue; // alguém já está usando esse nome agora
      past = h;
      hist.splice(k, 1);
    }
  }
  if (past) {
    name = past.name;
    if (past.accountId && accounts[past.accountId]) botEmail = past.accountId;
    else botEmail = botMaybeCreateAccount(name); // a conta antiga foi limpada: cria de novo com o mesmo nome
  } else {
    used = used || botUsedNames(state);
    name = botUniqueName(state, id, used);
    // Uma fração dos bots ganha uma conta vinculada de verdade (mesmo username
    // que o nome dele no jogo) — só ela participa de amizade/convite/chat.
    botEmail = botMaybeCreateAccount(name);
  }
  if (used) used.add(String(name).toLowerCase());
  const brain = botNewBrain(past ? past.archetype : null);
  if (past && typeof past.toxic === 'boolean') brain.toxic = past.toxic;
  brain.gender = botGenderFromName(name); // 'f' -> fala no feminino
  const c = { ws: botFakeWs(), room: null, name, activeChatWith: null, isBot: true, bot: brain };
  // Bots novos sorteiam uma skin do vestiário (ver botPickSkin). Bot "passado"
  // que já tinha uma skin mantém a mesma ao voltar.
  if (past && past.skin) c.skin = past.skin;
  else c.skin = botPickSkin();
  if (botEmail) c.accountId = botEmail;
  state.clients.set(id, c);
  state.botIds.add(id);
  return id;
}

function botIsFree(state, id) {
  const c = state.clients.get(id);
  return !!c && !c.room && (c.bot.phase === 'idle' || c.bot.phase === 'post');
}

// Bot que já virou amigo de um humano fica online (não é removido pela
// oscilação da população) — assim ele continua respondendo/convidando.
function botHasHumanFriend(c) {
  return !!(c && c.accountId && ensureFriends(c.accountId).friends.length);
}

function botDespawn(state, id) {
  const c = state.clients.get(id);
  // Guarda quem saiu: mais tarde 20% dos bots novos são esses "bots passados".
  if (c && c.isBot && state.botHistory && !/^User \d+$/.test(c.name || '')) {
    state.botHistory.push({ name: c.name, accountId: c.accountId || null, archetype: c.bot && c.bot.archetype, toxic: !!(c.bot && c.bot.toxic), skin: c.skin || null });
    if (state.botHistory.length > BOT_HISTORY_MAX) state.botHistory.splice(0, state.botHistory.length - BOT_HISTORY_MAX);
  }
  state.clients.delete(id);
  state.botIds.delete(id);
}

function botEnterQueue(state, id, mode) {
  const c = state.clients.get(id);
  if (!c || !c.isBot || c.room) return false;
  handleQueueMessage(state, id, { type: 'queue', mode, name: c.name });
  const queued = state.queues[mode].includes(id);
  if (queued || c.room) {
    c.bot.phase = c.room ? 'inMatch' : 'queued';
    c.bot.phaseAt = Date.now();
    c.bot.lastMode = mode;
    c.bot.patience = mode === 'survival' ? bRand(240000, 420000) : mode === 'mega' ? bRand(30000, 60000) : bRand(15000, 40000); // Survival (100) e Mega (20): esperam mais pra juntar
    return true;
  }
  return false;
}

// 38% dos bots vão pro Survival; os outros 62% se dividem como antes (26/16/10/28/10/6/4 = 100).
const BOT_SURVIVAL_SHARE = 0.38;
const BOT_AMBIENT_WEIGHTS = [['survival', 7], ['1x1', 26 * 0.62], ['2x2', 16 * 0.62], ['3x3', 10 * 0.62], ['ffa', 18 * 0.62], ['mega', 10 * 0.62], ['bedwars', 10 * 0.62], ['bedwars_duo', 6 * 0.62], ['bedwars_trio', 4 * 0.62]];
function botAmbientMode() {
  const total = BOT_AMBIENT_WEIGHTS.reduce((a, [, w]) => a + w, 0);
  let r = Math.random() * total;
  for (const [m, w] of BOT_AMBIENT_WEIGHTS) { if ((r -= w) <= 0) return m; }
  return '1x1';
}

// ---------- Ciclo de vida (fila -> partida -> resultado -> fila/menu) ----------
function botQueueOf(state, id) {
  for (const mode of Object.keys(state.queues)) if (state.queues[mode].includes(id)) return mode;
  return null;
}
function botQueueHasHuman(state, mode) {
  return state.queues[mode].some((qid) => { const c = state.clients.get(qid); return c && !c.isBot; });
}
// Pros bots, QUALQUER um esperando na fila (humano ou outro bot) é "gente de verdade":
// eles não ficam mais esperando um jogador real aparecer pra começar a entrar.
function botQueueHasPerson(state, mode) {
  return state.queues[mode].some((qid) => !!state.clients.get(qid));
}

function botLifeTick(state, id, c, now) {
  const b = c.bot;
  const inRoom = !!c.room;
  switch (b.phase) {
    case 'idle':
      if (inRoom) { b.phase = 'inMatch'; b.phaseAt = now; break; }
      if (BOT_AMBIENT_QUEUE && now >= b.nextQueueAt) {
        if ((state.botActiveNow || 0) >= BOT_ACTIVE_CAP) { b.nextQueueAt = now + bRand(3000, 15000); break; }
        if (!botEnterQueue(state, id, botAmbientMode())) b.nextQueueAt = now + bRand(5000, 30000);
      }
      break;
    case 'queued': {
      if (inRoom) { b.phase = 'inMatch'; b.phaseAt = now; b.stayUntil = now + bRand(25000, 90000); break; }
      const qm = botQueueOf(state, id);
      if (!qm) { b.phase = 'idle'; b.nextQueueAt = now + bRand(5000, 40000); break; }
      if (now - b.phaseAt > b.patience && !botQueueHasHuman(state, qm)) {
        handleCancelMessage(state, id);
        b.phase = 'idle';
        b.nextQueueAt = now + bRand(5000, 40000);
      }
      break;
    }
    case 'inMatch': {
      if (!inRoom) {
        b.phase = 'post'; b.phaseAt = now; b.postWait = bRand(3000, 10000);
        break;
      }
      const room = state.rooms.get(c.room);
      // BedWars: agora o bot sabe jogar (luta, constrói ponte, compra na
      // loja e quebra cama) — ver bwBotTick/bwTickBots. Ele fica na sala
      // normalmente até a partida acabar de verdade (bwEndGame), igual um
      // jogador de verdade. O corte de segurança pra partida 100% bot que
      // travou fica dentro do próprio tick do BedWars (bwTickRoom).
      // Partida só de bots que travou por algum motivo: derruba depois de 8 min.
      if (room && room.startedAt && now - room.startedAt > 480000 && !roomHasHuman(state, room)) botsEndRoom(state, room);
      break;
    }
    case 'post':
      if (inRoom) { b.phase = 'inMatch'; b.phaseAt = now; break; }
      if (now - b.phaseAt > b.postWait) {
        if (BOT_AMBIENT_QUEUE && b.lastMode && (state.botActiveNow || 0) < BOT_ACTIVE_CAP && Math.random() < 0.55) {
          if (!botEnterQueue(state, id, b.lastMode)) { b.phase = 'idle'; b.nextQueueAt = now + bRand(5000, 40000); }
        } else {
          b.phase = 'idle';
          b.nextQueueAt = now + bRand(10000, 90000);
        }
      }
      break;
  }
}

// ---------- Preenchimento das filas quando tem gente de verdade esperando ----------
function botFillTarget(mode) {
  if (mode === 'ffa') { const r = Math.random(); return r < 0.75 ? 8 : r < 0.85 ? 7 : r < 0.95 ? 6 : 5; }
  if (isBedwarsMode(mode)) {
    const cfg = BEDWARS_MODES[mode];
    return Math.random() < 0.75 ? cfg.max : Math.floor(bRand(cfg.min, cfg.max + 1));
  }
  return MODE_INFO[mode].total;
}

function botsFillTick(state, now) {
  for (const mode of Object.keys(state.queues)) {
    const q = state.queues[mode];
    let f = state.botFill[mode];
    if (!botQueueHasPerson(state, mode)) { if (f) delete state.botFill[mode]; continue; }
    // Só tem bot esperando (sem humano): os outros bots entram igual entrariam por uma pessoa de
    // verdade, mas usando só bots que já estão online (não cria bot novo e não infla o online).
    const humanWaiting = botQueueHasHuman(state, mode);
    if (!f) f = state.botFill[mode] = { nextAt: now + bRand(600, 1500), target: botFillTarget(mode) };
    if (q.length >= f.target || now < f.nextAt) continue;
    if (!humanWaiting) {
      let freeN = 0;
      for (const fid of state.botIds) { if (botIsFree(state, fid)) freeN++; if (freeN >= 3) break; }
      if (freeN < Math.min(f.target - q.length, 3)) continue; // quase ninguém livre: espera (o bot desiste sozinho depois da paciência)
    }
    // Mega e Survival têm 20/100 vagas: entram vários bots por vez (senão o Survival levava ~100s pra encher
    // e parecia que os bots \"não queriam entrar\"). Os outros modos continuam 1 por vez.
    const perTick = mode === 'survival' ? Math.floor(bRand(5, 9)) : mode === 'mega' ? Math.floor(bRand(1, 3)) : 1;
    f.nextAt = now + (isBigFfa(mode) ? bRand(250, 700) : bRand(300, 1400));
    const used = botUsedNames(state);
    for (let n = 0; n < perTick && q.length < f.target; n++) {
      const free = [];
      for (const id of state.botIds) { if (botIsFree(state, id)) free.push(id); if (free.length >= 300) break; }
      let id;
      if (free.length) id = bPick(free);
      else if (humanWaiting && state.botIds.size < BOTS_MAX) id = botSpawn(state, used);
      else break;
      const ok = botEnterQueue(state, id, mode);
      if (!ok) console.log('[bots] bot ' + ((state.clients.get(id) || {}).name) + ' NÃO conseguiu entrar na fila de ' + mode);
    }
    if (humanWaiting) console.log('[bots] jogador real esperando em ' + mode + ' -> fila ' + q.length + '/' + f.target);
  }
}

// ---------- População online: crescimento "disfarçado" ----------
// O online começa em ~30 e daí em diante NÃO sobe reto: vai entrando gente a
// mais e saindo alguns (30 -> 40 -> 41 -> 48 -> 43 -> 52 ...), e a tendência
// é subir até o próximo marco da escada: 127, depois 200, e assim por diante.
// Depois do último degrau, fica na faixa do horário do dia (com o mesmo sobe-e-desce).
const BOT_POP_START_MIN = 20000;           // ponto de partida
const BOT_POP_START_MAX = 20000;
const BOT_POP_LADDER = [127, 200, 350, 500, 700, 927]; // marcos: chegou num, vai pro próximo
const BOT_POP_STEP_MIN_MS = 9000;          // de quanto em quanto tempo o alvo mexe (9–24s)
const BOT_POP_STEP_MAX_MS = 24000;
const BOT_POP_DIP_CHANCE = 0.28;           // chance de um passo ser de DESCIDA (uns desconectando)
// Depois de passar a escada: faixa do horário do dia.
function botTimeOfDayRange(now) {
  const h = new Date(now).getHours();
  if (h >= 0 && h < 6) return [90, 166];   // madrugada (meia-noite às 6h): bem baixo, ~128 online
  if (h < 9) return [250, 520];            // começo da manhã: ainda subindo
  return [700, 927];                       // resto do dia/noite: pico
}
// Sorteia o próximo alvo de online (um "passo" do passeio aleatório com tendência de subida).
function botPopNextTarget(pop, now) {
  return bClamp(BOTS_MAX, BOTS_MIN, BOTS_MAX); // fixo em 20 mil
}
function botsPopulationTick(state, now) {
  const pop = state.botPop;
  if (now >= pop.retargetAt) {
    pop.target = botPopNextTarget(pop, now);
    pop.retargetAt = now + bRand(BOT_POP_STEP_MIN_MS, BOT_POP_STEP_MAX_MS);
  }
  const have = state.botIds.size;
  const diff = pop.target - have;
  let changed = false;
  if (diff > 0) {
    // entram aos poucos (não todos no mesmo segundo)
    const n = Math.min(diff, Math.max(2, Math.ceil(diff * 0.4)), 5000); // no máximo 5 mil por rodada (não trava o servidor)
    const usedNames = botUsedNames(state);
    for (let i = 0; i < n; i++) botSpawn(state, usedNames);
    changed = true;
  } else if (diff < 0) {
    let n = Math.min(-diff, Math.max(1, Math.ceil(-diff * 0.4)), 5000);
    const free = [];
    for (const id of state.botIds) if (botIsFree(state, id) && !botHasHumanFriend(state.clients.get(id))) free.push(id);
    while (n-- > 0 && free.length) {
      const i = Math.floor(Math.random() * free.length);
      botDespawn(state, free[i]);
      free.splice(i, 1);
      changed = true;
    }
  }
  if (changed) broadcastOnline(state);
}

// ---------- Comportamento social dos bots (só quem tem conta vinculada) ----------
// Manda um pedido de amizade pra um humano que já jogou com esse bot antes.
function botSendFriendRequest(state, c, humanEmail) {
  const botEmail = c.accountId;
  const myFriends = ensureFriends(botEmail);
  const theirFriends = ensureFriends(humanEmail);
  if (myFriends.friends.includes(humanEmail) || myFriends.outgoing.includes(humanEmail)) return;
  // Se o humano já mandou um pedido pra esse bot, o sorteio de aceite (25%)
  // já foi feito na hora — não cruza um segundo pedido nem aceita por fora.
  if (myFriends.incoming.includes(humanEmail)) return;
  if (theirFriends.prefs.requests === false) return; // humano desligou "receber pedidos de amizade"
  const myUsername = displayNameFor(botEmail);
  myFriends.outgoing.push(humanEmail);
  theirFriends.incoming.push(botEmail);
  saveFriends();
  const notif = pushNotification(humanEmail, myUsername + ' mandou solicitação de amizade! Toque aqui para ver', { type: 'request', fromEmail: botEmail, fromUsername: myUsername });
  pushLiveUpdate(humanEmail, notif);
}
// Aceita um pedido de amizade pendente que um humano mandou pro bot.
function botAcceptFriendRequest(botEmail, requesterEmail) {
  const myFriends = ensureFriends(botEmail);
  if (!myFriends.incoming.includes(requesterEmail)) return;
  myFriends.incoming = myFriends.incoming.filter((e) => e !== requesterEmail);
  const theirFriends = ensureFriends(requesterEmail);
  theirFriends.outgoing = theirFriends.outgoing.filter((e) => e !== botEmail);
  if (!myFriends.friends.includes(requesterEmail)) myFriends.friends.push(requesterEmail);
  if (!theirFriends.friends.includes(botEmail)) theirFriends.friends.push(botEmail);
  saveFriends();
  const notif = pushNotification(requesterEmail, displayNameFor(botEmail) + ' Aceitou o seu pedido de amizade!', { type: 'accepted' });
  pushLiveUpdate(requesterEmail, notif);
}
// Chamado quando um HUMANO manda pedido de amizade pra uma conta de bot.
// Sorteio ÚNICO na hora que o pedido chega: 25% aceitam (depois de um tempo
// "humano"); nos outros 75% o pedido fica pendente, sem resposta.
function botOnHumanFriendRequest(botEmail, humanEmail) {
  if (Math.random() >= BOT_ACCEPT_REQUEST_CHANCE) return;
  setTimeout(() => botAcceptFriendRequest(botEmail, humanEmail), bRand(BOT_ACCEPT_DELAY_MIN, BOT_ACCEPT_DELAY_MAX));
}
// Convida um amigo humano (que está online agora) pra jogar um modo junto —
// mesmo fluxo de convite que dois jogadores de verdade usariam.
function botInviteToPlay(state, c, humanEmail, forcedMode) {
  const botEmail = c.accountId;
  if (c.room) return;
  const myFriends = ensureFriends(botEmail);
  if (!myFriends.friends.includes(humanEmail)) return;
  if (ensureFriends(humanEmail).prefs.invites === false) return; // humano desligou "receber convites pra jogar"
  const targetId = findClientInVs(state, humanEmail);
  if (targetId === null) return;
  const targetClient = state.clients.get(targetId);
  if (!targetClient || targetClient.room) return;
  if (isAccountBusyElsewhere(humanEmail, state, targetId)) return;
  const mode = forcedMode || botAmbientMode();
  const myUsername = displayNameFor(botEmail);
  const inviteId = crypto.randomBytes(6).toString('hex');
  const invite = {
    id: inviteId, fromEmail: botEmail, fromUsername: myUsername,
    toEmail: humanEmail, toUsername: displayNameFor(humanEmail),
    mode, vs: state.vsIndex, createdAt: Date.now(),
  };
  gameInvites[inviteId] = invite;
  setTimeout(() => {
    if (gameInvites[inviteId]) {
      delete gameInvites[inviteId];
      broadcastToAccount(humanEmail, { type: 'gameInviteExpired', inviteId });
      for (const target of findClientsByAccount(humanEmail)) sendFriendsData(target.state, target.id, humanEmail);
    }
  }, 60000);
  const notif = pushNotification(humanEmail, myUsername + ' Convidou você para jogar ' + (isBedwarsMode(mode) ? 'BedWars ' + BEDWARS_MODES[mode].label : mode) + '! Aceitar?', {
    type: 'gameInvite', inviteId, fromEmail: botEmail, fromUsername: myUsername, mode, vs: state.vsIndex,
  });
  pushLiveUpdate(humanEmail, notif);
}
// Manda uma mensagem de chat casual pra um amigo humano online — com um
// "digitando..." antes, com um atraso variável, pra não parecer instantâneo
// demais (comportamento de bot óbvio).
function botSendChatMessage(state, c, humanEmail) {
  const botEmail = c.accountId;
  const myFriends = ensureFriends(botEmail);
  if (!myFriends.friends.includes(humanEmail)) return;
  if (!isAccountOnline(humanEmail)) return;
  const recentlyPlayed = Date.now() - (c.bot.metHumans.get(humanEmail) || 0) < 20 * 60000;
  let line = botPickChatLine(recentlyPlayed).replace(/\{nome\}/g, botFriendlyName(displayNameFor(humanEmail))).replace(/\s+([,!?.])/g, '$1').replace(/\s+/g, ' ').trim();
  line = botStyle(line, c.bot.gender);
  const conv = botConvOf(botEmail, humanEmail);
  if (/bora|jogar|revanche/.test(line)) { conv.ask = 'play'; conv.askAt = Date.now(); conv.lastAsk = 'play'; conv.readyUntil = Date.now() + BOT_READY_MS; }
  else if (/tudo bem|dboa|como tá|tudo certo/.test(line)) { conv.ask = 'howAreYou'; conv.askAt = Date.now(); conv.lastAsk = 'howAreYou'; }
  botTypeAndSend(botEmail, humanEmail, line, bClamp(line.length * bRand(80, 140) + bRand(500, 1200), 1200, 9000), null);
}
// Responde (aceita ou recusa) um convite de partida que um HUMANO mandou
// pro bot — mesmo fluxo de quando um jogador de verdade aceita um convite.
function botRespondGameInvite(state, id, c, inviteId, accept) {
  const invite = gameInvites[inviteId];
  if (!invite || invite.toEmail !== c.accountId) return;
  delete gameInvites[inviteId];
  for (const target of findClientsByAccount(invite.toEmail)) sendFriendsData(target.state, target.id, invite.toEmail);
  if (!accept) {
    broadcastToAccount(invite.fromEmail, { type: 'gameInviteDeclined', mode: invite.mode, byUsername: displayNameFor(c.accountId) });
    return;
  }
  if (c.room || isAccountBusyElsewhere(c.accountId, state, id)) {
    broadcastToAccount(invite.fromEmail, { type: 'gameInviteDeclined', mode: invite.mode, byUsername: displayNameFor(c.accountId) });
    return;
  }
  const inviterId = findClientInVs(state, invite.fromEmail);
  if (inviterId === null) return;
  const inviterClient = state.clients.get(inviterId);
  if (!inviterClient || inviterClient.room || isAccountBusyElsewhere(invite.fromEmail, state, inviterId)) return;
  // O humano chamou esse bot pra jogar: guarda quem foi, pra saber (quando a
  // partida começar) que é uma partida de "convite direto" — o que muda a
  // chance de rage quit lá na frente.
  if (c.bot && !inviterClient.isBot) c.bot.pendingChallengeFrom = invite.fromEmail;
  for (const mode of Object.keys(state.queues)) {
    state.queues[mode] = state.queues[mode].filter((x) => x !== id && x !== inviterId);
  }
  send(state, inviterId, { type: 'inviteAccepted', mode: invite.mode });
  state.queues[invite.mode].unshift(inviterId, id);
  if (isBedwarsMode(invite.mode)) { bwLobbyEnter(state, inviterId, invite.mode); bwLobbyEnter(state, id, invite.mode); }
  if (invite.mode === 'ffa') processFfaQueue(state, { resetWait: true });
  else if (isBedwarsMode(invite.mode)) processBedwarsQueue(state, invite.mode, { resetWait: true });
  else tryMatch(state, invite.mode);
  broadcastOnline(state);
}
// Se um humano convidou esse bot pra jogar, ele "lê a notificação" com um
// atraso humano (alguns segundos) e então aceita (na maioria das vezes) ou
// recusa — em vez de deixar o convite pendurado até expirar sozinho.
function botMaybeRespondToInvites(state, id, c) {
  const invites = pendingInvitesFor(c.accountId);
  if (!invites.length) return;
  const inv = invites[0];
  if (c.bot.respondingInviteId === inv.id) return; // já agendado pra essa
  c.bot.respondingInviteId = inv.id;
  const ready = botIsReady(c.accountId, inv.fromEmail); // ele mesmo chamou / disse "bora": aceita na hora
  const accept = ready || Math.random() < 0.85;
  setTimeout(() => {
    const cc = state.clients.get(id);
    if (!cc || cc.bot.respondingInviteId !== inv.id) return;
    cc.bot.respondingInviteId = null;
    botRespondGameInvite(state, id, cc, inv.id, accept);
  }, ready ? bRand(800, 2200) : bRand(3000, 12000));
}
// A cada checagem, cada bot-com-conta sorteia no máximo UMA ação social
// (aceitar pedido / mandar pedido / convidar / mandar mensagem), espaçadas
// por um cooldown aleatório — pra parecer alguém que só de vez em quando
// mexe no jogo, não um robô martelando ações a cada segundo.
function botsSocialTick(state, now) {
  for (const id of state.botIds) {
    const c = state.clients.get(id);
    if (!c || !c.accountId) continue;
    const b = c.bot;
    botMaybeRespondToInvites(state, id, c); // reage a convite recebido, sem esperar o cooldown geral
    if (!b.socialInitiator) continue; // os outros só respondem (convites, mensagens, pedidos)
    if (now < b.nextSocialAt) continue;
    b.nextSocialAt = now + bRand(BOT_SOCIAL_COOLDOWN_MIN, BOT_SOCIAL_COOLDOWN_MAX);

    const myFriends = ensureFriends(c.accountId);
    if (!b.metHumans.size) continue;
    const candidates = Array.from(b.metHumans.keys());
    const human = candidates[Math.floor(Math.random() * candidates.length)];

    if (!myFriends.friends.includes(human)) {
      if (myFriends.outgoing.includes(human)) continue; // já esperando resposta
      if (Math.random() < BOT_FRIEND_REQUEST_CHANCE) botSendFriendRequest(state, c, human);
      continue;
    }
    if (!isAccountOnline(human)) continue; // só puxa assunto com quem está online agora
    const roll = Math.random();
    if (roll < BOT_INVITE_CHANCE) botInviteToPlay(state, c, human);
    else if (roll < BOT_INVITE_CHANCE + BOT_MESSAGE_CHANCE) botSendChatMessage(state, c, human);
  }
}


// ---------- Chat da partida: bots falando ----------
// (1) Quando um jogador de verdade manda mensagem no chat da partida, em 30%
//     das vezes algum bot da sala responde (às vezes dois), com uma fala que
//     combina com o que foi dito.
// (2) 30% dos bots, por conta própria, mandam uma mensagem durante a partida:
//     oi, "nós vai perder", "vc é br?" e outras coisas.
// Bot parado (AFK) NÃO manda nada, nem responde.
const BOT_MATCH_REPLY_CHANCE = 0.30;
const BOT_MATCH_SPONTANEOUS_CHANCE = 0.30;
function botCanChat(c) {
  return !!(c && c.isBot && c.bot && c.bot.archetype !== 'afk' && !c.bot.hasQuit && !c.bot.leaving);
}
const BOT_MCHAT_LINES = {
  hi: ['oi', 'eae', 'salve', 'opa', 'fala', 'e aí', 'oii', 'fala galera', 'eae mn', 'opa, bora', 'oi galera', 'salve salve'],
  lose: ['nois vai perder kkk', 'nós vai perder isso aqui', 'já perdemos kkkk', 'vixe, nois vai perder', 'ferrou, nós vai perder', 'nois vai perder feio', 'vamo perder de novo kkk', 'nós vai perder fácil'],
  loseSolo: ['vou perder kkk', 'vou perder essa', 'vixe, vou perder feio', 'hj eu perco kkk', 'já perdi kkkk'],
  br: ['vc é br?', 'br?', 'alguém aqui é br?', 'todo mundo br aqui?', 'sou br, e vcs?', 'br aqui kkk', 'quem é br?', 'vcs são br?', 'é br?'],
  other: ['gg', 'bora', 'boa sorte', 'que lag hj', 'quem perder paga o pix kkk', 'ez', 'partiu', 'bora kkkk', 'fé kkk', 'vai ser tenso', 'me ajuda aí kkk', 'essa vai ser difícil', 'kkkkk que isso'],
};
const BOT_MCHAT_REPLIES = {
  hi: ['oi', 'eae', 'salve', 'opa', 'fala', 'e aí', 'oi mn', 'fala aí'],
  brYes: ['sou sim', 'sou br sim, e vc?', 'br sim kkk', 'sou, e vc?', 'sou br kkk', 'sim, br'],
  brSaid: ['eu tbm kkk', 'salve br', 'br gang kkk', 'tmj br', 'também sou br', 'boa, br aqui também'],
  roastToxic: ['ruim é vc kkkk', 'chora mais kkk', 'fala isso qnd eu te matar', 'vem 1x1 então', 'olha quem fala kkk', 'kkkk ruim é vc'],
  roastCalm: ['kkk calma', 'relaxa mn', 'ruim nada kkk', 'de boa mano', 'kkk tô só aquecendo', 'ih, tá nervoso kkk'],
  loseTalk: ['kkk relaxa, dá pra virar', 'ainda dá pra ganhar', 'nada, a gente vira', 'kkkk verdade, tá feio', 'calma que ainda dá', 'kkk vdd'],
  winTalk: ['bora que ganha', 'isso aí', 'fé kkk', 'ez', 'vamo que vamo', 'partiu ganhar'],
  gg: ['gg', 'gg wp', 'gg mn', 'boa partida kkk', 'gg ez'],
  thanks: ['de nada', 'tmj', 'de nada mn', 'nada'],
  luck: ['vlw, vc tb', 'boa sorte pra nois kkk', 'tmj, boa sorte', 'valeu, pra vc tb', 'vamo que vamo'],
  play: ['bora!', 'partiu', 'bora kkk', 'bora sim'],
  laugh: ['kkkk', 'kkkkk', 'rsrs', 'kkk'],
  yesNo: ['sim', 'n', 'talvez kkk', 'acho que sim', 'acho q n', 'sei lá mn', 'com certeza', 'acho que não'],
  fallback: ['kkk', 'verdade', 'boa', 'aham', 'ss', 'vdd', 'kkkk é isso', 'pode ser'],
};
function botMatchReplyText(c, norm) {
  const key = 'match|' + c.name;
  const pick = (pool) => botPickFresh(key, pool);
  const toxic = !!(c.bot && c.bot.toxic);
  const asks = norm.includes('?');
  let text;
  if (BOT_RX.crisis.test(norm)) return botStyle(pick(BOT_REPLIES.crisis), c.bot && c.bot.gender);
  else if (BOT_RX.gender.test(norm)) text = pick(c.bot && c.bot.gender === 'f' ? BOT_REPLIES.gender_f : BOT_REPLIES.gender_m);
  else if (BOT_RX.asBot.test(norm)) text = pick(BOT_REPLIES.asBot);
  else if (/\b(br|brasil|brasileir[oa]s?)\b/.test(norm)) text = (asks || /\b(e|eh|sao) (br|brasileir\w*)\b/.test(norm)) ? pick(BOT_MCHAT_REPLIES.brYes) : pick(BOT_MCHAT_REPLIES.brSaid);
  else if (BOT_RX.insult.test(norm) || BOT_RX.roast.test(norm)) text = pick(toxic ? BOT_MCHAT_REPLIES.roastToxic : BOT_MCHAT_REPLIES.roastCalm);
  else if (/\b(perder|perdemos|perdi|perdeu|vai perder|vamos perder)\b/.test(norm)) text = pick(BOT_MCHAT_REPLIES.loseTalk);
  else if (/\b(ganhar|ganhamos|ganhei|vamos ganhar|vai ganhar|ganha)\b/.test(norm)) text = pick(BOT_MCHAT_REPLIES.winTalk);
  else if (/\b(gg|gg wp|ez|boa partida|bom jogo)\b/.test(norm)) text = pick(BOT_MCHAT_REPLIES.gg);
  else if (/\b(boa sorte|bl|good luck)\b/.test(norm)) text = pick(BOT_MCHAT_REPLIES.luck);
  else if (BOT_RX.thanks.test(norm)) text = pick(BOT_MCHAT_REPLIES.thanks);
  else if (BOT_RX.praise.test(norm)) text = pick(BOT_REPLIES.praise);
  else if (BOT_RX.timeGreet.test(norm) || BOT_RX.greeting.test(norm)) text = pick(BOT_MCHAT_REPLIES.hi);
  else if (BOT_RX.howAreYou.test(norm)) text = pick(BOT_MOOD_LINES[botMoodOf(c.name)]) + (Math.random() < 0.6 ? ', e vc?' : '');
  else if (BOT_RX.name.test(norm)) text = 'meu nick tá aí em cima kkk';
  else if (BOT_RX.age.test(norm)) text = pick(BOT_REPLIES.age);
  else if (BOT_RX.where.test(norm)) text = pick(BOT_REPLIES.where);
  else if (BOT_RX.bye.test(norm)) text = pick(BOT_REPLIES.bye);
  else if (BOT_RX.play.test(norm)) text = pick(BOT_MCHAT_REPLIES.play);
  else if (BOT_RX.laugh.test(norm)) text = pick(BOT_MCHAT_REPLIES.laugh);
  else if (asks) text = pick(BOT_MCHAT_REPLIES.yesNo);
  else text = pick(BOT_MCHAT_REPLIES.fallback);
  return botStyle(text.replace(/\{nome\}/g, '').replace(/\{self\}/g, c.name).replace(/\s+([,!?.])/g, '$1').replace(/\s+/g, ' ').trim(), c.bot && c.bot.gender);
}
const BOT_MATCH_TYPE_MIN = 4000;
const BOT_MATCH_TYPE_MAX = 6000;
// Escreve (parado, 4–6s) e manda. false se não deu pra começar (apanhando / já escrevendo).
function botMatchTypeAndSend(state, room, botId, text) {
  const c = state.clients.get(botId);
  if (!text || !botCanChat(c) || state.rooms.get(c.room) !== room) return false;
  return !!botStartTyping(c, bRand(BOT_MATCH_TYPE_MIN, BOT_MATCH_TYPE_MAX), () => botSendMatchChat(state, room, botId, text));
}
// Igual a botMatchTypeAndSend, mas se o bot estiver momentaneamente ocupado
// (já escrevendo outra coisa / acabou de apanhar), tenta de novo em vez de
// simplesmente desistir da mensagem — sem isso, quando alguém chama o bot
// pelo nome (ou manda algo grave) bem na hora em que ele tá ocupado, ele
// nunca via/respondia aquilo, ficava mudo pra sempre com aquela mensagem.
function botMatchTypeAndSendRetry(state, room, botId, text, attemptsLeft) {
  if (attemptsLeft === undefined) attemptsLeft = 5;
  if (botMatchTypeAndSend(state, room, botId, text)) return;
  const c = state.clients.get(botId);
  if (attemptsLeft <= 0 || !botCanChat(c) || state.rooms.get(c.room) !== room) return;
  setTimeout(() => botMatchTypeAndSendRetry(state, room, botId, text, attemptsLeft - 1), bRand(700, 1400));
}
function botSendMatchChat(state, room, botId, text) {
  const c = state.clients.get(botId);
  if (!c || !c.isBot || !text || state.rooms.get(c.room) !== room || !botCanChat(c)) return;
  for (const p of room.players) {
    const pc = state.clients.get(p.id);
    if (pc && !pc.isBot) send(state, p.id, { type: 'matchChat', name: c.name, text });
  }
}
// ---------- "Chamar por nome" no chat da partida, "alguém morreu?" e "timing" (FFA) ----------
const BOT_RX_SOMEONE_DIED = /\balguem\s+(ja\s+)?morreu\b|\bmorreu\s+alguem\b|\bteve\s+alguma\s+morte\b|\bmorreu\s+algum\b/;
const BOT_RX_TEAM_UP = /\b(fazer\s+(um\s+|uma\s+)?tim(e|ing)\b|timing\b|fazer\s+dupla\b|vamo\s+de\s+dupla\b|quer\s+(ser\s+meu\s+)?aliad[oa]\b|fazer\s+alianca\b|vira\s+meu\s+aliad[oa]\b|topa\s+(fazer\s+)?tim(e|ing)\b|bora\s+de\s+alianca\b)/;
const BOT_MCHAT_DENY_INSULT = ['não, por quê?', 'não é não, por que vc falou isso?', 'quem te falou isso?', 'não, para de mentira kkk', 'mentira, não é não', 'não, por que isso agora?'];
const BOT_MCHAT_MOCK_REACT = ['iiii', 'lá ele', 'eita', 'affs', 'kkkkk pegou', 'ooooh', 'mds'];
// Acha, pelo primeiro nome citado na mensagem, um bot na sala pra quem ela foi
// direcionada (aceita nome parcial, tipo só o começo do nick).
function botFindNamedTarget(state, room, rawText, senderId) {
  const first = (String(rawText || '').trim().split(/[\s,:;!?.]+/)[0] || '');
  const tok = botNorm(first);
  if (!tok || tok.length < 2) return null;
  for (const p of room.players) {
    if (p.id === senderId) continue;
    const c = state.clients.get(p.id);
    if (!botCanChat(c)) continue;
    const firstName = botNorm((c.name || '').split(/\s+/)[0] || '');
    if (!firstName || firstName.length < 2) continue;
    if (firstName === tok || (firstName.length >= 3 && (firstName.startsWith(tok) || tok.startsWith(firstName)))) return { id: p.id, c };
  }
  return null;
}
function botsOnMatchChat(state, room, senderId, rawText) {
  const norm = botNorm(rawText);
  if (!norm) return;
  const crisis = BOT_RX.crisis.test(norm);
  const isAttack = BOT_RX.insult.test(norm) || BOT_RX.roast.test(norm);

  // Conta xingamento pra decisão de rage quit (independe de o bot responder).
  if (isAttack) {
    for (const p of room.players) {
      if (p.id === senderId) continue;
      const c = state.clients.get(p.id);
      if (c && c.isBot && c.bot) c.bot.insultsTaken = (c.bot.insultsTaken || 0) + 1;
    }
  }

  // Mensagem de crise no chat da partida: os bots da sala falam (até 3), cada um
  // com uma fala diferente e um pouco depois do outro.
  if (crisis) {
    const cands = [];
    for (const p of room.players) {
      if (p.id === senderId) continue;
      const c = state.clients.get(p.id);
      if (botCanChat(c)) cands.push({ id: p.id, c });
    }
    if (!cands.length) return;
    const n = Math.min(cands.length, Math.random() < 0.5 ? 3 : 2);
    const pool = BOT_REPLIES.crisis.slice();
    for (let i = 0; i < n; i++) {
      const pick = cands.splice(Math.floor(Math.random() * cands.length), 1)[0];
      const line = botStyle(pool.splice(Math.floor(Math.random() * pool.length), 1)[0], pick.c.bot && pick.c.bot.gender);
      if (i === 0) botMatchTypeAndSendRetry(state, room, pick.id, line);
      else setTimeout(() => botMatchTypeAndSendRetry(state, room, pick.id, line), bRand(1500, 4000) * i);
    }
    return;
  }

  // "Alguém morreu?" — cada bot que responde nega, A NÃO SER que ele mesmo
  // tenha morrido na partida, aí ele conta a verdade.
  if (!crisis && BOT_RX_SOMEONE_DIED.test(norm)) {
    const cands = [];
    for (const p of room.players) {
      if (p.id === senderId) continue;
      const c = state.clients.get(p.id);
      if (botCanChat(c)) cands.push({ id: p.id, p, c });
    }
    if (cands.length) {
      const n = Math.min(cands.length, Math.random() < 0.4 ? 2 : 1);
      for (let i = 0; i < n; i++) {
        const pick = cands.splice(Math.floor(Math.random() * cands.length), 1)[0];
        const dead = !pick.p.alive;
        const text = dead ? bPick(['eu morri kkk', 'eu já morri', 'eu já fui, morri', 'morri sim']) : bPick(['não', 'n', 'não que eu saiba', 'aqui não morreu ninguém', 'não morri não']);
        if (i === 0) botMatchTypeAndSendRetry(state, room, pick.id, text);
        else setTimeout(() => botMatchTypeAndSendRetry(state, room, pick.id, text), bRand(800, 2000));
      }
    }
    return;
  }

  // Mensagem endereçada pelo nome de alguém da sala.
  const target = !crisis ? botFindNamedTarget(state, room, rawText, senderId) : null;
  if (target) {
    if (isAttack) {
      // Quem foi chamado nega, e o resto da sala debocha.
      botMatchTypeAndSendRetry(state, room, target.id, botStyle(bPick(BOT_MCHAT_DENY_INSULT), target.c.bot && target.c.bot.gender));
      const others = [];
      for (const p of room.players) {
        if (p.id === senderId || p.id === target.id) continue;
        const c = state.clients.get(p.id);
        if (botCanChat(c)) others.push({ id: p.id, c });
      }
      const nReact = Math.min(others.length, Math.random() < 0.5 ? 2 : 1);
      for (let i = 0; i < nReact; i++) {
        const pick = others.splice(Math.floor(Math.random() * others.length), 1)[0];
        setTimeout(() => botMatchTypeAndSend(state, room, pick.id, bPick(BOT_MCHAT_MOCK_REACT)), bRand(600, 2200) * (i + 1));
      }
    } else {
      // Mensagem comum direcionada por nome: só quem foi chamado responde.
      botMatchTypeAndSendRetry(state, room, target.id, botMatchReplyText(target.c, norm));
    }
    return;
  }

  // "Timing" no FFA: 20% de chance de topar virar aliado até a partida acabar
  // (some do alvo até que ele mesmo bata no bot — ver applyHit).
  if (!crisis && room.mode === 'ffa' && BOT_RX_TEAM_UP.test(norm)) {
    const sc = state.clients.get(senderId);
    const cands = [];
    for (const p of room.players) {
      if (p.id === senderId) continue;
      const c = state.clients.get(p.id);
      if (botCanChat(c) && p.alive) cands.push({ id: p.id, p, c });
    }
    if (cands.length) {
      const pick = bPick(cands);
      const accept = Math.random() < 0.20;
      if (accept) {
        pick.c.bot.allyHumanId = senderId;
        pick.c.bot.allyHumanEmail = (sc && sc.accountId) || null;
      }
      botMatchTypeAndSend(state, room, pick.id, botStyle(accept ? bPick(['bora, sem se atracar hein', 'fechado, bora de timing', 'topo! só não me bate depois', 'bora, aliados até acabar']) : bPick(['não, prefiro sozinho', 'não vou não, kkk', 'de boa, mas não hoje', 'não, cada um por si']), pick.c.bot && pick.c.bot.gender));
    }
    return;
  }

  if (!crisis && Math.random() >= BOT_MATCH_REPLY_CHANCE) return;
  const cands = [];
  for (const p of room.players) {
    if (p.id === senderId) continue;
    const c = state.clients.get(p.id);
    if (botCanChat(c)) cands.push({ id: p.id, c });
  }
  if (!cands.length) return;
  const n = (!crisis && cands.length > 1 && Math.random() < 0.25) ? 2 : 1;
  for (let i = 0; i < n; i++) {
    const pick = cands.splice(Math.floor(Math.random() * cands.length), 1)[0];
    const text = botMatchReplyText(pick.c, norm);
    // o 2º bot só começa a escrever um pouco depois do 1º
    if (i === 0) botMatchTypeAndSend(state, room, pick.id, text);
    else setTimeout(() => botMatchTypeAndSend(state, room, pick.id, text), bRand(1200, 3000));
  }
}
// Falas espontâneas: nada de "afirmar" coisa que não é verdade (tipo "vamo
// perder" sem nem ter perdido ainda) — isso quebra a simulação. Só coisas
// neutras, que não dependem do placar de verdade.
function botSpontaneousLine(room, gender) {
  const r = Math.random();
  let pool;
  if (r < 0.40) pool = BOT_MCHAT_LINES.hi;
  else if (r < 0.72) pool = BOT_MCHAT_LINES.br;
  else pool = BOT_MCHAT_LINES.other;
  return botStyle(bPick(pool), gender);
}
// Roda a cada ~1,5s: cada bot que entra numa sala com gente de verdade sorteia
// UMA vez (30%) se vai puxar assunto e em que momento; depois raramente fala de novo.
function botsMatchChatTick(state, now) {
  for (const room of state.rooms.values()) {
    if (!roomHasHuman(state, room)) continue;
    for (const p of room.players) {
      const c = state.clients.get(p.id);
      if (!botCanChat(c)) continue; // parado (AFK) não fala nada
      const b = c.bot;
      if (b.chatRoom !== room) {
        b.chatRoom = room;
        b.chatSpoke = 0;
        b.chatAt = Math.random() < BOT_MATCH_SPONTANEOUS_CHANCE ? now + bRand(2500, 40000) : 0;
      }
      if (b.chatAt && now >= b.chatAt) {
        if (!botMatchTypeAndSend(state, room, p.id, botSpontaneousLine(room, b.gender))) { b.chatAt = now + 3000; continue; } // apanhando / ocupado: tenta de novo daqui a pouco
        b.chatAt = 0;
        b.chatSpoke++;
        if (b.chatSpoke < 2 && Math.random() < 0.15) b.chatAt = now + bRand(20000, 60000);
      }
    }
  }
}

// ---------- Simulação de luta ----------
// Arena do Survival = 8x a normal (igual ao cliente: ARENA_HALF_BASE * SURVIVAL_ARENA_MUL).
const ARENA_HALF_BASE_SV = 19;
function bigArenaHalf(mode) { return ARENA_HALF_BASE_SV * (BIG_FFA_ARENA_MUL[mode] || 1); }
function botArenaLim(room) {
  return bigArenaHalf(room && room.mode) - 0.6;
}
function botSpawnPoint(room, p) {
  const roster = room.roster;
  if (room.mode === 'ffa' || isBigFfa(room.mode)) {
    // Mesma conta do cliente (spawnForFfa): círculo, ordenado pelo id. No Survival
    // o raio é 80% da arena gigante — antes os bots caíam todos no mesmo ponto.
    const order = roster.map((r) => r.id).sort((a, b) => a - b);
    const idx = Math.max(0, order.indexOf(p.id));
    const angle = (idx / Math.max(order.length, 1)) * Math.PI * 2;
    const radius = isBigFfa(room.mode) ? bigArenaHalf(room.mode) * 0.8 : 12;
    return { x: Math.sin(angle) * radius, z: Math.cos(angle) * radius, yaw: angle + Math.PI };
  }
  const me = roster.find((r) => r.id === p.id) || p;
  const teamSize = roster.filter((r) => r.team === me.team).length;
  const arr = { 1: [0], 2: [-3, 3], 3: [-6, 0, 6], 4: [-6, -2, 2, 6], 5: [-8, -4, 0, 4, 8] }[teamSize] || [0];
  const x = arr[Math.min(me.slot, arr.length - 1)] || 0;
  return { x, z: me.team === 'A' ? 14 : -14, yaw: me.team === 'A' ? 0 : Math.PI };
}

function botRespawn(room, p, b, now) {
  const sp = botSpawnPoint(room, p);
  b.x = sp.x; b.z = sp.z; b.y = 0; b.vy = 0; b.yaw = sp.yaw; b.pitch = 0;
  b.kx = 0; b.kz = 0; b.stun = 0; b.grounded = true;
  b.punchCd = 0; b.fleeing = false; b.fleeCool = 0; b.targetId = null;
  // A técnica muda a abertura: ambusher finge que não viu ninguém por mais
  // tempo (fica parado "escondido"); rusher quase não espera; os outros
  // ficam no tempo padrão. O pulo inicial também não é mais igual pra todo
  // mundo (kiter pula logo pra já começar driblando; rusher demora mais).
  const opening = (room.freezeUntil || now) + bRand(150, 450);
  const tactic = b.combatTactic;
  b.engageAt = tactic === 'ambusher' ? opening + bRand(700, 1800) : tactic === 'rusher' ? opening - bRand(0, 150) : opening;
  b.nextJumpAt = b.engageAt + (tactic === 'kiter' ? bRand(150, 700) : tactic === 'rusher' ? bRand(1200, 3200) : bRand(500, 2500));
}

// Chamado pelo applyHit quando o alvo é um bot.
function botOnHit(c, dx, dz) {
  const b = c.bot;
  const len = Math.hypot(dx || 0, dz || 0);
  if (len > 0) { b.kx = (dx / len) * B_KNOCK_SPEED; b.kz = (dz / len) * B_KNOCK_SPEED; b.stun = B_KNOCK_STUN; }
  b.vy = B_KNOCK_UP; b.grounded = false;
  b.lastHitAt = Date.now();
  // Apanhou enquanto escrevia: para de escrever e a mensagem NÃO é enviada.
  if (b.chatBusy) botCancelTyping(c);
}
// Bot "escreve" por `ms` (fica parado, sem andar nem bater) e depois manda.
// Se alguém bater nele nesse meio tempo, a escrita é cancelada (botOnHit).
// Não começa a escrever se já está escrevendo ou se acabou de apanhar.
const BOT_HIT_QUIET_MS = 3000;
function botStartTyping(c, ms, onSend, humanEmail, onCancel) {
  const b = c.bot;
  const now = Date.now();
  if (!b || b.chatBusy || now - b.lastHitAt < BOT_HIT_QUIET_MS) return null;
  const job = { cancelled: false, humanEmail: humanEmail || null, onCancel: onCancel || null };
  b.chatBusy = job;
  b.typingUntil = now + ms;
  if (job.humanEmail && c.accountId) broadcastToAccount(job.humanEmail, { type: 'typing', fromEmail: c.accountId });
  setTimeout(() => {
    if (b.chatBusy === job) { b.chatBusy = null; b.typingUntil = 0; }
    if (job.cancelled) return;
    onSend();
  }, ms);
  return job;
}
function botCancelTyping(c) {
  const b = c.bot;
  const job = b.chatBusy;
  if (!job) return;
  job.cancelled = true;
  b.chatBusy = null;
  b.typingUntil = 0;
  if (job.humanEmail && c.accountId) broadcastToAccount(job.humanEmail, { type: 'stopTyping', fromEmail: c.accountId });
  if (job.onCancel) job.onCancel();
}

// 1x1 contra jogador de verdade: o cliente decide as rodadas e avisa com
// 'roundReset'; aqui só volta os bots pro começo e congela na contagem.
function botsEndRoom(state, room) {
  for (const p of room.players) {
    const pc = state.clients.get(p.id);
    if (pc) pc.room = null;
  }
  for (const [roomId, r] of state.rooms) {
    if (r === room) { state.rooms.delete(roomId); break; }
  }
  broadcastOnline(state);
}

function botsResetForNewRound(state, room) {
  let any = false;
  for (const p of room.players) {
    const c = state.clients.get(p.id);
    if (c && c.isBot) { p.alive = true; p.hp = p.maxHp || 20; p.regenTimer = 0; any = true; }
  }
  if (any) {
    room.epoch = (room.epoch || 0) + 1;
    room.freezeUntil = Date.now() + 2900;
  }
}

function botPosOf(state, room, q) {
  const qc = state.clients.get(q.id);
  if (!qc) return null;
  if (qc.isBot) return { x: qc.bot.x, y: qc.bot.y, z: qc.bot.z };
  if (qc.pos) return qc.pos;
  const sp = botSpawnPoint(room, q);
  return { x: sp.x, y: 0, z: sp.z };
}

// Executa o rage quit de verdade: sai da sala (mesmo caminho de sempre) e
// guarda o motivo, pra responder direito se o humano perguntar depois "pq vc
// saiu?" numa mensagem privada.
function botRagequit(state, id, b, humanEmail) {
  const reason = (b.deathsThisMatch - b.killsAgainstHumanThisMatch) >= 1 ? (Math.random() < 0.65 ? 'losing' : 'boring') : 'boring';
  const c = state.clients.get(id);
  if (c && c.accountId) botQuitMemory.set(c.accountId + '|' + (humanEmail || ''), { reason, at: Date.now() });
  removeFromRoom(state, id);
}

function botTick(state, room, p, c, dt, now) {
  const B_LIM = botArenaLim(room); // Survival tem arena 8x maior
  const b = c.bot;
  const isNewMatch = b.roomRef !== room;
  if (isNewMatch || b.epoch !== (room.epoch || 0)) {
    // posição antiga dos jogadores de verdade não vale mais (nova partida/rodada)
    for (const q of room.players) { const qc = state.clients.get(q.id); if (qc && !qc.isBot) qc.pos = null; }
    botRespawn(room, p, b, now);
    b.roomRef = room;
    b.epoch = room.epoch || 0;
  }
  if (isNewMatch && b.archetype === 'quitter') {
    // Reseta a "hora de desistir" só quando entra numa partida NOVA (não a
    // cada rodada), senão ele tentaria kitar de novo em toda rodada seguinte.
    b.hasQuit = false;
    b.leaving = false;
    b.quitAt = now + bRand(4000, 30000);
  }
  if (isNewMatch && b.archetype === 'afk') {
    b.afkActive = true;
    // 3% desses bots "acordam" em algum momento da partida e voltam a jogar normal
    b.afkWakeAt = Math.random() < BOT_ARCHETYPE_AFK_WAKE_CHANCE ? now + bRand(5000, 45000) : 0;
  }

  // Parado esperando sair (quitter / rage quit): fica congelado no lugar por
  // 2-4s (ver setTimeout mais abaixo) e só então some da sala de verdade —
  // mas NÃO sai da função aqui: precisa continuar até a seção de física lá
  // embaixo, senão ele fica imune a soco (empurrão) enquanto "kita". A IA
  // dele (decisão de mover/mirar/socar) é bloqueada mais abaixo com o
  // próprio `b.leaving` na condição.

  // Arquétipo "quitter": desiste no meio da partida, como jogador de
  // verdade que rage-quita — fica parado uns segundos e sai (mesmo caminho
  // de saída de sempre, removeFromRoom), então o resto da sala trata isso
  // normalmente.
  if (b.archetype === 'quitter' && b.quitAt && !b.hasQuit && now > b.quitAt) {
    b.hasQuit = true;
    b.leaving = true;
    setTimeout(() => removeFromRoom(state, p.id), bRand(2000, 4000));
    return;
  }

  // "Rage quit" dinâmico: sorteia só uma vez por partida nova, só quando tem
  // gente de verdade na sala e o bot não é já um "quitter" de arquétipo.
  if (isNewMatch) {
    b.insultsTaken = 0;
    b.deathsThisMatch = 0;
    b.killsAgainstHumanThisMatch = 0;
    b.hasRagequit = false;
    b.ragequitPlanned = false;
    b.ragequitAt = 0;
    b.leaving = false;
    b.allyHumanId = null;
    b.allyHumanEmail = null;
    const challengeEmail = b.pendingChallengeFrom;
    b.pendingChallengeFrom = null;
    const humanInRoom = roomHasHuman(state, room);
    b.isChallengeMatch = !!(challengeEmail && room.players.some((pp) => {
      const pc = state.clients.get(pp.id);
      return pc && !pc.isBot && pc.accountId === challengeEmail;
    }));
    b.challengeHumanEmail = b.isChallengeMatch ? challengeEmail : null;
    if (b.archetype !== 'quitter' && humanInRoom) {
      if (b.isChallengeMatch) {
        // só "planeja" — só sai de verdade se depois vier xingamento + goleada (checado abaixo)
        b.ragequitPlanned = Math.random() < BOT_RAGEQUIT_CHANCE_CHALLENGE;
      } else if (Math.random() < BOT_RAGEQUIT_CHANCE_NORMAL) {
        b.ragequitPlanned = true;
        b.ragequitAt = now + bRand(15000, 90000);
      }
    }
  }
  if (b.ragequitPlanned && !b.hasRagequit) {
    if (b.isChallengeMatch) {
      if (b.insultsTaken >= BOT_RAGEQUIT_INSULT_THRESHOLD && (b.deathsThisMatch - b.killsAgainstHumanThisMatch) >= BOT_RAGEQUIT_DEATH_MARGIN) {
        b.hasRagequit = true;
        b.leaving = true;
        const humanEmail = b.challengeHumanEmail;
        setTimeout(() => botRagequit(state, p.id, b, humanEmail), bRand(2000, 4000));
        return;
      }
    } else if (b.ragequitAt && now > b.ragequitAt) {
      b.hasRagequit = true;
      b.leaving = true;
      setTimeout(() => botRagequit(state, p.id, b, null), bRand(2000, 4000));
      return;
    }
  }

  // ---- decisão (só se vivo e a rodada já começou) ----
  let mx = 0, mz = 0, wantJump = false;
  const frozen = now < room.freezeUntil || now < b.engageAt;
  // Arquétipo "afk": fica parado no lugar (mas continua podendo ser
  // empurrado por um soco, isso é física, não decisão de movimento).
  // 3% desses bots "acordam" no meio da partida e voltam a jogar normal.
  if (b.archetype === 'afk' && b.afkActive && b.afkWakeAt && now > b.afkWakeAt) b.afkActive = false;
  const isAfk = b.archetype === 'afk' && b.afkActive;
  const isTyping = now < b.typingUntil; // parado escrevendo mensagem
  if (p.alive && !frozen && !isAfk && !isTyping && !b.leaving) {
    // alvo: inimigo vivo mais "atraente" (perto e com pouca vida), com histerese
    if (now - b.targetAt > 500 || !b.targetId) {
      let best = null, bestScore = Infinity;
      for (const q of room.players) {
        if (!q.alive || q.team === p.team) continue;
        if (b.allyHumanId === q.id) continue; // "timing": não ataca quem virou aliado no FFA
        if (q.cheats && q.cheats.invis) continue; // ADM invisível: os bots não acham
        const qp = botPosOf(state, room, q);
        if (!qp) continue;
        let score = Math.hypot(qp.x - b.x, qp.z - b.z) + q.hp * 0.15;
        if (q.id === b.targetId) score -= 1.5;
        if (score < bestScore) { bestScore = score; best = q; }
      }
      b.targetId = best ? best.id : null;
      b.targetAt = now;
    }
    const tq = room.players.find((q) => q.id === b.targetId && q.alive);
    const tp = tq ? botPosOf(state, room, tq) : null;

    if (tq && tp) {
      let dx = tp.x - b.x, dz = tp.z - b.z;
      const dist = Math.max(0.001, Math.hypot(dx, dz));
      const ux = dx / dist, uz = dz / dist;
      const perpX = -uz, perpZ = ux;

      // ruído de mira renovado de tempos em tempos
      if (now > b.aimErrAt) { b.aimErr = bGauss() * b.aimNoise; b.aimErrAt = now + bRand(250, 550); }

      // ---- fugir com pouca vida ----
      const wall = Math.min(B_LIM - Math.abs(b.x), B_LIM - Math.abs(b.z));
      const cornered = wall < 1.6 && dist < 3.5;
      const lowHp = p.hp <= b.fleeHp && tq.hp > p.hp;
      if (!b.fleeing && lowHp && !cornered && now > b.fleeCool) {
        b.fleeing = true;
        b.fleeUntil = now + bRand(2500, 6000);
      }
      if (b.fleeing && (now > b.fleeUntil || cornered || !lowHp)) {
        b.fleeing = false;
        b.fleeCool = now + bRand(5000, 9000);
      }

      let faceYaw;
      if (b.fleeing) {
        let ax = -ux, az = -uz;
        const push = 4;
        if (b.x > B_LIM - push) ax -= (b.x - (B_LIM - push)) / push * 1.6;
        if (b.x < -B_LIM + push) ax += ((-B_LIM + push) - b.x) / push * 1.6;
        if (b.z > B_LIM - push) az -= (b.z - (B_LIM - push)) / push * 1.6;
        if (b.z < -B_LIM + push) az += ((-B_LIM + push) - b.z) / push * 1.6;
        ax += -az * 0.5 * b.strafeDir; az += ax * 0.5 * b.strafeDir; // contorna em vez de correr em linha reta
        const l = Math.hypot(ax, az) || 1;
        mx = ax / l; mz = az / l;
        faceYaw = Math.atan2(-mx, -mz);
        if (now > b.nextJumpAt) wantJump = true;
      } else {
        // ---- luta: aproxima, mantém distância e faz strafe — o "como" muda
        // conforme a técnica sorteada do bot (ver BOT_COMBAT_TACTICS), pra
        // não ser sempre o mesmo andar-na-sua-direção-e-pular ----
        const tactic = b.combatTactic;
        const tacticPrefDist = tactic === 'kiter' ? b.prefDist + 2.2 : tactic === 'rusher' ? Math.min(b.prefDist, 1.4) : b.prefDist;
        let fwd = 0;
        if (now < b.backoffUntil) fwd = -0.8;
        else if (dist > tacticPrefDist + 0.6) fwd = 1;
        else if (dist < tacticPrefDist - 0.7) fwd = tactic === 'rusher' ? 0 : -0.7;
        if (now > b.strafeUntil) {
          // faker troca de direção muito mais seguido (finta) e às vezes
          // recua de propósito pra depois investir de repente.
          const swapChance = tactic === 'faker' ? 0.9 : 0.65;
          b.strafeDir = Math.random() < swapChance ? -b.strafeDir : b.strafeDir;
          b.strafeUntil = now + (tactic === 'faker' ? bRand(180, 500) : tactic === 'flanker' ? bRand(700, 2000) : bRand(500, 1600));
          if (tactic === 'faker' && Math.random() < 0.5) b.backoffUntil = now + bRand(150, 400);
        }
        // flanker circula bem mais de lado antes de vir de frente; rusher
        // quase não desvia (vai reto); os demais mantêm o strafe normal.
        const strafeMul = tactic === 'flanker' ? 1.6 : tactic === 'rusher' ? 0.15 : 1;
        const strafe = dist < 7 ? b.strafeDir * bRand(0.55, 1) * strafeMul : 0;
        mx = ux * fwd + perpX * strafe;
        mz = uz * fwd + perpZ * strafe;
        // longe da parede? não. Perto? empurra pra dentro.
        const inward = 2.2;
        if (b.x > B_LIM - inward) mx -= 0.9;
        if (b.x < -B_LIM + inward) mx += 0.9;
        if (b.z > B_LIM - inward) mz -= 0.9;
        if (b.z < -B_LIM + inward) mz += 0.9;
        const l = Math.hypot(mx, mz);
        if (l > 1) { mx /= l; mz /= l; }
        faceYaw = Math.atan2(-dx, -dz) + b.aimErr;
        // kiter pula bastante pra desviar de perto; rusher quase não pula
        // (foca em fechar distância); os outros no ritmo padrão.
        const jumpRange = tactic === 'kiter' ? 12 : tactic === 'rusher' ? 5 : 9;
        if (now > b.nextJumpAt && dist < jumpRange) wantJump = true;
      }

      // Arquétipo "beginner": de vez em quando "esquece" a lógica de
      // perseguir e vaga sem rumo (os pés vão pra qualquer lado), mas
      // continua olhando/mirando pro inimigo normalmente — dá pra ver que
      // ele nem sempre entende o que devia estar fazendo.
      if (b.archetype === 'beginner' && !b.fleeing) {
        if (now > b.wanderUntil) {
          b.wandering = Math.random() < 0.35;
          b.wanderUntil = now + (b.wandering ? bRand(800, 2200) : bRand(400, 900));
          if (b.wandering) b.wanderDir = bRand(0, Math.PI * 2);
        }
        if (b.wandering) { mx = Math.sin(b.wanderDir); mz = Math.cos(b.wanderDir); }
      }

      // ---- mira (giro limitado, então dá pra "enganar" com movimento rápido) ----
      const maxTurn = b.turnRate * dt;
      b.yaw += bClamp(bAngDiff(b.yaw, faceYaw), -maxTurn, maxTurn);
      const wantPitch = bClamp(Math.atan2((tp.y + 1.2) - (b.y + B_EYE), Math.max(dist, 0.5)), -0.4, 0.4);
      b.pitch += (wantPitch - b.pitch) * Math.min(1, dt * 8);

      // ---- soco (mesmas regras do doPunch do cliente) ----
      if (!b.fleeing || cornered) {
        const fx = -Math.sin(b.yaw), fz = -Math.cos(b.yaw);
        const dot = (dx * fx + dz * fz) / dist;
        const along = dx * fx + dz * fz;              // quanto o alvo está "à frente"
        const lateral = Math.abs(dx * fz - dz * fx);   // quão fora da mira (em unidades do mundo)
        const eyeY = b.y + B_EYE;
        const vertOK = eyeY >= tp.y && eyeY <= tp.y + B_HITBOX_MAX;
        if (b.punchCd <= 0) {
          if (dist < b.reach && along > 0 && lateral < B_BODY_HALF_W && vertOK) {
            b.punchCd = Math.max(B_PUNCH_CD_MIN, b.punchBase + bRand(0, 0.1));
            b.punchFlagUntil = now + 130;
            applyHit(state, p.id, tq.id, ux, uz);
            if (Math.random() < 0.3) b.backoffUntil = now + bRand(120, 300);
          } else if (dist < b.reach + 1 && dot > 0.85 && Math.random() < 0.25) {
            // soco no ar (só animação), como jogador de verdade errando
            b.punchCd = Math.max(B_PUNCH_CD_MIN, b.punchBase + bRand(0.05, 0.2));
            b.punchFlagUntil = now + 130;
          }
        }
      }
    } else {
      // ninguém pra lutar (venceu a rodada / esperando): pulinhos ocasionais
      if (now > b.nextJumpAt) wantJump = true;
    }
  }
  if (b.punchCd > 0) b.punchCd -= dt;

  // ---- física (sempre roda, mesmo congelado/morto) ----
  if (wantJump && b.grounded) {
    b.vy = B_JUMP; b.grounded = false;
    b.nextJumpAt = now + (b.combatTactic === 'kiter' ? bRand(400, 1300) : b.combatTactic === 'rusher' ? bRand(2000, 5000) : bRand(1200, 4200));
  }
  const inputScale = b.stun > 0 ? 0.15 : 1;
  b.x += mx * b.speed * dt * inputScale;
  b.z += mz * b.speed * dt * inputScale;
  if (b.kx !== 0 || b.kz !== 0) {
    b.x += b.kx * dt; b.z += b.kz * dt;
    const decay = Math.max(0, 1 - B_KNOCK_DECAY * dt);
    b.kx *= decay; b.kz *= decay;
    if (Math.abs(b.kx) < 0.05) b.kx = 0;
    if (Math.abs(b.kz) < 0.05) b.kz = 0;
  }
  if (b.stun > 0) b.stun -= dt;
  b.vy += B_GRAVITY * dt;
  b.y += b.vy * dt;
  if (b.y <= 0) { b.y = 0; b.vy = 0; b.grounded = true; }
  b.x = bClamp(b.x, -B_LIM, B_LIM);
  b.z = bClamp(b.z, -B_LIM, B_LIM);
}

let botLastTick = Date.now();
function botsSimTick() {
  const now = Date.now();
  const dt = Math.min(0.1, (now - botLastTick) / 1000);
  botLastTick = now;
  for (const state of virtualServers) {
    for (const room of state.rooms.values()) {
      if (isBedwarsMode(room.mode)) continue;
      let hasBot = false, humans = null;
      for (const p of room.players) {
        const c = state.clients.get(p.id);
        if (c && c.isBot) hasBot = true;
      }
      if (!hasBot) continue;
      if (!room.roster) {
        room.roster = room.players.map((p) => ({ id: p.id, team: p.team, slot: p.slot }));
        room.startedAt = now;
        room.freezeUntil = now + (isBigFfa(room.mode) ? 3300 : 3600); // 'matched' + 0,6s + contagem 3-2-1-JÁ (Survival: + tempo de montar a arena gigante)
        room.epoch = room.epoch || 0;
        if (roomHasHuman(state, room)) console.log('[bots] partida ' + room.mode + ' começou com jogador real + ' + room.players.filter((p) => { const c = state.clients.get(p.id); return c && c.isBot; }).length + ' bot(s)');
      }
      for (const p of room.players.slice()) {
        const c = state.clients.get(p.id);
        if (c && c.isBot && state.rooms.get(c.room) === room) botTick(state, room, p, c, dt, now);
      }
      // manda a posição dos bots pros jogadores de verdade (~12x/s, igual ao cliente)
      if (!room.lastBc || now - room.lastBc >= 80) {
        room.lastBc = now;
        // Sala só de bots com ADM assistindo: ninguém recebe 'state', então manda direto pros espectadores.
        if (room.watchers && room.watchers.length && !roomHasHuman(state, room)) {
          for (const p of room.players) {
            const c = state.clients.get(p.id);
            if (!c || !c.isBot || !p.alive) continue;
            const b = c.bot;
            watchMirror(state, room, { type: 'state', id: p.id, x: b.x, y: b.y, z: b.z, yaw: b.yaw, pitch: b.pitch, punching: b.punchFlagUntil > now });
          }
        }
        // Survival tem 49 bots: mandar todos a ~12x/s pra cada jogador (~500 msgs/s)
        // engasgava o celular/túnel e dava "conexão perdida". Agora: bot perto (<70)
        // continua a ~12x/s; bot longe só ~2x/s.
        const isSv = isBigFfa(room.mode);
        if (isSv) room.farBcN = ((room.farBcN || 0) + 1) % 6;
        const farTick = isSv && room.farBcN === 0;
        for (const q of room.players) {
          const qc = state.clients.get(q.id);
          if (!qc || qc.isBot) continue;
          const qpos = isSv ? (qc.pos || botSpawnPoint(room, q)) : null;
          // Com alcance de ADM alto, os bots dentro do alcance também são atualizados ~12x/s
          // (antes só os <70; os de longe vinham ~2x/s e o soco errava o alvo já desatualizado).
          const nearR = Math.max(70, ((qc.cheats && qc.cheats.reach) || 0) + 10);
          for (const p of room.players) {
            const c = state.clients.get(p.id);
            if (!c || !c.isBot || !p.alive) continue;
            const b = c.bot;
            if (isSv && !farTick && qpos && Math.hypot(b.x - qpos.x, b.z - qpos.z) > nearR) continue;
            send(state, q.id, { type: 'state', id: p.id, x: b.x, y: b.y, z: b.z, yaw: b.yaw, pitch: b.pitch, punching: b.punchFlagUntil > now });
          }
        }
      }
    }
  }
}

function startBots() {
  if (!BOTS_ENABLED) { console.log('[bots] desligados (BOTS=0)'); return; }
  for (const state of virtualServers) {
    state.botIds = new Set();
    state.botFill = {};
    // começa em ~30 e segura um tempinho antes do primeiro passo do crescimento disfarçado
    state.botPop = { target: Math.round(bRand(BOT_POP_START_MIN, BOT_POP_START_MAX)), retargetAt: Date.now() + bRand(12000, 25000), stage: 0 };
    state.botHistory = []; // bots que já estiveram online e saíram (20% dos novos são "reencarnações" deles)
    // enche o mínimo aos poucos logo no começo
    botsPopulationTick(state, Date.now());
  }
  setInterval(botsSimTick, 50);
  setInterval(() => {
    const now = Date.now();
    for (const state of virtualServers) {
      botsFillTick(state, now);
    }
  }, 500);
  setInterval(() => {
    const now = Date.now();
    for (const state of virtualServers) {
      let act = 0;
      for (const id of state.botIds) { const c0 = state.clients.get(id); if (c0 && (c0.room || c0.bot.phase === 'queued')) act++; }
      state.botActiveNow = act; // quantos bots estão em fila/partida agora (limita BOT_ACTIVE_CAP)
      for (const id of Array.from(state.botIds)) {
        const c = state.clients.get(id);
        if (c) botLifeTick(state, id, c, now);
      }
    }
  }, 1000);
  setInterval(() => {
    const now = Date.now();
    for (const state of virtualServers) botsPopulationTick(state, now);
  }, 3000);
  setInterval(() => {
    const now = Date.now();
    for (const state of virtualServers) botsSocialTick(state, now);
  }, BOT_SOCIAL_TICK_MS);
  setInterval(() => {
    const now = Date.now();
    for (const state of virtualServers) botsMatchChatTick(state, now);
  }, 1500);
  setInterval(() => {
    for (const state of virtualServers) {
      let inMatch = 0, queued = 0;
      for (const id of state.botIds) { const c = state.clients.get(id); if (!c) continue; if (c.room) inMatch++; else if (botQueueOf(state, id)) queued++; }
      console.log('[bots] online: ' + state.botIds.size + ' (alvo ' + state.botPop.target + ') | em partida: ' + inMatch + ' | na fila: ' + queued);
    }
  }, 60000);
  console.log('[bots] ligados: entre ' + BOTS_MIN + ' e ' + BOTS_MAX + ' bots online');
}

// Ao fechar o servidor (Ctrl+C no Termux etc.) grava tudo na hora — sem isso,
// contas/perfis/conversas mexidos nos últimos 0,5s podiam se perder.
let flushedOnExit = false;
function flushAllData() {
  if (flushedOnExit) return;
  flushedOnExit = true;
  try { writeJsonSync(ACCOUNTS_PATH, accounts, true); } catch (e) {}
  try { writeJsonSync(PROFILES_PATH, profiles, true); } catch (e) {}
  try { writeJsonSync(BANS_PATH, bans, true); } catch (e) {}
  try { writeJsonSync(FRIENDS_PATH, friendsData, true); } catch (e) {}
  try { writeJsonSync(CONVERSATIONS_PATH, conversations, true); } catch (e) {}
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { flushAllData(); process.exit(0); });
}
process.on('exit', flushAllData);

server.listen(PORT, () => {
  console.log('Servidor da Arena rodando na porta ' + PORT + ' (servidor único)');
  console.log(STT_ENABLED
    ? '[stt] transcrição de áudio LIGADA (' + (STT_CMD ? 'comando local' : STT_URL + ' / ' + STT_MODEL) + ')'
    : '[stt] transcrição de áudio DESLIGADA: os bots não conseguem entender áudio. Inicie com GROQ_API_KEY=... node server.js (ou OPENAI_API_KEY / STT_CMD)');
  startBots();
});
