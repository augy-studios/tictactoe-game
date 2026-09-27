-- Tic Tac Toe (oxo.uwuapps.org) schema, in the shared uwuapps Supabase
-- project. Paste into the Supabase SQL editor and run once. Safe to run
-- again: everything is "if not exists" or "or replace".
--
-- Access model: only the Vercel functions touch these tables, with the
-- service role key. RLS is on with no policies, so an anon key reads nothing.
--
-- The rules of the game are not in here. The API replays every submitted
-- game with the same code the browser plays with, replays the computer's
-- every move, recomputes the score, and only then calls oxogame_submit,
-- which does the checks that need the database.

-- One row per game that could go on the leaderboard: a game against the
-- computer, or a network game, started while online. The row is the start
-- ticket; created_at is the server's clock, which a browser cannot move.
create table if not exists oxogame_games (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('computer', 'network')),
  seed text not null,                   -- "3X3-BXK4-M9TR", canonical form
  size smallint not null check (size in (3, 4, 5)),
  first_side smallint not null check (first_side in (0, 1)),
                                        -- 0 X, 1 O: the computer game's
                                        -- player, or the network host
  difficulty smallint check (difficulty between 1 and 5),
  host_key text not null,               -- the client_key that started it
  -- The server picked the seed (the player pasted none), so nobody could
  -- have practised it. Only these earn the time bonuses.
  server_seed boolean not null default false,
  created_at timestamptz not null default now(),
  -- Undos the API was told about while the game went on, per side. The
  -- submit charges the higher of these and what the browser reports.
  undos_x int not null default 0,
  undos_o int not null default 0,
  -- The moves and the server's time when the page reported the game over,
  -- or when the first side was submitted. A network game's second side must
  -- submit the same moves.
  moves text,
  finished_at timestamptz,
  check ((mode = 'computer') = (difficulty is not null))
);

create index if not exists oxogame_games_created on oxogame_games (created_at);

-- Every move and undo as the server heard of it, with the server's time.
-- Each turn's time, and so its turn bonus, is measured between these; see
-- main-site/api/_lib/verify.js. Moves made offline are simply not here.
create table if not exists oxogame_events (
  id bigserial primary key,
  game_id uuid not null references oxogame_games(id) on delete cascade,
  kind text not null check (kind in ('move', 'undo')),
  side smallint not null check (side in (0, 1)),
  ply smallint check (ply between 0 and 24),
  cell smallint check (cell between 0 and 24),
  at timestamptz not null default now(),
  check ((kind = 'move') = (ply is not null and cell is not null))
);

create index if not exists oxogame_events_game on oxogame_events (game_id, id);

create table if not exists oxogame_leaderboard (
  id bigserial primary key,
  name text not null,
  score int not null check (score >= 0),
  game_id uuid not null references oxogame_games(id) on delete cascade,
  side smallint not null check (side in (0, 1)),
  mode text not null,
  difficulty smallint,
  size smallint not null,
  seed text not null,
  outcome text not null check (outcome in ('win', 'draw', 'loss')),
  created_at timestamptz not null default now(),
  unique (game_id, side)
);

create index if not exists oxogame_lb_name on oxogame_leaderboard (lower(name), score desc);

-- Each name's best game. The earliest of an equal top score wins, and the
-- casing shown is the one attached to that score.
create or replace view oxogame_leaderboard_best
with (security_invoker = true) as
select distinct on (lower(name)) name, score, mode, difficulty, size, outcome, created_at
from oxogame_leaderboard
order by lower(name), score desc, created_at asc;

-- Every submitted game added up per name. The casing shown is the most
-- recent one.
create or replace view oxogame_leaderboard_total
with (security_invoker = true) as
select
  (array_agg(name order by created_at desc))[1] as name,
  sum(score)::bigint as total,
  count(*)::int as games,
  max(created_at) as last_at
from oxogame_leaderboard
group by lower(name);

-- Fixed window counters for rate limiting by (hashed) IP. There are no
-- accounts to limit against, and Vercel functions share no memory.
create table if not exists oxogame_rate_limits (
  bucket text primary key,
  window_start timestamptz not null,
  hits int not null
);

alter table oxogame_games enable row level security;
alter table oxogame_events enable row level security;
alter table oxogame_leaderboard enable row level security;
alter table oxogame_rate_limits enable row level security;

-- True while the bucket is under its limit. One statement, so concurrent
-- hits cannot both read the old count.
create or replace function oxogame_hit(p_bucket text, p_window_seconds int, p_max int)
returns boolean
language sql
volatile
as $$
  insert into oxogame_rate_limits as r (bucket, window_start, hits)
  values (p_bucket, now(), 1)
  on conflict (bucket) do update set
    window_start = case
      when r.window_start < now() - make_interval(secs => p_window_seconds) then now()
      else r.window_start end,
    hits = case
      when r.window_start < now() - make_interval(secs => p_window_seconds) then 1
      else r.hits + 1 end
  returning hits <= p_max;
$$;

-- Whether this browser may speak for `p_side` of a live game: a computer
-- game, and a network game's host side, only from the browser that started
-- it; a network game's other side only from some other browser. Null if
-- the game is unknown, too old, or already on the leaderboard.
create or replace function oxogame_may_act(p_game oxogame_games, p_client_key text, p_side smallint)
returns boolean
language sql
stable
as $$
  select case
    when p_game.id is null or p_game.created_at < now() - interval '12 hours' then null
    when exists (select 1 from oxogame_leaderboard l where l.game_id = p_game.id) then null
    when p_game.mode = 'computer' then p_side = p_game.first_side and p_client_key = p_game.host_key
    when p_side = p_game.first_side then p_client_key = p_game.host_key
    else p_client_key <> p_game.host_key
  end;
$$;

-- Stamps one move of a live game with the server's time. At most 200
-- events a game, so a script cannot fill the table through one ticket.
create or replace function oxogame_move(p_game_id uuid, p_client_key text, p_side smallint, p_ply smallint, p_cell smallint)
returns boolean
language plpgsql
volatile
as $$
declare
  v_game oxogame_games%rowtype;
begin
  select * into v_game from oxogame_games where id = p_game_id for update;
  if not found or oxogame_may_act(v_game, p_client_key, p_side) is not true then
    return false;
  end if;
  if p_ply % 2 <> p_side or p_cell >= v_game.size * v_game.size then
    return false;
  end if;
  if (select count(*) from oxogame_events e where e.game_id = p_game_id) >= 200 then
    return false;
  end if;
  insert into oxogame_events (game_id, kind, side, ply, cell) values (p_game_id, 'move', p_side, p_ply, p_cell);
  return true;
end;
$$;

-- Records one undo against a side of a live game, and stamps it: a turn
-- after an undo is timed from the undo.
create or replace function oxogame_undo(p_game_id uuid, p_client_key text, p_side smallint)
returns int
language plpgsql
volatile
as $$
declare
  v_game oxogame_games%rowtype;
begin
  select * into v_game from oxogame_games where id = p_game_id for update;
  if not found or oxogame_may_act(v_game, p_client_key, p_side) is not true then
    return null;
  end if;
  if (select count(*) from oxogame_events e where e.game_id = p_game_id) < 200 then
    insert into oxogame_events (game_id, kind, side) values (p_game_id, 'undo', p_side);
  end if;
  if p_side = 0 then
    update oxogame_games set undos_x = undos_x + 1 where id = p_game_id returning undos_x into v_game.undos_x;
    return v_game.undos_x;
  end if;
  update oxogame_games set undos_o = undos_o + 1 where id = p_game_id returning undos_o into v_game.undos_o;
  return v_game.undos_o;
end;
$$;

-- Records the end of a game: its moves, as one string with any
-- resignation, and the server's time. The API has replayed the moves
-- first. Sent again after an undo reopened the game, it records the new
-- ending; once either side is on the leaderboard the game is fixed.
--
--   not_found, expired, not_yours  as for oxogame_submit
--   mismatch                       the game is on the board with other moves
create or replace function oxogame_finish(p_game_id uuid, p_client_key text, p_moves text)
returns table (status text, created_at timestamptz, finished_at timestamptz)
language plpgsql
volatile
as $$
#variable_conflict use_column
declare
  v_game oxogame_games%rowtype;
begin
  select * into v_game from oxogame_games where id = p_game_id for update;
  if not found then
    return query select 'not_found'::text, null::timestamptz, null::timestamptz;
    return;
  end if;
  if v_game.created_at < now() - interval '12 hours' then
    return query select 'expired'::text, null::timestamptz, null::timestamptz;
    return;
  end if;
  -- A computer game's end only from the browser that started it. Either
  -- player of a network game may send it; it is the same game on both.
  if v_game.mode = 'computer' and p_client_key <> v_game.host_key then
    return query select 'not_yours'::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  if exists (select 1 from oxogame_leaderboard l where l.game_id = p_game_id) then
    if v_game.moves is distinct from p_moves then
      return query select 'mismatch'::text, null::timestamptz, null::timestamptz;
      return;
    end if;
  elsif v_game.moves is distinct from p_moves then
    -- A new ending: the first, or one after an undo.
    update oxogame_games set moves = p_moves, finished_at = now() where id = p_game_id
    returning finished_at into v_game.finished_at;
  end if;

  return query select 'ok'::text, v_game.created_at, v_game.finished_at;
end;
$$;

-- Puts one side of a verified game on the board. The API has already
-- replayed the moves, checked the computer's, and computed the score; this
-- checks what only the database can:
--
--   not_found          no such game
--   expired            started more than 12 hours ago
--   not_yours          a computer game, or a network host side, submitted
--                      from a browser other than the one that started it
--   same_device        a network game's other side submitted from the host's
--                      own browser: one person playing both sides
--   already_submitted  this side of this game is already on the board
--   mismatch           a network game's second side sent different moves
--   too_fast           finished sooner than a second per own move, or under
--                      three seconds in all
--   same_name          both sides of one network game under one name
--   overlap            played while another game on the board under this
--                      name was also being played
--   seed_used          this name already has this seed at this level on the
--                      board, so a memorised line cannot be farmed
create or replace function oxogame_submit(
  p_game_id uuid,
  p_side smallint,
  p_name text,
  p_client_key text,
  p_moves text,
  p_score int,
  p_outcome text,
  p_own_moves int
)
returns table (status text, best_score int, rank bigint, total bigint, games int, total_rank bigint)
language plpgsql
volatile
as $$
#variable_conflict use_column
declare
  v_game oxogame_games%rowtype;
  v_host_side boolean;
  v_best int;
  v_best_at timestamptz;
  v_total bigint;
  v_games int;
begin
  select * into v_game from oxogame_games where id = p_game_id for update;

  if not found then
    return query select 'not_found'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;
  if v_game.created_at < now() - interval '12 hours' then
    return query select 'expired'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;

  v_host_side := p_side = v_game.first_side;
  if (v_game.mode = 'computer' or v_host_side) and p_client_key <> v_game.host_key then
    return query select 'not_yours'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;
  if v_game.mode = 'network' and not v_host_side and p_client_key = v_game.host_key then
    return query select 'same_device'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;

  if exists (select 1 from oxogame_leaderboard l where l.game_id = p_game_id and l.side = p_side) then
    return query select 'already_submitted'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;
  if exists (select 1 from oxogame_leaderboard l where l.game_id = p_game_id)
     and v_game.moves is distinct from p_moves then
    return query select 'mismatch'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;
  -- Timed to when the page reported this ending, or to now if it never did.
  if coalesce(case when v_game.moves = p_moves then v_game.finished_at end, now()) - v_game.created_at
     < make_interval(secs => greatest(3, p_own_moves)) then
    return query select 'too_fast'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;

  -- One submission per name at a time, so two sent together cannot both
  -- miss each other in the checks below.
  perform pg_advisory_xact_lock(hashtext('oxogame_submit:' || lower(p_name)));

  if exists (
    select 1 from oxogame_leaderboard l
    where l.game_id = p_game_id and lower(l.name) = lower(p_name)
  ) then
    return query select 'same_name'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;

  if exists (
    select 1
    from oxogame_leaderboard l
    join oxogame_games g on g.id = l.game_id
    where lower(l.name) = lower(p_name)
      and l.game_id <> p_game_id
      and l.created_at > v_game.created_at
  ) then
    return query select 'overlap'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;

  if v_game.mode = 'computer' and exists (
    select 1 from oxogame_leaderboard l
    where lower(l.name) = lower(p_name)
      and l.mode = 'computer'
      and l.seed = v_game.seed
      and l.difficulty = v_game.difficulty
  ) then
    return query select 'seed_used'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;

  -- Fixed from here: the moves on the board are these moves.
  if v_game.moves is distinct from p_moves then
    update oxogame_games set moves = p_moves, finished_at = now() where id = p_game_id;
  end if;

  insert into oxogame_leaderboard (name, score, game_id, side, mode, difficulty, size, seed, outcome)
  values (p_name, p_score, p_game_id, p_side, v_game.mode, v_game.difficulty, v_game.size, v_game.seed, p_outcome);

  select l.score, l.created_at into v_best, v_best_at
  from oxogame_leaderboard l
  where lower(l.name) = lower(p_name)
  order by l.score desc, l.created_at asc
  limit 1;

  select sum(l.score)::bigint, count(*)::int into v_total, v_games
  from oxogame_leaderboard l
  where lower(l.name) = lower(p_name);

  return query
  select
    'ok'::text,
    v_best,
    (
      select count(*) + 1
      from oxogame_leaderboard_best b
      where b.score > v_best or (b.score = v_best and b.created_at < v_best_at)
    ),
    v_total,
    v_games,
    (
      select count(*) + 1
      from oxogame_leaderboard_total t
      where lower(t.name) <> lower(p_name)
        and (
          t.total > v_total
          or (t.total = v_total and t.games < v_games)
          -- This name's total was only just reached, so an equal one got there first.
          or (t.total = v_total and t.games = v_games)
        )
    );
end;
$$;

-- Housekeeping, called now and then by /api/game/start: old counters, and
-- games nobody submitted that are past any use. Their events go with them.
create or replace function oxogame_prune()
returns void
language sql
volatile
as $$
  delete from oxogame_rate_limits where window_start < now() - interval '1 day';
  delete from oxogame_games g
  where g.created_at < now() - interval '2 days'
    and not exists (select 1 from oxogame_leaderboard l where l.game_id = g.id);
$$;

-- Service role only.
revoke all on function oxogame_hit(text, int, int) from public, anon, authenticated;
revoke all on function oxogame_may_act(oxogame_games, text, smallint) from public, anon, authenticated;
revoke all on function oxogame_move(uuid, text, smallint, smallint, smallint) from public, anon, authenticated;
revoke all on function oxogame_undo(uuid, text, smallint) from public, anon, authenticated;
revoke all on function oxogame_finish(uuid, text, text) from public, anon, authenticated;
revoke all on function oxogame_submit(uuid, smallint, text, text, text, int, text, int) from public, anon, authenticated;
revoke all on function oxogame_prune() from public, anon, authenticated;
grant execute on function oxogame_hit(text, int, int) to service_role;
grant execute on function oxogame_may_act(oxogame_games, text, smallint) to service_role;
grant execute on function oxogame_move(uuid, text, smallint, smallint, smallint) to service_role;
grant execute on function oxogame_undo(uuid, text, smallint) to service_role;
grant execute on function oxogame_finish(uuid, text, text) to service_role;
grant execute on function oxogame_submit(uuid, smallint, text, text, text, int, text, int) to service_role;
grant execute on function oxogame_prune() to service_role;
