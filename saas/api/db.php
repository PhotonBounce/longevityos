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
        'CREATE TABLE IF NOT EXISTS contributors (
            id          INTEGER PRIMARY KEY,
            token_hash  TEXT UNIQUE,
            name        TEXT,
            credits     INTEGER DEFAULT 0,
            units       INTEGER DEFAULT 0,
            flagged     INTEGER DEFAULT 0,
            created_at  INTEGER,
            last_seen   INTEGER
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

        'CREATE INDEX IF NOT EXISTS ix_mol_state    ON molecules(state, id)',
        'CREATE INDEX IF NOT EXISTS ix_units_open   ON units(status, created_at)',
        'CREATE INDEX IF NOT EXISTS ix_units_canary ON units(canary_digest)',
        'CREATE INDEX IF NOT EXISTS ix_res_unit     ON results(unit_id)',
        'CREATE INDEX IF NOT EXISTS ix_res_contrib  ON results(contributor)',
        'CREATE INDEX IF NOT EXISTS ix_hits_score   ON hits(score DESC)',
        'CREATE INDEX IF NOT EXISTS ix_contrib_cred ON contributors(credits DESC)',
        'CREATE INDEX IF NOT EXISTS ix_issued_c     ON issued(contributor)',
    );

    foreach ($sql as $stmt) {
        $pdo->exec($stmt);
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

/** Add to an integer meta counter. */
function los_meta_add(PDO $db, $k, $n)
{
    $cur = (int) los_meta_get($db, $k, '0');
    los_meta_set($db, $k, (string) ($cur + (int) $n));
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
