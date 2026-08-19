-- Fuse initial schema.
--
-- One row per submitted run. A run is five placements and a seed, so the whole
-- replay fits in a few hundred bytes and the server can reproduce it exactly.

CREATE TABLE player (
  id         TEXT PRIMARY KEY,
  handle     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE run (
  id           TEXT PRIMARY KEY,
  player_id    TEXT NOT NULL REFERENCES player(id),
  date         TEXT NOT NULL,
  score        INTEGER NOT NULL,
  placements   TEXT NOT NULL,
  attempt_no   INTEGER NOT NULL,
  submitted_at INTEGER NOT NULL
);

-- Makes a retried submission idempotent rather than a consumed attempt.
CREATE UNIQUE INDEX run_idem ON run (player_id, date, attempt_no);

-- Serves the leaderboard query directly.
CREATE INDEX run_board ON run (date, score DESC);
