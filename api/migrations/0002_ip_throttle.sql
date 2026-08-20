-- Per-IP throttle for player creation, the only unbounded write in the system.
--
-- One row per creation, pruned on each check, so the table stays roughly at the
-- limit times the number of active IPs. A pentest created 30 players from one
-- client before this table existed.
CREATE TABLE ip_throttle (
  ip         TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX ip_throttle_lookup ON ip_throttle (ip, created_at);
