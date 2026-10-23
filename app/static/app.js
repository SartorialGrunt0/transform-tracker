/* Transform Tracker — front-end
   Views: week (default) -> day (one weekday, all columns) -> cell (one cell).
   Tapping a cell adds a tally; every cell carries explicit -/+/reset controls. */

const S = { week: null, current: null, today: null, settings: {} };
/* One screen: the week grid. A tapped cell gets the bottom toolbar; ⤢ opens
   that cell in a popup. There are no zoom levels. */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

let QUEUE = Promise.resolve();

/* ------------------------------------------------------------------ api */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  let data = null;
  const type = res.headers.get("content-type") || "";
  if (type.includes("json")) data = await res.json();
  if (!res.ok) throw new Error((data && data.detail) || `HTTP ${res.status}`);
  return data;
}

function enqueue(fn) {
  QUEUE = QUEUE.then(fn).catch((err) => {
    toast(err.message || String(err));
    return load(S.week ? S.week.week_start : "current", { quiet: true });
  });
  return QUEUE;
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  const b = await api("/api/bootstrap");
  S.today = b.today;
  S.current = b.current_week;
  S.settings = b.settings;
  S.week = b.week;
  render();
}

async function load(weekStart, opts = {}) {
  const week = await api(`/api/week/${weekStart}`);
  S.week = week;
  S.current = mondayOf(week.today);
  hideBar();
  render();
  if (!opts.quiet) closeGoalPop();
}

/* ------------------------------------------------------------------ views */

function render() {
  renderHeader();
  renderNav();
  renderWeek($("#viewRoot"));
  renderWeights();
  renderLock();
}

function renderHeader() {
  $("#whoName").textContent = S.week.name || S.settings.name || "Me";
  $("#whoRange").textContent = shortRange(S.week);
}

function shortRange(week) {
  const a = new Date(week.week_start + "T00:00:00");
  const b = new Date(week.week_end + "T00:00:00");
  const m = (d) => d.toLocaleDateString(undefined, { month: "short" });
  if (a.getMonth() === b.getMonth()) return `${m(a)} ${a.getDate()} – ${b.getDate()}`;
  return `${m(a)} ${a.getDate()} – ${m(b)} ${b.getDate()}`;
}

function renderNav() {
  $("#weekLabel").textContent = S.week.label;
  const state = $("#weekState");
  if (S.week.is_current) state.textContent = "Current week";
  else if (S.week.locked) state.textContent = "Closed · read only";
  else state.textContent = "Unlocked · editable";

  const next = shiftDate(S.week.week_start, 7);
  $("#nextWeek").disabled = next > S.current;
  $("#todayBtn").hidden = S.week.is_current;
}

const colMeta = (key) => S.week.columns.find((c) => c.key === key) || {};
const colLabel = (key) => colMeta(key).label || key;
const colColor = (key) => colMeta(key).color || "#fff";
const countOf = (day, col) => S.week.days[day].cells[col];

function tallyHTML(n, max = 10) {
  if (n <= 0 || n > max) return "";
  const groups = [];
  let left = n;
  while (left > 0) {
    const size = Math.min(5, left);
    let bars = "";
    for (let i = 0; i < Math.min(4, size); i++) bars += "<i></i>";
    const strike = size === 5 ? "<b></b>" : "";
    groups.push(`<span class="g">${bars}${strike}</span>`);
    left -= size;
  }
  return `<span class="tally">${groups.join("")}</span>`;
}

/* ------------------------------------------------------------- week view */

function renderWeek(root) {
  const cols = S.week.columns;
  const goals = S.week.goals;

  let html = `<table id="grid" class="grid">
    <colgroup>
      <col class="c-day"><col span="8" class="c-col"><col class="c-act">
    </colgroup>
    <thead>
      <tr id="goalRow" class="gorow"><th class="daycol" aria-hidden="true"></th>`;

  for (const c of cols) {
    html += `<th class="goal" data-col="${c.key}" style="--tint:${c.color}"
      title="Daily goal for ${esc(c.label)} — tap to change">
      <span class="g">${goals[c.key]}</span></th>`;
  }
  html += `<th class="actcol" aria-hidden="true"></th></tr>
      <tr id="colRow" class="colrow"><th class="daycol" aria-hidden="true"></th>`;
  for (const c of cols) {
    html += `<th class="lbl" style="--tint:${c.color}">
      <span class="long">${esc(c.label)}</span>
      <span class="short">${esc(c.short)}</span></th>`;
  }
  html += `<th class="lbl actcol" style="--tint:#f7f3e9">Activity</th></tr>
    </thead><tbody id="daysBody">`;

  for (const d of S.week.days) {
    html += `<tr class="${d.is_today ? "todayrow" : ""}">
      <td class="daycol">${d.label}<span class="dom">${d.dom}</span></td>`;
    for (const c of cols) {
      const n = d.cells[c.key];
      const over = d.over[c.key];
      html += `<td class="cell${over ? " over" : ""}" data-day="${d.day}"
        data-col="${c.key}" style="--tint:${c.color}" role="button"
        aria-label="${d.label} ${esc(c.label)}: ${n} tallies, goal ${goals[c.key]}">
        <span class="n">${n || ""}</span>${tallyHTML(n)}</td>`;
    }
    html += `<td class="actcol"><div class="act-in" data-day="${d.day}">
      <div class="row1">
        <input class="t" data-field="time" inputmode="numeric" enterkeyhint="done"
          maxlength="5" placeholder="00:45" value="${esc(d.activity.time)}"
          aria-label="Time HH:MM">
        <input class="k" data-field="type" maxlength="120" placeholder="walk"
          value="${esc(d.activity.type)}" aria-label="Activity type">
      </div>
      <div class="int">${intensityButtons(d)}</div>
    </div></td></tr>`;
  }

  html += `</tbody><tfoot id="totalsFoot"><tr><td class="daycol">Σ</td>`;
  for (const c of cols) html += `<td>${S.week.col_totals[c.key] || ""}</td>`;
  html += `<td class="actcol"></td></tr></tfoot></table>`;

  html += `<div class="actwrap"><h2 class="sechead">Activity</h2><div class="actcards">`;
  for (const d of S.week.days) {
    html += `<div class="actcard${d.activity_done ? " done" : ""}" data-day="${d.day}">
      <div class="ah"><span>${d.label} ${d.dom}</span>
        <span class="ai">${d.activity.intensity ? "intensity " + d.activity.intensity : ""}</span></div>
      <div class="a1">
        <input class="t" data-field="time" inputmode="numeric" enterkeyhint="done"
          maxlength="5" placeholder="00:45" value="${esc(d.activity.time)}"
          aria-label="Time HH:MM">
        <input class="k" data-field="type" maxlength="120" placeholder="walk"
          value="${esc(d.activity.type)}" aria-label="Activity type">
      </div>
      <div class="int">${intensityButtons(d)}</div>
    </div>`;
  }
  html += `</div></div>`;

  root.innerHTML = html;
  if (S.week.locked) disableInputs(root);
}

function intensityButtons(d) {
  let out = "";
  for (let i = 1; i <= 10; i++) {
    out += `<button type="button" data-int="${i}" class="${d.activity.intensity === i ? "on" : ""}"
      aria-label="Intensity ${i}">${i}</button>`;
  }
  return out;
}

function disableInputs(root) {
  root.querySelectorAll("input, .int button").forEach((n) => (n.disabled = true));
}

/* ------------------------------------------------------------------ counts */

function setCount(day, col, value) {
  const next = Math.max(0, Math.min(999, value));
  const d = S.week.days[day];
  d.cells[col] = next;
  d.over[col] = next > S.week.goals[col];
  paintCounts(day, col);

  enqueue(async () => {
    const res = await api(`/api/week/${S.week.week_start}/cell`, {
      method: "PUT",
      body: JSON.stringify({ day, col, count: next }),
    });
    d.cells[col] = res.count;
    d.over[col] = res.over;
    paintCounts(day, col);
    flashSaved();
  });
}

function bump(day, col, delta) {
  setCount(day, col, countOf(day, col) + delta);
}

function paintCounts(day, col) {
  const n = countOf(day, col);
  const over = S.week.days[day].over[col];
  const goal = S.week.goals[col];

  const td = document.querySelector(`td.cell[data-day="${day}"][data-col="${col}"]`);
  if (td) {
    td.classList.toggle("over", over);
    td.querySelector(".n").textContent = n || "";
    const old = td.querySelector(".tally");
    if (old) old.remove();
    td.insertAdjacentHTML("beforeend", tallyHTML(n));
    td.setAttribute("aria-label",
      `${S.week.days[day].label} ${colLabel(col)}: ${n} tallies, goal ${goal}`);
    td.classList.remove("pop");
    void td.offsetWidth;
    td.classList.add("pop");
  }

  if (barFor && barFor.day === day && barFor.col === col) {
    $("#barCount").textContent = n;
  }

  paintTotals();
}

function paintTotals() {
  const cells = document.querySelectorAll("#totalsFoot td");
  if (!cells.length) return;
  S.week.columns.forEach((c, i) => {
    let sum = 0;
    for (const d of S.week.days) sum += d.cells[c.key];
    S.week.col_totals[c.key] = sum;
    if (cells[i + 1]) cells[i + 1].textContent = sum || "";
  });
}

/* ------------------------------------------------------------- cell toolbar */

let barFor = null;

function showBar(day, col) {
  const td = document.querySelector(`td.cell[data-day="${day}"][data-col="${col}"]`);
  if (!td) return;
  const bar = $("#cellBar");
  bar.dataset.day = day;
  bar.dataset.col = col;
  $("#barName").textContent = `${S.week.days[day].label} · ${colLabel(col)}`;
  $("#barCount").textContent = countOf(day, col);
  document.querySelectorAll("td.cell.active").forEach((n) => n.classList.remove("active"));
  td.classList.add("active");
  bar.hidden = false;
  document.body.classList.add("barshown");
  barFor = { day, col };
}

function hideBar() {
  const bar = $("#cellBar");
  if (bar) bar.hidden = true;
  document.body.classList.remove("barshown");
  document.querySelectorAll("td.cell.active").forEach((n) => n.classList.remove("active"));
  barFor = null;
}

/* ------------------------------------------------------------------ activity */

const ACT_TIMERS = new Map();

function scheduleActivity(day, delay = 450) {
  clearTimeout(ACT_TIMERS.get(day));
  ACT_TIMERS.set(day, setTimeout(() => saveActivity(day), delay));
}

function saveActivity(day) {
  const a = S.week.days[day].activity;
  enqueue(async () => {
    const res = await api(`/api/week/${S.week.week_start}/activity`, {
      method: "PUT",
      body: JSON.stringify({ day, time: a.time, type: a.type, intensity: a.intensity }),
    });
    a.time = res.time;
    a.type = res.type;
    a.intensity = res.intensity;
    const done = !!(res.time || res.type);
    S.week.days[day].activity_done = done;
    document.querySelectorAll(`[data-day="${day}"]`)
      .forEach((n) => {
        if (n.classList.contains("actcard") || n.classList.contains("act-in")) {
          n.classList.toggle("done", done);
        }
      });
    syncDayLabels(day);
    flashSaved();
  });
}

function syncDayLabels(day) {
  const i = S.week.days[day].activity.intensity;
  document.querySelectorAll(`.actcard[data-day="${day}"] .ai, .act-in[data-day="${day}"] .ai`)
    .forEach((n) => (n.textContent = i ? `intensity ${i}` : ""));
}

function normalizeTime(raw) {
  let v = String(raw || "").trim().replace(/[^0-9:]/g, "");
  if (!v) return "";
  if (v.includes(":")) {
    const [h, m] = v.split(":");
    return `${String(Math.min(23, Number(h) || 0)).padStart(2, "0")}:${String(
      Math.min(59, Number(m) || 0)).padStart(2, "0")}`;
  }
  if (v.length <= 2) v = v.padStart(2, "0");
  if (v.length === 3) v = "0" + v;
  v = v.padStart(4, "0");
  const h = Math.min(23, Number(v.slice(0, 2)) || 0);
  const m = Math.min(59, Number(v.slice(2, 4)) || 0);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ goal popover */

let goalPop = null;

function openGoalPop(th) {
  closeGoalPop();
  if (S.week.locked) return toast("Closed week — press Unlock to edit");
  const col = th.dataset.col;
  const pop = document.createElement("div");
  pop.className = "goalpop";
  for (let i = 1; i <= 9; i++) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = String(i);
    if (S.week.goals[col] === i) b.classList.add("on");
    b.onclick = () => {
      closeGoalPop();
      S.week.goals[col] = i;
      enqueue(async () => {
        await api(`/api/week/${S.week.week_start}`, {
          method: "PATCH",
          body: JSON.stringify({ goals: { [col]: i } }),
        });
        for (const d of S.week.days) d.over[col] = d.cells[col] > i;
        render();
        flashSaved();
      });
    };
    pop.appendChild(b);
  }
  document.body.appendChild(pop);
  const r = th.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - pw / 2),
    window.innerWidth - pw - 8);
  pop.style.left = `${left}px`;
  pop.style.top = `${Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 8)}px`;
  goalPop = pop;
}

function closeGoalPop() {
  if (goalPop) goalPop.remove();
  goalPop = null;
}

/* ------------------------------------------------------------------ weights */

function renderWeights() {
  const w = S.week;
  if (!w) return;
  const set = (id, v) => {
    const input = $(id);
    if (!input) return;
    if (document.activeElement !== input) input.value = v ?? "";
    input.disabled = w.locked;
  };
  set("#weightStart", w.weight_start);
  set("#weightEnd", w.weight_end);
  set("#waistStart", w.waist_start);
  set("#waistEnd", w.waist_end);

  const bits = [];
  if (w.weight_start != null && w.weight_end != null) {
    const d = (w.weight_end - w.weight_start).toFixed(1);
    bits.push(`${d > 0 ? "+" : ""}${d} lb`);
  }
  if (w.waist_start != null && w.waist_end != null) {
    const d = (w.waist_end - w.waist_start).toFixed(1);
    bits.push(`${d > 0 ? "+" : ""}${d} in`);
  }
  const delta = $("#wDelta");
  delta.textContent = bits.join(" · ");
  delta.style.color = bits.some((b) => b.startsWith("-")) ? "#3f7a4a" : "#a8632f";
}

function renderLock() {
  $("#lockBanner").hidden = !S.week.locked;
  $("#lockBtn").hidden = S.week.is_current || S.week.locked;
}

/* ------------------------------------------------------------------ events */

document.addEventListener("pointerdown", (e) => {
  if (e.target.closest("button, input")) return;
  const cell = e.target.closest("td.cell");
  if (cell) {
    if (S.week.locked) return toast("Closed week — press Unlock to edit");
    e.preventDefault();
    const day = Number(cell.dataset.day);
    const col = cell.dataset.col;
    bump(day, col, 1);
    showBar(day, col);
    return;
  }
  if (!e.target.closest("#cellBar")) hideBar();
});

document.addEventListener("click", (e) => {
  const actBtn = e.target.closest("[data-act]");
  if (actBtn) {
    e.preventDefault();
    const host = actBtn.closest("[data-day]") || $("#cellBar");
    const day = Number(host.dataset.day);
    const col = host.dataset.col;
    const act = actBtn.dataset.act;
    if (S.week.locked) return toast("Closed week — press Unlock to edit");
    if (act === "inc") bump(day, col, 1);
    else if (act === "dec") bump(day, col, -1);
    else if (act === "zero") setCount(day, col, 0);
    return;
  }

  const goalTh = e.target.closest("#goalRow th.goal");
  if (goalTh) return openGoalPop(goalTh);

  if (goalPop && !e.target.closest(".goalpop")) closeGoalPop();
  if (weekPop && !e.target.closest(".weekpop") && !e.target.closest("#weekLabel")) {
    closeWeekList();
  }

  const intBtn = e.target.closest(".int button[data-int]");
  if (intBtn) {
    if (S.week.locked) return toast("Closed week — press Unlock to edit");
    const host = intBtn.closest("[data-day]");
    const day = Number(host.dataset.day);
    const a = S.week.days[day].activity;
    const n = Number(intBtn.dataset.int);
    a.intensity = a.intensity === n ? null : n;
    document.querySelectorAll(`[data-day="${day}"] .int button`)
      .forEach((b) => b.classList.toggle("on", Number(b.dataset.int) === a.intensity));
    syncDayLabels(day);
    saveActivity(day);
  }
});

document.addEventListener("input", (e) => {
  const inp = e.target.closest("input[data-field]");
  if (!inp) return;
  const day = Number(inp.closest("[data-day]").dataset.day);
  const a = S.week.days[day].activity;
  a[inp.dataset.field] = inp.value;
  S.week.days[day].activity_done = !!(a.time || a.type);
  scheduleActivity(day);
});

document.addEventListener("blur", (e) => {
  const inp = e.target;
  if (!(inp instanceof HTMLInputElement)) return;
  if (inp.dataset.field === "time" && inp.value.trim()) {
    const norm = normalizeTime(inp.value);
    if (norm && norm !== inp.value) {
      inp.value = norm;
      const day = Number(inp.closest("[data-day]").dataset.day);
      S.week.days[day].activity.time = norm;
      saveActivity(day);
    }
  }
}, true);

document.addEventListener("change", (e) => {
  const id = e.target.id;
  if (!["weightStart", "weightEnd", "waistStart", "waistEnd"].includes(id)) return;
  const map = {
    weightStart: "weight_start",
    weightEnd: "weight_end",
    waistStart: "waist_start",
    waistEnd: "waist_end",
  };
  const field = map[id];
  const raw = e.target.value.trim();
  S.week[field] = raw === "" ? null : Number(raw);
  renderWeights();
  enqueue(async () => {
    const week = await api(`/api/week/${S.week.week_start}`, {
      method: "PATCH",
      body: JSON.stringify({ [field]: raw === "" ? null : raw }),
    });
    S.week = week;
    renderWeights();
    renderHeader();
    flashSaved();
  });
});

function goPrevWeek() {
  load(shiftDate(S.week.week_start, -7));
}

function goNextWeek() {
  const next = shiftDate(S.week.week_start, 7);
  if (next > S.current) return toast("Future weeks aren't open yet");
  load(next);
}

$("#prevWeek").addEventListener("click", goPrevWeek);
$("#nextWeek").addEventListener("click", goNextWeek);
$("#todayBtn").addEventListener("click", () => load("current"));

$("#unlockBtn").addEventListener("click", () => {
  enqueue(async () => {
    S.week = await api(`/api/week/${S.week.week_start}/unlock`, {
      method: "POST",
      body: JSON.stringify({ unlocked: true }),
    });
    render();
    toast("Week unlocked for editing");
  });
});

$("#lockBtn").addEventListener("click", () => {
  if (!confirm("Lock this week? You can unlock it again.")) return;
  enqueue(async () => {
    S.week = await api(`/api/week/${S.week.week_start}/unlock`, {
      method: "POST",
      body: JSON.stringify({ unlocked: false }),
    });
    render();
    toast("Week locked");
  });
});

/* week picker */
let weekPop = null;

async function openWeekList() {
  closeWeekList();
  const data = await api("/api/weeks");
  const pop = document.createElement("div");
  pop.className = "weekpop";
  for (const w of data.weeks) {
    const b = document.createElement("button");
    b.type = "button";
    if (w.week_start === S.week.week_start) b.classList.add("on");
    b.innerHTML = `<span>${esc(w.label)}</span>
      <span class="tag ${w.is_current ? "live" : ""}">${
        w.is_current ? "current" : w.locked ? "closed" : "open"}</span>`;
    b.onclick = () => {
      closeWeekList();
      load(w.week_start);
    };
    pop.appendChild(b);
  }
  document.body.appendChild(pop);
  const r = $("#weekLabel").getBoundingClientRect();
  pop.style.left = `${Math.max(10, Math.min(r.left, window.innerWidth - pop.offsetWidth - 10))}px`;
  pop.style.top = `${Math.min(r.bottom + 8, window.innerHeight - pop.offsetHeight - 10)}px`;
  weekPop = pop;
}

function closeWeekList() {
  if (weekPop) weekPop.remove();
  weekPop = null;
}

$("#weekLabel").addEventListener("click", openWeekList);

/* settings */
const dlg = $("#settingsDlg");

$("#settingsBtn").addEventListener("click", () => {
  const f = $("#settingsForm");
  f.name.value = S.settings.name || "";
  f.notify_enabled.checked = !!S.settings.notify_enabled;
  f.meal_times.value = (S.settings.meal_times || []).join(", ");
  f.evening_time.value = S.settings.evening_time || "";
  f.timezone.value = S.settings.timezone || "";
  f.telegram_bot_token.value = S.settings.telegram_bot_token || "";
  f.telegram_chat_id.value = S.settings.telegram_chat_id || "";
  f.webhook_url.value = S.settings.webhook_url || "";
  dlg.showModal();
});

$("#cancelSettings").addEventListener("click", () => dlg.close());

$("#settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const payload = {
    name: f.name.value.trim(),
    notify_enabled: f.notify_enabled.checked,
    meal_times: f.meal_times.value,
    evening_time: f.evening_time.value.trim(),
    timezone: f.timezone.value.trim(),
    telegram_bot_token: f.telegram_bot_token.value.trim(),
    telegram_chat_id: f.telegram_chat_id.value.trim(),
    webhook_url: f.webhook_url.value.trim(),
  };
  try {
    S.settings = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    dlg.close();
    renderHeader();
    toast("Settings saved");
  } catch (err) {
    toast(err.message);
  }
});

$("#testPush").addEventListener("click", async () => {
  try {
    await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        notify_enabled: $("#settingsForm").notify_enabled.checked,
        telegram_bot_token: $("#settingsForm").telegram_bot_token.value.trim(),
        telegram_chat_id: $("#settingsForm").telegram_chat_id.value.trim(),
        webhook_url: $("#settingsForm").webhook_url.value.trim(),
      }),
    });
    const res = await api("/api/notify/test", { method: "POST" });
    toast(res.ok ? `Test sent via ${res.detail}` : `Failed: ${res.detail}`);
  } catch (err) {
    toast(err.message);
  }
});

/* ------------------------------------------------------------------ utils */

function shiftDate(isoDate, days) {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function mondayOf(isoDate) {
  const d = new Date(isoDate + "T00:00:00Z");
  return shiftDate(isoDate, -((d.getUTCDay() + 6) % 7));
}

let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

let savedTimer = null;
function flashSaved() {
  const s = $("#savedDot");
  s.textContent = "Saved";
  s.classList.add("on");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => s.classList.remove("on"), 1200);
}

window.addEventListener("resize", () => {
  closeGoalPop();
  closeWeekList();
  hideBar();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    hideBar();
    closeGoalPop();
    closeWeekList();
    hideBar();
    return;
  }
  if (/input|textarea/i.test(document.activeElement.tagName)) return;
  if (e.key === "ArrowLeft") goPrevWeek();
  if (e.key === "ArrowRight") goNextWeek();
});

boot().catch((err) => toast(err.message));
