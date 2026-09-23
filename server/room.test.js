// Room-code resolution, extracted from the phone client and exercised directly.
//
// This logic decides which pairing code the phone uses, and it is the reason a
// re-pair could silently dead-end: the QR carries the code in the URL, but the
// installed PWA launches at start_url with no fragment, so the phone fell back
// to a stale cached code and then waited forever for a laptop that was on a
// different one.
//
// The functions under test live inside server/public/index.html, so they are
// pulled out of the page rather than copied — a copy would drift.

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert");

const PAGE = path.join(__dirname, "public", "index.html");
const html = fs.readFileSync(PAGE, "utf8");

// The generator alphabet omits I and O so neither can be confused with 1 or 0.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const FILTER = /[^A-HJ-NP-Z2-9]/g;

// A legal 6-character code, standing in for whatever the phone had cached.
const STALE = "QLDXYZ";

const roomFromUrlSrc = (html.match(/function roomFromUrl\(\)[\s\S]*?\n  \}/) || [])[0];
assert.ok(roomFromUrlSrc, "roomFromUrl() not found in index.html — did it get renamed?");

// Mirrors how index.html applies roomFromUrl(): a scanned code wins, then the
// cached one, then a fresh code.
function resolve(search, hash, cached) {
  const fn = new Function("location", roomFromUrlSrc + "; return roomFromUrl();");
  const scanned = String(fn({ search, hash })).toUpperCase().replace(FILTER, "").slice(0, 6);
  const c = String(cached || "").toUpperCase().replace(FILTER, "").slice(0, 6);
  if (scanned.length === 6) return scanned;
  if (c.length === 6) return c;
  return "GENERATED";
}

let pass = 0;
const failures = [];

function t(name, got, want) {
  try {
    assert.strictEqual(got, want);
    pass++;
    console.log("  pass  " + name);
  } catch {
    failures.push(name + " -> got " + got + ", want " + want);
    console.log("  FAIL  " + name + " -> got " + got + ", want " + want);
  }
}

console.log("\nRoom code resolution");

// A scanned link must always beat whatever is cached, or re-pairing can't work.
t("QR hash form is used", resolve("", "#ABC234", STALE), "ABC234");
t("query form is used", resolve("?room=ABC234", "", STALE), "ABC234");
t("query wins over a stale hash", resolve("?room=ABC234", "#QLDXYZ", ""), "ABC234");
t("query survives other params", resolve("?utm=x&room=ABC234&y=1", "", ""), "ABC234");
t("lowercase link is normalised", resolve("?room=abc234", "", ""), "ABC234");
t("percent-encoding is decoded", resolve("?room=%41BC234", "", ""), "ABC234");

// The PWA icon launches at start_url ("/"), carrying no code at all.
t("PWA icon launch uses the cached code", resolve("", "", STALE), STALE);
t("no code anywhere generates a fresh one", resolve("", "", ""), "GENERATED");

// A malformed code must never be accepted as if it were valid, or the phone
// joins a room nothing else is in and the failure looks like a dead relay.
t("junk in the url falls back to cache", resolve("?room=!!!", "", STALE), STALE);
t("a short code is rejected", resolve("?room=ABC", "", STALE), STALE);
t("an overlong code is truncated", resolve("?room=ABC234ZZZ", "", ""), "ABC234");
t("a corrupt cache is not trusted", resolve("", "", "!!!"), "GENERATED");

// I, O, 0 and 1 are absent from the alphabet by design. Accepting them let a
// mistyped code pass validation and then never match.
t("confusables stripped, rest kept", resolve("?room=AIO234BC", "", ""), "A234BC");
t("a code of only confusables is rejected", resolve("?room=IO01IO", "", STALE), STALE);

console.log("\nAlphabet agreement");

// Every validator must accept exactly what the generators can emit.
t(
  "filter accepts the whole generator alphabet",
  ALPHABET.replace(FILTER, ""),
  ALPHABET
);
t("filter rejects I, O, 0 and 1", "IO01".replace(FILTER, ""), "");

const validators = [
  ["server/public/index.html", html],
  ["server/server.js", read("./server.js")],
  ["extension/pair.js", read("../extension/pair.js")],
  ["extension/popup.js", read("../extension/popup.js")],
  ["extension/content.js", read("../extension/content.js")],
];

function read(rel) {
  return fs.readFileSync(path.join(__dirname, rel), "utf8");
}

for (const [name, src] of validators) {
  t(
    name + " uses the confusable-safe class",
    /\[\^?A-Z2-9\]/.test(src) ? "stale [A-Z2-9]" : "ok",
    "ok"
  );
}

console.log("\nKeypair persistence");

// The phone used to generate a keypair on every load and keep it in memory
// only. Each reload republished a new public key, leaving the laptop — which
// derives once and then stops — holding a stale shared secret. Every dictation
// then failed with "Couldn't decrypt", and iOS reloads this page whenever it
// evicts it from the background, so it happened constantly.
t("phone persists its keypair", /localStorage\.setItem\(KEYS_KEY/.test(html) ? "ok" : "missing", "ok");
t("phone reloads a stored keypair", /function loadKeys\(\)/.test(html) ? "ok" : "missing", "ok");
t(
  "pair() reuses the stored keypair rather than always generating",
  /return keysFor\(rotate\)/.test(html) ? "ok" : "still calls freshKeys directly",
  "ok"
);
t(
  "a deliberate re-pair still rotates the keypair",
  /pair\(true\)/.test(html) ? "ok" : "missing",
  "ok"
);

console.log("\nPermanent pairing");

// Pairing has to survive closing the app and returning a week later. It did
// not: the relay drops a room after 30 minutes idle and on every redeploy, and
// the phone fetched the laptop's public key from the relay on every launch. So
// once the relay forgot, the phone could not derive and demanded a re-pair.
//
// The relay is not needed for this. The shared secret is a function of the two
// keypairs alone, so storing the peer's public key lets the phone re-derive the
// same key locally, offline, indefinitely.
t("phone stores the peer public key", /localStorage\.setItem\(PEER_KEY/.test(html) ? "ok" : "missing", "ok");
t(
  "startup derives from storage before touching the relay",
  /pairFromStorage\(\)[\s\S]{0,120}\.then\(function \(ok\) \{[\s\S]{0,80}pair\(false\)/.test(html)
    ? "ok"
    : "missing",
  "ok"
);
t(
  "pairFromStorage does no network call",
  (function () {
    const fn = (html.match(/function pairFromStorage\(\)[\s\S]*?\n  \}/) || [""])[0];
    return /fetch\(/.test(fn) ? "hits the network" : "ok";
  })(),
  "ok"
);
// A relay that has forgotten the handshake must not cost the user their key.
t(
  "a relay that forgot the room does not discard the key",
  /if \(!d\.paired\) \{\s*\n\s*republish\(\);/.test(html) ? "ok" : "still clears aesKey",
  "ok"
);
t(
  "republish keeps the existing key unless the peer actually changed",
  /if \(!d\.peer \|\| d\.peer === savedPeer\(\)\) return null;/.test(html) ? "ok" : "missing",
  "ok"
);
t(
  "republish is rate limited",
  /REPUBLISH_COOLDOWN_MS/.test(html) ? "ok" : "missing",
  "ok"
);
t(
  "laptop republishes when the relay has dropped the room",
  /!sas \|\| !p\.paired/.test(read("../extension/pair.js")) ? "ok" : "missing",
  "ok"
);
// pair(false) returning null must not wipe a good key on the laptop either.
t(
  "laptop keeps its key when the relay has no peer key",
  /if \(!data\.peer\) return null;/.test(read("../extension/pair.js")) ? "ok" : "missing",
  "ok"
);

console.log("\nAnalytics persistence");

// returningUsers.d7 is the number the pilot exists to produce and it needs a
// week of history. Held in memory it reset on every deploy — ten in one day
// during development — so it could never accumulate.
const srvSrc0 = read("./server.js");
t("counters are written to disk", /function saveStatsNow\(\)/.test(srvSrc0) ? "ok" : "missing", "ok");
t("counters are read back on boot", /^loadStats\(\);$/m.test(srvSrc0) ? "ok" : "missing", "ok");
t(
  "writes are atomic",
  /fs\.renameSync\(tmp, STATS_FILE\)/.test(srvSrc0) ? "ok" : "not atomic — a crash mid-write loses the data",
  "ok"
);
t(
  "flushed on SIGTERM (Render's redeploy signal)",
  /SIGTERM[\s\S]{0,200}saveStatsNow\(\)/.test(srvSrc0) ? "ok" : "missing",
  "ok"
);
t(
  "writes are coalesced rather than one per dictation",
  /function saveStats\(\)[\s\S]{0,200}setTimeout\(saveStatsNow/.test(srvSrc0) ? "ok" : "missing",
  "ok"
);
// Render's filesystem is writable without a disk, so a successful write does
// not prove durability. Reporting "disk" in that case would hide the loss.
t(
  "an unconfigured data dir reports ephemeral, not disk",
  /persistence = CONFIGURED_DIR \? "disk" : "ephemeral"/.test(srvSrc0) ? "ok" : "missing",
  "ok"
);
t("persistence state is exposed in /stats", /\n\s+persistence,/.test(srvSrc0) ? "ok" : "missing", "ok");
t(
  "a corrupt file does not stop the relay",
  /catch \{[\s\S]{0,120}stats_load_failed/.test(srvSrc0) ? "ok" : "missing",
  "ok"
);

console.log("\nPresence while parked on a long poll");

// The relay holds a laptop's poll for HOLD_MS but expires presence after
// PRESENCE_MS. With HOLD_MS (25s) longer than PRESENCE_MS (12s), a stamp-once
// lastPoll meant a connected laptop read as absent for most of every cycle.
const serverSrc = read("./server.js");
const holdMs = Number((serverSrc.match(/HOLD_MS = (\d+)/) || [])[1]);
const presenceMs = Number((serverSrc.match(/PRESENCE_MS = (\d+)/) || [])[1]);

t(
  "presence accounts for parked waiters",
  /function laptopPresent\(r\)[\s\S]{0,200}r\.waiters\.length/.test(serverSrc) ? "ok" : "missing",
  "ok"
);
t(
  "no presence check bypasses laptopPresent()",
  /lastPoll < PRESENCE_MS/.test(serverSrc.replace(/function laptopPresent[\s\S]*?\n\}/, ""))
    ? "a raw lastPoll comparison remains"
    : "ok",
  "ok"
);
// Documents why the helper is needed. If someone later shortens the hold below
// the presence window this stops being load-bearing, and that is worth knowing.
t(
  "hold outlasts the presence window (so waiters must count)",
  holdMs > presenceMs ? "ok" : "hold is now shorter — helper may be redundant",
  "ok"
);

console.log("\nStatus pill follows the phone");

// The pill was shown on every poll with a 2.2s fade, so on a 25s cycle it
// blinked on and off all day — including with the phone switched off in a bag,
// because it keyed off "do I hold a key" rather than "is the phone there".
const contentSrc0 = read("../extension/content.js");
const serverSrc1 = read("./server.js");

t(
  "relay reports phone presence to the laptop",
  /function phonePresent\(r\)/.test(serverSrc1) ? "ok" : "missing",
  "ok"
);
t(
  "every poll response carries it",
  (serverSrc1.match(/phone: phonePresent\(r\)/g) || []).length === 3
    ? "ok"
    : "not all three poll paths report it",
  "ok"
);
t(
  "pill shown only while the phone app is open",
  /if \(phoneHere\) \{[\s\S]{0,140}showPill\(/.test(contentSrc0) ||
    /phoneHere = !!data\.phone;[\s\S]{0,200}showPill\(/.test(contentSrc0)
    ? "ok"
    : "missing",
  "ok"
);
t(
  "and stays put rather than fading",
  /showPill\(aesKey \? "Sotto ready"[\s\S]{0,80}, true\)/.test(contentSrc0) ? "ok" : "not sticky",
  "ok"
);
t("hidden when the phone is away", /function hidePill\(\)/.test(contentSrc0) ? "ok" : "missing", "ok");
// A relay hiccup with the phone in a bag is not worth covering their screen.
t(
  "errors are suppressed when the phone is not in use",
  /if \(phoneHere\) showPill\("Sotto offline"/.test(contentSrc0) ? "ok" : "always shown",
  "ok"
);
// This branch retries every 3s; re-showing each time would reintroduce blinking.
t(
  "the not-set-up notice fires once, not on every retry",
  /notSetUpShown/.test(contentSrc0) ? "ok" : "missing",
  "ok"
);

console.log("\nAlready-open tabs");

// Declared content scripts only run on page load, so installing or updating
// the extension left every open chat tab without one — the pill never
// appeared and the user was told to reload. background.js injects into those
// tabs instead, which means three files have to agree on the origin list.
const manifest = JSON.parse(read("../extension/manifest.json"));
const bgSrc = read("../extension/background.js");
const csMatches = manifest.content_scripts[0].matches;

t("extension can inject programmatically", manifest.permissions.includes("scripting") ? "ok" : "no scripting permission", "ok");
t(
  "every content-script origin has a host permission",
  csMatches.filter((o) => !manifest.host_permissions.includes(o)).join(",") || "ok",
  "ok"
);
t(
  "background injects into the same origins it declares",
  csMatches.filter((o) => !bgSrc.includes(o)).join(",") || "ok",
  "ok"
);
t("injects on install and update", /onInstalled[\s\S]{0,120}injectIntoOpenTabs\(\)/.test(bgSrc) ? "ok" : "missing", "ok");
t("injects after a browser restart", /onStartup[\s\S]{0,120}injectIntoOpenTabs\(\)/.test(bgSrc) ? "ok" : "missing", "ok");

// Double injection would insert every dictation twice; a plain "loaded" flag
// would leave a tab dead after an update, because the superseded script set it.
const contentSrc = read("../extension/content.js");
t("content script claims the tab by build", /window\.__sottoOwner = ME/.test(contentSrc) ? "ok" : "missing", "ok");
t(
  "a superseded loop retires itself",
  /window\.__sottoOwner !== ME/.test(contentSrc) && /chrome\.runtime\.id/.test(contentSrc) ? "ok" : "missing",
  "ok"
);

console.log("\nSelf-healing");

const contentJs = read("../extension/content.js");
const backgroundJs = read("../extension/background.js");

// A stale key is something the extension can fix without the user. It used to
// tell them to go and re-pair by hand, which is a dead end for a recoverable
// fault.
t(
  "decrypt failure asks for a re-derivation",
  /await repair\(\)/.test(contentJs) ? "ok" : "missing",
  "ok"
);
t(
  "and retries the message once healed",
  (contentJs.match(/await decrypt\(msg\.iv, msg\.ct\)/g) || []).length >= 2 ? "ok" : "no retry",
  "ok"
);
t(
  "re-derivation is rate limited",
  /REPAIR_COOLDOWN_MS/.test(contentJs) ? "ok" : "missing",
  "ok"
);
t(
  "no dead-end 'go re-pair yourself' message remains",
  /re-pair from the Sotto popup/.test(contentJs) ? "still present" : "ok",
  "ok"
);
// pair(true) here would rotate the laptop's own key, invalidating the phone's
// in turn and making the two chase each other.
t(
  "healing re-derives without rotating the laptop's key",
  /SottoPair\.pair\(false\)/.test(backgroundJs) ? "ok" : "rotates, or missing",
  "ok"
);
t(
  "background reuses pair.js rather than duplicating the crypto",
  /importScripts\("pair\.js"\)/.test(backgroundJs) ? "ok" : "missing",
  "ok"
);

console.log("\n" + pass + " passed, " + failures.length + " failed");
if (failures.length) process.exit(1);
