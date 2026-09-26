# The Endless Mini

A 5×5 mini crossword in the spirit of the NYT Mini — except you never wait for tomorrow.
Press **New Puzzle** and a brand-new grid is built on the spot, with real answers and
hand-written clues, plus a running record of how you've done.

## Run it

```bash
node serve.js
```

Then open http://localhost:5173. (No dependencies, no build step. You can also open
`index.html` directly, but a browser's file:// restrictions may block saved history —
the tiny server avoids that.)

## Playing

| Action | How |
| --- | --- |
| Enter a letter | Type it (or tap the on-screen keyboard on mobile) |
| Move around | Arrow keys, or click a square |
| Switch Across / Down | Space, or click the square you're already on |
| Next row / column | Enter — and Shift+Enter for the previous one. Tab works too |
| Erase | Backspace |
| Pause | The Pause button; resume with the button or Enter / Space / Escape |

Enter walks down the Across clues row by row; past the last row it wraps round to the
first Down clue, i.e. the first column, and carries on through the columns back to the
top. Shift+Enter does the same in reverse.

**Check** marks wrong squares with a red slash. **Reveal** fills in a square, a word,
or the whole grid. Reveal Puzzle ends the game as unsolved.

Pausing stops the clock, covers the grid and blurs the clues, so a break costs you
nothing. Solving sets off falling confetti and a short fanfare — the 🔊 button mutes it,
and that choice is remembered.

## The record

Every finished grid is stored in your browser (`localStorage`) as one of:

- ✅ **Solved with no help** — filled it in correctly without Check or Reveal
- 🟡 **Solved with help** — correct, but Check or Reveal was used
- ❌ **Revealed** — gave up and revealed the grid
- ⛔ **Abandoned** — started a new puzzle with this one unfinished

Those feed the Played / Solved / Win-rate / streak / best-time tiles and the recent list.
"Reset history" clears them.

## How the puzzles are made

Each grid is generated fresh rather than pulled from a stash of pre-made puzzles:

1. **Word bank** (`js/words3.js`, `words4.js`, `words5.js`) — about 3,100 common English
   words (458 three-letter, 1,101 four-letter, 1,579 five-letter), each paired with a clue.
   Every answer that can appear in a grid comes from here, so an answer is never a
   non-word and never clue-less.
2. **Grid shape** (`js/generator.js`) — one of ten black-square layouts, weighted by how
   readily it fills. Every run of open squares is at least 3 letters.
3. **Theme seed** (`js/themes.js`) — a word from a random category (Animal Kingdom,
   In the Kitchen, Space Case…) is planted in a slot; the puzzle is named after it. If no
   theme word fits, the puzzle is labelled "Freestyle".
4. **The fill** — backtracking search over the slots: always work on the most-constrained
   slot next, try candidates in random order, and forward-check that every crossing entry
   still has at least one possible word. Candidate lookup goes through a
   position-and-letter index, so a typical grid solves in well under a tenth of a second.

5. **Anti-repeat memory** — the search returns the *first* solution it finds, which on its
   own biases it hard toward the same well-connected corner of the bank (left alone, about
   1 puzzle in 3 repeated an earlier one). So the last ~55 puzzles' answers and the last 700
   exact grids are kept in `localStorage`; recently-used words are tried last, and a grid
   that matches a remembered one is thrown away and re-rolled. Measured over 500 consecutive
   puzzles: 500 distinct, no repeats, median 38 ms.

Note that the pool is finite, and it grows far faster than the bank does. Every square has
to satisfy an Across and a Down word at once, so only a fraction of word combinations
interlock at all — at 1,486 words one layout could reach 163 distinct grids; at 1,857 it
reached 903; at 3,138 it reaches over 1,800. Growing the bank also made four previously
impossible layouts (the ones needing three crossing 5-letter entries) viable. Adding more
words is the single best way to widen it further.

### Adding your own words

Append `["WORD", "Clue"]` to the file matching the word's length. Longer or duplicated
entries are ignored, so there's nothing else to keep in sync — the index and the themes
pick up new words automatically. More words means richer fills and more variety.

## Files

```
index.html          markup
css/styles.css      styling, light + dark
js/words{3,4,5}.js  answers and clues
js/themes.js        theme categories
js/generator.js     grid shapes and the constraint fill
js/game.js          board, input, timer, stats and history
serve.js            tiny static server
```
