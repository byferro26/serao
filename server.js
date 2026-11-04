// Serão — servidor da app (website público + área de staff)
// Guarda os dados em Postgres (DATABASE_URL do Railway) ou, sem base de dados, numa pasta ./data (só para testes).
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const AI_KEY = process.env.ANTHROPIC_API_KEY || "";
const AI_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const COLS = ["clientes", "eventos", "fornecedores", "pedidos", "equipa", "mensagens", "config"];
const DEFAULT_TEAM = { admin: { id: "admin", nome: "Admin", role: "Admin", pin: "1234" }, it: { id: "it", nome: "IT", role: "IT", pin: "1234" } };
if (!process.env.SESSION_SECRET) console.warn("Aviso: SESSION_SECRET não definido. As sessões terminam sempre que o servidor reinicia.");

/* ---------------- Armazenamento ---------------- */
let seq = 0;
const stamp = () => (seq = Math.max(Date.now(), seq + 1));
function makeStore() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require("pg");
    const local = /localhost|127\.0\.0\.1|\.railway\.internal/.test(process.env.DATABASE_URL);
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false } });
    return {
      kind: "postgres",
      async init() {
        await pool.query(`create table if not exists docs (col text not null, id text not null, data jsonb, updated_at bigint not null, deleted boolean not null default false, primary key (col, id));
          create index if not exists docs_updated on docs (updated_at);
          create table if not exists files (id text primary key, name text, type text, size integer, data bytea, created bigint);`);
        const r = await pool.query("select coalesce(max(updated_at),0) m from docs"); seq = Number(r.rows[0].m);
      },
      async since(t) { const r = await pool.query("select col, id, data, deleted, updated_at from docs where updated_at > $1 order by updated_at", [t]); return r.rows.map(x => ({ ...x, updated_at: Number(x.updated_at) })); },
      async get(col, id) { const r = await pool.query("select data from docs where col=$1 and id=$2 and not deleted", [col, id]); return r.rows[0] ? r.rows[0].data : null; },
      async put(col, id, data) { const t = stamp(); await pool.query("insert into docs (col,id,data,updated_at,deleted) values ($1,$2,$3,$4,false) on conflict (col,id) do update set data=excluded.data, updated_at=excluded.updated_at, deleted=false", [col, id, data, t]); return t; },
      async del(col, id) { const t = stamp(); await pool.query("update docs set deleted=true, data=null, updated_at=$3 where col=$1 and id=$2", [col, id, t]); return t; },
      async fileSave(f) { await pool.query("insert into files (id,name,type,size,data,created) values ($1,$2,$3,$4,$5,$6)", [f.id, f.name, f.type, f.size, f.data, Date.now()]); },
      async fileGet(id) { const r = await pool.query("select name,type,size,data from files where id=$1", [id]); return r.rows[0] || null; },
      async fileDel(id) { await pool.query("delete from files where id=$1", [id]); }
    };
  }
  const dir = process.env.DATA_DIR || path.join(__dirname, "data"), dbFile = path.join(dir, "docs.json"), fdir = path.join(dir, "files");
  let docs = {};
  const save = () => fs.writeFileSync(dbFile, JSON.stringify(docs));
  return {
    kind: "ficheiro",
    async init() { fs.mkdirSync(fdir, { recursive: true }); if (fs.existsSync(dbFile)) docs = JSON.parse(fs.readFileSync(dbFile, "utf8")); seq = Math.max(0, ...Object.values(docs).map(d => d.updated_at)); },
    async since(t) { return Object.values(docs).filter(d => d.updated_at > t).sort((a, b) => a.updated_at - b.updated_at); },
    async get(col, id) { const d = docs[col + "/" + id]; return d && !d.deleted ? d.data : null; },
    async put(col, id, data) { const t = stamp(); docs[col + "/" + id] = { col, id, data, updated_at: t, deleted: false }; save(); return t; },
    async del(col, id) { const t = stamp(); docs[col + "/" + id] = { col, id, data: null, updated_at: t, deleted: true }; save(); return t; },
    async fileSave(f) { fs.writeFileSync(path.join(fdir, f.id), f.data); fs.writeFileSync(path.join(fdir, f.id + ".json"), JSON.stringify({ name: f.name, type: f.type, size: f.size })); },
    async fileGet(id) { const p = path.join(fdir, id); if (!/^[\w-]+$/.test(id) || !fs.existsSync(p)) return null; return { ...JSON.parse(fs.readFileSync(p + ".json", "utf8")), data: fs.readFileSync(p) }; },
    async fileDel(id) { if (!/^[\w-]+$/.test(id)) return; for (const p of [path.join(fdir, id), path.join(fdir, id + ".json")]) if (fs.existsSync(p)) fs.unlinkSync(p); }
  };
}
const store = makeStore();

/* ---------------- Sessões (cookie assinado) ---------------- */
const sign = v => crypto.createHmac("sha256", SECRET).update(v).digest("base64url");
function readSession(req) {
  const c = (req.headers.cookie || "").split(/;\s*/).find(x => x.startsWith("sid="));
  if (!c) return null;
  const [v, s] = c.slice(4).split(".");
  if (!v || !s || sign(v) !== s) return null;
  try { const o = JSON.parse(Buffer.from(v, "base64url").toString()); return o.exp > Date.now() ? o : null; } catch (e) { return null; }
}
function setSession(req, res, o) {
  const v = Buffer.from(JSON.stringify({ ...o, exp: Date.now() + 14 * 864e5 })).toString("base64url");
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `sid=${v}.${sign(v)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${14 * 86400}${secure}`);
}
async function member(id) { return (await store.get("equipa", id)) || DEFAULT_TEAM[id] || null; }
async function currentUser(req) {
  const s = readSession(req); if (!s) return null;
  const u = await member(s.id); if (!u || u.removido) return null;
  return { id: u.id, nome: u.nome, role: u.role };
}

/* ---------------- Limites simples por IP ---------------- */
const hits = new Map();
function limited(key, max, ms) {
  const now = Date.now(), arr = (hits.get(key) || []).filter(t => now - t < ms);
  arr.push(now); hits.set(key, arr); return arr.length > max;
}
const ip = req => (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
const uid = p => p + "_" + crypto.randomBytes(8).toString("hex");

/* ---------------- App ---------------- */
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use((req, res, next) => { res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "same-origin"); next(); });
const json = express.json({ limit: "3mb" });
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ code: "server_error", message: "Erro no servidor" }); });
const deny = (res, code, status = 403, message = "Sem permissão") => res.status(status).json({ code, message });

app.get("/api/me", wrap(async (req, res) => { res.json({ server: true, user: await currentUser(req), ai: !!AI_KEY, storage: store.kind }); }));

app.post("/api/login", json, wrap(async (req, res) => {
  if (limited("login:" + ip(req), 10, 15 * 60e3)) return deny(res, "rate_limited", 429, "Demasiadas tentativas");
  const { id, pin } = req.body || {};
  const u = await member(String(id || ""));
  if (!u || u.removido || String(u.pin) !== String(pin || "")) return deny(res, "bad_login", 401, "Palavra-passe errada");
  setSession(req, res, { id: u.id });
  res.json({ user: { id: u.id, nome: u.nome, role: u.role } });
}));
app.post("/api/logout", (req, res) => { res.setHeader("Set-Cookie", "sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0"); res.status(204).end(); });

// Sincronização: devolve o que mudou desde "since". Sem sessão só sai o público (empresa, website, nomes da equipa).
app.get("/api/sync", wrap(async (req, res) => {
  const u = await currentUser(req), since = Number(req.query.since) || 0;
  const rows = await store.since(since);
  const out = [];
  for (const r of rows) {
    if (!u && !["config", "equipa"].includes(r.col)) continue;
    let data = r.data;
    if (data && r.col === "equipa" && !(u && u.role === "IT")) { const { pin, ...rest } = data; data = rest; }
    if (data && r.col === "config" && r.id === "empresa" && !u) { const { iban, nif, morada, responsavel, ...rest } = data; data = rest; }
    out.push({ col: r.col, id: r.id, data, deleted: r.deleted });
  }
  res.json({ now: rows.length ? rows[rows.length - 1].updated_at : since, docs: out });
}));

function cleanPedido(b) {
  const s = (v, n) => String(v ?? "").slice(0, n);
  const servicos = Array.isArray(b.servicos) ? b.servicos.filter(x => typeof x === "string").slice(0, 10) : [];
  return { id: s(b.id, 80), ref: s(b.ref, 40), estado: "novo", nome: s(b.nome, 120), empresa: s(b.empresa, 120), email: s(b.email, 160), telefone: s(b.telefone, 40), tipo: s(b.tipo, 60), data: s(b.data, 10), convidados: Math.max(0, Math.min(5000, Number(b.convidados) || 0)), zona: s(b.zona, 120), orcamento: s(b.orcamento, 60), servicos, mensagem: s(b.mensagem, 4000), criado: new Date().toISOString() };
}
app.put("/api/doc/:col/:id", json, wrap(async (req, res) => {
  const { col, id } = req.params, body = req.body;
  if (!COLS.includes(col) || !/^[\w.@:+-]{1,120}$/.test(id) || !body || typeof body !== "object" || Array.isArray(body)) return deny(res, "invalid_request", 400, "Pedido inválido");
  const u = await currentUser(req);
  if (!u) {
    // Visitantes do website: só podem criar pedidos novos
    if (col !== "pedidos") return deny(res, "not_logged", 401, "Inicia sessão");
    if (limited("ped:" + ip(req), 8, 60 * 60e3)) return deny(res, "rate_limited", 429, "Demasiados pedidos");
    if (await store.get("pedidos", id)) return deny(res, "exists", 409, "Já existe");
    const p = { ...cleanPedido(body), id };
    if (!p.nome || !/^\S+@\S+\.\S+$/.test(p.email)) return deny(res, "invalid_request", 400, "Faltam dados");
    await store.put("pedidos", id, p); return res.json({ data: p });
  }
  let data = { ...body, id: body.id || id };
  if (col === "config" && u.role === "Staff") return deny(res, "not_allowed");
  if (col === "equipa") {
    const prev = await member(id);
    if (u.role !== "IT") {
      if (id !== u.id) return deny(res, "not_allowed");
      data = { ...(prev || {}), modo: data.modo, id }; // cada pessoa só muda a sua preferência de modo
    } else {
      if (data.pin === undefined || data.pin === null || data.pin === "") data.pin = prev ? prev.pin : "1234";
      if (!/^\d{4,}$/.test(String(data.pin))) return deny(res, "bad_pin", 400, "A palavra-passe tem de ter pelo menos 4 algarismos");
      if (id === "it") data.role = "IT";
    }
  }
  await store.put(col, id, data);
  res.json({ data });
}));
app.post("/api/doc/:col", json, wrap(async (req, res) => {
  const u = await currentUser(req); if (!u) return deny(res, "not_logged", 401, "Inicia sessão");
  if (req.params.col !== "mensagens") return deny(res, "invalid_request", 400, "Pedido inválido");
  const b = req.body || {}, id = uid("m");
  const data = { canal: String(b.canal || "geral").slice(0, 80), autor: u.nome, autorId: u.id, role: u.role, txt: String(b.txt || "").slice(0, 4000), ts: Date.now() };
  await store.put("mensagens", id, data); res.json({ id, data });
}));
app.delete("/api/doc/:col/:id", wrap(async (req, res) => {
  const u = await currentUser(req); if (!u) return deny(res, "not_logged", 401, "Inicia sessão");
  const { col, id } = req.params;
  if (!COLS.includes(col)) return deny(res, "invalid_request", 400, "Pedido inválido");
  if ((col === "equipa" && u.role !== "IT") || (col === "config" && u.role === "Staff")) return deny(res, "not_allowed");
  await store.del(col, id); res.status(204).end();
}));

/* Ficheiros (preçários, catálogos, documentos) */
const TYPES = /^(application\/pdf|image\/(png|jpeg|webp|gif)|text\/(csv|plain))$/;
app.post("/api/files", express.raw({ type: () => true, limit: "20mb" }), wrap(async (req, res) => {
  const u = await currentUser(req); if (!u) return deny(res, "not_logged", 401, "Inicia sessão");
  const type = String(req.headers["content-type"] || "").split(";")[0];
  if (!TYPES.test(type)) return deny(res, "unsupported_type", 415, "Formato não aceite");
  if (!req.body || !req.body.length) return deny(res, "invalid_request", 400, "Ficheiro vazio");
  const id = uid("f"), name = decodeURIComponent(String(req.headers["x-filename"] || "ficheiro")).slice(0, 200);
  await store.fileSave({ id, name, type, size: req.body.length, data: req.body });
  res.json({ id, url: "/_blob/" + id, contentType: type, sizeBytes: req.body.length });
}));
app.delete("/api/files/:id", wrap(async (req, res) => {
  const u = await currentUser(req); if (!u) return deny(res, "not_logged", 401, "Inicia sessão");
  await store.fileDel(req.params.id); res.status(204).end();
}));
app.get("/_blob/:id", wrap(async (req, res) => {
  if (!(await currentUser(req))) return res.status(401).send("Inicia sessão na área de staff para ver este ficheiro.");
  const f = await store.fileGet(req.params.id); if (!f) return res.status(404).send("Ficheiro não encontrado");
  res.setHeader("Content-Type", f.type); res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`); res.setHeader("Cache-Control", "private, max-age=3600");
  res.end(Buffer.from(f.data));
}));

/* IA (Claude) — precisa da variável ANTHROPIC_API_KEY */
app.post("/api/ai", express.json({ limit: "25mb" }), wrap(async (req, res) => {
  const u = await currentUser(req); if (!u) return deny(res, "not_logged", 401, "Inicia sessão");
  if (!AI_KEY) return deny(res, "sampling_disabled", 501, "IA não configurada");
  if (limited("ai:" + u.id, 40, 60 * 60e3)) return deny(res, "rate_limited", 429, "Demasiados pedidos à IA");
  const { input, images = [], json: asJSON } = req.body || {};
  let msgs = typeof input === "string" ? [{ role: "user", content: input }] : Array.isArray(input) ? input.filter(m => m && m.content && ["user", "assistant"].includes(m.role)).map(m => ({ role: m.role, content: String(m.content) })) : [];
  // juntar turnos seguidos do mesmo papel (a API exige alternância)
  msgs = msgs.reduce((a, m) => { const l = a[a.length - 1]; if (l && l.role === m.role) l.content += "\n\n" + m.content; else a.push({ ...m }); return a; }, []);
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return deny(res, "invalid_request", 400, "Pedido inválido");
  const last = msgs[msgs.length - 1];
  const imgs = images.slice(0, 4).map(d => /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(String(d))).filter(Boolean).map(m => ({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } }));
  last.content = [...imgs, { type: "text", text: last.content }];
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": AI_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: AI_MODEL, max_tokens: 4096, system: asJSON ? "Responde apenas com JSON válido, sem texto antes nem depois." : undefined, messages: msgs })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error("IA:", r.status, j?.error?.message); return deny(res, r.status === 429 ? "rate_limited" : "upstream_error", r.status === 429 ? 429 : 502, "A IA não respondeu"); }
  const text = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  if (!text.trim()) return deny(res, "empty_completion", 502, "Resposta vazia");
  res.json({ text });
}));

app.get("/health", (req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, "public"), { index: "index.html", maxAge: "5m" }));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

store.init().then(() => app.listen(PORT, () => console.log(`Serão a correr na porta ${PORT} · dados em ${store.kind}`))).catch(e => { console.error("Não foi possível ligar à base de dados:", e); process.exit(1); });
