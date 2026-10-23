/* Transform Tracker — front-end */

const S = {
  week: null,
  current: null,
  today: null,
  settings: {},
};

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

/* ------------------------------------------------------------------ api */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  let data = null;
  const type = res.headers.get("content-type") || "";
  if (type.includes("json")) data = await res.json();
  if (!res.ok) {
    throw new Error((data && data.detail) || `HTTP ${res.status}`);
  }
  return data;
}

let QUEUE = Promise.resolve();
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
  render();
  if (!opts.quiet) closeGoalPop();
}

/* ------------------------------------------------------------------ render */

function render() {
  renderHeader();
  renderNav();
  renderGrid();
  renderActivityCards();
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
  if (a.getMonth() === b.getMonth()) {
    return `${m(a)} ${a.getDate()} – ${b.getDate()}`;
  }
  return `${m(a)} ${a.getDate()} – ${m(b)} ${b.getDate()}`;
}

function renderNav() {
  $("#weekLabel").textContent = S.week.label;
  const state = $("#weekState");
  if (S.week.is_current) {
    state.textContent = "Current week";
  } else if (S.week.locked) {
    state.textContent = "Closed · read only";
  } else {
    state.textContent = "Unlocked · editable";
  }
  $("#nextWeek").disabled = true; // the future is not open
  $("#todayBtn").hidden = S.week.is_current;
}

function tallyHTML(n) {
  if (n <= 0 || n > 10) return "";
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

function renderGrid() {
  const cols = S.week.columns;
  const goals = S.week.goals;

  const gr = $("#goalRow");
  gr.innerHTML =
    `<th class="daycol" aria-hidden="true"></th>` +
    cols
      .map(
        (c) =>
          `<th class="goal" data-col="${c.key}" style="--tint:${c.color}"
               title="Daily goal for ${esc(c.label)} — tap to change">
             <span class="g">${goals[c.key]}</span>
           </th>`
      )
      .join("") +
    `<th class="actcol" aria-hidden="true"></th>`;

  const cr = $("#colRow");
  cr.innerHTML =
    `<th class="daycol" aria-hidden="true"></th>` +
    cols
      .map(
        (c) =>
          `<th class="lbl" style="--tint:${c.color}">
             <span class="long">${esc(c.label)}</span>
             <span class="short">${esc(c.short)}</span>
           </th>`
      )
      .join("") +
    `<th class="lbl actcol" style="--tint:#f7f3e9">Activity</th>`;

  const body = $("#daysBody");
  body.innerHTML = "";
  for (const d of S.week.days) {
    const tr = el("tr", d.is_today ? "todayrow" : "");
    const day = el("td", "daycol");
    day.innerHTML = `${d.label}<span class="dom">${d.dom}</span>`;
    tr.appendChild(day);

    for (const c of cols) {
      const count = d.cells[c.key];
      const over = d.over[c.key];
      const td = el("td", "cell" + (over ? " over" : ""));
      td.dataset.day = d.day;
      td.dataset.col = c.key;
      td.style.setProperty("--tint", c.color);
      td.setAttribute("role", "button");
      td.setAttribute(
        "aria-label",
        `${d.label} ${c.label}: ${count}${count ? " tally" : " tallies"}, goal ${goals[c.key]}`
      );
      td.innerHTML =
        `<span class="n">${count || ""}</span>` + tallyHTML(count);
      tr.appendChild(td);
    }

    const act = el("td", "actcol");
    act.appendChild(activityNode(d, "desk"));
    tr.appendChild(act);
    body.appendChild(tr);
  }

  const foot = $("#totalsFoot");
  foot.innerHTML =
    `<tr><td class="daycol">Σ</td>` +
    cols.map((c) => `<td>${S.week.col_totals[c.key] || ""}</td>`).join("") +
    `<td class="actcol"></td></tr>`;
}

function activityNode(d, variant) {
  const a = d.activity;
  const wrap = el("div", variant === "desk" ? "act-in" : "actcard" + (d.activity_done ? " done" : ""));
  wrap.dataset.day = d.day;

  if (variant === "mob") {
    wrap.innerHTML = `<div class="ah"><span>${d.label} ${d.dom}</span>
      <span class="ai">${a.intensity ? "intensity " + a.intensity : ""}</span></div>`;
  }

  const row1 = el("div", variant === "desk" ? "row1" : "a1");
  row1.innerHTML = `
    <input class="t" data-field="time" inputmode="numeric" enterkeyhint="done"
           maxlength="5" placeholder="00:45" value="${esc(a.time)}" aria-label="Time HH:MM">
    <input class="k" data-field="type" maxlength="120" placeholder="walk"
           value="${esc(a.type)}" aria-label="Activity type">`;

  const int = el("div", "int");
  let btns = "";
  for (let i = 1; i <= 10; i++) {
    btns += `<button type="button" data-int="${i}" class="${a.intensity === i ? "on" : ""}"
              aria-label="Intensity ${i}">${i}</button>`;
  }
  int.innerHTML = btns;

  wrap.appendChild(row1);
  wrap.appendChild(int);
  if (S.week.locked) {
    wrap.querySelectorAll("input, button").forEach((n) => (n.disabled = true));
  }
  return wrap;
}

function renderActivityCards() {
  const host = $("#activityCards");
  host.innerHTML = "";
  for (const d of S.week.days) host.appendChild(activityNode(d, "mob"));
}

function renderWeights() {
  const w = S.week;
  const set = (id, v) => {
    const input = $(id);
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
  $("#unlockBtn").textContent = "Unlock";
  $("#lockBtn").hidden = S.week.is_current || S.week.locked;
}

/* ------------------------------------------------------------------ tallies */

/* Gestures on a cell:
   tap            -> +1 (immediate, so fast tally entry stays fast)
   double tap     -> -1 net (a deliberate 200-340ms beat right after an idle cell)
   long press     -> -1
   Jamming taps faster than 200ms apart is never read as a double tap. */

const TAPS = new Map();
let longPress = null;

function cancelLongPress() {
  clearTimeout(longPress);
  longPress = null;
}

function onCellDown(e, cell) {
  if (S.week.locked) {
    toast("Closed week — press Unlock to edit");
    return;
  }
  e.preventDefault();
  const day = Number(cell.dataset.day);
  const col = cell.dataset.col;
  const key = `${day}:${col}`;
  const now = performance.now();
  const rec = TAPS.get(key) || { armed: 0, changed: 0 };
  const gap = now - rec.armed;

  if (rec.armed && gap >= 200 && gap <= 380) {
    TAPS.set(key, { armed: 0, changed: now });
    cancelLongPress();
    bump(day, col, -2); // the first tap already added one
    return;
  }

  const rested = now - rec.changed > 600;
  TAPS.set(key, { armed: rested ? now : 0, changed: now });
  bump(day, col, 1);

  cancelLongPress();
  const pressedKey = key;
  longPress = setTimeout(() => {
    TAPS.set(pressedKey, { armed: 0, changed: performance.now() });
    bump(day, col, -2);
  }, 700);
}

let undoTimer = null;

function showUndo(day, col) {
  const td = document.querySelector(
    `td.cell[data-day="${day}"][data-col="${col}"]`
  );
  if (!td || S.week.locked) return;
  const r = td.getBoundingClientRect();
  const card = $(".gridcard").getBoundingClientRect();
  const b = $("#undoBadge");
  b.dataset.day = day;
  b.dataset.col = col;
  b.style.left = `${r.right - card.left - 13}px`;
  b.style.top = `${r.top - card.top - 20}px`;
  b.hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => (b.hidden = true), 2400);
}

function bump(day, col, delta) {
  const d = S.week.days[day];
  const before = d.cells[col];
  const next = Math.max(0, Math.min(999, before + delta));
  d.cells[col] = next;
  d.over[col] = next > S.week.goals[col];
  paintCell(day, col, true);
  if (delta > 0) showUndo(day, col);
  paintTotals();

  enqueue(async () => {
    const res = await api(`/api/week/${S.week.week_start}/cell`, {
      method: "POST",
      body: JSON.stringify({ day, col, delta }),
    });
    d.cells[col] = res.count;
    d.over[col] = res.over;
    paintCell(day, col, false);
    paintTotals();
    flashSaved();
  });
}

function paintCell(day, col, animate) {
  const td = document.querySelector(
    `td.cell[data-day="${day}"][data-col="${col}"]`
  );
  if (!td) return;
  const count = S.week.days[day].cells[col];
  const over = S.week.days[day].over[col];
  td.classList.toggle("over", over);
  td.querySelector(".n").textContent = count || "";
  const tally = td.querySelector(".tally");
  if (tally) tally.remove();
  td.insertAdjacentHTML("beforeend", tallyHTML(count));
  td.setAttribute(
    "aria-label",
    `${S.week.days[day].label} ${col}: ${count} tallies, goal ${S.week.goals[col]}`
  );
  if (animate) {
    td.classList.remove("pop");
    void td.offsetWidth;
    td.classList.add("pop");
  }
}

function paintTotals() {
  const cells = document.querySelectorAll("#totalsFoot td");
  const cols = S.week.columns;
  cols.forEach((c, i) => {
    let sum = 0;
    for (const d of S.week.days) sum += d.cells[c.key];
    S.week.col_totals[c.key] = sum;
    if (cells[i + 1]) cells[i + 1].textContent = sum || "";
  });
}

/* ------------------------------------------------------------------ activity */

const ACT_TIMERS = new Map();

function scheduleActivity(day, delay = 450) {
  clearTimeout(ACT_TIMERS.get(day));
  ACT_TIMERS.set(
    day,
    setTimeout(() => saveActivity(day), delay)
  );
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
    S.week.days[day].activity_done = !!(res.time || res.type);
    document
      .querySelectorAll(`[data-day="${day}"].act-in, .actcard[data-day="${day}"]`)
      .forEach((n) => n.classList.toggle("done", S.week.days[day].activity_done));
    syncDayLabels(day);
    flashSaved();
  });
}

function syncDayLabels(day) {
  const label = document.querySelector(
    `.actcard[data-day="${day}"] .ai`
  );
  if (label) {
    const i = S.week.days[day].activity.intensity;
    label.textContent = i ? `intensity ${i}` : "";
  }
}

function normalizeTime(raw) {
  let v = String(raw || "").trim().replace(/[^0-9:]/g, "");
  if (!v) return "";
  if (v.includes(":")) {
    const [h, m] = v.split(":");
    return `${String(Math.min(23, Number(h) || 0)).padStart(2, "0")}:${String(
      Math.min(59, Number(m) || 0)
    ).padStart(2, "0")}`;
  }
  if (v.length <= 2) v = v.padStart(2, "0"); // "45" -> 45 minutes
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
  if (S.week.locked) {
    toast("Closed week — press Unlock to edit");
    return;
  }
  const col = th.dataset.col;
  const pop = el("div", "goalpop");
  for (let i = 1; i <= 9; i++) {
    const b = el("button", S.week.goals[col] === i ? "on" : "", String(i));
    b.type = "button";
    b.onclick = () => {
      closeGoalPop();
      const goals = { ...S.week.goals, [col]: i };
      S.week.goals = goals;
      paintGoals();
      enqueue(async () => {
        await api(`/api/week/${S.week.week_start}`, {
          method: "PATCH",
          body: JSON.stringify({ goals: { [col]: i } }),
        });
        flashSaved();
      });
    };
    pop.appendChild(b);
  }
  document.body.appendChild(pop);
  const r = th.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const left = Math.min(
    Math.max(8, r.left + r.width / 2 - pw / 2),
    window.innerWidth - pw - 8
  );
  pop.style.left = `${left}px`;
  pop.style.top = `${Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 8)}px`;
  goalPop = pop;
}

function closeGoalPop() {
  if (goalPop) goalPop.remove();
  goalPop = null;
}

function paintGoals() {
  document.querySelectorAll("#goalRow th.goal").forEach((th) => {
    th.querySelector(".g").textContent = S.week.goals[th.dataset.col];
  });
  document.querySelectorAll("td.cell").forEach((td) => {
    const day = Number(td.dataset.day);
    const col = td.dataset.col;
    const over = S.week.days[day].cells[col] > S.week.goals[col];
    S.week.days[day].over[col] = over;
    td.classList.toggle("over", over);
  });
}

/* ------------------------------------------------------------------ events */

document.addEventListener("pointerup", cancelLongPress);
document.addEventListener("pointercancel", cancelLongPress);

document.addEventListener("pointerdown", (e) => {
  const cell = e.target.closest("td.cell");
  if (cell) onCellDown(e, cell);
});

document.addEventListener("click", (e) => {
  const goalTh = e.target.closest("#goalRow th.goal");
  if (goalTh) {
    openGoalPop(goalTh);
    return;
  }
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
    document
      .querySelectorAll(`[data-day="${day}"] .int button`)
      .forEach((b) => b.classList.toggle("on", Number(b.dataset.int) === a.intensity));
    syncDayLabels(day);
    saveActivity(day);
  }
});

document.addEventListener("input", (e) => {
  const inp = e.target.closest("input[data-field]");
  if (!inp) return;
  const host = inp.closest("[data-day]");
  const day = Number(host.dataset.day);
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

$("#undoBadge").addEventListener("click", (e) => {
  const b = e.currentTarget;
  b.hidden = true;
  bump(Number(b.dataset.day), b.dataset.col, -1);
});

$("#prevWeek").addEventListener("click", () => {
  load(shiftDate(S.week.week_start, -7));
});
$("#nextWeek").addEventListener("click", () => toast("Future weeks aren't open yet"));
$("#todayBtn").addEventListener("click", () => load("current"));

$("#unlockBtn").addEventListener("click", () => {
  enqueue(async () => {
    const week = await api(`/api/week/${S.week.week_start}/unlock`, {
      method: "POST",
      body: JSON.stringify({ unlocked: true }),
    });
    S.week = week;
    render();
    toast("Week unlocked for editing");
  });
});

$("#lockBtn").addEventListener("click", () => {
  if (!confirm("Lock this week? You can unlock it again.")) return;
  enqueue(async () => {
    const week = await api(`/api/week/${S.week.week_start}/unlock`, {
      method: "POST",
      body: JSON.stringify({ unlocked: false }),
    });
    S.week = week;
    render();
    toast("Week locked");
  });
});

/* week picker */
let weekPop = null;

async function openWeekList() {
  closeWeekList();
  const data = await api("/api/weeks");
  const pop = el("div", "weekpop");
  for (const w of data.weeks) {
    const b = el("button", w.week_start === S.week.week_start ? "on" : "");
    b.type = "button";
    b.innerHTML = `<span>${esc(w.label)}</span>
      <span class="tag ${w.is_current ? "live" : ""}">${
        w.is_current ? "current" : w.locked ? "closed" : "open"
      }</span>`;
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
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeGoalPop();
    closeWeekList();
  }
  if (e.key === "ArrowLeft" && !/input|textarea/i.test(document.activeElement.tagName)) {
    load(shiftDate(S.week.week_start, -7));
  }
});

boot().catch((err) => toast(err.message));
