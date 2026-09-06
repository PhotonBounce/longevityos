<?php
/**
 * LongevityOS — the swarm server.
 *
 * Hands out work units, collects screening results, and promotes a result to a
 * verified hit only when two INDEPENDENT contributors produce the identical
 * digest. Canary units — whose correct digest is already known — are mixed into
 * the stream to catch fabricated submissions.
 *
 * Everything the swarm's trust model rests on lives here:
 *   - one submission per (unit, contributor), enforced by a UNIQUE index;
 *   - agreement is counted across DISTINCT contributors, never submissions;
 *   - a wrong canary digest flags the contributor and discards their unverified
 *     work, and earns no credit;
 *   - the ingest door fails CLOSED: no key file on disk means ingest is refused,
 *     never opened.
 *
 * Contract (every response is JSON, always under 10KB):
 *   GET  ?a=health                  -> { ok, engine, molecules, screened, verified, contributors, ingest_armed }
 *   POST ?a=join      {name?}       -> { token, contributor, name }
 *   GET  ?a=work&token=T            -> { unit: {...} } | { idle:true, message }
 *   POST ?a=submit    {token, unit_id, digest, results}
 *                                   -> { accepted, credited, status }
 *   GET  ?a=stats                   -> { totals, leaderboard }
 *   GET  ?a=hits&limit=N            -> { hits: [...] }
 *   POST ?a=ingest    (key)         -> { added, skipped }
 *   POST ?a=canary    (key)         -> { stored }
 *
 * 3.0 — teams, public contributor records, and an honest way to leave:
 *   POST ?a=team_create {token, name} -> { team: {id, code, name, members, units, credits} }
 *   POST ?a=team_join   {token, code} -> { team: {...same} }        (idempotent; switches)
 *   POST ?a=team_leave  {token}       -> { ok:true }                (idempotent)
 *   GET  ?a=team&code=X               -> { team: {code, name, members, units, credits, created_at},
 *                                          board: [{name, units, credits}] }
 *   GET  ?a=contributor&id=N          -> { contributor: {id, name, units, credits, created_at, rank, team|null} }
 *   GET  ?a=me&token=T                -> { contributor: {id, name, units, credits, created_at, team|null} }
 *   POST ?a=leave       {token}       -> { ok:true }   (hide the public record; work is never deleted)
 *   ?a=stats additionally carries teams: [{code, name, members, units, credits}] (top 10).
 *
 * PHP 8 + pdo_sqlite. No framework, no cookies, no sessions, no dependencies.
 */

declare(strict_types=1);

require_once __DIR__ . '/db.php';

/* ————————————————————————— configuration ————————————————————————— */

define('LOS_ENGINE_FALLBACK', 'los-chem-2'); // app/js/chem/targets.js ENGINE_VERSION
define('LOS_BATCH', 40);          // molecules per work unit
define('LOS_MAX_ISSUES', 4);      // a unit is never handed out more than this
define('LOS_LEASE', 1800);        // seconds a holder has to answer before a unit is abandoned
define('LOS_CANARY_ONE_IN', 20);  // roughly 1 issue in 20 is a canary
define('LOS_QUORUM', 2);          // agreeing contributors needed to verify
define('LOS_MAX_BODY', 262144);   // 256KB request cap
define('LOS_JSON_BUDGET', 9000);  // list responses stay well under 10KB
define('LOS_SMILES_MAX', 200);    // stored/served SMILES length cap
define('LOS_INGEST_MAX', 500);    // molecules per ingest call
define('LOS_CREDIT_PENDING', 1);
define('LOS_CREDIT_CONFIRMED', 10);
define('LOS_TEAM_CAP', 500);      // visible members a team may hold
define('LOS_TEAM_CODE_LEN', 8);   // join-code length
define('LOS_TEAM_ALPHABET', 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'); // 32 symbols, no 0/O, no 1/I

/* ————————————————————————— response plumbing ————————————————————————— */

header('Content-Type: application/json; charset=utf-8');
// THE CACHE SPLIT (4.0). LiteSpeed on this host caches aggressively and has
// cached 404s before now, so nothing here is ever "public". Two regimes:
//
//   READ endpoints (health / stats / hits / history / team / contributor):
//   Cache-Control: no-cache + a STRONG ETag (sha1 of the JSON body) + 304 to a
//   matching If-None-Match. The strip polls stats every 15 seconds; an
//   unchanged board must cost the server a hash and a 304, not a body.
//
//   WORK endpoints (work / submit / join / leave / team_* / me / ingest /
//   canary): Cache-Control: no-store. A cached work unit would hand two
//   "independent" volunteers the same answer, which is the one thing the
//   consensus rule cannot survive. These are never revalidated because they
//   are never stored.
//
// The default below is the strict one; los_out() relaxes it ONLY for a
// successful response from a read action (see LOS_READ_ACTIONS).
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('Access-Control-Expose-Headers: ETag');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
// Safe with a wildcard: this API has no cookies and no session, so a browser
// cannot carry ambient authority to it. The token is the only credential and it
// must be presented explicitly.
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Ingest-Key');
header('Access-Control-Max-Age: 600');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

/** The read actions: revalidatable (no-cache + ETag + 304). Everything else is
 *  no-store — see THE CACHE SPLIT above. */
define('LOS_READ_ACTIONS', 'health,stats,hits,history,team,contributor');

function los_is_read_action()
{
    $a = isset($_GET['a']) && is_scalar($_GET['a']) ? (string) $_GET['a'] : '';
    return $a !== '' && in_array($a, explode(',', LOS_READ_ACTIONS), true);
}

/** Emit JSON and stop. Never leaks a path, a query or a stack trace. */
function los_out(array $data, $status = 200)
{
    $json = json_encode($data, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    if ($json === false) {
        $json = '{"error":"encode_failed"}';
    }
    if ((int) $status === 200 && los_is_read_action()
        && ($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET') {
        // A strong validator over the exact bytes: the same board hashes the
        // same, and a board that changed by one credit does not.
        $etag = '"' . sha1($json) . '"';
        header('Cache-Control: no-cache');
        header('ETag: ' . $etag);
        $inm = isset($_SERVER['HTTP_IF_NONE_MATCH']) ? (string) $_SERVER['HTTP_IF_NONE_MATCH'] : '';
        if ($inm !== '') {
            foreach (explode(',', $inm) as $candidate) {
                $candidate = trim($candidate);
                if (strncmp($candidate, 'W/', 2) === 0) {
                    $candidate = substr($candidate, 2);
                }
                if ($candidate === $etag || $candidate === '*') {
                    http_response_code(304);
                    exit;
                }
            }
        }
    }
    http_response_code((int) $status);
    echo $json;
    exit;
}

/** A short machine-readable failure. The client never learns anything else. */
function los_fail($code, $status = 400, array $extra = array())
{
    los_out(array_merge(array('error' => (string) $code), $extra), $status);
}

/* ————————————————————————— input plumbing ————————————————————————— */

/**
 * The JSON request body, capped at 256KB. Malformed bodies become an empty
 * array so a hostile payload turns into a normal "missing field" refusal rather
 * than an exception.
 */
function los_body()
{
    static $cached = null;
    if ($cached !== null) {
        return $cached;
    }
    $cached = array();

    $declared = isset($_SERVER['CONTENT_LENGTH']) ? (int) $_SERVER['CONTENT_LENGTH'] : 0;
    if ($declared > LOS_MAX_BODY) {
        los_fail('body_too_large', 413);
    }

    $fh = @fopen('php://input', 'rb');
    if ($fh === false) {
        return $cached;
    }
    $raw = @stream_get_contents($fh, LOS_MAX_BODY + 1);
    @fclose($fh);
    if (!is_string($raw) || $raw === '') {
        return $cached;
    }
    if (strlen($raw) > LOS_MAX_BODY) {
        los_fail('body_too_large', 413);
    }

    $decoded = json_decode($raw, true, 32);
    if (is_array($decoded)) {
        $cached = $decoded;
    }
    return $cached;
}

/** A scalar parameter: request body first, then the query string. */
function los_param($key, $default = null)
{
    $body = los_body();
    if (array_key_exists($key, $body) && (is_scalar($body[$key]) || $body[$key] === null)) {
        return $body[$key];
    }
    if (isset($_GET[$key]) && is_scalar($_GET[$key])) {
        return $_GET[$key];
    }
    return $default;
}

/** True for a PHP array that is a plain list (0..n-1). PHP 8.0-safe. */
function los_is_list($v)
{
    if (!is_array($v)) {
        return false;
    }
    $i = 0;
    foreach ($v as $k => $_ignored) {
        if ($k !== $i++) {
            return false;
        }
    }
    return true;
}

/** An integer, or null when the value is not integral. Never throws. */
function los_int($v)
{
    if (is_int($v)) {
        return $v;
    }
    if (is_float($v)) {
        return (floor($v) === $v && is_finite($v)) ? (int) $v : null;
    }
    if (is_string($v) && preg_match('/^-?[0-9]{1,12}$/', $v) === 1) {
        return (int) $v;
    }
    return null;
}

/** Printable-ASCII display name, markup characters removed, 24 chars max. */
function los_clean_name($raw)
{
    if (!is_string($raw)) {
        return 'anonymous';
    }
    $out = '';
    $len = strlen($raw);
    for ($i = 0; $i < $len && strlen($out) < 64; $i++) {
        $c = $raw[$i];
        $o = ord($c);
        if ($o < 32 || $o > 126) {
            continue;                       // control bytes, UTF-8 tails
        }
        if (strpos('<>&"\'\\`', $c) !== false) {
            continue;                       // markup and quoting characters
        }
        $out .= $c;
    }
    $out = trim(preg_replace('/\s+/', ' ', $out));
    if (strlen($out) > 24) {
        $out = rtrim(substr($out, 0, 24));
    }
    return $out === '' ? 'anonymous' : $out;
}

/** SMILES as we are willing to store or serve it. Null when unusable. */
function los_clean_smiles($raw)
{
    if (!is_string($raw)) {
        return null;
    }
    $s = trim($raw);
    if ($s === '' || strlen($s) > LOS_SMILES_MAX) {
        return null;                        // a 9000-character "SMILES" is not one
    }
    for ($i = 0, $n = strlen($s); $i < $n; $i++) {
        $o = ord($s[$i]);
        if ($o < 33 || $o > 126) {
            return null;                    // SMILES is printable ASCII, no spaces
        }
    }
    return $s;
}

/** A short opaque token-ish string: printable ASCII, bounded. */
function los_clean_short($raw, $max)
{
    if (!is_string($raw)) {
        return '';
    }
    $out = '';
    $len = strlen($raw);
    for ($i = 0; $i < $len && strlen($out) < $max; $i++) {
        $o = ord($raw[$i]);
        if ($o >= 32 && $o <= 126 && strpos('<>&"\'\\`', $raw[$i]) === false) {
            $out .= $raw[$i];
        }
    }
    return trim($out);
}

/* ————————————————————————— identity and limits ————————————————————————— */

/**
 * A stable, non-reversible client key for rate limiting. The raw IP is hashed
 * with a per-install salt and is never written to disk or logged.
 */
function los_client_hash(PDO $db)
{
    static $h = null;
    if ($h !== null) {
        return $h;
    }
    $salt = los_meta_get($db, 'ip_salt');
    if (!is_string($salt) || strlen($salt) < 16) {
        $salt = bin2hex(random_bytes(16));
        los_meta_set($db, 'ip_salt', $salt);
    }
    // REMOTE_ADDR only. X-Forwarded-For is caller-controlled, so trusting it
    // would let anyone mint a fresh rate-limit bucket per request.
    $ip = isset($_SERVER['REMOTE_ADDR']) && is_string($_SERVER['REMOTE_ADDR'])
        ? $_SERVER['REMOTE_ADDR'] : 'unknown';
    // The address is hashed with the per-install salt and the digest is all
    // that is ever written or compared. Nothing keeps the raw REMOTE_ADDR.
    $h = hash('sha256', $ip . '|' . $salt);
    return $h;
}

/** Fixed-window limiter keyed by the caller's IP hash. False when over budget. */
function los_rate(PDO $db, $bucket, $limit, $window)
{
    return los_rate_key($db, $bucket . ':' . substr(los_client_hash($db), 0, 32), $limit, $window);
}

/**
 * Fixed-window limiter keyed by contributor id, for actions whose natural
 * unit of abuse is a token rather than an address (one person founding
 * teams in a loop). Keys never collide with the IP-hash form: an id is
 * decimal, a hash prefix is hex and 32 long.
 */
function los_rate_contrib(PDO $db, $bucket, $cid, $limit, $window)
{
    return los_rate_key($db, $bucket . ':c' . (int) $cid, $limit, $window);
}

/** The limiter itself: one row per key, a window start and a count. */
function los_rate_key(PDO $db, $k, $limit, $window)
{
    $now = time();

    $st = $db->prepare('SELECT window_start, n FROM ratelimit WHERE k = ?');
    $st->execute(array($k));
    $row = $st->fetch();
    $st->closeCursor();                     // see los_meta_get(): read->write upgrade

    if ($row === false || ($now - (int) $row['window_start']) >= (int) $window) {
        $ins = $db->prepare('INSERT OR REPLACE INTO ratelimit(k, window_start, n) VALUES(?, ?, 1)');
        $ins->execute(array($k, $now));
        // Opportunistic sweep so the table cannot grow without bound.
        if (random_int(1, 200) === 1) {
            $db->prepare('DELETE FROM ratelimit WHERE window_start < ?')
               ->execute(array($now - 86400));
        }
        return true;
    }
    if ((int) $row['n'] >= (int) $limit) {
        return false;
    }
    $db->prepare('UPDATE ratelimit SET n = n + 1 WHERE k = ?')->execute(array($k));
    return true;
}

/** Resolve a contributor token. Returns the row, or null. */
function los_contributor(PDO $db, $token)
{
    if (!is_string($token) || preg_match('/^[0-9a-f]{8,64}$/', $token) !== 1) {
        return null;                        // an injection-shaped token is just unknown
    }
    $st = $db->prepare('SELECT id, name, credits, units, flagged, team_id, hidden, created_at
                          FROM contributors WHERE token_hash = ?');
    $st->execute(array(hash('sha256', $token)));
    $row = $st->fetch();
    $st->closeCursor();                     // see los_meta_get(): read->write upgrade
    if ($row === false) {
        return null;
    }
    $db->prepare('UPDATE contributors SET last_seen = ? WHERE id = ?')
       ->execute(array(time(), (int) $row['id']));
    return $row;
}

/* ————————————————————————— the ingest door ————————————————————————— */

/**
 * The harvester key, read from ONE location OUTSIDE the web root: the api/
 * directory's grandparent, beside public_html on the shared host and beside
 * saas/ in a checkout. A second candidate one level up (los-private/ sitting
 * next to api/) used to be honoured, but on the host that directory is INSIDE
 * public_html and api/.htaccess governs only api/ — a key put there is
 * web-readable, so it is no longer an accepted location at all.
 *
 * Missing or empty file => null => the door is shut. "No key configured" is
 * never "everyone allowed".
 */
function los_ingest_key()
{
    // Two candidate locations, furthest-outside-the-web-root first:
    //   ../../../  on the live host this is /los-private, a SIBLING of
    //              public_html — unreachable over HTTP, and exactly where
    //              .github/workflows/deploy.yml uploads the secret.
    //   ../../     in a checkout this is <repo>/los-private, beside saas/ —
    //              the layout qa/api.mjs exercises.
    // On the host that second path resolves INSIDE public_html, where a key
    // would be web-readable; the DOCUMENT_ROOT guard rejects it there. So one
    // list is correct in both layouts without either having to know about the
    // other, and a key in a served directory is never honoured anywhere.
    $root = isset($_SERVER['DOCUMENT_ROOT']) && is_string($_SERVER['DOCUMENT_ROOT'])
        ? realpath($_SERVER['DOCUMENT_ROOT']) : false;

    foreach ([__DIR__ . '/../../../los-private/ingest-key.txt',
              __DIR__ . '/../../los-private/ingest-key.txt'] as $p) {
        if (!is_file($p) || !is_readable($p)) {
            continue;
        }
        $real = realpath($p);
        if ($root !== false && $real !== false && strpos($real, rtrim($root, '/') . '/') === 0) {
            continue;   // inside the served tree: never a valid key location
        }
        $k = @file_get_contents($p);
        if (!is_string($k)) {
            continue;
        }
        $k = trim($k);
        if ($k !== '') {
            return $k;
        }
    }
    return null;
}

/**
 * Refuse unless the caller presented the configured key. Fails closed.
 *
 * The offered key is read from the JSON body or the X-Ingest-Key header and
 * NEVER from the query string: query strings are written to access logs, proxy
 * logs and Referer headers, so one URL-bar test of the endpoint would spill the
 * harvester credential into files nobody treats as secret. tools/harvest.mjs
 * already sends both the body field and the header.
 */
function los_require_key()
{
    $configured = los_ingest_key();
    if ($configured === null) {
        los_fail('ingest_not_configured', 403, array(
            'message' => 'This server has no harvester key installed, so key-protected actions are closed.',
        ));
    }
    $body    = los_body();
    $offered = (isset($body['key']) && is_string($body['key'])) ? $body['key'] : null;
    if ($offered === null && isset($_SERVER['HTTP_X_INGEST_KEY']) && is_string($_SERVER['HTTP_X_INGEST_KEY'])) {
        $offered = $_SERVER['HTTP_X_INGEST_KEY'];
    }
    if (!is_string($offered) || $offered === '' || !hash_equals($configured, $offered)) {
        los_fail('forbidden', 403, array('message' => 'Bad or missing harvester key.'));
    }
}

/* ————————————————————————— engine identity ————————————————————————— */

/**
 * The engine version and reference-set digest a work unit must be screened
 * with. The server cannot compute targetsDigest() (that is JS), so the
 * harvester pins them on any ingest/canary call and they are remembered.
 * Until pinned, targets_digest is the empty string, which the client reads as
 * "unspecified — do not gate on it".
 */
function los_engine(PDO $db)
{
    $e = los_meta_get($db, 'engine', LOS_ENGINE_FALLBACK);
    return is_string($e) && $e !== '' ? $e : LOS_ENGINE_FALLBACK;
}

function los_targets_digest(PDO $db)
{
    $d = los_meta_get($db, 'targets_digest', '');
    return is_string($d) ? $d : '';
}

/** Let the harvester pin engine identity alongside the molecules it ships. */
function los_pin_engine(PDO $db)
{
    $engine = los_param('engine', null);
    if (is_string($engine)) {
        $engine = los_clean_short($engine, 40);
        if ($engine !== '') {
            los_meta_set($db, 'engine', $engine);
        }
    }
    $td = los_param('targets_digest', null);
    if (is_string($td) && preg_match('/^[0-9a-f]{64}$/', $td) === 1) {
        $was = los_meta_get($db, 'targets_digest', '');
        los_meta_set($db, 'targets_digest', $td);
        if ($was !== '' && $was !== $td) {
            los_retire_old_units($db, $td);
        }
    }
}

/**
 * The reference set changed (a corrected molecule, a new engine). Every unit
 * still carrying the old digest is unanswerable now: a current client refuses
 * it, and the old clients that could answer it must not be able to "confirm"
 * each other's work under a set nobody screens against any more. So open and
 * conflicted units are retired and their molecules go back to the pool, and
 * old canaries — whose known answer was computed under the old set — are
 * removed. Confirmed units and verified hits are history and stay exactly as
 * they are. Called inside the ingest/canary transactions' caller, so it takes
 * its own transaction here.
 */
function los_retire_old_units(PDO $db, $current)
{
    los_tx($db, function () use ($db, $current) {
        $st = $db->prepare("SELECT id, mol_ids FROM units
                             WHERE canary_digest IS NULL
                               AND status IN ('open','conflict')
                               AND targets_digest <> ?");
        $st->execute(array($current));
        $rows = $st->fetchAll();
        $st->closeCursor();
        $upd = $db->prepare("UPDATE units SET status = 'stale' WHERE id = ?");
        foreach ($rows as $u) {
            $upd->execute(array($u['id']));
            $ids = los_unit_mols($u['mol_ids']);
            if (!$ids) {
                continue;
            }
            $ph  = implode(',', array_fill(0, count($ids), '?'));
            $rst = $db->prepare("UPDATE molecules SET state = 'pending'
                                  WHERE id IN ($ph) AND state <> 'verified'");
            $rst->execute($ids);
        }
        $db->prepare("DELETE FROM units WHERE canary_digest IS NOT NULL AND targets_digest <> ?")
           ->execute(array($current));
    });
}

/* ————————————————————————— shared queries ————————————————————————— */

function los_count(PDO $db, $sql, array $args = array())
{
    $st = $db->prepare($sql);
    $st->execute($args);
    $n = (int) $st->fetchColumn();
    $st->closeCursor();                     // see los_meta_get(): read->write upgrade
    return $n;
}

/** Decode a unit's mol_ids column into a list of ints. Never throws. */
function los_unit_mols($json)
{
    $ids = json_decode(is_string($json) ? $json : '[]', true);
    if (!is_array($ids)) {
        return array();
    }
    $out = array();
    foreach ($ids as $id) {
        $i = los_int($id);
        if ($i !== null && $i > 0) {
            $out[] = $i;
        }
    }
    return $out;
}

/**
 * Trim a molecule list to what one work response is allowed to carry, and
 * return it in wire form. This is the ONLY place the served slice is decided,
 * so ?a=canary can ask, before it arms anything, whether the unit it is about
 * to store will be served whole. A canary whose known-good digest covers
 * molecules the server will not hand out is worse than no canary: every honest
 * volunteer who answers it is flagged as a fabricator.
 */
function los_fit_molecules(array $rows)
{
    $out   = array();
    $bytes = 0;
    foreach ($rows as $m) {
        $s      = substr((string) $m['smiles'], 0, LOS_SMILES_MAX);
        $bytes += strlen($s) + 30;
        if ($out && $bytes > LOS_JSON_BUDGET) {
            break;                          // never blow the 10KB ceiling
        }
        $out[] = array('id' => (int) $m['id'], 'smiles' => $s);
    }
    return $out;
}

/**
 * Retire units whose holders have all had their turn AND have all run out of
 * time, and return their molecules to the pool so they are not stranded in
 * 'issued' forever. Cheap, and only touches exhausted rows.
 *
 * The lease is the whole point. Issue count alone is not evidence that anybody
 * failed: with LOS_MAX_ISSUES=4, four volunteers merely HOLDING a unit used to
 * stale it on the fifth ?a=work, so the same molecules were immediately
 * re-carved into a second live unit. Two quorums then formed over the same
 * molecules with two different (both legitimate) digests, whichever landed last
 * owning the hit row, and the public "screened" total ran past "harvested".
 * A unit is only abandoned when its most recent issue is older than LOS_LEASE,
 * and action_submit refuses a stale unit outright.
 */
function los_reap_stale(PDO $db)
{
    // CAST(? AS INTEGER) and an explicit PARAM_INT binding, both on purpose:
    // PDO binds every execute() value as TEXT, and a COALESCE() expression —
    // unlike a bare column — carries no type affinity, so SQLite would compare
    // an INTEGER against a TEXT and, by its type ordering, call EVERY timestamp
    // smaller than the cut-off. That silently staled every unit the moment its
    // fourth holder took it, which is the exact bug this lease exists to fix.
    $st = $db->prepare("SELECT u.id AS id, u.mol_ids AS mol_ids FROM units u
                         WHERE u.canary_digest IS NULL
                           AND u.status IN ('open','conflict')
                           AND u.issues >= CAST(? AS INTEGER)
                           AND COALESCE((SELECT MAX(i.issued_at) FROM issued i
                                          WHERE i.unit_id = u.id), u.created_at) < CAST(? AS INTEGER)
                         LIMIT 20");
    $st->bindValue(1, LOS_MAX_ISSUES, PDO::PARAM_INT);
    $st->bindValue(2, time() - LOS_LEASE, PDO::PARAM_INT);
    $st->execute();
    $rows = $st->fetchAll();
    if (!$rows) {
        return;
    }
    $upd = $db->prepare("UPDATE units SET status = 'stale' WHERE id = ?");
    foreach ($rows as $u) {
        $upd->execute(array($u['id']));
        $ids = los_unit_mols($u['mol_ids']);
        if (!$ids) {
            continue;
        }
        $ph  = implode(',', array_fill(0, count($ids), '?'));
        $rst = $db->prepare("UPDATE molecules SET state = 'pending'
                              WHERE id IN ($ph) AND state <> 'verified'");
        $rst->execute($ids);
    }
}

/* ————————————————————————— actions ————————————————————————— */

/**
 * The public read endpoints share one generous bucket. Every one of them runs
 * several COUNT(*) scans and a sort, nothing may cache them (a cached work unit
 * would hand two volunteers the same "independent" answer, so the whole API is
 * no-store), and until now they were the only actions with no limit at all —
 * one unauthenticated loop could pin the database on a shared host.
 */
function los_rate_read(PDO $db)
{
    if (!los_rate($db, 'read', 3600, 3600)) {
        los_fail('rate_limited', 429);
    }
}

function action_health(PDO $db)
{
    los_rate_read($db);
    los_out(array(
        'ok'             => true,
        'engine'         => los_engine($db),
        'targets_digest' => los_targets_digest($db),
        'molecules'      => los_count($db, 'SELECT COUNT(*) FROM molecules'),
        'screened'       => (int) los_meta_get($db, 'screened', '0'),
        'verified'       => los_count($db, "SELECT COUNT(*) FROM molecules WHERE state = 'verified'"),
        // Contributors on the public record: one who pressed ?a=leave is
        // counted nowhere public, here included.
        'contributors'   => los_count($db, 'SELECT COUNT(*) FROM contributors WHERE hidden = 0'),
        // A boolean, never the key, never the path it lives at.
        'ingest_armed'   => los_ingest_key() !== null,
    ));
}

function action_join(PDO $db)
{
    if (!los_rate($db, 'join', 60, 3600)) {
        los_fail('rate_limited', 429);
    }

    $name  = los_clean_name(los_param('name', 'anonymous'));
    $token = bin2hex(random_bytes(16));     // 32 hex, shown exactly once
    $now   = time();

    $st = $db->prepare('INSERT INTO contributors(token_hash, name, credits, units, flagged, created_at, last_seen)
                        VALUES(?, ?, 0, 0, 0, ?, ?)');
    $st->execute(array(hash('sha256', $token), $name, $now, $now));

    los_out(array(
        'token'       => $token,
        'contributor' => (int) $db->lastInsertId(),
        'name'        => $name,
    ));
}

/**
 * A contributor a canary caught fabricating results draws no more work and
 * submits no more results.
 *
 * Leaving them running was not "self-harm": their submissions are invisible to
 * the agreement query (which counts only unflagged contributors), but they were
 * still consuming a unit's exclusive per-contributor issue slot. Three minted
 * accounts could hold three of a unit's four slots, so it could never reach
 * quorum, went stale, recycled its molecules and the attack repeated over the
 * whole pool. Refusing at the door is what makes flagging cost the fabricator
 * rather than the swarm.
 */
function los_refuse_flagged(array $me)
{
    if ((int) $me['flagged'] === 1) {
        los_fail('flagged', 403, array(
            'message' => 'This contributor answered a check unit with a known answer incorrectly, '
                       . 'so no further work is issued to it and no further results are accepted.',
        ));
    }
}

function action_work(PDO $db)
{
    if (!los_rate($db, 'work', 900, 3600)) {
        los_fail('rate_limited', 429);
    }
    $me = los_contributor($db, los_param('token', ''));
    if ($me === null) {
        los_fail('unknown_token', 401);
    }
    los_refuse_flagged($me);
    $cid = (int) $me['id'];

    /* FAIL CLOSED ON AN UNPINNED SERVER.
     *
     * A unit carries the reference-set digest it must be screened against, and
     * that is what stops a volunteer running a stale bundle from "confirming"
     * work computed against a different set of reference molecules. Until the
     * harvester's first ingest pins that digest, the server does not know it,
     * and a unit issued with an empty one is a unit nobody can check — the
     * client treats a blank digest as "no opinion" and screens it anyway.
     *
     * That window is exactly when a mismatch is most likely (a fresh deploy,
     * someone's month-old tab), so no work leaves here until the reference set
     * is known. The cost is nil: the same harvest that supplies the molecules
     * pins the digest in the same request. */
    if (los_targets_digest($db) === '') {
        los_out(array(
            'idle'    => true,
            'message' => 'This server has not been pinned to a reference set yet, so there is nothing '
                       . 'anyone could verify. The harvester pins it with its first delivery.'
        ));
    }

    $pin  = los_targets_digest($db);
    $unit = los_tx($db, function () use ($db, $cid, $pin) {
        los_reap_stale($db);

        /* — roughly 1 issue in 20 is a canary the server can already grade — */
        if (random_int(1, LOS_CANARY_ONE_IN) === 1) {
            $st = $db->prepare('SELECT id, engine, targets_digest, mol_ids FROM units
                                 WHERE canary_digest IS NOT NULL
                                   AND targets_digest = ?
                                   AND id NOT IN (SELECT unit_id FROM issued  WHERE contributor = ?)
                                   AND id NOT IN (SELECT unit_id FROM results WHERE contributor = ?)
                                 ORDER BY created_at ASC LIMIT 1');
            $st->execute(array($pin, $cid, $cid));
            $c = $st->fetch();
            if ($c !== false) {
                return los_issue($db, $c, $cid, true);
            }
        }

        /* — redundancy first: a unit somebody else already holds is worth more
             than a fresh one, because agreement is what makes a result real — */
        $st = $db->prepare("SELECT id, engine, targets_digest, mol_ids FROM units
                             WHERE canary_digest IS NULL
                               AND status IN ('open','conflict')
                               AND targets_digest = ?
                               AND issues < ?
                               AND id NOT IN (SELECT unit_id FROM issued  WHERE contributor = ?)
                               AND id NOT IN (SELECT unit_id FROM results WHERE contributor = ?)
                             ORDER BY created_at ASC LIMIT 1");
        $st->execute(array($pin, LOS_MAX_ISSUES, $cid, $cid));
        $u = $st->fetch();
        if ($u !== false) {
            return los_issue($db, $u, $cid, false);
        }

        /* — otherwise carve a new unit out of the pending pool — */
        $st = $db->prepare("SELECT id, smiles FROM molecules
                             WHERE state = 'pending' AND smiles IS NOT NULL AND smiles <> ''
                             ORDER BY id ASC LIMIT ?");
        $st->bindValue(1, LOS_BATCH, PDO::PARAM_INT);
        $st->execute();
        $mols = $st->fetchAll();
        if (!$mols) {
            return null;
        }

        // Keep the whole response comfortably inside the 10KB ceiling.
        $picked = array();
        $bytes  = 0;
        foreach ($mols as $m) {
            $cost = strlen((string) $m['smiles']) + 30;
            if ($picked && ($bytes + $cost) > LOS_JSON_BUDGET) {
                break;
            }
            $bytes   += $cost;
            $picked[] = array('id' => (int) $m['id'], 'smiles' => (string) $m['smiles']);
        }

        $ids     = array();
        foreach ($picked as $p) { $ids[] = $p['id']; }
        $unitId  = 'u' . bin2hex(random_bytes(8));
        $now     = time();

        $db->prepare('INSERT INTO units(id, created_at, engine, targets_digest, mol_ids, issues, status, canary_digest)
                      VALUES(?, ?, ?, ?, ?, 0, \'open\', NULL)')
           ->execute(array($unitId, $now, los_engine($db), los_targets_digest($db), json_encode($ids)));

        $ph = implode(',', array_fill(0, count($ids), '?'));
        $db->prepare("UPDATE molecules SET state = 'issued' WHERE id IN ($ph) AND state = 'pending'")
           ->execute($ids);

        return los_issue($db, array(
            'id'             => $unitId,
            'engine'         => los_engine($db),
            'targets_digest' => los_targets_digest($db),
            'mol_ids'        => json_encode($ids),
        ), $cid, false);
    });

    if ($unit === null) {
        los_out(array(
            'idle'    => true,
            'message' => 'Nothing to screen right now — the harvester tops the pool up daily. Thanks for the cycles.',
        ));
    }
    los_out(array('unit' => $unit));
}

/** Record the issue and build the wire form of a unit. */
function los_issue(PDO $db, array $u, $contributorId, $isCanary)
{
    $now = time();
    $db->prepare('INSERT OR IGNORE INTO issued(unit_id, contributor, issued_at) VALUES(?, ?, ?)')
       ->execute(array($u['id'], $contributorId, $now));
    $db->prepare('UPDATE units SET issues = issues + 1 WHERE id = ?')->execute(array($u['id']));

    $ids = los_unit_mols($u['mol_ids']);
    $mols = array();
    if ($ids) {
        $ph = implode(',', array_fill(0, count($ids), '?'));
        $st = $db->prepare("SELECT id, smiles FROM molecules WHERE id IN ($ph) ORDER BY id ASC");
        $st->execute($ids);
        $mols = los_fit_molecules($st->fetchAll());
    }

    // A canary looks exactly like ordinary work on the wire. It has to: a unit a
    // client could recognise as a test is a test that catches nobody.
    return array(
        'unit_id'        => (string) $u['id'],
        'engine'         => isset($u['engine']) && is_string($u['engine']) && $u['engine'] !== ''
                            ? $u['engine'] : los_engine($db),
        'targets_digest' => isset($u['targets_digest']) && is_string($u['targets_digest'])
                            ? $u['targets_digest'] : los_targets_digest($db),
        'molecules'      => $mols,
    );
}

/**
 * True when a canary's stored molecule list is exactly what a volunteer would
 * be served for it: no duplicate ids, no row missing, and the whole list inside
 * one work response's byte budget. Only then can the known-good digest be
 * reached by an honest screening.
 */
function los_canary_answerable(PDO $db, array $unit)
{
    $ids = los_unit_mols($unit['mol_ids']);
    if (!$ids || count(array_unique($ids)) !== count($ids)) {
        return false;
    }
    $ph  = implode(',', array_fill(0, count($ids), '?'));
    $st  = $db->prepare("SELECT id, smiles FROM molecules WHERE id IN ($ph) ORDER BY id ASC");
    $st->execute($ids);
    $rows = $st->fetchAll();
    $st->closeCursor();
    return count(los_fit_molecules($rows)) === count($ids);
}

function action_submit(PDO $db)
{
    if (!los_rate($db, 'submit', 900, 3600)) {
        los_fail('rate_limited', 429);
    }

    $me = los_contributor($db, los_param('token', ''));
    if ($me === null) {
        los_fail('unknown_token', 401);
    }
    los_refuse_flagged($me);
    $cid = (int) $me['id'];

    $unitId = los_param('unit_id', '');
    if (!is_string($unitId) || $unitId === '' || strlen($unitId) > 64) {
        los_fail('bad_unit_id', 400);
    }
    $digest = los_param('digest', '');
    if (!is_string($digest) || preg_match('/^[0-9a-f]{64}$/', $digest) !== 1) {
        los_fail('bad_digest', 400);
    }

    $st = $db->prepare('SELECT id, mol_ids, status, canary_digest FROM units WHERE id = ?');
    $st->execute(array($unitId));
    $unit = $st->fetch();
    $st->closeCursor();                     // see los_meta_get(): read->write upgrade
    if ($unit === false) {
        los_fail('unknown_unit', 404);
    }

    /* — the canary gate comes first: a known-good unit answered wrongly is a
         fabricated submission whether or not we handed it out — */
    $canary = $unit['canary_digest'];
    if (is_string($canary) && $canary !== '' && !los_canary_answerable($db, $unit)) {
        // A canary whose stored molecule list is not exactly what ?a=work
        // serves cannot be answered correctly by anybody, so a mismatch here is
        // evidence of a broken canary, not of a fabricator. ?a=canary refuses
        // to arm such a unit now, but a row stored by an earlier build may
        // still be sitting in a live database, and there is no un-flag path in
        // this API. Refuse the submission; never flag on it.
        los_fail('unit_unanswerable', 409, array(
            'message' => 'That check unit is mis-stored on the server and cannot be answered. Nothing is held against this contributor.',
        ));
    }
    if (is_string($canary) && $canary !== '' && !hash_equals($canary, $digest)) {
        los_tx($db, function () use ($db, $cid) {
            $db->prepare('UPDATE contributors SET flagged = 1 WHERE id = ?')->execute(array($cid));
            // Discard everything of theirs that is not already part of a
            // confirmed unit: work from a proven fabricator is worthless.
            $db->prepare("DELETE FROM results WHERE contributor = ? AND unit_id IN
                          (SELECT id FROM units WHERE status <> 'confirmed')")->execute(array($cid));
        });
        los_out(array(
            'accepted' => false,
            'credited' => 0,
            'status'   => 'canary_failed',
            'message'  => 'This unit had a known answer and the submitted digest did not match it.',
        ));
    }

    /* — an abandoned unit takes no more answers. Its molecules have gone back
         to the pool and may already be live in another unit, so accepting a
         late digest here is how the same molecules end up with two quorums and
         two different (both honest) answers, one silently overwriting the
         other. A distinct code so the client discards the unit and asks for
         fresh work instead of retrying this one. — */
    if (($unit['status'] ?? '') === 'stale') {
        los_fail('unit_stale', 409, array(
            'message' => 'That unit was abandoned before this result arrived; its molecules went back to the pool. Ask for new work.',
        ));
    }

    /* — you may only submit work you were actually issued — */
    $iss = $db->prepare('SELECT 1 FROM issued WHERE unit_id = ? AND contributor = ?');
    $iss->execute(array($unitId, $cid));
    $issOk = $iss->fetchColumn();
    $iss->closeCursor();                    // see los_meta_get(): read->write upgrade
    if ($issOk === false) {
        los_fail('not_issued', 409, array('message' => 'That unit was not issued to this contributor.'));
    }

    /* — the results array must match the unit's molecules exactly — */
    $body    = los_body();
    $results = isset($body['results']) ? $body['results'] : null;
    if (!los_is_list($results)) {
        los_fail('bad_results', 400);
    }
    $molIds = los_unit_mols($unit['mol_ids']);
    if (count($results) !== count($molIds)) {
        los_fail('result_count_mismatch', 400);
    }

    $want = array();
    foreach ($molIds as $id) {
        $want[(string) $id] = true;
    }
    $clean = array();
    $seen  = array();
    foreach ($results as $r) {
        if (!is_array($r)) {
            los_fail('bad_result_row', 400);
        }
        $rid = isset($r['id']) && is_scalar($r['id']) ? (string) $r['id'] : '';
        if ($rid === '' || !isset($want[$rid]) || isset($seen[$rid])) {
            los_fail('result_ids_mismatch', 400);
        }
        $seen[$rid] = true;

        $score = isset($r['score']) ? los_int($r['score']) : null;
        if ($score === null || $score < 0 || $score > 1000) {
            los_fail('bad_score', 400);
        }

        $best  = isset($r['best']) ? los_clean_short($r['best'], 40) : '';
        $flags = array();
        if (isset($r['flags']) && los_is_list($r['flags'])) {
            foreach (array_slice($r['flags'], 0, 16) as $f) {
                if (is_scalar($f)) {
                    $flags[] = los_clean_short((string) $f, 32);
                }
            }
        }
        $clean[] = array('id' => $rid, 'score' => $score, 'best' => $best, 'flags' => $flags);
    }

    $outcome = los_tx($db, function () use ($db, $cid, $unitId, $digest, $clean, $unit, $canary) {
        $now = time();

        // One submission per contributor per unit — the UNIQUE index is what
        // stops anyone confirming their own work.
        $dupSt = $db->prepare('SELECT 1 FROM results WHERE unit_id = ? AND contributor = ?');
        $dupSt->execute(array($unitId, $cid));
        $isDup = $dupSt->fetchColumn() !== false;
        $dupSt->closeCursor();
        if ($isDup) {
            return array(
                'accepted' => false,
                'credited' => 0,
                'status'   => 'pending',
                'message'  => 'This contributor has already submitted this unit.',
            );
        }

        $isCanary = is_string($canary) && $canary !== '';
        $first    = los_count($db, 'SELECT COUNT(*) FROM results WHERE unit_id = ?', array($unitId)) === 0;

        $db->prepare('INSERT INTO results(unit_id, contributor, digest, payload, created_at) VALUES(?, ?, ?, ?, ?)')
           ->execute(array($unitId, $cid, $digest, json_encode($clean), $now));

        // Screening progress is measured in molecules actually looked at, and a
        // canary's molecules were counted the first time round.
        if ($first && !$isCanary) {
            los_meta_add($db, 'screened', count(los_unit_mols($unit['mol_ids'])));
        }

        $credited = LOS_CREDIT_PENDING;
        $db->prepare('UPDATE contributors SET credits = credits + ? WHERE id = ?')
           ->execute(array(LOS_CREDIT_PENDING, $cid));

        // A canary that matches is real work, correctly done — credit it, but it
        // never writes hits and never moves a molecule.
        if ($isCanary) {
            $db->prepare('UPDATE contributors SET credits = credits + ?, units = units + 1 WHERE id = ?')
               ->execute(array(LOS_CREDIT_CONFIRMED - LOS_CREDIT_PENDING, $cid));
            return array('accepted' => true, 'credited' => LOS_CREDIT_CONFIRMED, 'status' => 'confirmed');
        }

        /* — count agreement across DISTINCT, unflagged contributors — */
        $agree = $db->prepare('SELECT r.digest AS d, COUNT(DISTINCT r.contributor) AS n
                                 FROM results r JOIN contributors c ON c.id = r.contributor
                                WHERE r.unit_id = ? AND c.flagged = 0
                             GROUP BY r.digest ORDER BY n DESC, d ASC');
        $agree->execute(array($unitId));
        $groups = $agree->fetchAll();

        $winner = null;
        foreach ($groups as $g) {
            if ((int) $g['n'] >= LOS_QUORUM) {
                $winner = $g['d'];
                break;
            }
        }

        if ($winner === null) {
            if (count($groups) >= 2) {
                // Disagreement is quarantined, never averaged. The unit stays
                // issuable so a third opinion can break the tie.
                $db->prepare("UPDATE units SET status = 'conflict' WHERE id = ? AND status = 'open'")
                   ->execute(array($unitId));
                return array('accepted' => true, 'credited' => $credited, 'status' => 'conflict');
            }
            return array('accepted' => true, 'credited' => $credited, 'status' => 'pending');
        }

        /* — promotion: two strangers computed the same thing.
             PROMOTION HAPPENS EXACTLY ONCE. The UPDATE below is the claim: only
             the submission that actually moves the unit out of its unconfirmed
             state writes hits, verifies molecules and pays the winners. Without
             that guard, the 3rd and 4th holder of a unit re-ran the whole block
             and re-credited EVERY earlier winner — four honest volunteers who
             each did one unit's work walked away with 28, 28, 19 and 10 credits
             instead of 10 each, and the leaderboard (the only public reward
             surface this project has) systematically over-paid whoever
             submitted first. A later agreeing submitter is still confirmed and
             still earns their own single unit's credit, below. — */
        $mineWon = hash_equals((string) $winner, $digest);

        $promote = $db->prepare("UPDATE units SET status = 'confirmed' WHERE id = ? AND status <> 'confirmed'");
        $promote->execute(array($unitId));
        $firstPromotion = $promote->rowCount() === 1;

        if ($firstPromotion) {
            $win = $db->prepare('SELECT contributor, payload FROM results WHERE unit_id = ? AND digest = ? ORDER BY id ASC');
            $win->execute(array($unitId, $winner));
            $winners = $win->fetchAll();
            $by      = count($winners);

            $payload = json_decode((string) $winners[0]['payload'], true);
            if (!los_is_list($payload)) {
                $payload = array();
            }

            $molIds = los_unit_mols($unit['mol_ids']);
            $rows   = array();
            if ($molIds) {
                $ph  = implode(',', array_fill(0, count($molIds), '?'));
                $mst = $db->prepare("SELECT id, cid, smiles, formula FROM molecules WHERE id IN ($ph)");
                $mst->execute($molIds);
                foreach ($mst->fetchAll() as $m) {
                    $rows[(string) $m['id']] = $m;
                }
            }

            $hit = $db->prepare('INSERT OR REPLACE INTO hits
                                 (cid, smiles, formula, score, best_target, flags, verified_by, verified_at)
                                 VALUES(?, ?, ?, ?, ?, ?, ?, ?)');
            foreach ($payload as $r) {
                if (!isset($rows[(string) $r['id']])) {
                    continue;
                }
                $m = $rows[(string) $r['id']];
                $hit->execute(array(
                    (string) $m['cid'],
                    substr((string) $m['smiles'], 0, LOS_SMILES_MAX),
                    (string) $m['formula'],
                    (int) $r['score'],
                    (string) $r['best'],
                    json_encode(isset($r['flags']) && is_array($r['flags']) ? $r['flags'] : array()),
                    $by,
                    $now,
                ));
            }

            if ($molIds) {
                $ph = implode(',', array_fill(0, count($molIds), '?'));
                $db->prepare("UPDATE molecules SET state = 'verified' WHERE id IN ($ph)")->execute($molIds);
            }

            // Everyone whose digest carried the day gets the full unit credit —
            // once, here, at the moment the unit is promoted.
            $topup = $db->prepare('UPDATE contributors SET credits = credits + ?, units = units + 1 WHERE id = ?');
            foreach ($winners as $w) {
                $topup->execute(array(LOS_CREDIT_CONFIRMED - LOS_CREDIT_PENDING, (int) $w['contributor']));
            }
        } elseif ($mineWon) {
            // The unit was already confirmed by an earlier quorum and this
            // contributor agrees with it: they get their own unit's credit, and
            // nobody else's is touched.
            $db->prepare('UPDATE contributors SET credits = credits + ?, units = units + 1 WHERE id = ?')
               ->execute(array(LOS_CREDIT_CONFIRMED - LOS_CREDIT_PENDING, $cid));
        }

        if (!$mineWon) {
            // Confirmed, but not by this answer. Saying "confirmed, credited 10"
            // to someone whose digest disagreed would be a plain lie.
            return array('accepted' => true, 'credited' => $credited, 'status' => 'conflict');
        }
        return array('accepted' => true, 'credited' => LOS_CREDIT_CONFIRMED, 'status' => 'confirmed');
    });

    los_out($outcome);
}

function action_stats(PDO $db)
{
    los_rate_read($db);
    $totals = array(
        'harvested'    => los_count($db, 'SELECT COUNT(*) FROM molecules'),
        'screened'     => (int) los_meta_get($db, 'screened', '0'),
        'verified'     => los_count($db, "SELECT COUNT(*) FROM molecules WHERE state = 'verified'"),
        'contributors' => los_count($db, 'SELECT COUNT(*) FROM contributors WHERE hidden = 0'),
        'units_open'   => los_count($db, "SELECT COUNT(*) FROM units
                                           WHERE canary_digest IS NULL AND status IN ('open','conflict')"),
    );

    // Names and totals only — never a token, never a token hash, never an id.
    // hidden = 0: a contributor who left the public record is on no board.
    $st = $db->prepare('SELECT name, units, credits FROM contributors
                         WHERE flagged = 0 AND hidden = 0 AND credits > 0
                      ORDER BY credits DESC, units DESC, id ASC LIMIT 20');
    $st->execute();
    $board = array();
    $bytes = 0;
    foreach ($st->fetchAll() as $r) {
        $name  = los_clean_name($r['name']);
        $bytes += strlen($name) + 48;
        if ($board && $bytes > LOS_JSON_BUDGET) {
            break;
        }
        $board[] = array('name' => $name, 'units' => (int) $r['units'], 'credits' => (int) $r['credits']);
    }

    // Top 10 teams by the credits of their VISIBLE members. A team with no
    // visible member is swept on departure, so every row here has at least
    // one; the HAVING is belt and braces against a stale row.
    $ts = $db->prepare('SELECT t.code AS code, t.name AS name, COUNT(c.id) AS members,
                               COALESCE(SUM(c.units), 0) AS units, COALESCE(SUM(c.credits), 0) AS credits
                          FROM teams t
                          LEFT JOIN contributors c ON c.team_id = t.id AND c.hidden = 0
                      GROUP BY t.id HAVING COUNT(c.id) > 0
                      ORDER BY credits DESC, units DESC, t.id ASC LIMIT 10');
    $ts->execute();
    $teams = array();
    foreach ($ts->fetchAll() as $t) {
        $name   = los_clean_short((string) $t['name'], 24);
        $bytes += strlen($name) + 80;
        if ($teams && $bytes > LOS_JSON_BUDGET) {
            break;
        }
        $teams[] = array(
            'code'    => (string) $t['code'],
            'name'    => $name,
            'members' => (int) $t['members'],
            'units'   => (int) $t['units'],
            'credits' => (int) $t['credits'],
        );
    }

    los_out(array('totals' => $totals, 'leaderboard' => $board, 'teams' => $teams));
}

function action_hits(PDO $db)
{
    los_rate_read($db);
    $limit = los_int(los_param('limit', 25));
    if ($limit === null) {
        $limit = 25;
    }
    $limit = max(1, min(50, $limit));

    /* flags travel with the hit. They are the whole reason a chemist would look
     * at a row twice — "this scores well AND carries a reactive-group alert" is
     * a different story from a clean one — and leaving the column out of this
     * SELECT is why the Lab could only ever print "not reported". */
    $st = $db->prepare('SELECT cid, smiles, formula, score, best_target, flags, verified_by
                          FROM hits ORDER BY score DESC, cid ASC LIMIT ?');
    $st->bindValue(1, $limit, PDO::PARAM_INT);
    $st->execute();

    $hits  = array();
    $bytes = 0;
    foreach ($st->fetchAll() as $h) {
        $smiles = substr((string) $h['smiles'], 0, LOS_SMILES_MAX);
        /* stored as a JSON list; a corrupt or oversized value degrades to an
           empty list rather than breaking the response */
        $flags = array();
        $decoded = json_decode((string) $h['flags'], true);
        if (los_is_list($decoded)) {
            foreach (array_slice($decoded, 0, 8) as $f) {
                if (is_string($f) || is_numeric($f)) {
                    $flags[] = los_clean_short((string) $f, 32);
                }
            }
        }
        $bytes += strlen($smiles) + strlen((string) $h['cid']) + strlen((string) $h['formula'])
                + strlen(implode(',', $flags)) + 100;
        if ($hits && $bytes > LOS_JSON_BUDGET) {
            break;
        }
        $hits[] = array(
            'cid'         => (string) $h['cid'],
            'smiles'      => $smiles,
            'score'       => (int) $h['score'],
            'best_target' => (string) $h['best_target'],
            'formula'     => (string) $h['formula'],
            'flags'       => $flags,
            'verified_by' => (int) $h['verified_by'],
        );
    }

    los_out(array('hits' => $hits));
}

function action_ingest(PDO $db)
{
    los_require_key();
    los_pin_engine($db);

    $body = los_body();
    $mols = isset($body['molecules']) ? $body['molecules'] : null;
    if (!los_is_list($mols)) {
        los_fail('bad_molecules', 400, array('message' => 'molecules must be an array'));
    }
    if (count($mols) > LOS_INGEST_MAX) {
        $mols = array_slice($mols, 0, LOS_INGEST_MAX);
    }

    $added = 0;
    $skipped = 0;
    $rejected = 0;
    $now = time();

    // 'skipped' and 'rejected' are DIFFERENT facts and used to share a counter:
    // a harmless idempotent re-run and a run whose source data was thrown away
    // both reported the same number, so the harvester's log could not tell an
    // operator which had happened. skipped = already known; rejected = the row
    // was unusable (no cid, non-ASCII or over-long SMILES) and was discarded.
    los_tx($db, function () use ($db, $mols, $now, &$added, &$skipped, &$rejected) {
        $ins = $db->prepare('INSERT OR IGNORE INTO molecules(cid, smiles, formula, source, added_at, state)
                             VALUES(?, ?, ?, ?, ?, \'pending\')');
        foreach ($mols as $m) {
            if (!is_array($m)) { $rejected++; continue; }

            // A SQL-shaped cid is just a string here — every write is a bound
            // parameter — but it is still bounded and stripped.
            $cid = isset($m['cid']) && is_scalar($m['cid']) ? los_clean_short((string) $m['cid'], 32) : '';
            $smi = los_clean_smiles(isset($m['smiles']) ? $m['smiles'] : null);
            if ($cid === '' || $smi === null) { $rejected++; continue; }

            // is_scalar, not isset: an array-valued formula would raise an
            // "Array to string conversion" warning, and on a host with
            // display_errors on that warning lands in the response body.
            $formula = (isset($m['formula']) && is_scalar($m['formula']))
                ? los_clean_short((string) $m['formula'], 40) : '';
            $source  = (isset($m['source']) && is_scalar($m['source']))
                ? los_clean_short((string) $m['source'], 40) : 'harvest';

            $ins->execute(array($cid, $smi, $formula, $source, $now));
            if ($ins->rowCount() > 0) { $added++; } else { $skipped++; }
        }
    });

    los_out(array('added' => $added, 'skipped' => $skipped, 'rejected' => $rejected));
}

/** A refusal raised inside a transaction, so the whole attempt rolls back. */
class LosRefusal extends RuntimeException
{
    public $reason;
    public $hint;
    public $status;
    public function __construct($reason, $hint, $status = 400)
    {
        parent::__construct((string) $reason);
        $this->reason = (string) $reason;
        $this->hint   = (string) $hint;
        $this->status = (int) $status;
    }
}

/**
 * Store (or resolve) a canary: a unit whose correct digest the server already
 * knows, used to catch fabricated submissions.
 *
 * TWO CALLS, because a canary's digest is computed over SERVER-ASSIGNED
 * molecule ids and the caller cannot know them in advance (screenUnit's
 * canonical string is engine|targets|unit_id#id:score:best:flags;...). So:
 *
 *   1. POST ?a=canary {unit_id, molecules}          -> {armed:false, unit_id,
 *      engine, targets_digest, molecules:[{id,smiles}]}   — resolves and
 *      returns exactly what will be served, arming nothing.
 *   2. screen those molecules with that unit_id, then
 *      POST ?a=canary {unit_id, digest, molecules}  -> {armed:true, stored:1}
 *
 * Without step 1 no harvester could ever compute a correct canary digest, so
 * every honest volunteer handed one was flagged as a fabricator — there is no
 * un-flag path in this API.
 *
 * Two more rules the stored list must satisfy, both learned the same way:
 *   - ids are DEDUPLICATED. Two posted molecules sharing a cid used to store
 *     mol_ids [1,1,2] while the server serves the 2 distinct rows, and submit's
 *     count check then refused the answer forever.
 *   - the resolved list must FIT one work response. Storing 40 molecules and
 *     serving 39 makes the known-good digest unreachable by construction.
 * Either condition is a refusal, not a repair: a canary that cannot be answered
 * correctly is worse than no canary at all.
 */
function action_canary(PDO $db)
{
    los_require_key();
    los_pin_engine($db);

    $unitId = los_param('unit_id', '');
    if (!is_string($unitId) || $unitId === '' || strlen($unitId) > 64
        || preg_match('/^[A-Za-z0-9_.:-]{1,64}$/', $unitId) !== 1) {
        los_fail('bad_unit_id', 400);
    }

    // No digest field at all => the resolve call. A digest that is PRESENT but
    // unusable — an array, a number, the wrong length — is a refusal, never a
    // silent downgrade to "resolve": the caller asked to arm something, and a
    // door that guesses what they meant is a door that fails open.
    $body    = los_body();
    $offered = array_key_exists('digest', $body) ? $body['digest']
             : (isset($_GET['digest']) ? $_GET['digest'] : null);
    $arming  = !($offered === null || $offered === '');
    if ($arming && (!is_string($offered) || preg_match('/^[0-9a-f]{64}$/', $offered) !== 1)) {
        los_fail('bad_digest', 400);
    }
    $digest = $arming ? (string) $offered : null;

    $mols = isset($body['molecules']) ? $body['molecules'] : null;
    if (!los_is_list($mols) || count($mols) === 0 || count($mols) > LOS_BATCH) {
        los_fail('bad_molecules', 400, array('message' => 'a canary needs 1..' . LOS_BATCH . ' molecules'));
    }

    try {
        $out = los_tx($db, function () use ($db, $unitId, $digest, $arming, $mols) {
            $now = time();
            $ins = $db->prepare('INSERT OR IGNORE INTO molecules(cid, smiles, formula, source, added_at, state)
                                 VALUES(?, ?, ?, ?, ?, \'pending\')');
            $sel = $db->prepare('SELECT id FROM molecules WHERE cid = ?');

            $ids = array();
            foreach ($mols as $m) {
                if (!is_array($m)) { continue; }
                $cid = isset($m['cid']) && is_scalar($m['cid']) ? los_clean_short((string) $m['cid'], 32) : '';
                $smi = los_clean_smiles(isset($m['smiles']) ? $m['smiles'] : null);
                if ($cid === '' || $smi === null) { continue; }
                $ins->execute(array($cid, $smi,
                    (isset($m['formula']) && is_scalar($m['formula']))
                        ? los_clean_short((string) $m['formula'], 40) : '',
                    (isset($m['source']) && is_scalar($m['source']))
                        ? los_clean_short((string) $m['source'], 40) : 'canary',
                    $now));
                $sel->execute(array($cid));
                $row = $sel->fetch();
                $sel->closeCursor();
                if ($row !== false) { $ids[] = (int) $row['id']; }
            }
            if (!$ids) {
                throw new LosRefusal('bad_molecules', 'None of the posted molecules were usable.');
            }
            $ids = array_values(array_unique($ids));
            sort($ids, SORT_NUMERIC);

            // Exactly what ?a=work would serve for this unit.
            $ph  = implode(',', array_fill(0, count($ids), '?'));
            $mst = $db->prepare("SELECT id, smiles FROM molecules WHERE id IN ($ph) ORDER BY id ASC");
            $mst->execute($ids);
            $served = los_fit_molecules($mst->fetchAll());
            if (count($served) !== count($ids)) {
                throw new LosRefusal(
                    'canary_too_large',
                    'A canary must fit one work response: this one resolves to ' . count($ids)
                    . ' molecules and only ' . count($served) . ' would be served.'
                );
            }

            $wire = array(
                'unit_id'        => $unitId,
                'engine'         => los_engine($db),
                'targets_digest' => los_targets_digest($db),
                'molecules'      => $served,
            );

            if (!$arming) {
                // Resolve only: the molecules now have stable ids (cid is
                // UNIQUE, so the arming call resolves to exactly these), and no
                // unit row is created — an un-answerable canary is never armed,
                // and a NULL canary_digest would make this ordinary work.
                return array_merge(array('stored' => 0, 'armed' => false), $wire);
            }

            // Re-storing a canary keeps its issue history: only the answer moves.
            $exists = $db->prepare('SELECT 1 FROM units WHERE id = ?');
            $exists->execute(array($unitId));
            $have = $exists->fetchColumn() !== false;
            $exists->closeCursor();
            if ($have) {
                $db->prepare("UPDATE units SET engine = ?, targets_digest = ?, mol_ids = ?,
                                               canary_digest = ?, status = 'open' WHERE id = ?")
                   ->execute(array(los_engine($db), los_targets_digest($db), json_encode($ids), $digest, $unitId));
            } else {
                $db->prepare("INSERT INTO units(id, created_at, engine, targets_digest, mol_ids, issues, status, canary_digest)
                              VALUES(?, ?, ?, ?, ?, 0, 'open', ?)")
                   ->execute(array($unitId, $now, los_engine($db), los_targets_digest($db), json_encode($ids), $digest));
            }

            return array_merge(array('stored' => 1, 'armed' => true), $wire);
        });
    } catch (LosRefusal $e) {
        los_fail($e->reason, 400, array('message' => $e->hint));
    }

    los_out($out);
}

/* ————————————————————————— 3.0: teams, public records, leaving ————————————————————————— */

/**
 * A fresh join code: LOS_TEAM_CODE_LEN characters from an alphabet with no
 * 0/O or 1/I, so a code read out loud or copied from a screenshot survives.
 * 32 symbols make each byte's low five bits an unbiased draw (256 % 32 === 0).
 */
function los_team_code()
{
    $alphabet = LOS_TEAM_ALPHABET;
    $bytes    = random_bytes(LOS_TEAM_CODE_LEN);
    $code     = '';
    for ($i = 0; $i < LOS_TEAM_CODE_LEN; $i++) {
        $code .= $alphabet[ord($bytes[$i]) & 31];
    }
    return $code;
}

/** A join code as the client typed it, normalised; null when it is not one. */
function los_clean_code($raw)
{
    if (!is_string($raw)) {
        return null;
    }
    $c = strtoupper(trim($raw));
    return preg_match('/^[A-HJ-NP-Z2-9]{8}$/', $c) === 1 ? $c : null;
}

/** A team row by code, or null. */
function los_team_by_code(PDO $db, $code)
{
    $st = $db->prepare('SELECT id, code, name, created_by, created_at FROM teams WHERE code = ?');
    $st->execute(array($code));
    $row = $st->fetch();
    $st->closeCursor();                     // see los_meta_get(): read->write upgrade
    return $row === false ? null : $row;
}

/** A team row by id, or null. */
function los_team_by_id(PDO $db, $id)
{
    $st = $db->prepare('SELECT id, code, name, created_by, created_at FROM teams WHERE id = ?');
    $st->execute(array((int) $id));
    $row = $st->fetch();
    $st->closeCursor();
    return $row === false ? null : $row;
}

/** Aggregates over a team's VISIBLE members: hidden rows count for nothing here. */
function los_team_totals(PDO $db, $teamId)
{
    $st = $db->prepare('SELECT COUNT(*) AS members, COALESCE(SUM(units), 0) AS units,
                               COALESCE(SUM(credits), 0) AS credits
                          FROM contributors WHERE team_id = ? AND hidden = 0');
    $st->execute(array((int) $teamId));
    $row = $st->fetch();
    $st->closeCursor();
    return array(
        'members' => (int) $row['members'],
        'units'   => (int) $row['units'],
        'credits' => (int) $row['credits'],
    );
}

/**
 * The wire form of a team. The private shape (create/join, to a member) carries
 * the id; the public shape (?a=team, ?a=stats) carries created_at instead.
 * Neither ever carries a token, a token hash, or who created it.
 */
function los_team_wire(PDO $db, array $team, $public)
{
    $t   = los_team_totals($db, $team['id']);
    $out = $public ? array() : array('id' => (int) $team['id']);
    $out['code']    = (string) $team['code'];
    $out['name']    = los_clean_short((string) $team['name'], 24);
    $out['members'] = $t['members'];
    $out['units']   = $t['units'];
    $out['credits'] = $t['credits'];
    if ($public) {
        $out['created_at'] = (int) $team['created_at'];
    }
    return $out;
}

/**
 * Delete a team the moment it has no visible member left. Called inside the
 * SAME transaction as the departure (team_leave, a switch, ?a=leave), so a
 * daily create/join/leave leaves nothing behind and the code is simply
 * unknown afterwards. Null/0 is a no-op so callers need not branch.
 */
function los_team_sweep(PDO $db, $teamId)
{
    $teamId = (int) $teamId;
    if ($teamId <= 0) {
        return;
    }
    $db->prepare('DELETE FROM teams WHERE id = ?
                    AND NOT EXISTS (SELECT 1 FROM contributors WHERE team_id = ? AND hidden = 0)')
       ->execute(array($teamId, $teamId));
}

/** The {code, name} a contributor record shows for its team, or null. */
function los_team_ref(PDO $db, $teamId)
{
    if ($teamId === null || (int) $teamId <= 0) {
        return null;
    }
    $t = los_team_by_id($db, (int) $teamId);
    if ($t === null) {
        return null;
    }
    return array('code' => (string) $t['code'], 'name' => los_clean_short((string) $t['name'], 24));
}

/**
 * A token-bearing team action's contributor: known, unflagged, and still on
 * the public record. A contributor who pressed ?a=leave chose to be nobody
 * here; they can keep contributing on that token, but a team is a public
 * face and they gave theirs up. Re-joining the swarm mints a fresh identity.
 */
function los_team_actor(PDO $db)
{
    $me = los_contributor($db, los_param('token', ''));
    if ($me === null) {
        los_fail('unknown_token', 401);
    }
    los_refuse_flagged($me);
    if ((int) $me['hidden'] === 1) {
        los_fail('departed', 403, array(
            'message' => 'This contributor left the public record. Join the swarm again to team up.',
        ));
    }
    return $me;
}

/** Translate a refusal raised inside a team transaction into its response. */
function los_team_refused(LosRefusal $e)
{
    $extra = $e->hint !== '' ? array('message' => $e->hint) : array();
    los_fail($e->reason, $e->status, $extra);
}

/**
 * POST ?a=team_create {token, name} -> {team:{id, code, name, members, units, credits}}
 *
 * The creator is placed in the team. One contributor may found five teams an
 * hour, and only while standing in none (409 already_in_team): switching is
 * ?a=team_join's job, and a founder who wants a new team leaves first. The
 * name is cleaned the way every other stranger-typed string is and must keep
 * two characters (400 bad_name).
 */
function action_team_create(PDO $db)
{
    if (!los_rate($db, 'team_create', 60, 3600)) {
        los_fail('rate_limited', 429);
    }
    $me  = los_team_actor($db);
    $cid = (int) $me['id'];
    if (!los_rate_contrib($db, 'team_create', $cid, 5, 3600)) {
        los_fail('rate_limited', 429);
    }

    $name = los_clean_short(los_param('name', ''), 24);
    if (strlen($name) < 2) {
        los_fail('bad_name', 400, array('message' => 'A team name needs at least two printable characters.'));
    }

    try {
        $team = los_tx($db, function () use ($db, $cid, $name) {
            // Re-read under the write lock: two creates from one token in
            // flight at once must not both succeed.
            $cur = $db->prepare('SELECT team_id FROM contributors WHERE id = ?');
            $cur->execute(array($cid));
            $row = $cur->fetch();
            $cur->closeCursor();
            if ($row !== false && $row['team_id'] !== null && (int) $row['team_id'] > 0) {
                throw new LosRefusal('already_in_team', 'Leave the current team before creating another.', 409);
            }

            // INSERT OR IGNORE + rowCount: a UNIQUE collision on the code is
            // an ignored row, never an exception, and the loop draws again.
            // Under BEGIN IMMEDIATE nobody else can take the code in between.
            $ins = $db->prepare('INSERT OR IGNORE INTO teams(code, name, created_by, created_at) VALUES(?, ?, ?, ?)');
            $now = time();
            $id  = 0;
            for ($attempt = 0; $attempt < 16; $attempt++) {
                $code = los_team_code();
                $ins->execute(array($code, $name, $cid, $now));
                if ($ins->rowCount() === 1) {
                    $id = (int) $db->lastInsertId();
                    break;
                }
            }
            if ($id <= 0) {
                throw new RuntimeException('team code space exhausted');   // 500; astronomically unlikely
            }
            $db->prepare('UPDATE contributors SET team_id = ? WHERE id = ?')->execute(array($id, $cid));
            return los_team_by_id($db, $id);
        });
    } catch (LosRefusal $e) {
        los_team_refused($e);
    }

    los_out(array('team' => los_team_wire($db, $team, false)));
}

/**
 * POST ?a=team_join {token, code} -> {team:{id, code, name, members, units, credits}}
 *
 * Joining the team you already stand in is a success that changes nothing;
 * joining a different one switches you (and sweeps the team you left if it is
 * now empty). A team holds LOS_TEAM_CAP visible members (409 team_full). The
 * per-IP bucket is the code-guessing limit: an unauthenticated storm burns it
 * before any token is even looked up.
 */
function action_team_join(PDO $db)
{
    if (!los_rate($db, 'team_join', 120, 3600)) {
        los_fail('rate_limited', 429);
    }
    $me  = los_team_actor($db);
    $cid = (int) $me['id'];
    if (!los_rate_contrib($db, 'team_join', $cid, 60, 3600)) {
        los_fail('rate_limited', 429);
    }

    $code = los_clean_code(los_param('code', ''));
    if ($code === null) {
        los_fail('bad_code', 400, array('message' => 'A join code is 8 letters or digits.'));
    }

    try {
        $team = los_tx($db, function () use ($db, $cid, $code) {
            $team = los_team_by_code($db, $code);
            if ($team === null) {
                throw new LosRefusal('unknown_team', 'No team has that code.', 404);
            }
            $tid = (int) $team['id'];

            $cur = $db->prepare('SELECT team_id FROM contributors WHERE id = ?');
            $cur->execute(array($cid));
            $row  = $cur->fetch();
            $cur->closeCursor();
            $from = ($row !== false && $row['team_id'] !== null) ? (int) $row['team_id'] : 0;
            if ($from === $tid) {
                return $team;                   // idempotent: already here
            }

            // The cap is checked under the write lock, so 500 simultaneous
            // joins cannot each see 499 and all get in.
            $n = los_count($db, 'SELECT COUNT(*) FROM contributors WHERE team_id = ? AND hidden = 0', array($tid));
            if ($n >= LOS_TEAM_CAP) {
                throw new LosRefusal('team_full', 'That team already has ' . LOS_TEAM_CAP . ' members.', 409);
            }

            $db->prepare('UPDATE contributors SET team_id = ? WHERE id = ?')->execute(array($tid, $cid));
            los_team_sweep($db, $from);         // the team we left, if it is now empty
            return $team;
        });
    } catch (LosRefusal $e) {
        los_team_refused($e);
    }

    los_out(array('team' => los_team_wire($db, $team, false)));
}

/**
 * POST ?a=team_leave {token} -> {ok:true}
 *
 * Idempotent: leaving when in no team is still ok. The team is swept in the
 * same transaction when this was its last visible member.
 */
function action_team_leave(PDO $db)
{
    if (!los_rate($db, 'team_leave', 120, 3600)) {
        los_fail('rate_limited', 429);
    }
    $me = los_contributor($db, los_param('token', ''));
    if ($me === null) {
        los_fail('unknown_token', 401);
    }
    $cid = (int) $me['id'];

    los_tx($db, function () use ($db, $cid) {
        $cur = $db->prepare('SELECT team_id FROM contributors WHERE id = ?');
        $cur->execute(array($cid));
        $row  = $cur->fetch();
        $cur->closeCursor();
        $from = ($row !== false && $row['team_id'] !== null) ? (int) $row['team_id'] : 0;
        $db->prepare('UPDATE contributors SET team_id = NULL WHERE id = ?')->execute(array($cid));
        los_team_sweep($db, $from);
    });

    los_out(array('ok' => true));
}

/**
 * GET ?a=team&code=X -> {team:{code, name, members, units, credits, created_at},
 *                        board:[{name, units, credits}]}
 *
 * Public. The board is the top 20 visible members; a member who left the
 * public record is on no board and in no total.
 */
function action_team(PDO $db)
{
    los_rate_read($db);
    $code = los_clean_code(los_param('code', ''));
    if ($code === null) {
        los_fail('bad_code', 400);
    }
    $team = los_team_by_code($db, $code);
    if ($team === null) {
        los_fail('unknown_team', 404);
    }

    $st = $db->prepare('SELECT name, units, credits FROM contributors
                         WHERE team_id = ? AND hidden = 0
                      ORDER BY credits DESC, units DESC, id ASC LIMIT 20');
    $st->execute(array((int) $team['id']));
    $board = array();
    $bytes = 0;
    foreach ($st->fetchAll() as $r) {
        $name   = los_clean_name($r['name']);
        $bytes += strlen($name) + 48;
        if ($board && $bytes > LOS_JSON_BUDGET) {
            break;
        }
        $board[] = array('name' => $name, 'units' => (int) $r['units'], 'credits' => (int) $r['credits']);
    }

    los_out(array('team' => los_team_wire($db, $team, true), 'board' => $board));
}

/**
 * A contributor id as the public record accepts it: a canonical positive
 * decimal integer — no sign, no leading zero, no exponent, at most 12 digits.
 * Anything else is a 400, never a lookup.
 */
function los_clean_contributor_id($raw)
{
    if (is_int($raw)) {
        return $raw > 0 ? $raw : null;
    }
    if (is_string($raw) && preg_match('/^[1-9][0-9]{0,11}$/', $raw) === 1) {
        return (int) $raw;
    }
    return null;
}

/**
 * GET ?a=contributor&id=N -> {contributor:{id, name, units, credits, created_at, rank,
 *                                          team:{code,name}|null}}
 *
 * Public. rank is 1 + the number of visible contributors with more credits.
 * A contributor who left the public record is unknown here (404), exactly as
 * if they had never been.
 */
function action_contributor(PDO $db)
{
    los_rate_read($db);
    $id = los_clean_contributor_id(los_param('id', null));
    if ($id === null) {
        los_fail('bad_id', 400);
    }
    $st = $db->prepare('SELECT id, name, units, credits, created_at, team_id
                          FROM contributors WHERE id = ? AND hidden = 0');
    $st->execute(array($id));
    $c = $st->fetch();
    $st->closeCursor();
    if ($c === false) {
        los_fail('unknown_contributor', 404);
    }
    $rank = 1 + los_count($db, 'SELECT COUNT(*) FROM contributors WHERE hidden = 0 AND credits > ?',
                          array((int) $c['credits']));

    los_out(array('contributor' => array(
        'id'         => (int) $c['id'],
        'name'       => los_clean_name($c['name']),
        'units'      => (int) $c['units'],
        'credits'    => (int) $c['credits'],
        'created_at' => (int) $c['created_at'],
        'rank'       => $rank,
        'team'       => los_team_ref($db, $c['team_id']),
    )));
}

/**
 * GET ?a=me&token=T -> {contributor:{id, name, units, credits, created_at, team:{code,name}|null}}
 *
 * The holder's own record. Works for a hidden contributor too — it is their
 * token — and shows them what the public sees: 'departed', no team.
 */
function action_me(PDO $db)
{
    if (!los_rate($db, 'me', 900, 3600)) {
        los_fail('rate_limited', 429);
    }
    $me = los_contributor($db, los_param('token', ''));
    if ($me === null) {
        los_fail('unknown_token', 401);
    }
    los_out(array('contributor' => array(
        'id'         => (int) $me['id'],
        'name'       => los_clean_name($me['name']),
        'units'      => (int) $me['units'],
        'credits'    => (int) $me['credits'],
        'created_at' => (int) $me['created_at'],
        'team'       => los_team_ref($db, $me['team_id']),
    )));
}

/**
 * POST ?a=leave {token} -> {ok:true}
 *
 * The honest way out of the public record. The row is hidden, the name is
 * replaced with 'departed', the team membership is dropped (and the team swept
 * if that emptied it). After this the contributor is absent from ?a=stats
 * (leaderboard AND totals.contributors), from every team board and total, and
 * from ?a=contributor.
 *
 * What is NOT touched, on purpose: their results and issued rows. A unit two
 * strangers agreed on stays verified — the agreement happened, and deleting
 * one half of it would turn a verified hit back into one stranger's word.
 * Their token also keeps working for ?a=work and ?a=submit: leaving the
 * record is not leaving the swarm, and a contributor may go on screening
 * anonymously for as long as they like. Idempotent.
 */
function action_leave(PDO $db)
{
    if (!los_rate($db, 'leave', 60, 3600)) {
        los_fail('rate_limited', 429);
    }
    $me = los_contributor($db, los_param('token', ''));
    if ($me === null) {
        los_fail('unknown_token', 401);
    }
    $cid = (int) $me['id'];

    los_tx($db, function () use ($db, $cid) {
        $cur = $db->prepare('SELECT team_id FROM contributors WHERE id = ?');
        $cur->execute(array($cid));
        $row  = $cur->fetch();
        $cur->closeCursor();
        $from = ($row !== false && $row['team_id'] !== null) ? (int) $row['team_id'] : 0;
        $db->prepare("UPDATE contributors SET hidden = 1, team_id = NULL, name = 'departed' WHERE id = ?")
           ->execute(array($cid));
        los_team_sweep($db, $from);
    });

    los_out(array('ok' => true));
}

/* ————————————————————————— dispatch ————————————————————————— */

try {
    $action = isset($_GET['a']) && is_scalar($_GET['a']) ? (string) $_GET['a'] : '';
    if ($action === '') {
        $a = los_param('a', '');
        $action = is_string($a) ? $a : '';
    }
    if (preg_match('/^[a-z_]{1,24}$/', $action) !== 1) {
        los_fail('unknown_action', 404);
    }

    $db = los_db();

    switch ($action) {
        case 'health': action_health($db); break;
        case 'join':   action_join($db);   break;
        case 'work':   action_work($db);   break;
        case 'submit': action_submit($db); break;
        case 'stats':  action_stats($db);  break;
        case 'hits':   action_hits($db);   break;
        case 'ingest': action_ingest($db); break;
        case 'canary': action_canary($db); break;
        /* 3.0 */
        case 'team_create': action_team_create($db); break;
        case 'team_join':   action_team_join($db);   break;
        case 'team_leave':  action_team_leave($db);  break;
        case 'team':        action_team($db);        break;
        case 'contributor': action_contributor($db); break;
        case 'me':          action_me($db);          break;
        case 'leave':       action_leave($db);       break;
        default:
            los_fail('unknown_action', 404);
    }
    los_fail('unknown_action', 404);
} catch (Throwable $e) {
    // Never a stack trace, never a path, never a query. The operator reads the
    // server log; the internet reads a short code.
    error_log('los-api: ' . $e->getMessage());
    los_out(array('error' => 'server_error'), 500);
}
