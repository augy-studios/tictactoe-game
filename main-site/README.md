# main-site

What Vercel deploys, served at <https://oxo.uwuapps.org>. No build step:
the files are served as they are, and `api/` holds the serverless functions.

| Path | What it is |
| --- | --- |
| `index.html` | The only page. Its `<head>` is the template for any page added later. |
| `404.html`, `404.css` | The shared not-found page. |
| `sw.js` | Service worker: the offline shell, and the update bar's waiting worker. |
| `manifest.json` | PWA manifest. |
| `css/theme.css` | The uwuapps theme, verbatim from `uwuapps-theme.md`, time-based mode included. |
| `css/style.css` | Layout, the board and the marks. The mark colours are tokens at the top. |
| `js/` | ES modules, below. |
| `api/` | The leaderboard API, below. |
| `images/` | Manifest screenshots, at the sizes `manifest.json` gives. |

## js

Every file here is precached; `scripts/check-precache.mjs` fails if one is
not. The first five are pure, with no DOM, and the API imports them too, so
the browser and the server always agree on a game.

| File | What it does |
| --- | --- |
| `rules.js` | The board, the winning lines for each size, and cell names. |
| `ai.js` | The computer: negamax with alpha-beta, and its levels (below). Deterministic. |
| `seed.js` | Seeds, and the integer random numbers everything draws from. |
| `record.js` | Replays a seed and a move list into boards, threats, blocks and the result; packs replay links. |
| `score.js` | Scoring (below). |
| `ai-worker.js`, `computer.js` | The computer's Web Worker, and the page's side of it. |
| `board.js` | The board on screen: tap, click or arrow keys, marks that draw themselves in, the stroke through a win. |
| `game.js` | The game screen: setup, play, undo, resign, result, submit, saving, replay links. |
| `replay.js` | The instant replay. |
| `net.js` | Pairing over PeerJS, STUN only, from `STUN-p2p-spec.md`. |
| `multiplayer.js` | Network games on top of `net.js`: hosting, joining, and the messages. |
| `qr.js` | QR encoder for the join link, from uwuPromptr, so it works offline. |
| `api.js`, `leaderboard.js`, `settings.js` | The API client, and the leaderboard and settings windows, after MRT Station Guesser's. |
| `theme.js`, `icons.js`, `ui.js`, `update-bar.js`, `confetti.js`, `app.js` | Theme, inline SVG icons, modal and storage helpers, the update bar, the win confetti, and boot. |

## The game

**Boards.** 3×3, three in a row wins. 4×4 and 5×5, four in a row wins. X
always moves first.

**Modes.** Against the computer; two people taking turns on this device; or
two devices on one network, one hosting with a six character code, a link or
a QR code, and the other joining.

**Seeds.** A seed looks like `3X3-BXK4-M9TR`. The prefix is the board. The
seed picks which mark the player takes when they let the game decide, and
every choice the computer makes, so the same seed and the same moves are
always the same game. The seed shows during play and at the end, where it
can be copied; paste one into the new-game screen to play that game again.
A pasted seed sets the board to match.

**The computer.** Five levels. Each looks further ahead, and each picks from
a narrower spread of moves around its best one, so a weaker level plays
decent but not best moves rather than random ones. It runs in a Web Worker,
stops on a count of positions rather than a clock, and never reads the time
or `Math.random`. That is what lets the API replay a game and check every
one of the computer's moves.

| Level | Looks ahead | Moves at random | On 3×3 |
| --- | --- | --- | --- |
| 1 Beginner | 1 move | 30% | beatable |
| 2 Casual | 2 | 10% | beatable |
| 3 Steady | 3 | 3% | beatable, by about 1 line in 40 |
| 4 Sharp | 5 | none | never beaten in testing |
| 5 Master | as far as 150,000 positions allow | none | cannot be beaten; searches to the end |

On 4×4 and 5×5 Master cannot see to the end and can be beaten, but it takes
about half a second a move on a laptop, more on a phone.

**Hints.** A setting marks, on your turn, the cells that win (a dot) and the
cells you must block (a dashed ring). Off by default.

**Undo.** Unlimited, in every mode. Against the computer it takes back your
move and its reply. In a network game it asks the other player, who accepts
or declines. In a scored game each undo costs 30 points before the
percentages.

**Replay.** When a game ends it plays back on the board by itself (a setting
turns this off), with play, pause, a step back or forward, a slider and the
move list. It plays at 0.5x, 1x, 2x or 4x, remembered in this browser.

**Sharing a replay.** Share replay makes a link such as
`/?watch=40862&seed=3X3-BXK4-M9TR&game=c3x&end=ro`, through the device's
share sheet where it has one and the clipboard otherwise. The link is the
whole game: the seed, each move as one character (its cell, 0 to 9 then a
to o, reading along each row from the top left), who played (`c3x` the
computer at level 3 with the player as X, `l` one device, `n` network), and
a resignation if there was one (`rx` or `ro`). Nothing is stored anywhere,
and a link opens offline once the site has been visited. Opening one plays
the replay without touching the viewer's own saved game; Close replay goes
back to it, and Play this seed fills in the new-game screen. A shared replay
shows no score, since a link can be edited and only the leaderboard's
scores are checked.

**Scoring.** The score grows with the game, from the side's own moves:

| | Points |
| --- | --- |
| Each move | 10 |
| Each line the move leaves one short of a win (a fork counts every line) | 25 |
| Each line the move stops the other side finishing | 30 |
| Winning | 300, plus up to 150 more for a quick win (full in the fewest moves the board allows, none on the last possible move) |
| Drawing | 150 |
| Each quick turn, wins and draws only | up to 20 (below) |
| Each undo | minus 30 |

The total is then scaled by the opponent, levels 1 to 5 counting 40%, 80%,
120%, 170% and 240% and a network game 100%, and by the board: 3×3 100%,
4×4 125%, 5×5 150%.

Then by time. A win or a draw earns up to 50% more, shrinking evenly to
nothing at 2 minutes on 3×3, 5 minutes on 4×4 and 10 minutes on 5×5. Losses
get nothing from time, per game or per turn.

**Turn times** come only from the server. The page sends each of its own
moves to `/api/game/move` as it is played, and the server stamps it with its
own clock. A turn runs from the server's previous stamp for the game (the
start ticket, the other player's move, or an undo) to this one; against the
computer, from the player's previous move less the computer's fixed pause
before it replied. A turn of 1.5 seconds or less earns the full 20 points,
10 seconds or more earns none. A move the server never heard of, made
offline or before the ticket arrived, earns nothing, and so does the turn
after it. Both time bonuses count only on a seed the server picked: leave
the seed empty and the server chooses one. A pasted seed could have been
practised against the deterministic computer, so it scores everything but
time.

## The leaderboard and anti-cheat

Games against the computer and network games count; games on one device do
not. A game counts only if it started while online: starting asks
`/api/game/start` for a ticket, whose time comes from the server. Games
started offline play the same, and say they are not scored.

On submit the API trusts nothing but the name. It replays every move from
the seed and refuses an illegal one. It reads the result off the final
board, or accepts a resignation, but never the computer's. It replays the
computer at every one of its moves and refuses any that differ
(`not_computer`). It takes turn times only from its own stamps, and the
game's time from its own start ticket to the moment the page reported the
game over (`/api/game/finish`), so watching the replay or typing a name
afterwards costs nothing. It computes the score itself. The database then
refuses a submission that:

| Code | When |
| --- | --- |
| `not_yours` | comes from a browser other than the one that started the game |
| `same_device` | is a network game's second side, sent from the host's own browser |
| `too_fast` | finishes sooner than a second per own move, or three seconds in all |
| `overlap` | was played at the same time as another game under the same name |
| `seed_used` | repeats a seed and level already on the board under that name |
| `mismatch` | is a network game's second side, with different moves from the first |
| `same_name` | puts both sides of one network game under one name |

Stamps and undos are only taken from the browser that plays that side, at
most 200 a game. Undos are counted on the server as they happen, from
browsers that are online, and a submission is charged the higher of that
count and its own. Every endpoint is rate limited by hashed address.

None of this stops a person using a solver in another tab, and a script
could still play a game at human speed. It is meant to stop replayed,
edited and instantly scripted games, and scores that were never earned.

## Network games

Per `STUN-p2p-spec.md`: STUN only, no TURN relay. **Both devices have to be
on the same network**: the same wifi, or one sharing a hotspot with the
other. PeerJS loads from cdnjs only when somebody hosts or joins, and is
never cached. The host holds the game and sends it in full 20 times a
second; the guest sends moves, resignations and undo requests. A guest that
reloads or drops rejoins with the same code, and leaving on purpose retires
it.

## Offline and updates

Everything the page loads is precached, the computer's worker and the Jua
font included, so the site opens and plays with no connection, and shared
replay links open too. Only the leaderboard and network games need the
network. Nothing under `/api/` is ever cached.

A new service worker installs and waits. The update bar offers Reload or Not
now, and nothing reloads until the reader asks. Bump `VERSION` in `sw.js` on
every change to anything in this directory.

## API

| Endpoint | Body | Returns |
| --- | --- | --- |
| `POST /api/game/start` | `client_key, mode, seed?, size?, difficulty?, side?` | `game_id, seed, first_side, server_seed, created_at` |
| `POST /api/game/move` | `game_id, client_key, side, ply, cell` | `ok` |
| `POST /api/game/undo` | `game_id, client_key, side` | `undos` |
| `POST /api/game/finish` | `game_id, client_key, moves, end?` | `elapsed_ms, server_seed, turn_ms` |
| `POST /api/game/submit` | `game_id, client_key, name, side, moves, end?, undos?` | `name, score, outcome, turn_bonus, time_bonus, turn_ms, elapsed_ms, rank, best_score, total, games, total_rank` |
| `POST /api/leaderboard/name` | `name` | `name`, cleaned, or a `400` saying why not |
| `GET /api/leaderboard` | `?board=best` or `?board=total` | `board, entries`, cached 30 s |

`side` is `x` or `o`. `moves` is an array of cell numbers, 0 at the top left
along each row. With no `seed`, start picks one on a `size` board (3, 4 or
5). `end` is a resignation, `{ by: "resign", side }`. `turn_ms` has an entry
per ply: the server's time for that turn, or `null`. Errors are
`{ error, message? }` with a matching status. Start and finish are limited
to 60 an address per 10 minutes, move to 400, and submit to 30. Submit
replays the whole game, computer included; `vercel.json` gives it up to 60
seconds, though a 5×5 game against Master takes a few.

## Environment variables (Vercel)

Documented in `.env.example`. `.vercelignore` keeps every env file out of
deployments, since anything in this directory would otherwise be served.

| Variable | Used for |
| --- | --- |
| `SUPABASE_URL` | The shared uwuapps project. |
| `SUPABASE_SERVICE_KEY` | Service role key. Server side only, never sent to a browser. |
