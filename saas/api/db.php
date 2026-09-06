<?php
/**
 * LongevityOS — swarm database.
 *
 * One SQLite file beside this script, opened lazily, schema asserted on every
 * open so a fresh install and an upgraded one converge on the same shape.
 * PHP 8 + pdo_sqlite only: no framework, no composer, no migrations directory.
 *
 * data/los.sqlite is the LIVE swarm record — every contributor's credited work
 * and every verified hit. It is gitignored and a deploy must never mirror over
 * it.
 */

declare(strict_types=1);

define('LOS_DB_DIR', __DIR__ . '/data');
define('LOS_DB_FILE', LOS_DB_DIR . '/los.sqlite');

/**
 * Open (creating if needed) the swarm database. Same handle for the request.
 */
function los_db()
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    if (!is_dir(LOS_DB_DIR)) {
        @mkdir(LOS_DB_DIR, 0770, true);
    }
    if (!is_dir(LOS_DB_DIR)) {
        throw new RuntimeException('data directory unavailable');
    }

    // Belt and braces for shared hosting: even if the vhost ignores the API's
    // .htaccess, the data directory carries its own deny rule and an index.
    $guard = LOS_DB_DIR . '/.htaccess';
    if (!file_exists($guard)) {
        @file_put_contents(
            $guard,
            "# The live swarm database. Never served, never mirrored over.\n"
            . "<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n"
            . "<IfModule !mod_authz_core.c>\n  Order allow,deny\n  Deny from all\n</IfModule>\n"
        );
    }

    $pdo = new PDO('sqlite:' . LOS_DB_FILE, null, null, array(
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
        PDO::ATTR_TIMEOUT            => 10,
    ));

    // WAL keeps readers (the dashboard) out of the writers' way; busy_timeout
    // is what turns "database is locked" into "wait your turn" on a host where
    // several volunteers submit at once.
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA busy_timeout = 8000');
    $pdo->exec('PRAGMA synchronous = NORMAL');
    $pdo->exec('PRAGMA foreign_keys = ON');

    los_schema($pdo);
    return $pdo;
}

/**
 * CREATE TABLE IF NOT EXISTS for the whole schema, every open.
 */
function los_schema(PDO $pdo)
{
    $sql = array(

        // Volunteers. The token itself is never stored — only its SHA-256, so a
        // stolen database cannot impersonate a contributor.
        //
        // 3.0: team_id (nullable) is the team a contributor stands in, hidden=1
        // is a contributor who chose to leave the public record (?a=leave). A
        // hidden row keeps its token, its credits and every result it ever
        // agreed on — only its public face is gone. These two columns exist
        // here for a FRESH install; an existing database gets them from
        // los_migrate() below, because CREATE TABLE IF NOT EXISTS never touches
        // a table that already exists.
        'CREATE TABLE IF NOT EXISTS contributors (
            id          INTEGER PRIMARY KEY,
            token_hash  TEXT UNIQUE,
            name        TEXT,
            credits     INTEGER DEFAULT 0,
            units       INTEGER DEFAULT 0,
            flagged     INTEGER DEFAULT 0,
            created_at  INTEGER,
            last_seen   INTEGER,
            team_id     INTEGER,
            hidden      INTEGER NOT NULL DEFAULT 0
        )',

        // 3.0 teams. code is the 8-character join code (unambiguous alphabet,
        // see los_team_code() in index.php); name is a cleaned display name.
        // A team lives exactly as long as it has a visible member: the same
        // transaction that takes the last non-hidden member out (team_leave,
        // a switch to another team, or ?a=leave) deletes the row, so a daily
        // live-QA create/join/leave never accumulates empty teams and the code
        // is simply unknown afterwards.
        'CREATE TABLE IF NOT EXISTS teams (
            id          INTEGER PRIMARY KEY,
            code        TEXT UNIQUE NOT NULL,
            name        TEXT NOT NULL,
            created_by  INTEGER,
            created_at  INTEGER
        )',

        // Candidate molecules from the harvester.
        // state: pending | issued | verified | conflict
        'CREATE TABLE IF NOT EXISTS molecules (
            id        INTEGER PRIMARY KEY,
            cid       TEXT UNIQUE,
            smiles    TEXT,
            formula   TEXT,
            source    TEXT,
            added_at  INTEGER,
            state     TEXT DEFAULT \'pending\'
        )',

        // Work units. canary_digest non-NULL marks a unit whose correct answer
        // the server already knows; such units never touch molecule progress.
        // status: open | conflict | confirmed | stale
        'CREATE TABLE IF NOT EXISTS units (
            id              TEXT PRIMARY KEY,
            created_at      INTEGER,
            engine          TEXT,
            targets_digest  TEXT,
            mol_ids         TEXT,
            issues          INTEGER DEFAULT 0,
            status          TEXT DEFAULT \'open\',
            canary_digest   TEXT
        )',

        // One submission per (unit, contributor) — the UNIQUE constraint is the
        // structural reason nobody can confirm their own work.
        'CREATE TABLE IF NOT EXISTS results (
            id          INTEGER PRIMARY KEY,
            unit_id     TEXT,
            contributor INTEGER,
            digest      TEXT,
            payload     TEXT,
            created_at  INTEGER,
            UNIQUE(unit_id, contributor)
        )',

        // Verified hits: the public shortlist of hypotheses.
        'CREATE TABLE IF NOT EXISTS hits (
            cid          TEXT PRIMARY KEY,
            smiles       TEXT,
            formula      TEXT,
            score        INTEGER,
            best_target  TEXT,
            flags        TEXT,
            verified_by  INTEGER,
            verified_at  INTEGER
        )',

        // Rate limiting. k is sha256(ip + per-install salt) prefixed by bucket —
        // a raw IP is never written to disk.
        'CREATE TABLE IF NOT EXISTS ratelimit (
            k            TEXT PRIMARY KEY,
            window_start INTEGER,
            n            INTEGER
        )',

        /* ——— two tables the protocol needs that are not in the public shape ———
         *
         * issued: which unit went to which contributor. Required by two rules in
         * the spec that are otherwise unimplementable — "a contributor may not
         * be issued the same unit twice" and "a unit is not issued more than 4
         * times" (units.issues counts issues, but not to whom).
         *
         * meta: small server-owned key/value — the per-install rate-limit salt,
         * the engine/targets digest the harvester pinned, and the O(1) screened
         * counter that keeps ?a=stats cheap.
         */
        'CREATE TABLE IF NOT EXISTS issued (
            unit_id     TEXT,
            contributor INTEGER,
            issued_at   INTEGER,
            PRIMARY KEY(unit_id, contributor)
        )',

        'CREATE TABLE IF NOT EXISTS meta (
            k TEXT PRIMARY KEY,
            v TEXT
        )',

        // 4.0 history: one row per UTC hour (hour = unix seconds at the top of
        // the hour), written by ?a=stats behind a 60-second meta guard and
        // pruned past 720 hours. Running totals (harvested, screened,
        // verified, contributors, units_confirmed, results) are snapshots of
        // the counters; active, units_open and conflicts are gauges. The
        // Observatory differences the snapshots client-side, so a row is a
        // reading, never an event.
        'CREATE TABLE IF NOT EXISTS history (
            hour             INTEGER PRIMARY KEY,
            harvested        INTEGER NOT NULL DEFAULT 0,
            screened         INTEGER NOT NULL DEFAULT 0,
            verified         INTEGER NOT NULL DEFAULT 0,
            contributors     INTEGER NOT NULL DEFAULT 0,
            active           INTEGER NOT NULL DEFAULT 0,
            units_open       INTEGER NOT NULL DEFAULT 0,
            units_confirmed  INTEGER NOT NULL DEFAULT 0,
            conflicts        INTEGER NOT NULL DEFAULT 0,
            results          INTEGER NOT NULL DEFAULT 0
        )',

        'CREATE INDEX IF NOT EXISTS ix_mol_state    ON molecules(state, id)',
        'CREATE INDEX IF NOT EXISTS ix_units_open   ON units(status, created_at)',
        'CREATE INDEX IF NOT EXISTS ix_units_canary ON units(canary_digest)',
        'CREATE INDEX IF NOT EXISTS ix_res_unit     ON results(unit_id)',
        'CREATE INDEX IF NOT EXISTS ix_res_contrib  ON results(contributor)',
        'CREATE INDEX IF NOT EXISTS ix_hits_score   ON hits(score DESC)',
        'CREATE INDEX IF NOT EXISTS ix_contrib_cred ON contributors(credits DESC)',
        'CREATE INDEX IF NOT EXISTS ix_issued_c     ON issued(contributor)',
        'CREATE INDEX IF NOT EXISTS ix_teams_code   ON teams(code)',
        // 4.0: totals.active_1h is COUNT(*) WHERE last_seen >= now - 3600,
        // polled every 15 seconds by every open Observatory.
        'CREATE INDEX IF NOT EXISTS ix_contrib_seen ON contributors(last_seen)',
    );

    foreach ($sql as $stmt) {
        $pdo->exec($stmt);
    }

    // Columns added after 2.0 reach an EXISTING database only through the
    // migration, and the index on one of them can only be created once the
    // column is there — so this order is load-bearing.
    los_migrate($pdo);
    $pdo->exec('CREATE INDEX IF NOT EXISTS ix_contrib_team ON contributors(team_id)');
}

/** The real column set of the contributors table, as {name => true}. */
function los_columns_contributors(PDO $pdo)
{
    $st = $pdo->query('PRAGMA table_info(contributors)');
    $have = array();
    foreach ($st->fetchAll() as $row) {
        if (isset($row['name']) && is_string($row['name'])) {
            $have[$row['name']] = true;
        }
    }
    $st->closeCursor();
    return $have;
}

/**
 * Idempotent schema migration for a database that predates a column.
 *
 * The live los.sqlite already exists with the 2.0 shape, and
 * CREATE TABLE IF NOT EXISTS is a no-op on an existing table, so a column that
 * merely appears in los_schema() above never reaches the live host. This looks
 * at the table's REAL columns (PRAGMA table_info) and ALTERs in only what is
 * missing. It runs on every open and costs one PRAGMA when nothing is missing.
 *
 * Racing is safe: several PHP workers can open the database at the same moment
 * after a deploy and each see the column missing. SQLite serialises the
 * ALTERs; the losers get "duplicate column name", re-read the columns, and
 * carry on when the column is now there. Only a column that is STILL missing
 * after that is a genuine failure and is rethrown.
 */
function los_migrate(PDO $pdo)
{
    $want = array(
        'team_id' => 'ALTER TABLE contributors ADD COLUMN team_id INTEGER',
        'hidden'  => 'ALTER TABLE contributors ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0',
    );
    $have = los_columns_contributors($pdo);
    foreach ($want as $col => $ddl) {
        if (isset($have[$col])) {
            continue;
        }
        try {
            $pdo->exec($ddl);
        } catch (PDOException $e) {
            $have = los_columns_contributors($pdo);
            if (!isset($have[$col])) {
                throw $e;
            }
        }
    }
}

/** Read a small server-owned value. */
function los_meta_get(PDO $db, $k, $default = null)
{
    $st = $db->prepare('SELECT v FROM meta WHERE k = ?');
    $st->execute(array($k));
    $row = $st->fetch();
    // Close the cursor before the caller writes. A statement left half-read
    // holds this connection in an implicit WAL READ transaction, and the write
    // that follows is then a read->write upgrade, which SQLite refuses with
    // SQLITE_BUSY_SNAPSHOT *without* consulting busy_timeout. That is the
    // "database is locked" 500 that loses a volunteer's finished work.
    $st->closeCursor();
    return $row === false ? $default : $row['v'];
}

/** Write a small server-owned value. */
function los_meta_set(PDO $db, $k, $v)
{
    $st = $db->prepare('INSERT OR REPLACE INTO meta(k, v) VALUES(?, ?)');
    $st->execute(array($k, (string) $v));
}

/** Add to an integer meta counter. Read-then-write: safe only inside los_tx(). */
function los_meta_add(PDO $db, $k, $n)
{
    $cur = (int) los_meta_get($db, $k, '0');
    los_meta_set($db, $k, (string) ($cur + (int) $n));
}

/**
 * Add to an integer meta counter in ONE statement, so it is safe outside a
 * transaction: two PHP workers answering at once both land (los_meta_add
 * outside los_tx() would have both read N and both written N+n — measured at
 * 526 of 800 increments under four concurrent writers). UPSERT needs SQLite
 * 3.24 (2018); an older library falls back to the serialised read-then-write.
 */
function los_meta_incr(PDO $db, $k, $n)
{
    $n = (int) $n;
    try {
        $st = $db->prepare('INSERT INTO meta(k, v) VALUES(?, ?)
                            ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + excluded.v AS TEXT)');
        $st->execute(array($k, (string) $n));
        return;
    } catch (PDOException $e) {
        // no UPSERT in this SQLite: serialise the read-then-write instead
    }
    if ($db->inTransaction()) {
        los_meta_add($db, $k, $n);
        return;
    }
    los_tx($db, function () use ($db, $k, $n) {
        los_meta_add($db, $k, $n);
    });
}

/**
 * BEGIN IMMEDIATE ... COMMIT around $fn. Immediate (not deferred) because every
 * caller here reads-then-writes, and a deferred transaction that upgrades under
 * WAL is exactly how two simultaneous submits deadlock.
 */
function los_tx(PDO $db, $fn)
{
    $db->exec('BEGIN IMMEDIATE');
    try {
        $out = $fn();
        $db->exec('COMMIT');
        return $out;
    } catch (Throwable $e) {
        try {
            $db->exec('ROLLBACK');
        } catch (Throwable $ignored) {
            // already rolled back
        }
        throw $e;
    }
}
