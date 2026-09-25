/* The Endless Mini — game UI, input handling, and success/failure history. */

const HISTORY_KEY = "endlessMini.history.v1";
const CURRENT_KEY = "endlessMini.current.v1";
const SOUND_KEY = "endlessMini.sound.v1";

const el = (id) => document.getElementById(id);
const key = (r, c) => r * SIZE + c;

let puzzle = null;
let userGrid = [];
let cursor = { r: 0, c: 0 };
let dir = "across";
let entryMap = {};      // cell key -> { across, down }
let orderedEntries = [];
let revealedCells = new Set();
let wrongCells = new Set();
let usedHelp = false;
let finished = false;
let elapsedMs = 0;
let lastTick = 0;
let tickId = null;
let generating = false;
let paused = false;

/* Input is ignored whenever the board isn't actually playable. */
const boardLocked = () => finished || generating || paused;

/* ---------------- in-app confirm ---------------- */

function askConfirm(title, body, okLabel = "Yes") {
  return new Promise((resolve) => {
    const overlay = el("confirmOverlay");
    const ok = el("confirmOk");
    const cancel = el("confirmCancel");
    el("confirmTitle").textContent = title;
    el("confirmBody").textContent = body;
    ok.textContent = okLabel;
    overlay.hidden = false;
    ok.focus();

    const done = (value) => {
      overlay.hidden = true;
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); done(true); }
    };
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey, true);
  });
}

const confirmOpen = () => !el("confirmOverlay").hidden;

/* ---------------- storage ---------------- */

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveHistory(list) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(-300))); } catch {}
}

function saveCurrent() {
  if (!puzzle) return;
  const state = {
    puzzle,
    userGrid,
    revealed: [...revealedCells],
    usedHelp,
    finished,
    paused,
    elapsedMs,
    dir,
    cursor
  };
  try { localStorage.setItem(CURRENT_KEY, JSON.stringify(state)); } catch {}
}

function clearCurrent() {
  try { localStorage.removeItem(CURRENT_KEY); } catch {}
}

/* ---------------- timer ---------------- */

function formatTime(ms) {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function startTimer() {
  stopTimer();
  lastTick = Date.now();
  tickId = setInterval(() => {
    const now = Date.now();
    elapsedMs += now - lastTick;
    lastTick = now;
    el("timer").textContent = formatTime(elapsedMs);
  }, 250);
}

function stopTimer() {
  if (tickId) clearInterval(tickId);
  tickId = null;
}

/* ---------------- pause ---------------- */

function applyPauseUI() {
  document.body.classList.toggle("paused", paused);
  el("pausedVeil").hidden = !paused;
  el("pauseBtn").textContent = paused ? "Resume" : "Pause";
  el("pauseBtn").disabled = !puzzle || finished || generating;
}

function setPaused(on) {
  if (!puzzle || finished || generating) return;
  if (paused === on) return;
  paused = on;
  if (paused) stopTimer(); else startTimer();
  applyPauseUI();
  saveCurrent();
}

/* ---------------- victory sound ---------------- */

let soundOn = true;
try { soundOn = localStorage.getItem(SOUND_KEY) !== "off"; } catch {}
let audioCtx = null;

function setSound(on) {
  soundOn = on;
  el("soundBtn").textContent = on ? "🔊" : "🔇";
  el("soundBtn").setAttribute("aria-pressed", String(on));
  try { localStorage.setItem(SOUND_KEY, on ? "on" : "off"); } catch {}
}

// A short rising fanfare, synthesized so there's no audio file to ship.
function playVictory() {
  if (!soundOn) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = audioCtx || new Ctx();
    if (audioCtx.state === "suspended") audioCtx.resume();

    const master = audioCtx.createGain();
    master.gain.value = 0.18;
    master.connect(audioCtx.destination);

    const start = audioCtx.currentTime + 0.03;
    // C5, E5, G5, then C6 held with a fifth above it.
    const notes = [[523.25, 0, 0.26], [659.25, 0.11, 0.26], [783.99, 0.22, 0.3],
                   [1046.5, 0.34, 0.95], [1567.98, 0.34, 0.95]];

    for (const [freq, at, dur] of notes) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = freq > 1200 ? "sine" : "triangle";
      osc.frequency.setValueAtTime(freq, start + at);
      gain.gain.setValueAtTime(0.0001, start + at);
      gain.gain.exponentialRampToValueAtTime(freq > 1200 ? 0.35 : 1, start + at + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + at + dur);
      osc.connect(gain);
      gain.connect(master);
      osc.start(start + at);
      osc.stop(start + at + dur + 0.05);
    }
  } catch {}
}

/* ---------------- puzzle setup ---------------- */

function isBlack(r, c) {
  return r < 0 || c < 0 || r >= SIZE || c >= SIZE || puzzle.pattern[r][c] === "#";
}

function indexEntries() {
  entryMap = {};
  orderedEntries = [...puzzle.across, ...puzzle.down];
  for (const e of orderedEntries) {
    e.cells.forEach(([r, c]) => {
      const k = key(r, c);
      if (!entryMap[k]) entryMap[k] = {};
      entryMap[k][e.dir] = e;
    });
  }
}

async function newPuzzle(skipConfirm) {
  if (generating) return;
  if (!skipConfirm && puzzle && !finished && userGrid.some((row) => row.some((v) => v))) {
    const ok = await askConfirm(
      "Start a new puzzle?",
      "This grid goes into your history as unsolved.",
      "New puzzle"
    );
    if (!ok) return;
    recordResult("abandoned");
  }

  const wrap = document.querySelector(".grid-wrap");
  wrap.classList.add("loading");
  generating = true;
  paused = false;
  applyPauseUI();
  stopTimer();

  // Let the browser paint the loading state before the search runs.
  setTimeout(() => {
    let p = generatePuzzle();
    if (!p) p = generatePuzzle({ theme: false });
    wrap.classList.remove("loading");
    generating = false;
    if (!p) {
      el("clueBarText").textContent = "Couldn't build a grid — press New Puzzle to try again.";
      return;
    }
    installPuzzle(p);
  }, 20);
}

function installPuzzle(p, restored) {
  puzzle = p;
  indexEntries();

  if (!restored) {
    userGrid = Array.from({ length: SIZE }, () => Array(SIZE).fill(""));
    revealedCells = new Set();
    usedHelp = false;
    finished = false;
    paused = false;
    elapsedMs = 0;
  }
  wrongCells = new Set();

  el("nudge").hidden = true;
  el("timer").textContent = formatTime(elapsedMs);
  el("themeChip").textContent = puzzle.theme ? puzzle.theme : "Freestyle";
  el("puzzleId").textContent = "#" + puzzle.id;

  buildGrid();
  buildClueList();

  if (!restored) {
    const first = puzzle.across[0];
    dir = "across";
    cursor = { r: first.row, c: first.col };
  }

  refresh();
  applyPauseUI();
  if (!finished && !paused) startTimer();
  saveCurrent();
}

function buildGrid() {
  const grid = el("grid");
  grid.innerHTML = "";
  const numbers = {};
  for (const e of orderedEntries) numbers[key(e.row, e.col)] = e.number;

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const d = document.createElement("div");
      d.className = "cell" + (isBlack(r, c) ? " black" : "");
      d.dataset.r = r;
      d.dataset.c = c;
      if (!isBlack(r, c)) {
        const n = numbers[key(r, c)];
        if (n) {
          const span = document.createElement("span");
          span.className = "num";
          span.textContent = n;
          d.appendChild(span);
        }
        const letter = document.createElement("span");
        letter.className = "letter";
        d.appendChild(letter);
        d.addEventListener("click", () => onCellClick(r, c));
      }
      grid.appendChild(d);
    }
  }
}

function buildClueList() {
  const fill = (listEl, entries) => {
    listEl.innerHTML = "";
    for (const e of entries) {
      const li = document.createElement("li");
      li.dataset.dir = e.dir;
      li.dataset.num = e.number;
      li.innerHTML = `<span class="n">${e.number}</span><span class="t"></span>`;
      li.querySelector(".t").textContent = e.clue;
      li.addEventListener("click", () => {
        if (boardLocked()) return;
        dir = e.dir;
        const target = firstEmptyIn(e) || e.cells[0];
        cursor = { r: target[0], c: target[1] };
        refresh();
      });
      listEl.appendChild(li);
    }
  };
  fill(el("acrossList"), puzzle.across);
  fill(el("downList"), puzzle.down);
}

/* ---------------- helpers ---------------- */

function entryAt(r, c, d) {
  const m = entryMap[key(r, c)];
  if (!m) return null;
  return m[d] || m[d === "across" ? "down" : "across"] || null;
}

function currentEntry() {
  return entryAt(cursor.r, cursor.c, dir);
}

function firstEmptyIn(entry) {
  return entry.cells.find(([r, c]) => !userGrid[r][c]) || null;
}

function letterAt(entry, i) {
  const [r, c] = entry.cells[i];
  return userGrid[r][c];
}

function entryComplete(entry) {
  return entry.cells.every(([r, c]) => userGrid[r][c]);
}

function entryCorrect(entry) {
  return entry.cells.every(([r, c], i) => userGrid[r][c] === entry.answer[i]);
}

function gridFull() {
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++)
      if (!isBlack(r, c) && !userGrid[r][c]) return false;
  return true;
}

function gridCorrect() {
  return orderedEntries.every(entryCorrect);
}

/* ---------------- rendering ---------------- */

function refresh() {
  const entry = currentEntry();
  const inWord = new Set(entry ? entry.cells.map(([r, c]) => key(r, c)) : []);

  document.querySelectorAll(".cell").forEach((d) => {
    const r = +d.dataset.r, c = +d.dataset.c;
    if (isBlack(r, c)) return;
    const k = key(r, c);
    d.classList.toggle("in-word", inWord.has(k) && !(r === cursor.r && c === cursor.c));
    d.classList.toggle("active", r === cursor.r && c === cursor.c && !finished);
    d.classList.toggle("revealed", revealedCells.has(k));
    d.classList.toggle("wrong", wrongCells.has(k));
    d.classList.toggle("locked", finished && !revealedCells.has(k));
    d.querySelector(".letter").textContent = userGrid[r][c] || "";
  });

  if (entry) {
    el("clueBarNum").textContent = `${entry.number}${entry.dir === "across" ? "A" : "D"}`;
    el("clueBarText").textContent = entry.clue;
  }

  const crossEntry = entry ? entryAt(cursor.r, cursor.c, dir === "across" ? "down" : "across") : null;
  document.querySelectorAll(".clue-list li").forEach((li) => {
    const isActive = entry && li.dataset.dir === entry.dir && +li.dataset.num === entry.number;
    const isCross = crossEntry && li.dataset.dir === crossEntry.dir && +li.dataset.num === crossEntry.number;
    li.classList.toggle("active", !!isActive);
    li.classList.toggle("cross", !!isCross && !isActive);
    const e = orderedEntries.find((x) => x.dir === li.dataset.dir && x.number === +li.dataset.num);
    li.classList.toggle("done", e ? entryComplete(e) : false);
  });

  saveCurrent();
}

/* ---------------- input ---------------- */

function onCellClick(r, c) {
  if (boardLocked()) return;
  if (cursor.r === r && cursor.c === c) {
    flipDirection();
    return;
  }
  cursor = { r, c };
  const m = entryMap[key(r, c)];
  if (m && !m[dir]) dir = dir === "across" ? "down" : "across";
  refresh();
}

function flipDirection() {
  const other = dir === "across" ? "down" : "across";
  if (entryMap[key(cursor.r, cursor.c)][other]) dir = other;
  refresh();
}

function typeLetter(ch) {
  if (boardLocked()) return;
  const k = key(cursor.r, cursor.c);
  if (isBlack(cursor.r, cursor.c)) return;
  userGrid[cursor.r][cursor.c] = ch;
  wrongCells.delete(k);
  revealedCells.delete(k);
  advance();
  checkForWin();
  refresh();
}

function advance() {
  const entry = currentEntry();
  if (!entry) return;
  const idx = entry.cells.findIndex(([r, c]) => r === cursor.r && c === cursor.c);

  for (let i = idx + 1; i < entry.cells.length; i++) {
    if (!letterAt(entry, i)) { setCursorTo(entry.cells[i]); return; }
  }
  for (let i = 0; i < idx; i++) {
    if (!letterAt(entry, i)) { setCursorTo(entry.cells[i]); return; }
  }
  if (idx + 1 < entry.cells.length) { setCursorTo(entry.cells[idx + 1]); return; }
  jumpEntry(1, true);
}

function setCursorTo(cell) {
  cursor = { r: cell[0], c: cell[1] };
}

function backspace() {
  if (boardLocked()) return;
  const k = key(cursor.r, cursor.c);
  if (userGrid[cursor.r][cursor.c]) {
    userGrid[cursor.r][cursor.c] = "";
    wrongCells.delete(k);
    revealedCells.delete(k);
  } else {
    const entry = currentEntry();
    const idx = entry.cells.findIndex(([r, c]) => r === cursor.r && c === cursor.c);
    if (idx > 0) {
      setCursorTo(entry.cells[idx - 1]);
      const nk = key(cursor.r, cursor.c);
      userGrid[cursor.r][cursor.c] = "";
      wrongCells.delete(nk);
      revealedCells.delete(nk);
    }
  }
  refresh();
}

function jumpEntry(step, preferIncomplete) {
  const entry = currentEntry();
  if (!entry) return;
  let i = orderedEntries.indexOf(entry);
  for (let n = 1; n <= orderedEntries.length; n++) {
    const next = orderedEntries[(i + step * n + orderedEntries.length * n) % orderedEntries.length];
    if (preferIncomplete && entryComplete(next) && n < orderedEntries.length) continue;
    dir = next.dir;
    const target = firstEmptyIn(next) || next.cells[0];
    setCursorTo(target);
    return;
  }
}

function moveArrow(dr, dc) {
  const wanted = dr === 0 ? "across" : "down";
  if (dir !== wanted && entryMap[key(cursor.r, cursor.c)][wanted]) {
    dir = wanted;
    refresh();
    return;
  }
  let r = cursor.r + dr, c = cursor.c + dc;
  while (!isBlack(r, c)) {
    if (entryMap[key(r, c)]) { cursor = { r, c }; refresh(); return; }
    r += dr; c += dc;
  }
}

/* ---------------- check & reveal ---------------- */

function cellsFor(scope) {
  if (scope === "letter") return [[cursor.r, cursor.c]];
  if (scope === "word") return currentEntry().cells;
  const all = [];
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++)
      if (!isBlack(r, c)) all.push([r, c]);
  return all;
}

function answerAt(r, c) {
  const m = entryMap[key(r, c)];
  const e = m.across || m.down;
  const i = e.cells.findIndex(([rr, cc]) => rr === r && cc === c);
  return e.answer[i];
}

function doCheck(scope) {
  if (boardLocked()) return;
  usedHelp = true;
  for (const [r, c] of cellsFor(scope)) {
    const v = userGrid[r][c];
    if (v && v !== answerAt(r, c)) wrongCells.add(key(r, c));
    else wrongCells.delete(key(r, c));
  }
  refresh();
}

async function doReveal(scope) {
  if (boardLocked()) return;
  if (scope === "puzzle") {
    const sure = await askConfirm(
      "Reveal the whole puzzle?",
      "You'll see every answer, and this grid goes into your history as unsolved.",
      "Reveal it"
    );
    if (!sure || finished) return;
  }
  usedHelp = true;
  for (const [r, c] of cellsFor(scope)) {
    const correct = answerAt(r, c);
    if (userGrid[r][c] !== correct) {
      userGrid[r][c] = correct;
      revealedCells.add(key(r, c));
    }
    wrongCells.delete(key(r, c));
  }
  if (scope === "puzzle") {
    finish("revealed");
  } else {
    checkForWin();
  }
  refresh();
}

let nudgeTimer = null;

function nudge(message) {
  const box = el("nudge");
  box.textContent = message;
  box.hidden = false;
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => { box.hidden = true; }, 3500);
}

function checkForWin() {
  if (finished) return;
  if (!gridFull()) return;
  if (gridCorrect()) {
    el("nudge").hidden = true;
    finish(usedHelp ? "assisted" : "clean");
  } else {
    nudge("Every square is filled, but something's not right yet.");
  }
}

/* ---------------- finishing & history ---------------- */

function recordResult(result) {
  const list = loadHistory();
  list.push({
    id: puzzle.id,
    theme: puzzle.theme || "Freestyle",
    result,
    seconds: Math.round(elapsedMs / 1000),
    at: Date.now()
  });
  saveHistory(list);
  renderStats();
}

function finish(result) {
  finished = true;
  paused = false;
  stopTimer();
  applyPauseUI();
  recordResult(result);
  saveCurrent();
  showModal(result);
}

function statsFrom(list) {
  const solved = list.filter((g) => g.result === "clean" || g.result === "assisted");
  const clean = list.filter((g) => g.result === "clean");
  let streak = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].result === "clean" || list[i].result === "assisted") streak++;
    else break;
  }
  let best = 0, run = 0;
  for (const g of list) {
    if (g.result === "clean" || g.result === "assisted") { run++; best = Math.max(best, run); }
    else run = 0;
  }
  const times = solved.map((g) => g.seconds).filter((s) => s > 0);
  return {
    played: list.length,
    solved: solved.length,
    clean: clean.length,
    rate: list.length ? Math.round((solved.length / list.length) * 100) : 0,
    streak,
    best,
    bestTime: times.length ? Math.min(...times) : null,
    avgTime: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null
  };
}

function renderStats() {
  const list = loadHistory();
  const s = statsFrom(list);
  const fmt = (secs) => (secs == null ? "—" : formatTime(secs * 1000));

  el("statGrid").innerHTML = [
    ["Played", s.played],
    ["Solved", s.solved],
    ["Win rate", s.rate + "%"],
    ["No help", s.clean],
    ["Streak", s.streak],
    ["Best streak", s.best],
    ["Best time", fmt(s.bestTime)],
    ["Average", fmt(s.avgTime)]
  ].map(([k, v]) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`).join("");

  const marks = {
    clean: ["✅", "Solved with no help"],
    assisted: ["🟡", "Solved with help"],
    revealed: ["❌", "Revealed"],
    abandoned: ["⛔", "Abandoned"]
  };
  const items = list.slice(-25).reverse();
  el("historyList").innerHTML = items.length
    ? items.map((g) => {
        const [dot, label] = marks[g.result] || ["•", g.result];
        const when = new Date(g.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
        return `<li title="${label}">
            <span class="dot">${dot}</span>
            <span class="theme">${g.theme}</span>
            <span class="secs">${formatTime(g.seconds * 1000)}</span>
            <span class="when">${when}</span>
          </li>`;
      }).join("")
    : `<li class="empty"><span class="dot">·</span><span>No puzzles yet — solve one and it shows up here.</span></li>`;
}

/* ---------------- modal ---------------- */

function showModal(result) {
  const s = statsFrom(loadHistory());
  const titles = {
    clean: "Solved!",
    assisted: "Solved — with a little help",
    revealed: "Puzzle revealed"
  };
  const bodies = {
    clean: `Clean solve of the "${puzzle.theme || "Freestyle"}" mini.`,
    assisted: `You finished it, but Check or Reveal lent a hand.`,
    revealed: `That one goes down as unsolved. The next grid is brand new.`
  };
  el("modalTitle").textContent = titles[result] || "Done";
  el("modalBody").textContent = bodies[result] || "";
  el("modalStats").innerHTML = `
    <div><b>${formatTime(elapsedMs)}</b>Time</div>
    <div><b>${s.streak}</b>Streak</div>
    <div><b>${s.rate}%</b>Win rate</div>`;
  el("overlay").hidden = false;
  if (result === "clean" || result === "assisted") {
    confetti();
    playVictory();
  }
}

function confetti() {
  const colors = ["#2f6df6", "#ffb703", "#fb5607", "#38b000", "#e63946", "#8338ec", "#00b4d8"];
  const shapes = ["", "round", "strip"];
  const pieces = 140;

  for (let i = 0; i < pieces; i++) {
    const d = document.createElement("div");
    d.className = "confetti " + shapes[i % shapes.length];
    const w = 6 + Math.random() * 7;
    d.style.left = Math.random() * 100 + "vw";
    d.style.width = w + "px";
    d.style.height = (i % 3 === 1 ? w : w * (1.2 + Math.random())) + "px";
    d.style.background = colors[i % colors.length];
    d.style.setProperty("--drift", (Math.random() * 260 - 130).toFixed(0) + "px");
    d.style.setProperty("--spin", (Math.random() * 1080 - 360).toFixed(0) + "deg");
    d.style.animationDuration = (2.4 + Math.random() * 2.2).toFixed(2) + "s";
    d.style.animationDelay = (Math.random() * 1.1).toFixed(2) + "s";
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 6200);
  }
}

/* ---------------- wiring ---------------- */

function buildKeyboard() {
  const rows = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];
  const kb = el("keyboard");
  kb.innerHTML = "";
  rows.forEach((row, i) => {
    const div = document.createElement("div");
    div.className = "kb-row";
    if (i === 2) div.appendChild(makeKey("⌫", "del", true));
    [...row].forEach((ch) => div.appendChild(makeKey(ch, ch)));
    if (i === 2) div.appendChild(makeKey("↹", "next", true));
    kb.appendChild(div);
  });
}

function makeKey(label, value, wide) {
  const b = document.createElement("button");
  b.className = "key" + (wide ? " wide" : "");
  b.textContent = label;
  b.addEventListener("click", (ev) => {
    ev.preventDefault();
    if (boardLocked()) return;
    if (value === "del") backspace();
    else if (value === "next") { jumpEntry(1, true); refresh(); }
    else typeLetter(value);
  });
  return b;
}

function toggleMenu(menu, others) {
  menu.hidden = !menu.hidden;
  others.forEach((m) => { m.hidden = true; });
}

function wire() {
  const checkMenu = el("checkMenu");
  const revealMenu = el("revealMenu");

  el("newBtn").addEventListener("click", (e) => { e.currentTarget.blur(); newPuzzle(false); });
  el("pauseBtn").addEventListener("click", (e) => { e.currentTarget.blur(); setPaused(!paused); });
  el("resumeBtn").addEventListener("click", (e) => { e.currentTarget.blur(); setPaused(false); });
  el("soundBtn").addEventListener("click", (e) => { e.currentTarget.blur(); setSound(!soundOn); });
  el("clearBtn").addEventListener("click", (e) => {
    e.currentTarget.blur();
    if (boardLocked()) return;
    userGrid = Array.from({ length: SIZE }, () => Array(SIZE).fill(""));
    revealedCells.clear();
    wrongCells.clear();
    refresh();
  });

  el("checkBtn").addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(checkMenu, [revealMenu]); });
  el("revealBtn").addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(revealMenu, [checkMenu]); });
  checkMenu.addEventListener("click", (e) => {
    if (e.target.dataset.check) { doCheck(e.target.dataset.check); checkMenu.hidden = true; }
  });
  revealMenu.addEventListener("click", (e) => {
    if (e.target.dataset.reveal) { doReveal(e.target.dataset.reveal); revealMenu.hidden = true; }
  });
  document.addEventListener("click", () => { checkMenu.hidden = true; revealMenu.hidden = true; });

  el("prevClue").addEventListener("click", () => { if (boardLocked()) return; jumpEntry(-1, false); refresh(); });
  el("nextClue").addEventListener("click", () => { if (boardLocked()) return; jumpEntry(1, false); refresh(); });

  el("resetStats").addEventListener("click", async (e) => {
    e.currentTarget.blur();
    const ok = await askConfirm(
      "Erase your history?",
      "Every recorded solve, streak and time will be cleared. This can't be undone.",
      "Erase it"
    );
    if (ok) {
      saveHistory([]);
      renderStats();
    }
  });

  el("modalNew").addEventListener("click", () => { el("overlay").hidden = true; newPuzzle(true); });
  el("modalClose").addEventListener("click", () => { el("overlay").hidden = true; });

  document.addEventListener("keydown", (e) => {
    if (!puzzle || generating || confirmOpen()) return;
    if (!el("overlay").hidden) {
      if (e.key === "Escape") el("overlay").hidden = true;
      if (e.key === "Enter") { el("overlay").hidden = true; newPuzzle(true); }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (paused) {
      if (e.key === "Enter" || e.key === "Escape" || e.key === " ") {
        e.preventDefault();
        setPaused(false);
      }
      return;
    }
    if (finished) return;

    if (/^[a-zA-Z]$/.test(e.key)) { e.preventDefault(); typeLetter(e.key.toUpperCase()); return; }
    switch (e.key) {
      case "Backspace": case "Delete": e.preventDefault(); backspace(); break;
      case "ArrowLeft": e.preventDefault(); moveArrow(0, -1); break;
      case "ArrowRight": e.preventDefault(); moveArrow(0, 1); break;
      case "ArrowUp": e.preventDefault(); moveArrow(-1, 0); break;
      case "ArrowDown": e.preventDefault(); moveArrow(1, 0); break;
      case " ": e.preventDefault(); flipDirection(); break;
      // Enter walks to the next row (or column, going down), wrapping from the
      // last row round to the first column and vice versa.
      case "Enter":
      case "Tab": e.preventDefault(); jumpEntry(e.shiftKey ? -1 : 1, false); refresh(); break;
    }
  });

  window.addEventListener("beforeunload", saveCurrent);
}

function restore() {
  try {
    const raw = localStorage.getItem(CURRENT_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw);
    if (!s || !s.puzzle) return false;
    userGrid = s.userGrid;
    revealedCells = new Set(s.revealed || []);
    usedHelp = !!s.usedHelp;
    finished = !!s.finished;
    paused = !!s.paused && !finished;
    elapsedMs = s.elapsedMs || 0;
    dir = s.dir || "across";
    cursor = s.cursor || { r: 0, c: 0 };
    installPuzzle(s.puzzle, true);
    return true;
  } catch { return false; }
}

function boot() {
  buildKeyboard();
  wire();
  setSound(soundOn);
  renderStats();
  if (!restore()) newPuzzle(true);
}

boot();
