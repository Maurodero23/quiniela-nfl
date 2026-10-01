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
  tab: "card", standMode: "week", draft: {}, saving: false, msg: "",
  authMode: "signin", live: false, loaded: false,
};

/* ---------------- helpers ---------------- */
const fmt = (iso, o) => new Intl.DateTimeFormat("en-US", Object.assign({ timeZone: TZ }, o)).format(new Date(iso));
const fmtKick = (iso) => fmt(iso, { weekday: "short", hour: "numeric", minute: "2-digit" });
const fmtFull = (iso) => fmt(iso, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
function countdown(ms) {
  if (ms <= 0) return "now";
  const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${String(mm).padStart(2, "0")}m` : `${mm}m`;
}
function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
function emptyBox(title, text) { const d = el("div", "empty"); d.append(el("b", null, title), document.createTextNode(text)); return d; }
const weekObj = () => S.weeks.find((w) => w.id === S.week) || null;
const lockAt = (g, w) => Math.min(Date.parse(g.kickoff), Date.parse(w.cutoff));
const nick = (id) => (S.profiles[id] && S.profiles[id].nickname) || "Player";

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
  const [me, profs, weeks] = await Promise.all([
    sb.from("profiles").select("id,nickname,is_admin").eq("id", S.session.user.id).maybeSingle(),
    sb.from("profiles").select("id,nickname"),
    sb.from("weeks").select("*").order("first_kick"),
  ]);
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
  let label = "Next deadline", when = null, sub = S.session ? "No games loaded yet" : "Sign in to see this week";
  if (w) {
    const now = Date.now(), fk = Date.parse(w.first_kick), cut = Date.parse(w.cutoff);
    if (now < fk) { label = "Card due · first kickoff"; when = fk; }
    else if (now < cut) { label = "Sun/Mon changes close"; when = cut; }
    else { label = "All picks locked"; sub = "Enjoy the games"; }
  }
  dl.append(el("small", null, label), el("b", "num", when ? countdown(when - Date.now()) : (w ? "Locked" : "—")),
    el("span", null, when ? fmtFull(new Date(when).toISOString()) + " CDMX" : sub));
  const last = S.games.reduce((m, g) => (g.updated_at > m ? g.updated_at : m), "");
  $("#updated").textContent = last && S.games.some((g) => g.status !== "pre") ? `Scores updated ${fmt(last, { hour: "numeric", minute: "2-digit" })}` : "";
}
function renderAcct() {
  const a = $("#acct"); a.hidden = !S.session; if (!S.session) return;
  a.innerHTML = "";
  const dot = el("span", "conn" + (S.live ? " on" : "")); dot.title = S.live ? "Live updates on" : "Reconnecting…";
  a.append(dot, el("span", null, S.live ? "Live" : "Connecting"), el("span", null, "·"), el("b", null, (S.me && S.me.nickname) || ""));
  const out = el("button", "linkbtn", "Sign out"); out.type = "button";
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
  [["signin", "Sign in"], ["signup", "Create account"]].forEach(([k, l]) => {
    const b = el("button", null, l); b.type = "button"; b.setAttribute("aria-pressed", S.authMode === k || (k === "signin" && S.authMode === "forgot"));
    b.addEventListener("click", () => { S.authMode = k; S.msg = ""; renderAuth(); }); tabs.append(b);
  });
  f.append(tabs);
  const err = el("div", "err"); const ok = el("div", "ok", S.msg);
  if (S.authMode === "signup") {
    f.append(el("h2", null, "Join the pool"),
      el("p", "note", "Your nickname shows on the standings. Your email and phone are only visible to the organizer."),
      field("suNick", "Nickname", "text", "e.g. El Profe", "nickname"),
      field("suEmail", "Email", "email", "you@example.com", "email"),
      field("suPhone", "Phone", "tel", "+52 55 1234 5678", "tel"),
      field("suPass", "Password", "password", "At least 8 characters", "new-password"));
    const b = el("button", "btn", "Create account"); b.type = "submit"; f.append(err, ok, b);
    f.addEventListener("submit", async (e) => {
      e.preventDefault(); err.textContent = ""; ok.textContent = "";
      const nickname = $("#suNick").value.trim(), email = $("#suEmail").value.trim(), phone = $("#suPhone").value.trim(), password = $("#suPass").value;
      if (nickname.length < 2 || nickname.length > 24) return (err.textContent = "Nickname needs 2 to 24 characters.");
      if (phone.replace(/\D/g, "").length < 8) return (err.textContent = "Enter a phone number with at least 8 digits.");
      if (password.length < 8) return (err.textContent = "Password needs at least 8 characters.");
      b.disabled = true;
      const av = await S.sb.rpc("nickname_available", { p_nickname: nickname });
      if (av.error) { b.disabled = false; return (err.textContent = "Couldn't reach the pool. Check your connection."); }
      if (av.data === false) { b.disabled = false; return (err.textContent = "That nickname is taken. Try another."); }
      const r = await S.sb.auth.signUp({ email, password, options: { data: { nickname, phone }, emailRedirectTo: location.origin + location.pathname } });
      b.disabled = false;
      if (r.error) return (err.textContent = /registered/i.test(r.error.message) ? "That email already has an account. Sign in instead." : r.error.message);
      if (!r.data.session) { S.authMode = "signin"; S.msg = "Account created. Check your email to confirm it, then sign in."; renderAuth(); }
    });
  } else if (S.authMode === "forgot") {
    f.append(el("h2", null, "Reset password"), el("p", "note", "We'll email you a link to set a new password."), field("fpEmail", "Email", "email", "you@example.com", "email"));
    const b = el("button", "btn", "Send reset link"); b.type = "submit";
    const back = el("button", "linkbtn", "Back to sign in"); back.type = "button"; back.addEventListener("click", () => { S.authMode = "signin"; renderAuth(); });
    f.append(err, ok, b, back);
    f.addEventListener("submit", async (e) => {
      e.preventDefault(); b.disabled = true;
      const r = await S.sb.auth.resetPasswordForEmail($("#fpEmail").value.trim(), { redirectTo: location.origin + location.pathname });
      b.disabled = false; if (r.error) err.textContent = r.error.message; else ok.textContent = "Check your email for the reset link.";
    });
  } else if (S.authMode === "newpass") {
    f.append(el("h2", null, "Set a new password"), field("npPass", "New password", "password", "At least 8 characters", "new-password"));
    const b = el("button", "btn", "Save password"); b.type = "submit"; f.append(err, b);
    f.addEventListener("submit", async (e) => {
      e.preventDefault(); const p = $("#npPass").value; if (p.length < 8) return (err.textContent = "Password needs at least 8 characters.");
      const r = await S.sb.auth.updateUser({ password: p });
      if (r.error) return (err.textContent = r.error.message);
      S.authMode = "signin"; S.msg = ""; S.session = (await S.sb.auth.getSession()).data.session; S.loaded = false; render(); start();
    });
  } else {
    f.append(el("h2", null, "Sign in"), field("siEmail", "Email", "email", "you@example.com", "email"), field("siPass", "Password", "password", "", "current-password"));
    const b = el("button", "btn", "Sign in"); b.type = "submit";
    const fp = el("button", "linkbtn", "Forgot your password?"); fp.type = "button"; fp.addEventListener("click", () => { S.authMode = "forgot"; S.msg = ""; renderAuth(); });
    f.append(err, ok, b, fp);
    f.addEventListener("submit", async (e) => {
      e.preventDefault(); b.disabled = true; err.textContent = "";
      const r = await S.sb.auth.signInWithPassword({ email: $("#siEmail").value.trim(), password: $("#siPass").value });
      b.disabled = false;
      if (r.error) err.textContent = /confirm/i.test(r.error.message) ? "Confirm your email first. Check your inbox." : "Wrong email or password.";
    });
  }
  box.append(f); view.replaceChildren(box);
}

/* ---------------- My card ---------------- */
function statusChip(g) {
  if (g.status === "final") return el("span", "chip final", "Final");
  if (g.status === "live") return el("span", "chip live", g.detail || "Live");
  return el("span", "chip", fmtKick(g.kickoff));
}
function scoreLine(g) { return g.status === "pre" || g.away_score == null ? null : el("div", "score num", `${g.away} ${g.away_score} – ${g.home_score} ${g.home}`); }
const myPick = (gid) => S.picks.find((p) => p.user_id === S.me.id && p.game_id === gid) || null;

function renderCard() {
  const w = weekObj();
  if (!w || !S.games.length) return view.replaceChildren(emptyBox("No games yet", "This week's schedule appears here automatically."));
  const now = Date.now(), fk = Date.parse(w.first_kick);
  const late = now >= fk && !S.entries.has(S.me.id);
  const savedN = S.games.filter((g) => myPick(g.id)).length;
  const frag = document.createDocumentFragment();
  const top = el("div", "row"); top.append(el("b", null, S.me.nickname), el("span", "spacer"), el("span", "note", `${savedN} of ${S.games.length} picks saved`));
  frag.append(top);
  if (late) frag.append(el("div", "banner bad", "You didn't turn in a card before the first kickoff, so you sit out this week."));
  else if (now < fk) frag.append(el("div", "banner", `Turn in your card by ${fmtFull(w.first_kick)}. Sunday and Monday picks stay editable until ${fmtFull(w.cutoff)}.`));
  else if (now < Date.parse(w.cutoff)) frag.append(el("div", "banner warn", `Check the injury reports. Sunday and Monday picks can change until ${fmtFull(w.cutoff)}.`));
  const list = el("div", "games");
  for (const g of S.games) {
    const locked = late || now >= lockAt(g, w);
    const saved = myPick(g.id); const pick = S.draft[g.id] || saved;
    const card = el("div", "game" + (locked ? " locked" : ""));
    const meta = el("div", "gmeta"); if (g.tag) meta.append(el("span", "tag", g.tag)); meta.append(statusChip(g));
    meta.append(locked ? el("span", "chip lock", "Locked") : el("span", "chip open", "Locks " + fmtKick(new Date(lockAt(g, w)).toISOString())));
    const sl = scoreLine(g); if (sl) meta.append(el("span", "spacer"), sl);
    card.append(meta);
    const teams = el("div", "teams");
    const tb = (ab, nm) => {
      const b = el("button", "team"); b.type = "button"; b.disabled = locked;
      b.setAttribute("aria-pressed", pick && pick.team === ab ? "true" : "false");
      b.append(el("span", "ab", ab), el("span", "nm", nm || ""));
      b.addEventListener("click", () => { S.draft[g.id] = { team: ab, margin: (pick && pick.margin) || 3 }; S.msg = ""; render(); });
      return b;
    };
    teams.append(tb(g.away, g.away_name), el("span", "at", "@"), tb(g.home, g.home_name));
    const mg = el("div", "margin"); const lab = el("label", null, "by"); lab.htmlFor = "m-" + g.id;
    const inp = document.createElement("input"); inp.type = "number"; inp.min = 1; inp.max = 60; inp.id = "m-" + g.id; inp.inputMode = "numeric";
    inp.disabled = locked || !pick; inp.value = pick ? pick.margin : "";
    inp.setAttribute("aria-label", `Winning margin for ${g.away} at ${g.home}`);
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
  const b = el("button", "btn", S.saving ? "Saving…" : "Save picks"); b.disabled = !n || S.saving; b.addEventListener("click", savePicks);
  const r = el("button", "btn ghost", "Discard"); r.disabled = !n || S.saving; r.addEventListener("click", () => { S.draft = {}; S.msg = ""; render(); });
  bar.append(el("span", "note", S.msg || (n ? `${n} unsaved change${n > 1 ? "s" : ""}` : "All picks saved")), el("span", "spacer"), r, b);
}
async function savePicks() {
  const w = weekObj(); if (!w) return; const now = Date.now();
  const rows = []; let dropped = 0;
  for (const [gid, p] of Object.entries(S.draft)) {
    const g = S.games.find((x) => x.id === gid);
    if (g && now < lockAt(g, w)) rows.push({ user_id: S.me.id, game_id: gid, team: p.team, margin: p.margin }); else dropped++;
  }
  if (!rows.length) { S.draft = {}; S.msg = "Those games are already locked."; return render(); }
  S.saving = true; renderSaveBar();
  const r = await S.sb.from("picks").upsert(rows, { onConflict: "user_id,game_id" });
  S.saving = false;
  if (r.error) { S.msg = "Couldn't save. A game may have just locked, or the card deadline passed. Reload and try again."; console.warn(r.error); return renderSaveBar(); }
  S.draft = {}; S.msg = dropped ? `Saved. ${dropped} pick${dropped > 1 ? "s were" : " was"} already locked.` : "Picks saved";
  await loadWeek(); render();
}

/* ---------------- Games ---------------- */
function renderGames() {
  const w = weekObj();
  if (!w || !S.games.length) return view.replaceChildren(emptyBox("No games yet", "The schedule appears once the week is loaded."));
  const now = Date.now(); const list = el("div", "games");
  const players = Object.keys(S.profiles);
  for (const g of S.games) {
    const card = el("div", "game"); const meta = el("div", "gmeta");
    if (g.tag) meta.append(el("span", "tag", g.tag)); meta.append(statusChip(g));
    const t = el("div", "teams");
    const ta = el("span", "team"); ta.append(el("span", "ab", g.away), el("span", "nm", g.away_name || ""));
    const th = el("span", "team"); th.append(el("span", "ab", g.home), el("span", "nm", g.home_name || ""));
    t.append(ta, el("span", "at", "@"), th);
    card.append(meta, t, scoreLine(g) || el("span", "note", fmtFull(g.kickoff)));
    const gp = el("div", "gpicks");
    if (now < lockAt(g, w)) gp.append(el("span", "note", "Picks are hidden until this game locks."));
    else {
      const rows = players.map((id) => { const p = S.picks.find((k) => k.user_id === id && k.game_id === g.id); return { id, p, v: points(p, g) }; })
        .filter((r) => r.p || S.entries.has(r.id))
        .sort((a, b) => (b.v ?? -1) - (a.v ?? -1) || nick(a.id).localeCompare(nick(b.id)));
      for (const r of rows) {
        const c = el("span", "gp" + (r.id === S.me.id ? " me" : ""));
        c.append(el("span", "who", nick(r.id)), el("span", "pk", r.p ? `${r.p.team} +${r.p.margin}` : "no pick"));
        if (r.v != null) c.append(el("span", "pts p" + r.v, String(r.v)));
        gp.append(c);
      }
      if (!rows.length) gp.append(el("span", "note", "No picks for this game."));
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
function seasonRows() {
  const season = weekObj() ? weekObj().season : null;
  const inSeason = new Set(S.weeks.filter((w) => w.season === season).map((w) => w.id));
  const m = {}; Object.keys(S.profiles).forEach((id) => (m[id] = { id, tot: 0, exact: 0, weeks: 0, best: 0 }));
  S.standings.filter((r) => inSeason.has(r.week_id)).forEach((r) => {
    const x = m[r.user_id]; if (!x) return; x.tot += r.points; x.exact += r.exact; x.weeks++; x.best = Math.max(x.best, r.points);
  });
  return Object.values(m).sort((a, b) => b.tot - a.tot || b.exact - a.exact || nick(a.id).localeCompare(nick(b.id)));
}
function renderStandings() {
  const frag = document.createDocumentFragment();
  const top = el("div", "row"); const seg = el("div", "seg");
  [["week", "This week"], ["season", "Season"]].forEach(([k, l]) => {
    const b = el("button", null, l); b.type = "button"; b.setAttribute("aria-pressed", S.standMode === k);
    b.addEventListener("click", () => { S.standMode = k; render(); }); seg.append(b);
  });
  top.append(seg, el("span", "spacer"));
  const liveN = S.games.filter((g) => g.status === "live").length;
  if (S.standMode === "week" && liveN) top.append(el("span", "chip live", `${liveN} live · projected`));
  frag.append(top);
  const rows = S.standMode === "week" ? weekRows(S.week) : seasonRows();
  if (!rows.length) { frag.append(emptyBox("No players yet", "Players appear here after they create an account.")); return view.replaceChildren(frag); }
  const wrap = el("div", "tblwrap"); const t = el("table"); const thead = el("thead"); const hr = el("tr");
  const cols = S.standMode === "week" ? [["#", ""], ["Player", ""], ["Exact", "r"], ["Games scored", "r"], ["Points", "r"]]
    : [["#", ""], ["Player", ""], ["Exact", "r"], ["Weeks", "r"], ["Best week", "r"], ["Points", "r"]];
  cols.forEach(([c, cl]) => hr.append(el("th", cl, c))); thead.append(hr); t.append(thead);
  const tb = el("tbody"); let prev = null, rank = 0;
  rows.forEach((r, i) => {
    if (!prev || r.tot !== prev.tot || r.exact !== prev.exact) rank = i + 1; prev = r;
    const tr = el("tr", r.id === S.me.id ? "me" : ""); tr.append(el("td", "rank", String(rank)));
    const n = el("td"); n.append(el("b", null, nick(r.id)));
    if (S.standMode === "week" && r.live) n.append(document.createTextNode(" "), el("span", "chip live", `${r.live} live`));
    if (S.standMode === "week" && !r.card) n.append(el("span", "note", " · no card"));
    tr.append(n, el("td", "r num", String(r.exact)));
    if (S.standMode === "week") tr.append(el("td", "r num", String(r.scored)));
    else tr.append(el("td", "r num", String(r.weeks)), el("td", "r num", String(r.best)));
    tr.append(el("td", "r tot", String(r.tot))); tb.append(tr);
  });
  t.append(tb); wrap.append(t); frag.append(wrap);
  frag.append(el("p", "note", "Ties are broken by number of exact margins (11-point picks). Live games count as if they ended now."));
  view.replaceChildren(frag);
}

/* ---------------- Admin ---------------- */
function renderAdmin() {
  const frag = document.createDocumentFragment();
  const box = el("div", "form admin"); box.append(el("h2", null, "Organizer"));
  box.append(el("p", "note", "Scores update automatically every minute. If a score is wrong, type the right one and save; that game then stays manual until you switch it back to automatic."));
  if (S.games.length) {
    const wrap = el("div", "tblwrap"); const t = el("table"); const tb = el("tbody");
    const ah = el("thead"); const ahr = el("tr"); ["Game", "Away", "Home", "Status", "Source"].forEach((c) => ahr.append(el("th", null, c))); ah.append(ahr); t.append(ah);
    for (const g of S.games) {
      const tr = el("tr"); tr.append(el("td", null, `${g.away} @ ${g.home}`));
      const mk = (v, id) => { const i = document.createElement("input"); i.className = "sc"; i.type = "number"; i.min = 0; i.id = id; i.value = v ?? ""; i.setAttribute("aria-label", id.startsWith("sa") ? `${g.away} score` : `${g.home} score`); return i; };
      const ta = el("td"); ta.append(mk(g.away_score, "sa-" + g.id)); const th = el("td"); th.append(mk(g.home_score, "sh-" + g.id));
      const ts = el("td"); const se = document.createElement("select"); se.id = "ss-" + g.id; se.setAttribute("aria-label", "Status");
      [["pre", "Not started"], ["live", "Live"], ["final", "Final"]].forEach(([v, l]) => { const o = el("option", null, l); o.value = v; if (g.status === v) o.selected = true; se.append(o); });
      ts.append(se);
      const tm = el("td"); if (g.manual) { const b = el("button", "linkbtn", "Back to automatic"); b.type = "button";
        b.addEventListener("click", async () => { await S.sb.from("games").update({ manual: false }).eq("id", g.id); }); tm.append(b); } else tm.append(el("span", "note", "auto"));
      tr.append(ta, th, ts, tm); tb.append(tr);
    }
    t.append(tb); wrap.append(t); box.append(wrap);
    const b = el("button", "btn", "Save scores"); const m = el("span", "note");
    b.addEventListener("click", async () => {
      b.disabled = true; let n = 0;
      for (const g of S.games) {
        const a = $("#sa-" + g.id).value, h = $("#sh-" + g.id).value, s = $("#ss-" + g.id).value;
        const na = a === "" ? null : +a, nh = h === "" ? null : +h;
        if (na === g.away_score && nh === g.home_score && s === g.status) continue;
        const r = await S.sb.from("games").update({ away_score: na, home_score: nh, status: s, detail: s === "final" ? "Final" : s === "live" ? "Live" : "", manual: true }).eq("id", g.id);
        if (!r.error) n++;
      }
      b.disabled = false; m.textContent = n ? `Saved ${n} game${n > 1 ? "s" : ""}` : "Nothing changed";
    });
    const row = el("div", "row"); row.append(b, m); box.append(row);
  }
  frag.append(box);
  const pb = el("div", "form"); pb.append(el("h2", null, "Players"));
  if (!S.contacts.length) pb.append(el("p", "note", "No one has signed up yet."));
  else {
    const wrap = el("div", "tblwrap"); const t = el("table"); const thead = el("thead"); const hr = el("tr");
    ["Nickname", "Email", "Phone", "Card this week"].forEach((c) => hr.append(el("th", null, c))); thead.append(hr); t.append(thead);
    const tb = el("tbody");
    S.contacts.slice().sort((a, b) => nick(a.user_id).localeCompare(nick(b.user_id))).forEach((c) => {
      const tr = el("tr"); tr.append(el("td", null, nick(c.user_id)), el("td", null, c.email || ""), el("td", "num", c.phone || ""), el("td", null, S.entries.has(c.user_id) ? "Turned in" : "—")); tb.append(tr);
    });
    t.append(tb); wrap.append(t); pb.append(wrap);
  }
  frag.append(pb); view.replaceChildren(frag);
}

/* ---------------- render ---------------- */
function render() {
  renderHeader(); renderAcct();
  if (!S.session) return renderAuth();
  if (!S.loaded || !S.me) return view.replaceChildren(emptyBox("Loading", "Getting this week's games and picks…"));
  $("#tabs").hidden = false; $("#tab-admin").hidden = !S.me.is_admin;
  if (S.tab === "admin" && !S.me.is_admin) S.tab = "card";
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", b.id === "tab-" + S.tab));
  const focused = document.activeElement && document.activeElement.id;
  if (S.tab === "card") renderCard(); else if (S.tab === "games") renderGames();
  else if (S.tab === "stand") renderStandings(); else renderAdmin();
  if (focused) { const f = document.getElementById(focused); if (f) f.focus(); }
}

/* ---------------- start ---------------- */
[["card", "tab-card"], ["games", "tab-games"], ["stand", "tab-stand"], ["admin", "tab-admin"]].forEach(([k, id]) =>
  $("#" + id).addEventListener("click", () => { S.tab = k; try { localStorage.setItem("qnfl-tab", k); } catch (_) {} render(); }));
$("#weekSel").addEventListener("change", async (e) => { S.week = e.target.value; S.weekPinned = true; S.draft = {}; S.msg = ""; await loadWeek(); render(); });
try { const t = localStorage.getItem("qnfl-tab"); if (t) S.tab = t; } catch (_) {}

// Refresh countdowns and lock states every 30 s; full refresh every 2 min in case a live update was missed
setInterval(() => {
  renderHeader();
  const typing = document.activeElement && ["INPUT", "SELECT"].includes(document.activeElement.tagName);
  if (S.session && S.loaded && !typing && !Object.keys(S.draft).length && S.tab !== "admin") render();
}, 30000);
setInterval(() => { if (S.session && document.visibilityState === "visible") scheduleReload(true); }, 120000);
document.addEventListener("visibilitychange", () => { if (S.session && document.visibilityState === "visible") scheduleReload(true); });

async function start() {
  try { await reloadAll(); subscribe(); } catch (e) { console.error(e); view.replaceChildren(emptyBox("Couldn't load the pool", "Check your connection and reload the page.")); }
}

function boot() {
  if (!window.supabase || !cfg.SUPABASE_URL || /YOUR-PROJECT/.test(cfg.SUPABASE_URL)) {
    return view.replaceChildren(emptyBox("Almost there", "Add your Supabase URL and key to config.js, then reload."));
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
