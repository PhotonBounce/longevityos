/* gdrive-consent — THE ONE-TIME DOOR, opened without installing anything.
 *
 * Drive's refresh token cannot be minted by a machine on its own: a human has
 * to look at a Google consent screen and say yes. Every other credential in
 * this project was pasted into a GitHub secret by the owner; this one cannot
 * be, because Google never shows it on a web page — it is only ever returned
 * to a program, once, in exchange for an authorization code.
 *
 * SO THE OWNER'S PART IS TWO CLICKS AND A COPY, AND NO SOFTWARE.
 *   1. Dispatch the consent workflow with step=url. It prints a link.
 *   2. Open the link, choose the Google account, approve.
 *   3. The browser lands on a http://127.0.0.1:… page that FAILS TO LOAD.
 *      That failure is expected and is the whole trick: the authorization
 *      code is sitting in the address bar of that dead page.
 *   4. Copy that whole address and dispatch the workflow again with
 *      step=exchange and the address pasted in.
 *
 * WHERE THE TOKEN GOES. Not into the log, not into git, not into chat, and
 * not back to the owner to paste anywhere. The workflow exchanges the code and
 * uploads the refresh token straight to /los-private/ beside public_html —
 * unreachable over HTTP — which is exactly where this project already keeps
 * the harvester's ingest key. The bulk job downloads it at run time. The
 * owner never has to handle it.
 *
 * WHY THE CODE IS SAFE TO PASTE INTO A WORKFLOW INPUT. An authorization code
 * is single-use, expires in minutes, and is worthless without the client
 * secret, which lives only in this repository's secrets. The refresh token it
 * becomes is the thing that matters, and that never leaves the runner.
 *
 * A CLI FIRST, A MODULE SECOND. Offline-testable end to end:
 *
 *   node tools/gdrive-consent.mjs --selftest        no network at all
 *   node tools/gdrive-consent.mjs --url             print the consent URL
 *   node tools/gdrive-consent.mjs --exchange <url>  code -> refresh token
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { redact } from "./drive.mjs";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/* The narrowest scope that can do the job. drive.file gives access ONLY to
 * files this application itself created — it cannot read, list or delete
 * anything else in the owner's Drive, including files they made by hand. A
 * broader scope would be easier and would also mean handing a batch job the
 * keys to somebody's personal documents. */
export const SCOPE = "https://www.googleapis.com/auth/drive.file";

/* Google retired the out-of-band flow in 2022, so the redirect must be a
 * loopback address. Nothing listens on it, which is fine: the browser shows a
 * "can't be reached" page whose ADDRESS carries the code. */
export const REDIRECT = "http://127.0.0.1:1/los";

export function consentUrl(clientId, state) {
  if (typeof clientId !== "string" || clientId === "") return { ok: false, reason: "no client id", url: "" };
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    /* offline + consent is what makes Google return a REFRESH token rather
     * than only an hour-long access token. Without both, this whole exercise
     * yields a credential that expires before the first nightly run. */
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true"
  });
  if (typeof state === "string" && state) p.set("state", state);
  return { ok: true, reason: "", url: AUTH_URL + "?" + p.toString() };
}

/* The owner pastes an address bar. Accept generously — the whole URL, a
 * fragment of it, or the bare code — and refuse clearly when what arrived is
 * not a code at all (the commonest mistake is pasting the CONSENT url back). */
export function codeFrom(pasted) {
  if (typeof pasted !== "string") return { ok: false, reason: "nothing was pasted", code: "" };
  const text = pasted.trim();
  if (text === "") return { ok: false, reason: "nothing was pasted", code: "" };

  if (/accounts\.google\.com/.test(text) && /response_type=code/.test(text)) {
    return { ok: false, reason: "that is the CONSENT link, not the address you landed on. Open it, approve, then copy the address of the page that fails to load.", code: "" };
  }

  let params = null;
  try {
    /* a relative or mangled paste still parses against a base */
    params = new URL(text, "http://127.0.0.1/").searchParams;
  } catch (_) { params = null; }

  if (params) {
    const err = params.get("error");
    if (err) {
      return { ok: false, reason: "Google refused the consent: " + String(err).slice(0, 80)
        + (err === "access_denied" ? " (the approve button was not pressed, or the account is not a test user on the OAuth consent screen)" : ""), code: "" };
    }
    const code = params.get("code");
    if (typeof code === "string" && code !== "") return { ok: true, reason: "", code, state: params.get("state") || "" };
  }

  /* a bare code, pasted without its URL */
  if (/^[0-9A-Za-z._\-/]{20,}$/.test(text) && !/\s/.test(text)) return { ok: true, reason: "", code: text, state: "" };

  return { ok: false, reason: "no authorization code found in what was pasted — expected an address containing ?code=…", code: "" };
}

export async function exchange(fetchImpl, { clientId, clientSecret, code }) {
  for (const [k, v] of [["client id", clientId], ["client secret", clientSecret], ["code", code]]) {
    if (typeof v !== "string" || v === "") return { ok: false, reason: "missing " + k, refreshToken: "" };
  }
  if (typeof fetchImpl !== "function") return { ok: false, reason: "no fetch available", refreshToken: "" };
  let res = null;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId, client_secret: clientSecret, code,
        grant_type: "authorization_code", redirect_uri: REDIRECT
      }).toString()
    });
  } catch (err) {
    /* never the message — it can carry the request, and the request carries the secret */
    return { ok: false, reason: "token request failed: " + (err && err.code ? err.code : "error"), refreshToken: "" };
  }
  let body = "";
  try { body = await res.text(); } catch (_) { body = ""; }
  if (!res || !res.ok) {
    let hint = "";
    if (/invalid_grant/.test(body)) hint = " — an authorization code is single-use and expires in minutes; run step=url again and use the fresh one straight away";
    if (/redirect_uri_mismatch/.test(body)) hint = " — add " + REDIRECT + " to the OAuth client's authorised redirect URIs in Google Cloud Console";
    return { ok: false, reason: "token endpoint answered " + (res && res.status) + redact(body) + hint, refreshToken: "" };
  }
  let json = null;
  try { json = JSON.parse(body); } catch (_) { json = null; }
  const rt = json && typeof json.refresh_token === "string" ? json.refresh_token : "";
  if (!rt) {
    return { ok: false, refreshToken: "",
      reason: "Google returned no refresh_token. This happens when the account has already granted this client and Google reuses the earlier grant. "
            + "Remove this app at https://myaccount.google.com/permissions and run step=url again." };
  }
  const scopes = json && typeof json.scope === "string" ? json.scope : "";
  return { ok: true, reason: "", refreshToken: rt, scope: scopes, hasDriveFile: scopes.includes(SCOPE) };
}

/* ————————————————————————— selftest (offline) ————————————————————————— */

export function selftest() {
  let checks = 0, failed = 0;
  const ok = (cond, msg) => { checks++; if (!cond) { failed++; console.error("  ✗ " + msg); } };

  const u = consentUrl("123.apps.googleusercontent.com", "st");
  ok(u.ok && u.url.startsWith(AUTH_URL + "?"), "a consent URL is built");
  const q = new URL(u.url).searchParams;
  ok(q.get("access_type") === "offline" && q.get("prompt") === "consent",
     "offline + consent are set — without both Google returns no refresh token at all");
  ok(q.get("scope") === SCOPE && /drive\.file$/.test(q.get("scope")),
     "the scope is drive.file: files this app created, never the owner's own documents");
  ok(q.get("redirect_uri") === REDIRECT && q.get("response_type") === "code", "the loopback redirect and code response are set");
  ok(consentUrl("").ok === false, "no client id, no URL");

  /* what the owner actually pastes */
  const landed = "http://127.0.0.1:1/los?state=st&code=4/0AY0e-g7ABCdef_ghi-jkl&scope=" + encodeURIComponent(SCOPE);
  const c1 = codeFrom(landed);
  ok(c1.ok && c1.code === "4/0AY0e-g7ABCdef_ghi-jkl" && c1.state === "st", "the code is read out of the pasted address (" + c1.code.slice(0, 12) + "…)");
  ok(codeFrom("  " + landed + "  ").ok === true, "surrounding whitespace is forgiven");
  ok(codeFrom("4/0AY0e-g7ABCdef_ghi-jkl").ok === true, "a bare code pasted without its URL is accepted");
  const wrong = codeFrom(consentUrl("abc").url);
  ok(wrong.ok === false && /that is the CONSENT link/.test(wrong.reason), "pasting the consent link back is named, not just refused");
  const denied = codeFrom("http://127.0.0.1:1/los?error=access_denied");
  ok(denied.ok === false && /approve button was not pressed/.test(denied.reason), "access_denied explains itself: " + denied.reason.slice(0, 50));
  ok(codeFrom("").ok === false && codeFrom(null).ok === false && codeFrom({}).ok === false, "empty and non-string pastes are refused, never thrown on");
  ok(codeFrom("hello there").ok === false, "prose is not a code");

  return (async () => {
    const good = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ refresh_token: "1//0-REFRESH", access_token: "ya29.x", scope: SCOPE }) });
    const r = await exchange(good, { clientId: "c", clientSecret: "s", code: "4/x" });
    ok(r.ok && r.refreshToken === "1//0-REFRESH" && r.hasDriveFile === true, "a code is exchanged for a refresh token with the scope confirmed");

    const noRt = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ access_token: "ya29.x" }) });
    const r2 = await exchange(noRt, { clientId: "c", clientSecret: "s", code: "4/x" });
    ok(r2.ok === false && /myaccount\.google\.com\/permissions/.test(r2.reason),
       "the commonest failure — Google reusing an earlier grant — is explained with the page that fixes it");

    const stale = async () => ({ ok: false, status: 400, text: async () => '{"error":"invalid_grant"}' });
    const r3 = await exchange(stale, { clientId: "c", clientSecret: "s", code: "4/old" });
    ok(r3.ok === false && /single-use and expires in minutes/.test(r3.reason), "a stale code says why: " + r3.reason.slice(-60));

    const mismatch = async () => ({ ok: false, status: 400, text: async () => '{"error":"redirect_uri_mismatch"}' });
    const r4 = await exchange(mismatch, { clientId: "c", clientSecret: "s", code: "4/x" });
    ok(r4.ok === false && r4.reason.includes(REDIRECT), "a redirect mismatch names the exact URI to add");

    const boom = async () => { const e = new Error("POST https://oauth2.googleapis.com/token client_secret=SUPERSECRET"); e.code = "ENOTFOUND"; throw e; };
    const r5 = await exchange(boom, { clientId: "c", clientSecret: "s", code: "4/x" });
    ok(/ENOTFOUND/.test(r5.reason) && !/SUPERSECRET/.test(r5.reason), "a thrown request is reported by code, never by a message carrying the secret");

    const r6 = await exchange(good, { clientId: "c", code: "4/x" });
    ok(r6.ok === false && /missing client secret/.test(r6.reason), "an incomplete credential is refused before any request");

    console.log(failed ? `gdrive-consent selftest: ${failed} FAILED of ${checks}` : `gdrive-consent selftest: ${checks} checks passed ✓`);
    return failed ? 1 : 0;
  })();
}

/* ————————————————————————— CLI ————————————————————————— */

const invokedDirectly = (() => {
  const entry = process.argv && process.argv[1];
  if (!entry) return false;
  let self;
  try { self = fileURLToPath(import.meta.url); } catch (e) { return false; }
  try { if (realpathSync(entry) === realpathSync(self)) return true; } catch (e) { /* fall through */ }
  try { return resolve(entry) === self; } catch (e) { return false; }
})();

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) {
    Promise.resolve(selftest()).then((code) => process.exit(code || 0));
  } else if (argv.includes("--url")) {
    const r = consentUrl(process.env.LOS_GDRIVE_CLIENT_ID || "", "los41");
    if (!r.ok) { console.error("cannot build the consent URL: " + r.reason); process.exit(1); }
    console.log(r.url);
  } else if (argv.includes("--exchange")) {
    const pasted = argv[argv.indexOf("--exchange") + 1] || process.env.LOS_GDRIVE_PASTED || "";
    const c = codeFrom(pasted);
    if (!c.ok) { console.error("gdrive-consent: " + c.reason); process.exit(1); }
    exchange(globalThis.fetch, {
      clientId: process.env.LOS_GDRIVE_CLIENT_ID || "",
      clientSecret: process.env.LOS_GDRIVE_CLIENT_SECRET || "",
      code: c.code
    }).then((r) => {
      if (!r.ok) { console.error("gdrive-consent: " + r.reason); process.exit(1); }
      /* The token is written to stdout ONLY when a caller asked for it on a
       * pipe (the workflow writes it straight to a file it then uploads). It
       * is never printed to a log. */
      if (argv.includes("--emit")) process.stdout.write(r.refreshToken);
      else console.log("consent complete: a refresh token was obtained, scope drive.file confirmed=" + r.hasDriveFile);
      process.exit(0);
    });
  } else {
    console.log("gdrive-consent.mjs — try --selftest, --url, or --exchange '<pasted address>'");
  }
}
