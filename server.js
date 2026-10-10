// server.js - Batalha ao vivo: TikFinity -> Node.js (Render) -> Roblox
// Funciona sem configurar nada. A variavel SECRET (senha) e OPCIONAL.
const express = require("express");
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===================== CONFIG =====================
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SECRET || "";                        // vazio = sem senha
const MAX_HP = 500;
const DMG_CHAT = 1;
const DMG_GIFT = 10;
const HITKILL_MIN_COINS = 10;                                   // acima de 10 coins = HitKill
const KO_PAUSE_MS = Number(process.env.KO_PAUSE_MS) || 2500;    // pausa antes do proximo round
const HITKILL_FALLBACK = process.env.HITKILL_FALLBACK || "random"; // random | left | right | underdog
const USER_SIDE_TTL_MS = 30 * 60 * 1000;
const MAX_USERS = 5000;
const MAX_EVENTS = 3000;
const EVENT_TTL_MS = 60 * 1000;
const MAX_GIFT_COUNT = 50;

// Lados: "left" = LULA (PT / Rosa) | "right" = BOLSONARO (PL / GG)
const SIDES = ["left", "right"];
const other = (s) => (s === "left" ? "right" : "left");

// ===================== ESTADO =====================
const state = {
  hp: { left: MAX_HP, right: MAX_HP },
  points: { left: 0, right: 0 },
  round: 1,
  phase: "fight", // "fight" | "ko"
  lastWinner: null,
};
let seq = 0;
let koTimer = null;
const events = [];
const userSide = new Map();

const snapshot = () => ({
  hp: { ...state.hp },
  points: { ...state.points },
  round: state.round,
  phase: state.phase,
});

function pushEvent(e) {
  e.seq = ++seq;
  e.ts = Date.now();
  events.push(e);
  while (events.length > MAX_EVENTS || (events.length && events[0].ts < e.ts - EVENT_TTL_MS)) {
    events.shift();
  }
  return e;
}

function rememberSide(user, side) {
  userSide.delete(user);
  userSide.set(user, { side, ts: Date.now() });
  if (userSide.size > MAX_USERS) userSide.delete(userSide.keys().next().value);
}

function endRound(winner) {
  state.phase = "ko";
  state.points[winner] += 1;
  state.lastWinner = winner;
  pushEvent({ type: "ko", side: winner, target: other(winner), points: { ...state.points } });
  clearTimeout(koTimer);
  koTimer = setTimeout(() => {
    state.hp.left = MAX_HP;
    state.hp.right = MAX_HP;
    state.round += 1;
    state.phase = "fight";
    pushEvent({ type: "round_start", round: state.round });
  }, KO_PAUSE_MS);
}

function applyDamage(attacker, amount, kind, user) {
  if (state.phase !== "fight") return false;
  const target = other(attacker);
  state.hp[target] = Math.max(0, state.hp[target] - amount);
  pushEvent({ type: "hit", kind, side: attacker, target, amount, user });
  if (state.hp[target] <= 0) endRound(attacker);
  return true;
}

function hitKill(attacker, user) {
  if (state.phase !== "fight") return false;
  const target = other(attacker);
  state.hp[target] = 0;
  pushEvent({ type: "hit", kind: "hitkill", side: attacker, target, amount: MAX_HP, user });
  endRound(attacker);
  return true;
}

// ===================== UTIL =====================
const p = (req, name, def = "") => String(req.query[name] ?? (req.body && req.body[name]) ?? def);
const norm = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();

function auth(req, res, next) {
  if (!SECRET) return next();
  const key = req.query.key || (req.body && req.body.key) || req.get("x-api-key");
  if (key !== SECRET) return res.status(401).json({ ok: false, error: "nao autorizado" });
  next();
}

// Aceita 13 / PT / LULA (esquerda) e 22 / PL / FLAVIO / BOLSONARO (direita),
// em qualquer lugar do comentario ("13", "vai 13!!", "22 pra sempre"). Se citar os dois, ignora.
function parseChat(text) {
  const t = " " + String(text).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().replace(/[^A-Z0-9]+/g, " ") + " ";
  const left = /\s(13|PT|LULA)\s/.test(t);
  const right = /\s(22|PL|FLAVIO|BOLSONARO)\s/.test(t);
  if (left === right) return null;
  return left ? "left" : "right";
}

function resolveHitKillSide(req, user) {
  const q = p(req, "side").toLowerCase();
  if (SIDES.includes(q)) return q;
  const mem = userSide.get(user);
  if (mem && Date.now() - mem.ts < USER_SIDE_TTL_MS) return mem.side;
  if (HITKILL_FALLBACK === "left" || HITKILL_FALLBACK === "right") return HITKILL_FALLBACK;
  if (HITKILL_FALLBACK === "underdog" && state.hp.left !== state.hp.right) {
    return state.hp.left < state.hp.right ? "left" : "right";
  }
  return SIDES[Math.floor(Math.random() * 2)];
}

function compact(list) {
  const out = [];
  for (const e of list) {
    const prev = out[out.length - 1];
    if (prev && e.type === "hit" && e.kind === "chat" && prev.type === "hit" &&
        prev.kind === "chat" && prev.side === e.side) {
      prev.amount += e.amount;
      prev.count += 1;
      prev.seq = e.seq;
    } else {
      out.push(e.type === "hit" ? { ...e, count: 1 } : { ...e });
    }
  }
  return out;
}

// ===================== ROBLOX =====================
app.get("/state", auth, (req, res) => {
  const since = parseInt(req.query.since || "0", 10) || 0;
  res.set("Cache-Control", "no-store");
  res.json({
    maxHp: MAX_HP,
    ...snapshot(),
    lastWinner: state.lastWinner,
    seq,
    events: compact(events.filter((e) => e.seq > since)),
  });
});

// ===================== TIKFINITY =====================
app.all("/chat", auth, (req, res) => {
  const side = parseChat(p(req, "comment"));
  if (!side) return res.json({ ok: true, ignored: true });
  const user = p(req, "user", "anon");
  rememberSide(user, side);
  applyDamage(side, DMG_CHAT, "chat", user);
  res.json({ ok: true, ...snapshot() });
});

app.all(["/pt", "/13"], auth, (req, res) => {
  const user = p(req, "user", "anon");
  rememberSide(user, "left");
  applyDamage("left", DMG_CHAT, "chat", user);
  res.json({ ok: true, ...snapshot() });
});
app.all(["/pl", "/22"], auth, (req, res) => {
  const user = p(req, "user", "anon");
  rememberSide(user, "right");
  applyDamage("right", DMG_CHAT, "chat", user);
  res.json({ ok: true, ...snapshot() });
});

app.all("/gift", auth, (req, res) => {
  const name = norm(p(req, "name"));
  const coins = Number(p(req, "coins", "0")) || 0;
  const user = p(req, "user", "anon");
  const count = Math.min(MAX_GIFT_COUNT, Math.max(1, parseInt(p(req, "count", "1"), 10) || 1));

  if (coins > HITKILL_MIN_COINS) {
    const side = resolveHitKillSide(req, user);
    const done = hitKill(side, user);
    return res.json({ ok: true, hitkill: done, side, ...snapshot() });
  }
  if (name === "rose" || name === "rosa") {
    applyDamage("left", DMG_GIFT * count, "gift", user);
    return res.json({ ok: true, ...snapshot() });
  }
  if (name === "gg") {
    applyDamage("right", DMG_GIFT * count, "gift", user);
    return res.json({ ok: true, ...snapshot() });
  }
  res.json({ ok: true, ignored: true });
});

app.all("/rose", auth, (req, res) => { applyDamage("left", DMG_GIFT, "gift", p(req, "user", "anon")); res.json({ ok: true, ...snapshot() }); });
app.all("/gg", auth, (req, res) => { applyDamage("right", DMG_GIFT, "gift", p(req, "user", "anon")); res.json({ ok: true, ...snapshot() }); });
// HitKill sem lado: usa o ultimo lado que o doador comentou (PT/PL); se nao souber, usa o fallback
app.all("/hitkill", auth, (req, res) => {
  const user = p(req, "user", "anon");
  const side = resolveHitKillSide(req, user);
  const done = hitKill(side, user);
  res.json({ ok: true, hitkill: done, side, ...snapshot() });
});
app.all("/hitkill/:side", auth, (req, res) => {
  const side = req.params.side === "right" ? "right" : "left";
  hitKill(side, p(req, "user", "anon"));
  res.json({ ok: true, ...snapshot() });
});

// ===================== ADMIN =====================
app.all("/reset", auth, (_req, res) => {
  clearTimeout(koTimer);
  state.hp = { left: MAX_HP, right: MAX_HP };
  state.points = { left: 0, right: 0 };
  state.round = 1;
  state.phase = "fight";
  state.lastWinner = null;
  events.length = 0;
  userSide.clear();
  pushEvent({ type: "round_start", round: 1 });
  res.json({ ok: true, ...snapshot() });
});

app.get("/health", (_req, res) => res.send("ok"));
app.get("/", (_req, res) => res.send("Batalha online"));

// Painel de teste: abra /teste no navegador (se usar SECRET: /teste?key=SUASENHA)
app.get("/teste", (req, res) => {
  const key = req.query.key ? "?key=" + encodeURIComponent(String(req.query.key)) : "";
  res.type("html").send(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Painel de teste</title>
<style>
body{font-family:sans-serif;max-width:480px;margin:20px auto;padding:0 12px}
button{display:block;width:100%;padding:16px;margin:8px 0;font-size:18px;border:0;border-radius:10px;cursor:pointer}
.l{background:#e74c3c;color:#fff}.r{background:#27ae60;color:#fff}.k{background:#f1c40f}.n{background:#ddd}
pre{background:#111;color:#0f0;padding:10px;border-radius:8px;font-size:13px;white-space:pre-wrap}
</style>
<h2>Painel de teste</h2>
<button class="l" onclick="go('/13')">13: Lula ataca (-1 no Bolsonaro)</button>
<button class="r" onclick="go('/22')">22: Bolsonaro ataca (-1 no Lula)</button>
<button class="l" onclick="go('/rose')">Rosa: Lula (-10 no Bolsonaro)</button>
<button class="r" onclick="go('/gg')">GG: Bolsonaro (-10 no Lula)</button>
<button class="k" onclick="go('/hitkill/left')">HitKill do Lula</button>
<button class="k" onclick="go('/hitkill/right')">HitKill do Bolsonaro</button>
<button class="n" onclick="go('/reset')">Zerar tudo (reset)</button>
<pre id="o">Clique em um botao.</pre>
<script>
const K=${JSON.stringify(key)};
async function go(path){
  try{const r=await fetch(path+K);document.getElementById('o').textContent=JSON.stringify(await r.json(),null,2);}
  catch(e){document.getElementById('o').textContent='Erro: '+e;}
}
</script>`);
});

app.listen(PORT, () => console.log("Batalha rodando na porta " + PORT));
