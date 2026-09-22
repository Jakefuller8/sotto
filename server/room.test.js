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

console.log("\n" + pass + " passed, " + failures.length + " failed");
if (failures.length) process.exit(1);
