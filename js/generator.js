/* Mini crossword generator.
   Fills a 5x5 grid by backtracking search over the word bank, so every entry
   (across and down) is a real word that has a hand-written clue. */

const SIZE = 5;

// '#' = black square. Every run of open squares is 3+ letters long.
// These six shapes were kept because the word bank can actually fill them;
// grids demanding three crossing 5-letter entries almost never solve.
const PATTERNS = [
  ["##...",
   "#....",
   ".....",
   "....#",
   "...##"],

  ["...##",
   "....#",
   ".....",
   "#....",
   "##..."],

  ["##...",
   "#....",
   ".....",
   ".....",
   "....."],

  ["##...",
   ".....",
   ".....",
   ".....",
   "...##"],

  [".....",
   ".....",
   ".....",
   "....#",
   "...##"],

  [".....",
   ".....",
   ".....",
   "#....",
   "##..."],

  // These four need three interlocking 5-letter entries. They were impossible
  // with the original word bank and became viable once it grew.
  ["....#",
   ".....",
   ".....",
   ".....",
   "#...."],

  ["#....",
   ".....",
   ".....",
   ".....",
   "....#"],

  ["...##",
   "....#",
   ".....",
   ".....",
   "....."],

  ["...##",
   ".....",
   ".....",
   ".....",
   "##..."]
];

// Weighted by how readily each one fills, so a new puzzle arrives quickly.
const PATTERN_WEIGHTS = [6, 6, 8, 8, 5, 4, 4, 5, 5, 6];

const BANK = (() => {
  const byLen = { 3: [], 4: [], 5: [] };
  const clues = new Map();
  const add = (list, len) => {
    for (const [w, c] of list) {
      if (w.length !== len || clues.has(w)) continue;
      clues.set(w, c);
      byLen[len].push(w);
    }
  };
  add(WORDS3, 3);
  add(WORDS4, 4);
  add(WORDS5, 5);

  // index[len][position][letter] -> words with that letter in that spot.
  const index = {};
  for (const len of [3, 4, 5]) {
    index[len] = [];
    for (let i = 0; i < len; i++) index[len].push(new Map());
    for (const w of byLen[len]) {
      for (let i = 0; i < len; i++) {
        const m = index[len][i];
        if (!m.has(w[i])) m.set(w[i], []);
        m.get(w[i]).push(w);
      }
    }
  }
  return { byLen, clues, index };
})();

/* ---- memory of recent puzzles ------------------------------------------
   The fill always returns the FIRST solution it finds, which biases it toward
   the same well-connected corner of the word bank. Remembering what came up
   lately and trying those words last pushes the search somewhere new. */

const RECENT_KEY = "endlessMini.recent.v1";
const RECENT_WORDS_MAX = 550;    // roughly the last 55 puzzles' answers
const RECENT_PUZZLES_MAX = 700;  // exact grids to refuse to serve again

const recent = { words: [], wordSet: new Set(), puzzles: [] };

(function loadRecent() {
  try {
    if (typeof localStorage === "undefined") return;
    const saved = JSON.parse(localStorage.getItem(RECENT_KEY) || "{}");
    recent.words = Array.isArray(saved.words) ? saved.words : [];
    recent.puzzles = Array.isArray(saved.puzzles) ? saved.puzzles : [];
    recent.wordSet = new Set(recent.words);
  } catch {}
})();

function rememberPuzzle(answers, signature) {
  recent.words.push(...answers);
  while (recent.words.length > RECENT_WORDS_MAX) recent.words.shift();
  recent.wordSet = new Set(recent.words);

  recent.puzzles.push(signature);
  while (recent.puzzles.length > RECENT_PUZZLES_MAX) recent.puzzles.shift();

  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(RECENT_KEY, JSON.stringify({ words: recent.words, puzzles: recent.puzzles }));
  } catch {}
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function weightedPatternIndex() {
  const total = PATTERN_WEIGHTS.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < PATTERN_WEIGHTS.length; i++) {
    r -= PATTERN_WEIGHTS[i];
    if (r <= 0) return i;
  }
  return 0;
}

/* ---- slot extraction ---------------------------------------------------- */

function buildSlots(pattern) {
  const black = (r, c) => pattern[r][c] === "#";
  const slots = [];

  const addRun = (cells, dir) => {
    if (cells.length >= 3) slots.push({ dir, cells, len: cells.length, word: null });
  };

  for (let r = 0; r < SIZE; r++) {
    let run = [];
    for (let c = 0; c < SIZE; c++) {
      if (black(r, c)) { addRun(run, "across"); run = []; }
      else run.push([r, c]);
    }
    addRun(run, "across");
  }
  for (let c = 0; c < SIZE; c++) {
    let run = [];
    for (let r = 0; r < SIZE; r++) {
      if (black(r, c)) { addRun(run, "down"); run = []; }
      else run.push([r, c]);
    }
    addRun(run, "down");
  }

  slots.forEach((s, i) => { s.id = i; });

  // For each slot, which other slots cross it and at which letter positions.
  const cellOwners = new Map();
  slots.forEach((s) => {
    s.cells.forEach(([r, c], i) => {
      const key = r * SIZE + c;
      if (!cellOwners.has(key)) cellOwners.set(key, []);
      cellOwners.get(key).push({ slot: s, index: i });
    });
  });

  slots.forEach((s) => { s.crosses = []; });
  for (const owners of cellOwners.values()) {
    if (owners.length !== 2) continue;
    const [a, b] = owners;
    a.slot.crosses.push({ myIndex: a.index, other: b.slot.id, otherIndex: b.index });
    b.slot.crosses.push({ myIndex: b.index, other: a.slot.id, otherIndex: a.index });
  }

  return slots;
}

/* ---- the fill ----------------------------------------------------------- */

// Words that fit a slot given the letters its crossings have already locked in.
// Starts from the smallest index bucket instead of scanning the whole bank.
function candidatesFor(slot, slots, used, stopAtOne) {
  const constraints = [];
  for (const x of slot.crosses) {
    const w = slots[x.other].word;
    if (w) constraints.push([x.myIndex, w[x.otherIndex]]);
  }

  let pool = BANK.byLen[slot.len];
  if (constraints.length) {
    for (const [i, ch] of constraints) {
      const bucket = BANK.index[slot.len][i].get(ch);
      if (!bucket) return [];
      if (bucket.length < pool.length) pool = bucket;
    }
  }

  const out = [];
  outer:
  for (const w of pool) {
    if (used.has(w)) continue;
    for (const [i, ch] of constraints) {
      if (w[i] !== ch) continue outer;
    }
    out.push(w);
    if (stopAtOne) return out;
  }
  return out;
}

function fill(slots, used, budget) {
  const open = slots.filter((s) => !s.word);
  if (open.length === 0) return true;

  // Most-constrained slot first, breaking ties at random so the search doesn't
  // walk the grid in the same order every time.
  let best = null, bestCands = null;
  for (const s of open) {
    const cands = candidatesFor(s, slots, used);
    if (cands.length === 0) return false;
    const better = !bestCands || cands.length < bestCands.length ||
      (cands.length === bestCands.length && Math.random() < 0.5);
    if (better) {
      best = s; bestCands = cands;
      if (cands.length === 1) break;
    }
  }

  // Words that haven't shown up lately go first; recent ones stay available as
  // a fallback so a grid can still be filled when the fresh options run out.
  const fresh = [], stale = [];
  for (const w of bestCands) (recent.wordSet.has(w) ? stale : fresh).push(w);
  shuffle(fresh);
  shuffle(stale);
  const tries = fresh.concat(stale).slice(0, 80);
  for (const word of tries) {
    if (budget.nodes-- < 0) return false;
    best.word = word;
    used.add(word);

    // Forward check: every crossing slot must still have an option.
    let viable = true;
    for (const x of best.crosses) {
      const other = slots[x.other];
      if (other.word) continue;
      if (candidatesFor(other, slots, used, true).length === 0) { viable = false; break; }
    }

    if (viable && fill(slots, used, budget)) return true;

    best.word = null;
    used.delete(word);
  }
  return false;
}

/* ---- numbering + assembly ----------------------------------------------- */

function numberGrid(pattern, slots) {
  const black = (r, c) => r < 0 || c < 0 || r >= SIZE || c >= SIZE || pattern[r][c] === "#";
  const numbers = {};
  let n = 1;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (black(r, c)) continue;
      const startsAcross = black(r, c - 1) && !black(r, c + 1);
      const startsDown = black(r - 1, c) && !black(r + 1, c);
      if (startsAcross || startsDown) numbers[r * SIZE + c] = n++;
    }
  }
  slots.forEach((s) => {
    const [r, c] = s.cells[0];
    s.number = numbers[r * SIZE + c];
  });
  return numbers;
}

function themeWordsAvailable(words) {
  return words.filter((w) => BANK.clues.has(w));
}

function attemptFill(pattern, seedWords) {
  const slots = buildSlots(pattern);
  const used = new Set();

  // Try to plant a theme word somewhere before filling the rest.
  let planted = null;
  if (seedWords && seedWords.length) {
    const options = [];
    for (const w of shuffle([...seedWords])) {
      for (const s of slots) if (s.len === w.length) options.push([s, w]);
    }
    shuffle(options);
    for (const [slot, word] of options.slice(0, 12)) {
      slot.word = word;
      used.add(word);
      if (fill(slots, used, { nodes: 12000 })) {
        planted = word;
        return { slots, planted };
      }
      slots.forEach((s) => { s.word = null; });
      used.clear();
    }
    return null;
  }

  if (fill(slots, used, { nodes: 20000 })) return { slots, planted };
  return null;
}

function generatePuzzle(options = {}) {
  const wantTheme = options.theme !== false;
  const themeNames = Object.keys(THEMES);

  for (let attempt = 0; attempt < 60; attempt++) {
    const pattern = PATTERNS[weightedPatternIndex()];

    // First two-thirds of attempts: try for a themed seed word.
    let themeName = null, seeds = null;
    if (wantTheme && attempt < 40) {
      themeName = pick(themeNames);
      seeds = themeWordsAvailable(THEMES[themeName]);
      if (!seeds.length) { themeName = null; seeds = null; }
    }

    const result = attemptFill(pattern, seeds);
    if (!result) continue;

    const { slots, planted } = result;

    // Don't hand back a grid that's still fresh in the player's memory.
    const signature = slots.map((s) => s.word).join("-");
    if (recent.puzzles.includes(signature) && attempt < 50) continue;

    numberGrid(pattern, slots);

    const entries = slots.map((s) => ({
      number: s.number,
      dir: s.dir,
      row: s.cells[0][0],
      col: s.cells[0][1],
      cells: s.cells,
      answer: s.word,
      clue: BANK.clues.get(s.word)
    }));

    rememberPuzzle(entries.map((e) => e.answer), signature);

    const bySort = (a, b) => a.number - b.number;
    return {
      pattern,
      theme: planted ? themeName : null,
      themeWord: planted || null,
      across: entries.filter((e) => e.dir === "across").sort(bySort),
      down: entries.filter((e) => e.dir === "down").sort(bySort),
      id: Math.random().toString(36).slice(2, 8).toUpperCase()
    };
  }
  return null;
}
