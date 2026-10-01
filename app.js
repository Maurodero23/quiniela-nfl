// Quiniela NFL — website logic
// Talks to Supabase for accounts, picks and scores. Scores arrive live through Supabase Realtime.
(function () {
"use strict";
const TZ = "America/Mexico_City";
const cfg = window.QUINIELA_CONFIG || {};
const $ = (s) => document.querySelector(s);
const view = $("#view");

const S = {
  sb: null, session: null, me: null,
  profiles: {}, weeks: [], week: null, weekPinned: false,
  games: [], picks: [], entries: new Set(), standings: [], contacts: [],
  tab: "home", standMode: "week", draft: {}, saving: false, msg: "",
  authMode: "signin", live: false, loaded: false,
  seasons: [], poPicks: [], poPoints: [], allEntries: [], poDraft: null, poMsg: "", suggestions: [], sugMsg: "",
};

// NFL teams (ESPN abbreviations) by conference and division
const TEAMS = {
  AFC: { Este: [["BUF","Bills"],["MIA","Dolphins"],["NE","Patriots"],["NYJ","Jets"]], Norte: [["BAL","Ravens"],["CIN","Bengals"],["CLE","Browns"],["PIT","Steelers"]],
         Sur: [["HOU","Texans"],["IND","Colts"],["JAX","Jaguars"],["TEN","Titans"]], Oeste: [["DEN","Broncos"],["KC","Chiefs"],["LV","Raiders"],["LAC","Chargers"]] },
  NFC: { Este: [["DAL","Cowboys"],["NYG","Giants"],["PHI","Eagles"],["WSH","Commanders"]], Norte: [["CHI","Bears"],["DET","Lions"],["GB","Packers"],["MIN","Vikings"]],
         Sur: [["ATL","Falcons"],["CAR","Panthers"],["NO","Saints"],["TB","Buccaneers"]], Oeste: [["ARI","Cardinals"],["LAR","Rams"],["SF","49ers"],["SEA","Seahawks"]] },
};
const CONF_OF = {}; const NAME_OF = {};
for (const c of ["AFC", "NFC"]) for (const d of Object.values(TEAMS[c])) for (const [ab, nm] of d) { CONF_OF[ab] = c; NAME_OF[ab] = nm; }

/* ---------------- helpers ---------------- */
const fmt = (iso, o) => new Intl.DateTimeFormat("es-MX", Object.assign({ timeZone: TZ }, o)).format(new Date(iso));
const fmtKick = (iso) => fmt(iso, { weekday: "short", hour: "numeric", minute: "2-digit" });
const fmtFull = (iso) => fmt(iso, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
function countdown(ms) {
  if (ms <= 0) return "ya";
  const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${String(mm).padStart(2, "0")}m` : `${mm}m`;
}
function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
// Team logo from ESPN's image server (same source as the scores). Hidden if it fails to load.
const LOGO_FIX = { WAS: "wsh", JAC: "jax", LA: "lar" };
function logo(ab) {
  const img = document.createElement("img"); img.className = "logo"; img.alt = ""; img.width = 28; img.height = 28; img.loading = "lazy"; img.decoding = "async";
  const code = LOGO_FIX[ab] || String(ab || "").toLowerCase();
  img.src = `https://a.espncdn.com/combiner/i?img=/i/teamlogos/nfl/500/${code}.png&h=80&w=80`;
  img.addEventListener("error", () => img.remove(), { once: true });
  return img;
}
function emptyBox(title, text) { const d = el("div", "empty"); d.append(el("b", null, title), document.createTextNode(text)); return d; }
const weekObj = () => S.weeks.find((w) => w.id === S.week) || null;
const lockAt = (g, w) => Math.min(Date.parse(g.kickoff), Date.parse(w.cutoff));
const nick = (id) => (S.profiles[id] && S.profiles[id].nickname) || "Jugador";

// Same scoring as the database: 11 / 9 / 8 / 6 / 0
function points(p, g) {
  if (!p || !g || g.status === "pre" || g.away_score == null || g.home_score == null) return null;
  const diff = g.home_score - g.away_score; if (diff === 0) return 0;
  const win = diff > 0 ? g.home : g.away; if (p.team !== win) return 0;
  const e = Math.abs(Math.abs(diff) - p.margin);
  return e === 0 ? 11 : e <= 3 ? 9 : e <= 7 ? 8 : 6;
}

/* ---------------- data ---------------- */
async function loadBase() {
  const sb = S.sb;
  const [me, profs, weeks, seasons, po, pts, ent] = await Promise.all([
    sb.from("profiles").select("id,nickname,is_admin").eq("id", S.session.user.id).maybeSingle(),
    sb.from("profiles").select("id,nickname,created_at"),
    sb.from("weeks").select("*").order("first_kick"),
    sb.from("season_settings").select("*").order("season"),
    sb.from("playoff_picks").select("user_id,season,teams,champion"),
    sb.rpc("playoff_points"),
    sb.from("entries").select("user_id,week_id"),
  ]);
  S.seasons = seasons.data || []; S.poPicks = po.data || []; S.poPoints = pts.data || []; S.allEntries = ent.data || [];
  const sg = await sb.from("suggestions").select("id,user_id,body,created_at").order("created_at", { ascending: false });
  S.suggestions = sg.data || [];
  S.me = me.data;
  S.profiles = {}; (profs.data || []).forEach((p) => (S.profiles[p.id] = p));
  S.weeks = weeks.data || [];
  if (!S.weekPinned || !weekObj()) S.week = pickCurrentWeek();
}
// The current week switches to the next one 2.5 days before its first kickoff (Tuesday morning)
function pickCurrentWeek() {
  if (!S.weeks.length) return null;
  const now = Date.now(); let cur = S.weeks[0];
  for (const w of S.weeks) if (Date.parse(w.first_kick) - 2.5 * 864e5 <= now) cur = w;
  return cur.id;
}
async function loadWeek() {
  const sb = S.sb; const w = weekObj();
  if (!w) { S.games = []; S.picks = []; S.entries = new Set(); return; }
  const g = await sb.from("games").select("*").eq("week_id", w.id).order("kickoff");
  S.games = g.data || [];
  const ids = S.games.map((x) => x.id);
  const [p, e] = await Promise.all([
    ids.length ? sb.from("picks").select("user_id,game_id,team,margin").in("game_id", ids) : Promise.resolve({ data: [] }),
    sb.from("entries").select("user_id").eq("week_id", w.id),
  ]);
  S.picks = p.data || [];
  S.entries = new Set((e.data || []).map((x) => x.user_id));
}
async function loadStandings() {
  const r = await S.sb.rpc("standings"); S.standings = r.data || [];
}
async function loadContacts() {
  if (!S.me || !S.me.is_admin) return;
  const r = await S.sb.from("contacts").select("user_id,email,phone"); S.contacts = r.data || [];
}
async function reloadAll() {
  await loadBase();
  await Promise.all([loadWeek(), loadStandings(), loadContacts()]);
  S.loaded = true; render();
}
let reloadTimer = null;
function scheduleReload(full) {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    try { if (full) await loadBase(); await Promise.all([loadWeek(), loadStandings(), full ? loadContacts() : null]); render(); }
    catch (e) { console.warn(e); }
  }, 400);
}
let channel = null;
function subscribe() {
  if (channel) S.sb.removeChannel(channel);
  channel = S.sb.channel("pool")
    .on("postgres_changes", { event: "*", schema: "public", table: "games" }, () => scheduleReload(false))
    .on("postgres_changes", { event: "*", schema: "public", table: "picks" }, () => scheduleReload(false))
    .on("postgres_changes", { event: "*", schema: "public", table: "entries" }, () => scheduleReload(false))
    .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, () => scheduleReload(true))
    .on("postgres_changes", { event: "*", schema: "public", table: "playoff_picks" }, () => scheduleReload(true))
    .on("postgres_changes", { event: "*", schema: "public", table: "season_settings" }, () => scheduleReload(true))
    .subscribe((status) => { S.live = status === "SUBSCRIBED"; renderAcct(); });
}

/* ---------------- header ---------------- */
function renderHeader() {
  const w = weekObj();
  $("#weekRow").hidden = !S.session || !S.weeks.length;
  const sel = $("#weekSel"); sel.innerHTML = "";
  S.weeks.forEach((x) => { const o = el("option", null, x.label); o.value = x.id; if (x.id === S.week) o.selected = true; sel.append(o); });
  $("#wkLabel").textContent = w ? `${w.label} · ${w.season}` : "NFL";
  const dl = $("#deadline"); dl.innerHTML = "";
  let label = "Próximo cierre", when = null, sub = S.session ? "Aún no hay partidos" : "Inicia sesión para ver la semana";
  if (w) {
    const now = Date.now(), fk = Date.parse(w.first_kick), cut = Date.parse(w.cutoff);
    if (now < fk) { label = "Entrega tu quiniela · primer partido"; when = fk; }
    else if (now < cut) { label = "Cierran cambios dom/lun"; when = cut; }
    else { label = "Todo cerrado"; sub = "¡A disfrutar los partidos!"; }
  }
  dl.append(el("small", null, label), el("b", "num", when ? countdown(when - Date.now()) : (w ? "Cerrado" : "—")),
    el("span", null, when ? fmtFull(new Date(when).toISOString()) + " (CDMX)" : sub));
  const last = S.games.reduce((m, g) => (g.updated_at > m ? g.updated_at : m), "");
  $("#updated").textContent = last && S.games.some((g) => g.status !== "pre") ? `Marcadores al ${fmt(last, { hour: "numeric", minute: "2-digit" })}` : "";
}
function renderAcct() {
  const a = $("#acct"); a.hidden = !S.session; if (!S.session) return;
  a.innerHTML = "";
  const dot = el("span", "conn" + (S.live ? " on" : "")); dot.title = S.live ? "Actualización en vivo" : "Reconectando…";
  a.append(dot, el("span", null, S.live ? "En vivo" : "Conectando"), el("span", null, "·"), el("b", null, (S.me && S.me.nickname) || ""));
  const out = el("button", "linkbtn", "Cerrar sesión"); out.type = "button";
  out.addEventListener("click", () => S.sb.auth.signOut());
  a.append(out);
}

/* ---------------- auth screens ---------------- */
function field(id, label, type, ph, auto) {
  const d = el("div", "field"); const l = el("label", null, label); l.htmlFor = id;
  const i = document.createElement("input"); i.id = id; i.type = type; i.placeholder = ph || ""; i.required = true; if (auto) i.autocomplete = auto;
  d.append(l, i); return d;
}
function renderAuth() {
  $("#tabs").hidden = true;
  const box = el("div", "auth"); const f = el("form", "form");
  const tabs = el("div", "authtabs");
  [["signin", "Iniciar sesión"], ["signup", "Crear cuenta"]].forEach(([k, l]) => {
    const b = el("button", null, l); b.type = "button"; b.setAttribute("aria-pressed", S.authMode === k || (k === "signin" && S.authMode === "forgot"));
    b.addEventListener("click", () => { S.authMode = k; S.msg = ""; renderAuth(); }); tabs.append(b);
  });
  f.append(tabs);
  const err = el("div", "err"); const ok = el("div", "ok", S.msg);
  if (S.authMode === "signup") {
    f.append(el("h2", null, "Únete a la quiniela"),
      el("p", "note", "Tu apodo aparece en la tabla. Tu correo y celular solo los ve el organizador."),
      field("suNick", "Apodo", "text", "p. ej. El Profe", "nickname"),
      field("suEmail", "Correo", "email", "tu@correo.com", "email"),
      field("suPhone", "Celular", "tel", "+52 55 1234 5678", "tel"),
      field("suPass", "Contraseña", "password", "Mínimo 8 caracteres", "new-password"));
    const b = el("button", "btn", "Crear cuenta"); b.type = "submit"; f.append(err, ok, b);
    f.addEventListener("submit", async (e) => {
      e.preventDefault(); err.textContent = ""; ok.textContent = "";
      const nickname = $("#suNick").value.trim(), email = $("#suEmail").value.trim(), phone = $("#suPhone").value.trim(), password = $("#suPass").value;
      if (nickname.length < 2 || nickname.length > 24) return (err.textContent = "El apodo debe tener entre 2 y 24 caracteres.");
      if (phone.replace(/\D/g, "").length < 8) return (err.textContent = "Escribe un celular con al menos 8 dígitos.");
      if (password.length < 8) return (err.textContent = "La contraseña debe tener mínimo 8 caracteres.");
      b.disabled = true;
      const av = await S.sb.rpc("nickname_available", { p_nickname: nickname });
      if (av.error) { b.disabled = false; return (err.textContent = "No pudimos conectar con la quiniela. Revisa tu conexión."); }
      if (av.data === false) { b.disabled = false; return (err.textContent = "Ese apodo ya está en uso. Prueba otro."); }
      const r = await S.sb.auth.signUp({ email, password, options: { data: { nickname, phone }, emailRedirectTo: location.origin + location.pathname } });
      b.disabled = false;
      if (r.error) return (err.textContent = /registered/i.test(r.error.message) ? "Ese correo ya tiene cuenta. Mejor inicia sesión." : r.error.message);
      if (!r.data.session) { S.authMode = "signin"; S.msg = "Cuenta creada. Revisa tu correo para confirmarla y luego inicia sesión."; renderAuth(); }
    });
  } else if (S.authMode === "forgot") {
    f.append(el("h2", null, "Recuperar contraseña"), el("p", "note", "Te enviaremos un enlace para crear una nueva contraseña."), field("fpEmail", "Correo", "email", "tu@correo.com", "email"));
    const b = el("button", "btn", "Enviar enlace"); b.type = "submit";
    const back = el("button", "linkbtn", "Volver a iniciar sesión"); back.type = "button"; back.addEventListener("click", () => { S.authMode = "signin"; renderAuth(); });
    f.append(err, ok, b, back);
    f.addEventListener("submit", async (e) => {
      e.preventDefault(); b.disabled = true;
      const r = await S.sb.auth.resetPasswordForEmail($("#fpEmail").value.trim(), { redirectTo: location.origin + location.pathname });
      b.disabled = false; if (r.error) err.textContent = r.error.message; else ok.textContent = "Revisa tu correo: te enviamos el enlace.";
    });
  } else if (S.authMode === "newpass") {
    f.append(el("h2", null, "Nueva contraseña"), field("npPass", "Nueva contraseña", "password", "Mínimo 8 caracteres", "new-password"));
    const b = el("button", "btn", "Guardar contraseña"); b.type = "submit"; f.append(err, b);
    f.addEventListener("submit", async (e) => {
      e.preventDefault(); const p = $("#npPass").value; if (p.length < 8) return (err.textContent = "La contraseña debe tener mínimo 8 caracteres.");
      const r = await S.sb.auth.updateUser({ password: p });
      if (r.error) return (err.textContent = r.error.message);
      S.authMode = "signin"; S.msg = ""; S.session = (await S.sb.auth.getSession()).data.session; S.loaded = false; render(); start();
    });
  } else {
    f.append(el("h2", null, "Iniciar sesión"), field("siEmail", "Correo", "email", "tu@correo.com", "email"), field("siPass", "Contraseña", "password", "", "current-password"));
    const b = el("button", "btn", "Entrar"); b.type = "submit";
    const fp = el("button", "linkbtn", "¿Olvidaste tu contraseña?"); fp.type = "button"; fp.addEventListener("click", () => { S.authMode = "forgot"; S.msg = ""; renderAuth(); });
    f.append(err, ok, b, fp);
    f.addEventListener("submit", async (e) => {
      e.preventDefault(); b.disabled = true; err.textContent = "";
      const r = await S.sb.auth.signInWithPassword({ email: $("#siEmail").value.trim(), password: $("#siPass").value });
      b.disabled = false;
      if (r.error) err.textContent = /confirm/i.test(r.error.message) ? "Primero confirma tu correo. Revisa tu bandeja." : "Correo o contraseña incorrectos.";
    });
  }
  box.append(f);
  const hero = el("div", "hero");
  hero.append(el("h2", null, "Bienvenido a la Quiniela NFL"),
    el("p", null, "Pronostica el ganador y la diferencia de cada partido de la temporada regular. Marcadores y tabla en vivo, recordatorios por correo y MVP de cada semana."),
    el("p", "pilot", "Temporada piloto 2026: es una prueba para la quiniela formal del próximo año. ¡Tus sugerencias son bienvenidas!"),
    el("p", "prize", "🍽️ Premio de la temporada: el campeón se lleva una cena en Fishers (o un lugar similar)."));
  const frag = document.createDocumentFragment(); frag.append(hero, box); view.replaceChildren(frag);
}

/* ---------------- My card ---------------- */
function statusChip(g) {
  if (g.status === "final") return el("span", "chip final", "Final");
  if (g.status === "live") return el("span", "chip live", g.detail || "En vivo");
  return el("span", "chip", fmtKick(g.kickoff));
}
function scoreLine(g) { return g.status === "pre" || g.away_score == null ? null : el("div", "score num", `${g.away} ${g.away_score} – ${g.home_score} ${g.home}`); }
const myPick = (gid) => S.picks.find((p) => p.user_id === S.me.id && p.game_id === gid) || null;

function renderCard() {
  const w = weekObj();
  if (!w || !S.games.length) return view.replaceChildren(emptyBox("Aún no hay partidos", "El calendario de la semana aparece aquí automáticamente."));
  const now = Date.now(), fk = Date.parse(w.first_kick);
  const late = false; // anyone can pick any game until that game locks
  const savedN = S.games.filter((g) => myPick(g.id)).length;
  const frag = document.createDocumentFragment();
  const top = el("div", "row"); top.append(el("b", null, S.me.nickname), el("span", "spacer"), el("span", "note", `${savedN} de ${S.games.length} pronósticos guardados`));
  frag.append(top);
  if (!S.picks.some((p) => p.user_id === S.me.id) && !S.standings.some((r) => r.user_id === S.me.id)) {
    const ft = el("div", "banner firsttime"); ft.append(el("span", null, "¿Primera vez? Elige ganador y diferencia en cada partido y toca Guardar."));
    const lk = el("button", "linkbtn", "Ver instrucciones"); lk.type = "button"; lk.addEventListener("click", () => { S.tab = "rules"; render(); });
    ft.append(lk); frag.append(ft);
  }
  if (now < fk) frag.append(el("div", "banner", `El primer partido cierra el ${fmtFull(w.first_kick)}. Domingo y lunes los puedes llenar o cambiar hasta el ${fmtFull(w.cutoff)}`));
  else if (now < Date.parse(w.cutoff)) frag.append(el("div", "banner warn", `Revisa los reportes de lesionados. ¿Te faltó el jueves? Todavía puedes pronosticar domingo y lunes hasta el ${fmtFull(w.cutoff)}`));
  const list = el("div", "games");
  for (const g of S.games) {
    const locked = late || now >= lockAt(g, w);
    const saved = myPick(g.id); const pick = S.draft[g.id] || saved;
    const card = el("div", "game" + (locked ? " locked" : ""));
    const meta = el("div", "gmeta"); if (g.tag) meta.append(el("span", "tag", g.tag)); meta.append(statusChip(g));
    meta.append(locked ? el("span", "chip lock", "Cerrado") : el("span", "chip open", "Cierra " + fmtKick(new Date(lockAt(g, w)).toISOString())));
    const sl = scoreLine(g); if (sl) meta.append(el("span", "spacer"), sl);
    card.append(meta);
    const teams = el("div", "teams");
    const tb = (ab, nm) => {
      const b = el("button", "team"); b.type = "button"; b.disabled = locked;
      b.setAttribute("aria-pressed", pick && pick.team === ab ? "true" : "false");
      b.append(logo(ab), el("span", "ab", ab), el("span", "nm", nm || ""));
      b.addEventListener("click", () => { S.draft[g.id] = { team: ab, margin: (pick && pick.margin) || 3 }; S.msg = ""; render(); });
      return b;
    };
    teams.append(tb(g.away, g.away_name), el("span", "at", "@"), tb(g.home, g.home_name));
    const mg = el("div", "margin"); const lab = el("label", null, "por"); lab.htmlFor = "m-" + g.id;
    const inp = document.createElement("input"); inp.type = "number"; inp.min = 1; inp.max = 60; inp.id = "m-" + g.id; inp.inputMode = "numeric";
    inp.disabled = locked || !pick; inp.value = pick ? pick.margin : "";
    inp.setAttribute("aria-label", `Diferencia de victoria en ${g.away} @ ${g.home}`);
    inp.addEventListener("change", () => {
      let v = Math.round(+inp.value); if (!(v >= 1)) v = 1; if (v > 60) v = 60; inp.value = v;
      S.draft[g.id] = { team: pick.team, margin: v }; S.msg = ""; renderSaveBar();
    });
    mg.append(lab, inp, el("span", null, "pts"));
    const v = points(saved, g); if (v != null) mg.append(el("span", "pts p" + v, (g.status === "live" ? "~" : "") + v));
    card.append(teams, mg); list.append(card);
  }
  frag.append(list);
  const bar = el("div", "savebar"); bar.id = "savebar"; frag.append(bar);
  view.replaceChildren(frag); renderSaveBar();
}
function renderSaveBar() {
  const bar = $("#savebar"); if (!bar) return; bar.innerHTML = "";
  const n = Object.keys(S.draft).length;
  const b = el("button", "btn", S.saving ? "Guardando…" : "Guardar"); b.disabled = !n || S.saving; b.addEventListener("click", savePicks);
  const r = el("button", "btn ghost", "Descartar"); r.disabled = !n || S.saving; r.addEventListener("click", () => { S.draft = {}; S.msg = ""; render(); });
  bar.append(el("span", "note", S.msg || (n ? `${n} cambio${n > 1 ? "s" : ""} sin guardar` : "Todo guardado")), el("span", "spacer"), r, b);
}
async function savePicks() {
  const w = weekObj(); if (!w) return; const now = Date.now();
  const rows = []; let dropped = 0;
  for (const [gid, p] of Object.entries(S.draft)) {
    const g = S.games.find((x) => x.id === gid);
    if (g && now < lockAt(g, w)) rows.push({ user_id: S.me.id, game_id: gid, team: p.team, margin: p.margin }); else dropped++;
  }
  if (!rows.length) { S.draft = {}; S.msg = "Esos partidos ya están cerrados."; return render(); }
  S.saving = true; renderSaveBar();
  const r = await S.sb.from("picks").upsert(rows, { onConflict: "user_id,game_id" });
  S.saving = false;
  if (r.error) { S.msg = "No se pudo guardar. Quizá un partido acaba de cerrar o ya pasó el límite. Recarga e intenta de nuevo."; console.warn(r.error); return renderSaveBar(); }
  S.draft = {}; S.msg = dropped ? `Guardado. ${dropped} pronóstico${dropped > 1 ? "s ya estaban cerrados" : " ya estaba cerrado"}.` : "Pronósticos guardados";
  await loadWeek(); render();
}

/* ---------------- Games ---------------- */
function renderGames() {
  const w = weekObj();
  if (!w || !S.games.length) return view.replaceChildren(emptyBox("Aún no hay partidos", "El calendario aparece cuando se carga la semana."));
  const now = Date.now(); const list = el("div", "games");
  const players = Object.keys(S.profiles);
  for (const g of S.games) {
    const card = el("div", "game"); const meta = el("div", "gmeta");
    if (g.tag) meta.append(el("span", "tag", g.tag)); meta.append(statusChip(g));
    const t = el("div", "teams");
    const ta = el("span", "team"); ta.append(logo(g.away), el("span", "ab", g.away), el("span", "nm", g.away_name || ""));
    const th = el("span", "team"); th.append(logo(g.home), el("span", "ab", g.home), el("span", "nm", g.home_name || ""));
    t.append(ta, el("span", "at", "@"), th);
    card.append(meta, t, scoreLine(g) || el("span", "note", fmtFull(g.kickoff)));
    const gp = el("div", "gpicks");
    if (now < lockAt(g, w)) gp.append(el("span", "note", "Los pronósticos se ven cuando cierra este partido."));
    else {
      const rows = players.map((id) => { const p = S.picks.find((k) => k.user_id === id && k.game_id === g.id); return { id, p, v: points(p, g) }; })
        .filter((r) => r.p || S.entries.has(r.id))
        .sort((a, b) => (b.v ?? -1) - (a.v ?? -1) || nick(a.id).localeCompare(nick(b.id)));
      for (const r of rows) {
        const c = el("span", "gp" + (r.id === S.me.id ? " me" : ""));
        c.append(el("span", "who", nick(r.id)), el("span", "pk", r.p ? `${r.p.team} +${r.p.margin}` : "sin pronóstico"));
        if (r.v != null) c.append(el("span", "pts p" + r.v, String(r.v)));
        gp.append(c);
      }
      if (!rows.length) gp.append(el("span", "note", "Nadie pronosticó este partido."));
    }
    card.append(gp); list.append(card);
  }
  view.replaceChildren(list);
}

/* ---------------- Standings ---------------- */
function weekRows(wid) {
  const by = {}; S.standings.filter((r) => r.week_id === wid).forEach((r) => (by[r.user_id] = r));
  return Object.keys(S.profiles).map((id) => {
    const r = by[id] || { points: 0, exact: 0, scored: 0, live: 0 };
    return { id, tot: r.points, exact: r.exact, scored: r.scored, live: r.live, card: S.entries.has(id) || !!by[id] };
  }).sort((a, b) => b.tot - a.tot || b.exact - a.exact || nick(a.id).localeCompare(nick(b.id)));
}
function currentSeason() {
  const w = weekObj(); if (w) return w.season;
  const last = S.seasons[S.seasons.length - 1]; return last ? last.season : new Date().getFullYear();
}
// Weeks a player could have played (joined before the Saturday cutoff, cutoff already passed) with no picks
function missedWeeks(id, season) {
  const joined = S.profiles[id] && S.profiles[id].created_at ? Date.parse(S.profiles[id].created_at) : 0;
  const played = new Set(S.allEntries.filter((e) => e.user_id === id).map((e) => e.week_id));
  return S.weeks.filter((w) => w.season === season && Date.parse(w.cutoff) < Date.now() && joined < Date.parse(w.cutoff) && !played.has(w.id)).length;
}
function seasonRows() {
  const season = currentSeason();
  const inSeason = new Set(S.weeks.filter((w) => w.season === season).map((w) => w.id));
  const m = {}; Object.keys(S.profiles).forEach((id) => (m[id] = { id, tot: 0, exact: 0, weeks: 0, best: 0, po: 0, missed: missedWeeks(id, season) }));
  S.standings.filter((r) => inSeason.has(r.week_id)).forEach((r) => {
    const x = m[r.user_id]; if (!x) return; x.tot += r.points; x.exact += r.exact; x.weeks++; x.best = Math.max(x.best, r.points);
  });
  S.poPoints.filter((r) => r.season === season).forEach((r) => { const x = m[r.user_id]; if (x) { x.po = r.points; x.tot += r.points; } });
  return Object.values(m).sort((a, b) => b.tot - a.tot || b.exact - a.exact || nick(a.id).localeCompare(nick(b.id)));
}
function renderStandings() {
  const frag = document.createDocumentFragment();
  const top = el("div", "row"); const seg = el("div", "seg");
  [["week", "Esta semana"], ["season", "Temporada"]].forEach(([k, l]) => {
    const b = el("button", null, l); b.type = "button"; b.setAttribute("aria-pressed", S.standMode === k);
    b.addEventListener("click", () => { S.standMode = k; render(); }); seg.append(b);
  });
  top.append(seg, el("span", "spacer"));
  const liveN = S.games.filter((g) => g.status === "live").length;
  if (S.standMode === "week" && liveN) top.append(el("span", "chip live", `${liveN} en vivo · proyectado`));
  frag.append(top);
  const rows = S.standMode === "week" ? weekRows(S.week) : seasonRows();
  if (!rows.length) { frag.append(emptyBox("Aún no hay jugadores", "Los jugadores aparecen aquí cuando crean su cuenta.")); return view.replaceChildren(frag); }
  const wrap = el("div", "tblwrap"); const t = el("table"); const thead = el("thead"); const hr = el("tr");
  const cols = S.standMode === "week" ? [["#", ""], ["Jugador", ""], ["Exactos", "r"], ["Partidos", "r"], ["Puntos", "r"]]
    : [["#", ""], ["Jugador", ""], ["Exactos", "r"], ["Semanas", "r"], ["Faltas", "r"], ["Mejor semana", "r"], ["Playoffs", "r"], ["Puntos", "r"]];
  cols.forEach(([c, cl]) => hr.append(el("th", cl, c))); thead.append(hr); t.append(thead);
  const tb = el("tbody"); let prev = null, rank = 0;
  rows.forEach((r, i) => {
    if (!prev || r.tot !== prev.tot || r.exact !== prev.exact) rank = i + 1; prev = r;
    const tr = el("tr", r.id === S.me.id ? "me" : ""); tr.append(el("td", "rank", String(rank)));
    const n = el("td"); n.append(el("b", null, nick(r.id)));
    if (S.standMode === "week" && r.live) n.append(document.createTextNode(" "), el("span", "chip live", `${r.live} en vivo`));
    if (S.standMode === "week" && !r.card) n.append(el("span", "note", " · sin quiniela"));
    tr.append(n, el("td", "r num", String(r.exact)));
    if (S.standMode === "week") tr.append(el("td", "r num", String(r.scored)));
    else tr.append(el("td", "r num", String(r.weeks)), el("td", "r num" + (r.missed ? " miss" : ""), String(r.missed)), el("td", "r num", String(r.best)), el("td", "r num", String(r.po)));
    tr.append(el("td", "r tot", String(r.tot))); tb.append(tr);
  });
  t.append(tb); wrap.append(t); frag.append(wrap);
  frag.append(el("p", "note", S.standMode === "week" ? "Los empates se rompen por número de diferencias exactas (pronósticos de 11 puntos). Los partidos en vivo cuentan como si terminaran ahorita." : "Puntos = semanas + playoffs. Faltas = semanas sin ningún pronóstico. Los empates se rompen por diferencias exactas."));
  view.replaceChildren(frag);
}

/* ---------------- Admin ---------------- */
function renderAdmin() {
  const frag = document.createDocumentFragment();
  const box = el("div", "form admin"); box.append(el("h2", null, "Organizador"));
  box.append(el("p", "note", "Los marcadores se actualizan solos cada minuto. Si alguno está mal, escribe el correcto y guarda; ese partido queda manual hasta que lo regreses a automático."));
  if (S.games.length) {
    const wrap = el("div", "tblwrap"); const t = el("table"); const tb = el("tbody");
    const ah = el("thead"); const ahr = el("tr"); ["Partido", "Visita", "Local", "Estado", "Origen"].forEach((c) => ahr.append(el("th", null, c))); ah.append(ahr); t.append(ah);
    for (const g of S.games) {
      const tr = el("tr"); tr.append(el("td", null, `${g.away} @ ${g.home}`));
      const mk = (v, id) => { const i = document.createElement("input"); i.className = "sc"; i.type = "number"; i.min = 0; i.id = id; i.value = v ?? ""; i.setAttribute("aria-label", id.startsWith("sa") ? `Marcador ${g.away}` : `Marcador ${g.home}`); return i; };
      const ta = el("td"); ta.append(mk(g.away_score, "sa-" + g.id)); const th = el("td"); th.append(mk(g.home_score, "sh-" + g.id));
      const ts = el("td"); const se = document.createElement("select"); se.id = "ss-" + g.id; se.setAttribute("aria-label", "Estado");
      [["pre", "Sin iniciar"], ["live", "En vivo"], ["final", "Final"]].forEach(([v, l]) => { const o = el("option", null, l); o.value = v; if (g.status === v) o.selected = true; se.append(o); });
      ts.append(se);
      const tm = el("td"); if (g.manual) { const b = el("button", "linkbtn", "Regresar a automático"); b.type = "button";
        b.addEventListener("click", async () => { await S.sb.from("games").update({ manual: false }).eq("id", g.id); }); tm.append(b); } else tm.append(el("span", "note", "automático"));
      tr.append(ta, th, ts, tm); tb.append(tr);
    }
    t.append(tb); wrap.append(t); box.append(wrap);
    const b = el("button", "btn", "Guardar marcadores"); const m = el("span", "note");
    b.addEventListener("click", async () => {
      b.disabled = true; let n = 0;
      for (const g of S.games) {
        const a = $("#sa-" + g.id).value, h = $("#sh-" + g.id).value, s = $("#ss-" + g.id).value;
        const na = a === "" ? null : +a, nh = h === "" ? null : +h;
        if (na === g.away_score && nh === g.home_score && s === g.status) continue;
        const r = await S.sb.from("games").update({ away_score: na, home_score: nh, status: s, detail: s === "final" ? "Final" : s === "live" ? "En vivo" : "", manual: true }).eq("id", g.id);
        if (!r.error) n++;
      }
      b.disabled = false; m.textContent = n ? `${n} partido${n > 1 ? "s" : ""} guardado${n > 1 ? "s" : ""}` : "Sin cambios";
    });
    const row = el("div", "row"); row.append(b, m); box.append(row);
  }
  frag.append(box);
  const pb = el("div", "form"); pb.append(el("h2", null, "Jugadores"));
  if (!S.contacts.length) pb.append(el("p", "note", "Nadie se ha registrado todavía."));
  else {
    const wrap = el("div", "tblwrap"); const t = el("table"); const thead = el("thead"); const hr = el("tr");
    ["Apodo", "Correo", "Celular", "Quiniela esta semana"].forEach((c) => hr.append(el("th", null, c))); thead.append(hr); t.append(thead);
    const tb = el("tbody");
    S.contacts.slice().sort((a, b) => nick(a.user_id).localeCompare(nick(b.user_id))).forEach((c) => {
      const tr = el("tr"); tr.append(el("td", null, nick(c.user_id)), el("td", null, c.email || ""), el("td", "num", c.phone || ""), el("td", null, S.entries.has(c.user_id) ? "Entregada" : "—")); tb.append(tr);
    });
    t.append(tb); wrap.append(t); pb.append(wrap);
  }
  const sb2 = el("div", "form"); sb2.append(el("h2", null, `Sugerencias (${S.suggestions.length})`));
  if (!S.suggestions.length) sb2.append(el("p", "note", "Todavía no hay sugerencias."));
  for (const g of S.suggestions) {
    const it = el("div", "sug"); const hd = el("div", "row");
    hd.append(el("b", null, nick(g.user_id)), el("span", "spacer"), el("span", "note", fmtFull(g.created_at)));
    it.append(hd, el("p", null, g.body)); sb2.append(it);
  }
  frag.append(pb, renderAdminPlayoffs(), sb2); view.replaceChildren(frag);
}

/* ---------------- Playoffs ---------------- */
const seasonCfg = () => S.seasons.find((x) => x.season === currentSeason()) || null;
function renderPlayoffs() {
  const cfgS = seasonCfg();
  if (!cfgS) return view.replaceChildren(emptyBox("Playoffs aún no abiertos", "El organizador todavía no abre los pronósticos de playoffs de esta temporada."));
  const now = Date.now(), lock = Date.parse(cfgS.playoff_lock), locked = now >= lock;
  const mine = S.poPicks.find((p) => p.user_id === S.me.id && p.season === cfgS.season) || null;
  if (!S.poDraft || S.poDraft.season !== cfgS.season) S.poDraft = { season: cfgS.season, teams: new Set(mine ? mine.teams : []), champion: mine ? mine.champion || "" : "", dirty: false };
  const d = S.poDraft; const results = new Set(cfgS.playoff_teams || []); const hasResults = results.size > 0;
  const frag = document.createDocumentFragment();
  const intro = el("div", "banner" + (locked ? "" : " warn"));
  intro.append(el("b", null, `${cfgS.pts_per_team} pts por cada equipo que aciertes. `),
    document.createTextNode(locked ? "Los pronósticos de playoffs ya cerraron." : `Elige los 7 equipos de la AFC y los 7 de la NFC que crees que llegan a playoffs. Cierra el ${fmtFull(cfgS.playoff_lock)}`));
  frag.append(intro);
  for (const conf of ["AFC", "NFC"]) {
    const box = el("div", "pobox"); const n = [...d.teams].filter((t) => CONF_OF[t] === conf).length;
    const head = el("div", "row"); head.append(el("h3", "poconf", conf), el("span", "spacer"), el("span", "chip" + (n === 7 ? " open" : ""), `${n}/7`));
    box.append(head);
    const grid = el("div", "pogrid");
    for (const [div, teams] of Object.entries(TEAMS[conf])) {
      const col = el("div", "podiv"); col.append(el("small", null, `${conf} ${div}`));
      for (const [ab, nm] of teams) {
        const on = d.teams.has(ab);
        const b = el("button", "team poteam" + (hasResults ? (results.has(ab) ? " made" : " out") : "")); b.type = "button";
        b.setAttribute("aria-pressed", on ? "true" : "false"); b.disabled = locked;
        b.append(logo(ab), el("span", "ab", ab), el("span", "nm", nm));
        b.addEventListener("click", () => {
          if (on) { d.teams.delete(ab); if (d.champion === ab) d.champion = ""; }
          else { if (n >= 7) { S.poMsg = `Ya elegiste 7 equipos de la ${conf}. Quita uno para cambiarlo.`; return render(); } d.teams.add(ab); }
          d.dirty = true; S.poMsg = ""; render();
        });
        col.append(b);
      }
      grid.append(col);
    }
    box.append(grid); frag.append(box);
  }
  if (!locked) { const bar = el("div", "savebar"); bar.id = "pobar"; frag.append(bar); }
  if (locked) {
    // Everyone's picks are visible once playoff picks lock
    const season = cfgS.season; const pts = {}; S.poPoints.filter((r) => r.season === season).forEach((r) => (pts[r.user_id] = r));
    const rows = S.poPicks.filter((p) => p.season === season).map((p) => ({ p, r: pts[p.user_id] }))
      .sort((a, b) => ((b.r && b.r.points) || 0) - ((a.r && a.r.points) || 0) || nick(a.p.user_id).localeCompare(nick(b.p.user_id)));
    const wrap = el("div", "tblwrap"); const t = el("table"); const th = el("thead"); const hr = el("tr");
    [["Jugador", ""], ["Equipos", ""], ["Aciertos", "r"], ["Puntos", "r"]].forEach(([c, cl]) => hr.append(el("th", cl, c))); th.append(hr); t.append(th);
    const tb = el("tbody");
    for (const { p, r } of rows) {
      const tr = el("tr", p.user_id === S.me.id ? "me" : ""); tr.append(el("td", null, nick(p.user_id)));
      const teams = el("td", "poteams"); p.teams.slice().sort().forEach((x) => teams.append(el("span", "pot" + (hasResults ? (results.has(x) ? " made" : " out") : ""), x)));
      tr.append(teams, el("td", "r num", r ? String(r.hits) : "—"), el("td", "r tot", r ? String(r.points) : "—"));
      tb.append(tr);
    }
    if (!rows.length) { const tr = el("tr"); const td = el("td", "note", "Nadie hizo pronósticos de playoffs."); td.colSpan = 4; tr.append(td); tb.append(tr); }
    t.append(tb); wrap.append(t); frag.append(el("h3", "poconf", "Pronósticos de todos"), wrap);
  }
  view.replaceChildren(frag); renderPoBar();
}
function renderPoBar() {
  const bar = $("#pobar"); if (!bar) return; bar.innerHTML = ""; const d = S.poDraft;
  const a = [...d.teams].filter((t) => CONF_OF[t] === "AFC").length, n = [...d.teams].filter((t) => CONF_OF[t] === "NFC").length;
  const ready = a === 7 && n === 7;
  const missing = [7 - a ? `${7 - a} AFC` : "", 7 - n ? `${7 - n} NFC` : ""].filter(Boolean).join(" y ");
  const msg = S.poMsg || (ready ? (d.dirty ? "Listo para guardar" : "Pronóstico de playoffs guardado") : `Te falta: ${missing}`);
  const b = el("button", "btn", S.saving ? "Guardando…" : "Guardar playoffs"); b.disabled = !d.dirty || S.saving;
  b.addEventListener("click", async () => {
    const cfgS = seasonCfg(); if (!cfgS) return;
    S.saving = true; renderPoBar();
    const r = await S.sb.from("playoff_picks").upsert({ user_id: S.me.id, season: cfgS.season, teams: [...d.teams], champion: null }, { onConflict: "user_id,season" });
    S.saving = false;
    if (r.error) { S.poMsg = "No se pudo guardar. Quizá ya cerraron los pronósticos de playoffs."; console.warn(r.error); return renderPoBar(); }
    d.dirty = false; S.poMsg = ready ? "Pronóstico de playoffs guardado" : "Guardado. Completa tus 14 equipos antes del cierre.";
    await loadBase(); render();
  });
  bar.append(el("span", "note", msg), el("span", "spacer"), b);
}
function toLocalInput(iso) { const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
function renderAdminPlayoffs() {
  const season = currentSeason();
  const c = seasonCfg() || { season, playoff_lock: new Date(Date.now() + 7 * 864e5).toISOString(), pts_per_team: 10, pts_champion: 20, playoff_teams: [], champion: null };
  const box = el("div", "form admin"); box.append(el("h2", null, `Playoffs ${season}`));
  box.append(el("p", "note", "Define cuándo cierran los pronósticos de playoffs y cuántos puntos vale cada acierto. Al terminar la Semana 18 marca los 14 equipos que entraron; los puntos se suman solos a la tabla de la temporada."));
  const row = el("div", "row");
  const mkField = (id, label, input) => { const f = el("div", "field"); const l = el("label", null, label); l.htmlFor = id; input.id = id; f.append(l, input); return f; };
  const i1 = document.createElement("input"); i1.type = "datetime-local"; i1.value = toLocalInput(c.playoff_lock);
  const i2 = document.createElement("input"); i2.type = "number"; i2.min = 0; i2.max = 100; i2.value = c.pts_per_team;
  row.append(mkField("apLock", "Cierre (hora de tu dispositivo)", i1), mkField("apPts", "Pts por equipo", i2));
  box.append(row);
  box.append(el("small", "note", "Equipos que entraron a playoffs (marca los 14 cuando termine la temporada regular):"));
  const made = new Set(c.playoff_teams || []); const grid = el("div", "pochecks");
  for (const conf of ["AFC", "NFC"]) for (const teams of Object.values(TEAMS[conf])) for (const [ab] of teams) {
    const lb = el("label", "pocheck"); const cb = document.createElement("input"); cb.type = "checkbox"; cb.value = ab; cb.id = "apT-" + ab; cb.checked = made.has(ab);
    lb.append(cb, document.createTextNode(" " + ab)); grid.append(lb);
  }
  box.append(grid);
  const b = el("button", "btn", "Guardar playoffs"); const m = el("span", "note");
  b.addEventListener("click", async () => {
    const teams = [...grid.querySelectorAll("input:checked")].map((x) => x.value);
    if (teams.length && teams.length !== 14) { m.textContent = `Marcaste ${teams.length} equipos; deben ser 14 (o ninguno todavía).`; return; }
    if (!i1.value) { m.textContent = "Elige la fecha de cierre."; return; }
    b.disabled = true;
    const r = await S.sb.from("season_settings").upsert({ season, playoff_lock: new Date(i1.value).toISOString(), pts_per_team: +i2.value || 0, pts_champion: 0, playoff_teams: teams, champion: null, updated_at: new Date().toISOString() }, { onConflict: "season" });
    b.disabled = false; m.textContent = r.error ? "No se pudo guardar." : "Playoffs guardados";
    if (!r.error) await loadBase();
  });
  const rr = el("div", "row"); rr.append(b, m); box.append(rr);
  return box;
}

/* ---------------- Cómo jugar ---------------- */
function renderRules() {
  const panel = el("div", "rulespanel");
  panel.append($("#rulesContent").cloneNode(true));
  panel.firstChild.removeAttribute("id");
  const frag = document.createDocumentFragment(); frag.append(panel, suggestionBox());
  view.replaceChildren(frag);
}
function suggestionBox() {
  const box = el("div", "form"); box.id = "sugerencias";
  box.append(el("h2", null, "Sugerencias para la próxima temporada"));
  box.append(el("p", "note", "Esta temporada es una prueba piloto. Cuéntanos qué cambiarías o agregarías para la quiniela del próximo año: reglas, puntos, premios, diseño, lo que sea. Solo el organizador lee las sugerencias."));
  const f = el("div", "field"); const l = el("label", null, "Tu sugerencia"); l.htmlFor = "sugText";
  const ta = document.createElement("textarea"); ta.id = "sugText"; ta.rows = 4; ta.maxLength = 2000; ta.placeholder = "Ej. que haya un premio para el MVP de la temporada…";
  f.append(l, ta); box.append(f);
  const msg = el("span", "note", S.sugMsg); const b = el("button", "btn", "Enviar sugerencia");
  b.addEventListener("click", async () => {
    const body = ta.value.trim(); if (body.length < 3) { msg.textContent = "Escribe un poco más."; return; }
    b.disabled = true;
    const r = await S.sb.from("suggestions").insert({ user_id: S.me.id, body });
    b.disabled = false;
    if (r.error) { msg.textContent = "No se pudo enviar. Intenta de nuevo."; return; }
    ta.value = ""; S.sugMsg = "¡Gracias! Tu sugerencia llegó al organizador.";
    await loadBase(); render();
  });
  const row = el("div", "row"); row.append(b, msg); box.append(row);
  const mine = S.suggestions.filter((g) => g.user_id === S.me.id);
  if (mine.length) {
    box.append(el("small", "note", `Has enviado ${mine.length} sugerencia${mine.length > 1 ? "s" : ""}:`));
    for (const g of mine.slice(0, 5)) { const it = el("div", "sug"); it.append(el("span", "note", fmtFull(g.created_at)), el("p", null, g.body)); box.append(it); }
  }
  return box;
}

/* ---------------- Inicio (home) ---------------- */
function renderHome() {
  const w = weekObj(); const now = Date.now(); const frag = document.createDocumentFragment();
  const hero = el("div", "hero");
  hero.append(el("h2", null, `¡Bienvenido, ${S.me.nickname}!`),
    el("p", null, "Pronostica el ganador y la diferencia de cada partido de la temporada regular de la NFL. Los marcadores y la tabla se actualizan en vivo."));
  frag.append(hero);
  const pilot = el("div", "pilot");
  pilot.append(el("b", null, "Temporada piloto 2026. "), document.createTextNode("Esta temporada es una prueba para la quiniela formal del próximo año. ¿Ideas o algo que mejorar? "));
  const pl = el("button", "linkbtn", "Envía una sugerencia"); pl.type = "button"; pl.addEventListener("click", () => go("rules", "sugerencias"));
  pilot.append(pl); frag.append(pilot);
  const prize = el("div", "prize"); prize.append(el("span", "prizeicon", "🍽️"), el("div", null));
  prize.lastChild.append(el("b", null, "Premio de la temporada: "), document.createTextNode("el campeón de la temporada se lleva una cena en Fishers (o un lugar similar)."));
  frag.append(prize);

  const grid = el("div", "homegrid");
  // Your week
  const c1 = el("div", "hcard");
  c1.append(el("small", null, w ? w.label : "Esta semana"));
  if (w && S.games.length) {
    const mine = S.games.filter((g) => S.picks.some((p) => p.user_id === S.me.id && p.game_id === g.id)).length;
    const open = S.games.filter((g) => now < lockAt(g, w));
    const missingOpen = open.filter((g) => !S.picks.some((p) => p.user_id === S.me.id && p.game_id === g.id)).length;
    c1.append(el("div", "big num", `${mine}/${S.games.length}`), el("p", null, "pronósticos guardados"));
    c1.append(el("p", "note", missingOpen ? `Te faltan ${missingOpen} partido${missingOpen > 1 ? "s" : ""} abierto${missingOpen > 1 ? "s" : ""}.` : open.length ? "Todos tus partidos abiertos tienen pronóstico." : "Todos los partidos de la semana ya cerraron."));
    const nextLock = open.map((g) => lockAt(g, w)).sort((a, b) => a - b)[0];
    if (nextLock) c1.append(el("p", "note", `Próximo cierre: ${fmtFull(new Date(nextLock).toISOString())} (en ${countdown(nextLock - now)})`));
  } else c1.append(el("p", "note", "El calendario de la semana aparece aquí automáticamente."));
  const b1 = el("button", "btn", "Llenar mi quiniela"); b1.type = "button"; b1.addEventListener("click", () => go("card")); c1.append(b1);
  grid.append(c1);

  // This week's top 3
  const c2 = el("div", "hcard"); c2.append(el("small", null, "Tabla de la semana"));
  const wr = weekRows(S.week).filter((r) => r.card);
  if (wr.length && wr.some((r) => r.scored)) {
    const ol = el("ol", "mini");
    wr.slice(0, 3).forEach((r) => { const li = el("li", r.id === S.me.id ? "me" : ""); li.append(el("span", null, nick(r.id)), el("b", "num", String(r.tot))); ol.append(li); });
    c2.append(ol);
    const meIdx = wr.findIndex((r) => r.id === S.me.id);
    if (meIdx >= 3) c2.append(el("p", "note", `Vas en el lugar ${meIdx + 1} con ${wr[meIdx].tot} puntos.`));
    const liveN = S.games.filter((g) => g.status === "live").length; if (liveN) c2.append(el("span", "chip live", `${liveN} en vivo`));
  } else c2.append(el("p", "note", "Los puntos aparecen en cuanto empiece el primer partido."));
  const b2 = el("button", "btn ghost", "Ver tabla"); b2.type = "button"; b2.addEventListener("click", () => { S.standMode = "week"; go("stand"); }); c2.append(b2);
  grid.append(c2);

  // Season leader
  const c3 = el("div", "hcard"); c3.append(el("small", null, "Temporada"));
  const sr = seasonRows().filter((r) => r.tot > 0);
  if (sr.length) {
    c3.append(el("p", null, "Líder (va por la cena):"), el("div", "big", nick(sr[0].id)), el("p", "note", `${sr[0].tot} puntos`));
    const me = sr.findIndex((r) => r.id === S.me.id); if (me > 0) c3.append(el("p", "note", `Tú vas en el lugar ${me + 1}.`));
  } else c3.append(el("p", "note", "Aún no hay puntos esta temporada."));
  const b3 = el("button", "btn ghost", "Ver temporada"); b3.type = "button"; b3.addEventListener("click", () => { S.standMode = "season"; go("stand"); }); c3.append(b3);
  grid.append(c3);

  // Playoff picks reminder
  const cfgS = seasonCfg();
  if (cfgS && now < Date.parse(cfgS.playoff_lock)) {
    const mine = S.poPicks.find((p) => p.user_id === S.me.id && p.season === cfgS.season);
    const n = mine ? mine.teams.length : 0;
    const c4 = el("div", "hcard"); c4.append(el("small", null, "Playoffs"));
    c4.append(el("div", "big num", `${n}/14`), el("p", null, "equipos elegidos"), el("p", "note", `Cierra el ${fmtFull(cfgS.playoff_lock)}`));
    const b4 = el("button", n === 14 ? "btn ghost" : "btn", n === 14 ? "Revisar" : "Elegir equipos"); b4.type = "button"; b4.addEventListener("click", () => go("playoffs")); c4.append(b4);
    grid.append(c4);
  }
  grid.classList.add("n" + grid.children.length);
  frag.append(grid);
  view.replaceChildren(frag);
}
function go(tab, anchor) {
  S.tab = tab; try { localStorage.setItem("qnfl-tab", tab); } catch (_) {}
  render(); window.scrollTo(0, 0);
  if (anchor) { const a = document.getElementById(anchor); if (a) a.scrollIntoView({ behavior: "smooth", block: "start" }); }
}

/* ---------------- render ---------------- */
function render() {
  renderHeader(); renderAcct();
  $("#rulesBox").hidden = !!(S.session && S.loaded); // signed-in players use the "Cómo jugar" tab
  if (!S.session) return renderAuth();
  if (!S.loaded || !S.me) return view.replaceChildren(emptyBox("Cargando", "Trayendo los partidos y pronósticos de la semana…"));
  $("#tabs").hidden = false; $("#tab-admin").hidden = !S.me.is_admin;
  if (S.tab === "admin" && !S.me.is_admin) S.tab = "card";
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", b.id === "tab-" + S.tab));
  const focused = document.activeElement && document.activeElement.id;
  if (S.tab === "home") renderHome(); else if (S.tab === "card") renderCard(); else if (S.tab === "games") renderGames();
  else if (S.tab === "stand") renderStandings(); else if (S.tab === "rules") renderRules(); else if (S.tab === "playoffs") renderPlayoffs(); else renderAdmin();
  if (focused) { const f = document.getElementById(focused); if (f) f.focus(); }
}

/* ---------------- start ---------------- */
[["home", "tab-home"], ["card", "tab-card"], ["games", "tab-games"], ["stand", "tab-stand"], ["rules", "tab-rules"], ["playoffs", "tab-playoffs"], ["admin", "tab-admin"]].forEach(([k, id]) =>
  $("#" + id).addEventListener("click", () => { S.tab = k; try { localStorage.setItem("qnfl-tab", k); } catch (_) {} render(); }));
$("#weekSel").addEventListener("change", async (e) => { S.week = e.target.value; S.weekPinned = true; S.draft = {}; S.msg = ""; await loadWeek(); render(); });
try { const t = localStorage.getItem("qnfl-tab"); if (t) S.tab = t; } catch (_) {}

// Refresh countdowns and lock states every 30 s; full refresh every 2 min in case a live update was missed
setInterval(() => {
  renderHeader();
  const typing = document.activeElement && ["INPUT", "SELECT"].includes(document.activeElement.tagName);
  if (S.session && S.loaded && !typing && !Object.keys(S.draft).length && !(S.poDraft && S.poDraft.dirty) && S.tab !== "admin" && S.tab !== "playoffs" && S.tab !== "rules") render();
}, 30000);
setInterval(() => { if (S.session && document.visibilityState === "visible") scheduleReload(true); }, 120000);
document.addEventListener("visibilitychange", () => { if (S.session && document.visibilityState === "visible") scheduleReload(true); });

async function start() {
  try { await reloadAll(); subscribe(); } catch (e) { console.error(e); view.replaceChildren(emptyBox("No se pudo cargar la quiniela", "Revisa tu conexión y recarga la página.")); }
}

function boot() {
  if (!window.supabase || !cfg.SUPABASE_URL || /YOUR-PROJECT/.test(cfg.SUPABASE_URL)) {
    return view.replaceChildren(emptyBox("Casi listo", "Agrega la URL y la clave de Supabase en config.js y recarga."));
  }
  S.sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  S.sb.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") { S.authMode = "newpass"; S.session = null; return renderAuth(); }
    if (S.authMode === "newpass" && event !== "SIGNED_OUT") return; // finish setting the new password first
    const had = !!S.session; S.session = session;
    if (session && !had) { S.loaded = false; render(); setTimeout(start, 0); }
    else if (!session) { S.me = null; S.loaded = false; if (channel) { S.sb.removeChannel(channel); channel = null; } render(); }
  });
}
boot();
})();
