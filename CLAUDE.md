# Sotto

Speak quietly into your phone; the text appears in an AI chat box on your
laptop. Built for working in cafés and libraries without talking at a screen.

Owner: Jake (first-year Wharton MBA). This is a full-time venture in place of a
summer internship, so speed to a testable product matters more than polish.

---

## Current state

Version 1.4.0. The version-mismatch blocker that once dominated this file is
resolved — see *The upload trap* below for why it happened and how to avoid
re-creating it.

**1.4.0 has not been through a real-device pass.** 1.2.0 was the last build
verified end to end on real hardware. Since then: pairing-code resolution, the
first-run flow, phone keypair persistence, decrypt self-healing and a generated
manifest. The suites cover all of it and a real relay was driven from a browser
at phone dimensions, but nobody has held a phone, scanned the QR and dictated
on this build. **Do that before the pilot**, and specifically confirm the one
thing no test can: that the home screen icon, once added, launches already
paired.

**Live relay:** https://sotto-relay.onrender.com (Render). **Tier is
unconfirmed** — check the dashboard before any pilot. Free sleeps after 15
minutes, takes ~30s to wake, and wipes the in-memory analytics counters; the
first person to hit a cold start will decide the product is broken.

**Repo:** github.com/Jakefuller8/sotto — a real git checkout at
`~/Documents/sotto`.

### The upload trap — don't re-create it

For several releases the repo was updated by dragging files into GitHub's web
uploader. Two distinct failures came from that, and both were silent:

1. **Browser-edited files get skipped.** `server/server.js` had been edited in
   GitHub's web editor, after which drag-and-drop refused to overwrite it
   without saying so. The repo sat at `1.0.1` while local was `1.2.0`, so Render
   kept building the old relay.
2. **Directory structure gets flattened.** The 1.2.0 `extension/` did upload —
   into the repo *root*, not `extension/`. Result: a correct 1.2.0 extension in
   the wrong place, a stale 1.0.1 `server.js`, and a root `manifest.json` that
   could make "Load unpacked" grab the wrong directory. Of the 13 stray root
   files, 9 were byte-identical to the proper 1.2.0 `extension/` files — git
   recorded 5 of them as straight renames into `extension/` (those it didn't
   already have a copy of), which confirmed the diagnosis.

Commit and push from the command line. Never the web uploader.

### Bumping the version

The number lives in three places and they drifted apart once already
(`package.json` said `1.0.1` while the relay served `1.2.0`):

- `server/server.js` — `const VERSION`, the only one `/health` actually reports
- `server/package.json` — `"version"`
- `extension/manifest.json` — `"version"`, and Chrome rejects a re-upload that
  doesn't increase it

Render deploys on push to `main` and takes ~2–3 minutes; `/health` showing the
old number immediately after a push is normal. Confirm via `uptimeSeconds`
resetting, not just the version field.

---

## Architecture

```
phone mic → transcribed on phone → encrypted → relay → decrypted in browser → typed into chat box
```

Three parts:

| Part | Where | Does |
|---|---|---|
| Phone client | `server/public/index.html` | Hold-to-talk, Web Speech transcription, AES-GCM encryption, PWA |
| Relay | `server/server.js` | HTTP long-polling, ECDH brokerage, event-only analytics. Zero dependencies |
| Extension | `extension/` | Polls relay, decrypts, inserts text into the page |

### Decisions that look odd but are deliberate

**HTTP long-polling, not WebSockets.** Two reasons, both learned the hard way.
Manifest V3 service workers are killed after ~30s idle, which tore down the
socket and caused a permanent reconnect flap — and `chrome.alarms` can't fix it
because alarms clamp to a 1-minute floor, slower than the timeout. Separately,
content scripts can't reliably open WebSockets (page CSP may block them), but
`fetch()` from a content script runs with extension privileges and always works.
Don't "modernise" this back to WebSockets.

**The polling loop lives in the content script, not a service worker.** It
survives as long as the tab. There is no long-lived background worker;
`background.js` exists only to open the onboarding tab on install.

**Text insertion uses `document.execCommand("insertText")`.** Setting `.value`
or `.textContent` directly does not work — Claude's input is a ProseMirror
contenteditable and React never sees the change, leaving the send button
disabled. `execCommand` fires the `beforeinput`/`input` events frameworks
listen for. This is non-obvious and load-bearing.

**Encryption is real, not decorative.** ECDH P-256 key exchange brokered through
the relay (public keys only), AES-GCM for the payload. Both devices display a
4-character safety number — a fingerprint of the shared secret — so an active
relay swapping keys would be detected. The relay cannot read what it forwards
by construction, not by policy. Never add server-side transcription or text
cleanup without changing the privacy claims in `store/privacy-policy.html`.

**QR encoder is hand-written** (`extension/qr.js`). MV3 forbids remote scripts,
and a hosted QR API would leak the pairing code to a third party. Validated
against ISO/IEC 18004 format strings, byte-mode capacities and Reed-Solomon
syndromes in `extension/qr.test.js`.

**The chime is why the recognition session outlives a press.** iOS plays its
dictation sound on every `SpeechRecognition.start()` and no web API silences
it. The old code started on press and stopped on release, so it chimed once
per sentence — unusable in a library, which is the entire premise. Now the
session is kept alive and press/release only gates whether results are
collected (`baseIndex` marks where an utterance began, so speech between
presses is discarded). The chime fires once per session instead.

The cost is an open microphone between sentences, and on iOS Web Speech streams
audio to Apple — so `IDLE_STOP_MS` is deliberately short (10s), and
`closeMic()` shuts it immediately on blur, `pagehide` or `visibilitychange`.
**Do not lengthen that idle window without deciding the privacy question
first**; it is a trade, not an oversight.

**The QR carries `?room=CODE`, not `#CODE`, and the relay rewrites the manifest
link server-side.** A fragment never reaches the server, and the server has to
know the room while serving the page: iOS parses `<link rel="manifest">` at
load and does **not** appear to honour a later `href` change from JavaScript.
An icon added from a page whose link was only retargeted by JS captured
`start_url: "/"` and launched unpaired — the observed failure. The rewrite in
`serveStatic()` makes the correct href present in the markup before any script
runs. (That iOS behaviour is inferred from the failure, not from documentation;
Settings → Diagnostics reports the launch URL so it can be confirmed.)

**The manifest is generated per pairing, not served as a static file.**
`/manifest.webmanifest?room=ABC234` returns `start_url: "/?room=ABC234"`, and
the page also retargets its own `<link rel="manifest">` as a fallback for the
fragment form. The home screen icon is the product — one tap, already paired, ready to
talk — and a static manifest cannot deliver that: its `start_url` is `/` with
no code, so the installed app depends on `localStorage` carrying over the
Safari-to-standalone boundary, which is not something to rely on. Baking the
room into `start_url` means the icon launches paired, permanently.

The room is not a secret; it only names a mailbox whose contents are encrypted
with a key the relay never sees. The manifest is served `no-store` and excluded
from the service worker cache, or a re-pair would keep handing out the previous
room. `sw.js` also has a `SHELL` version constant — **bump it whenever the
shell changes**, or phones that already installed keep serving the cached old
page and never receive the fix.

**The phone does not auto-follow the laptop's pairing code.** The tempting
version is a `/whereis?id=<installId>` endpoint the phone consults to find
where the laptop went. Don't build that one.

Note what is *not* the objection: `installId` already exists and is already
sent to the relay on every presence poll, and the relay already stores it per
room and keys analytics off it (`note()`, so that a re-pair doesn't read as a
new user). The privacy policy already discloses per-device counting. A
`/whereis` endpoint adds almost no privacy surface.

The objection is that such a redirect is **unauthenticated**. It hands a
malicious relay a new capability: tell the phone "your laptop moved to room X"
at a moment of the attacker's choosing, where X is the attacker's room. The
phone does a fresh ECDH with the attacker and streams plaintext. Today an
attacker must swap keys *during* a user-initiated pairing — a narrow window
that coincides with the screen showing the safety number. A silent migration
has no verification moment by construction, which is exactly what made it
attractive.

If this is ever worth building, the sound design is **key continuity**, not a
lookup: before moving to room B, the laptop posts `AES-GCM(K_A, "move to B")`
into room A. AES-GCM is authenticated, so only a holder of the already-verified
`K_A` can produce it and the relay cannot forge it. Trust chains back to the
pairing the user checked.

Its limit, and the reason it is not built: it requires the laptop to still hold
`K_A`, so it cannot help when extension storage is lost (new extension id,
reinstall, cleared data) — which is the most common way the codes diverge. It
also needs the phone to persist its AES key, which it currently does not
(`aesKey` is in memory only). Until there is evidence that rescanning is a real
source of friction, a visible one-action recovery beats a new security-sensitive
code path.

**Streaming replaces rather than appends.** The phone sends the whole current
utterance every ~180ms because the recogniser revises interim words. The
extension only ever deletes characters it can *prove* are its own — it checks
the text before the caret still matches exactly what it last inserted. If the
user typed in the box, that check fails and it appends instead. Worst case is a
duplicated phrase, never eating the user's own words. Do not weaken this check.

---

## Testing

```bash
cd server && npm test           # no dependencies needed
cd extension && node qr.test.js # 25 assertions against ISO reference values
```

`npm test` runs `room.test.js` before `test.js`. `room.test.js` covers
pairing-code resolution, alphabet agreement across all six validators, keypair
persistence and the self-healing path; it pulls `roomFromUrl()` out of
`index.html` and runs it directly rather than copying it, so the test cannot
drift from the shipped page.

**Do not read the result through a pipe.** `npm test | grep …` reports grep's
exit status, which masked a syntax error in `test.js` and made a crashing suite
look clean. Redirect to a file and check `$?`.

Room codes used as fixtures must be legal under the generator alphabet — no
`I`, `O`, `0` or `1`. Eight fixtures violated this and only surfaced when the
relay's regex was tightened.

Green as of 2026-09-22: 57 room + 87 relay + 25 QR. Requires Node; the engine
floor is `>=22`.

The relay suite takes roughly three minutes — the latency and long-polling
tests genuinely wait, several parking a poll for the full 25s `HOLD_MS`. It
prints nothing for stretches, which looks like a hang and isn't. Don't kill it.

**Never run two suites at once.** Both bind port 39413, so the second one's
server fails to bind and its harness silently talks to the *first* suite's
server. That produces failures that look like real regressions — dictation
counts off by one, persistence appearing broken — and sent a long stretch of
this session chasing a bug that did not exist. If results look impossible,
check for a stale `node server.js` on 39413 before believing them.

`extension/test-page.html` — open in Chrome. Runs the real `content.js` against
a mock ProseMirror box: insertion, streaming, revision, and the case where the
user typed first.

Relay tests spawn the real server on port 39413 and drive it over HTTP,
including a genuine ECDH + AES-GCM round trip using Node's WebCrypto.

---

## Bugs already fixed — don't reintroduce

1. **`close()` set readyState before sending the close frame**, so the frame was
   never written and clients saw an abnormal 1006 disconnect. (WebSocket era,
   now removed.)
2. **Phone registered presence only once, during pairing.** It polled
   `/presence` with a GET, which didn't count as a check-in, so the server
   decided the phone had vanished 12 seconds later. Fixed with `?role=phone`.
3. **Popup reported "Paired and encrypted" without checking a chat tab was
   open.** Green light, dead system — the worst kind of bug here. The status now
   walks the whole chain: relay → phone → pairing → chat tab → ready.
4. **A third connection was rejected instead of evicting a stale one**, so
   reconnects were refused. (WebSocket era.)
5. **Streamed chunks each counted as a dictation**, inflating analytics. A
   `{done:true}` marker now counts one per utterance.
6. **A pairing-code mismatch was an unrecoverable dead end.** The QR carries
   the code in the URL, but the installed PWA launches at `start_url` (`/`)
   with no fragment, so the phone fell back to its cached code. If the laptop's
   code had changed — a deliberate re-pair, cleared storage, or a reinstall —
   the two sat on different codes and both showed only "waiting", never naming
   the code or suggesting a fix. The phone now accepts `?room=` as well as
   `#room`, and after 8 seconds both sides name the code instead of waiting
   silently. Covered by `server/room.test.js`.
7. **Code validators accepted `I` and `O`**, which the generator alphabet
   deliberately omits so they cannot be confused with `1` and `0`. A mistyped
   code passed validation and then silently never matched. All six validation
   sites now use `[A-HJ-NP-Z2-9]`.
8. **`SottoPair.reset()` was unreachable.** The README documented "Re-pair with
   a new code" as the fix for a stale pairing, but nothing in the UI called it.
   It is now a button on the onboarding page.
9. **The phone kept its keypair in memory only and regenerated it on every
   load.** Each reload published a new public key, while the laptop derives its
   key once and then never again — so the laptop was left holding a stale
   shared secret and every dictation failed with "Couldn't decrypt". iOS
   reloads the page whenever it evicts it from the background, so this fired
   constantly. `/presence` could not reveal it either: `paired` only means two
   public keys exist, not that they agree. The phone now persists its keypair
   in `localStorage`, symmetric with the laptop keeping `privJwk` in
   `chrome.storage.local`.
10. **A stale key was a dead end.** The extension told the user to go and
    re-pair by hand for a fault it can fix itself. It now asks the service
    worker to re-derive and retries the message. Use `pair(false)`, never
    `pair(true)`: the laptop must re-derive against the phone's *current*
    public key while keeping its own, or the two rotate in lockstep and chase
    each other. The laptop is the only side that decrypts, so healing there
    recovers the whole link.
11. **A full-screen "Add to Home Screen" gate ran before anything else.** Every
    first-time user had to complete an iOS share-sheet ritual before hearing a
    word transcribed, and it made the deferred install banner — which already
    held itself back until after a first dictation — unreachable. The gate is
    gone; the banner now appears as soon as pairing succeeds.
12. **The relay's `ROOM_RE` still accepted `I` and `O`** after the six client
    validators were fixed, and eight test fixtures used codes the generator can
    never emit (`PAIR23`, `UNI234`, `LON234`, `INS234`…). Tightening the regex
    is what surfaced them.
13. **The install prompt could be permanently destroyed.** The early return for
    "already dismissed" sat *above* the definition of
    `window.sottoOfferInstall`, so the first time that flag was set — by the ×,
    or automatically on `appinstalled` — the function was never defined again
    and no prompt could ever appear on that phone. A user who installed once
    and later deleted the icon had no way to be told how to re-add it. The
    prompt is now a **permanent, non-dismissible bar** above the talk button
    opening a dedicated instructions screen; both vanish once `display-mode`
    reports the app is installed. **Do not re-add a dismiss control** — that is
    the bug.
14. **An installed icon launched unpaired.** See the `?room=` note above. This
    is what "it worked until I added it to the home screen" was.
15. **The chime fired once per sentence.** See the session-lifetime note above.

16. **Pairing did not survive closing the app.** Two causes compounding. The
    relay drops a room after `ROOM_TTL_MS` (30 minutes) idle and loses
    everything on redeploy; and the phone fetched the laptop's public key from
    the relay on *every* launch, so once the relay had forgotten, the phone
    could not derive and demanded a re-pair. Worse, `checkPresence` treated
    `paired: false` as "our key is stale" and threw a perfectly good key away —
    on the relay's schedule, not the user's.

    The relay was never needed for this: the shared secret is a function of the
    two keypairs alone, and both now live on their own devices. The phone stores
    the peer public key (`sotto.peer`) and `pairFromStorage()` derives locally
    at launch with **no network call**, so a returning user is encrypted before
    a single request goes out. `paired: false` now triggers a quiet
    `republish()` that keeps the existing key and only adopts a new one if the
    peer actually changed. Verified by wiping the relay's memory entirely and
    reloading at a bare `/`: the phone still came up encrypted.

    **Do not "simplify" the startup path back to calling `pair()` first.** That
    is the regression.

17. **A connected laptop read as absent for most of every poll cycle.** The
    relay stamps `lastPoll` once when a poll arrives and then holds that
    request for `HOLD_MS` (25s), while presence expires after `PRESENCE_MS`
    (12s). So between the 12s and 25s marks the relay reported the laptop gone
    while it sat there connected, and the phone flapped between "Paired" and
    "Laptop not connected" during entirely normal use. This was most of what
    "clunky" meant. `laptopPresent()` now counts a parked waiter as presence,
    which it is by definition. **Every presence check must go through that
    helper** — a raw `lastPoll < PRESENCE_MS` comparison reintroduces the bug,
    and `room.test.js` fails if one appears.
18. **Open chat tabs were never connected.** Declared content scripts only run
    on page load, so installing or updating the extension left every open tab
    without one — and after an update, with an *orphaned* one whose context had
    been invalidated. The user was told to reload the tab, which is a support
    ticket rather than a product. `background.js` now injects into matching
    open tabs on install, update and browser startup. Ownership in `content.js`
    is keyed to `runtime.id + version` rather than a boolean, because a plain
    "already loaded" flag is set by the *superseded* script and would make the
    fresh injection stand down; a superseded loop also checks
    `chrome.runtime.id` each iteration and retires itself instead of polling on
    with a stale key.

## Diagnostics

Settings → **Diagnostics** reports mode (installed app vs browser tab), the
room and where it came from, the build version, whether a keypair was stored,
and **the URL the app was launched with** — captured before `persist()` rewrites
it. That last line is the only reliable way to tell whether a home screen icon
captured its pairing code, and it turns "it stopped working" into one
screenshot. The version comes from `SOTTO_VERSION_TOKEN`, substituted by the
relay, so a stale service worker cache is visible rather than looking like a
code bug.

---

## Known limits

- **Chrome browser tabs only.** Not the Claude desktop app, Word, or a terminal.
  That needs a native helper synthesizing keystrokes (macOS Accessibility API,
  or `SendInput` on Windows) — roughly 300 lines per platform, plus $99/year
  Apple account to avoid Gatekeeper warnings. Deferred pending demand.
- **Safari plays a chime** on every recognition session. iOS triggers it; no API
  suppresses it. Restarts are minimised to reduce how often it fires.
- **Transcription is literal** — every "um" survives. Deliberate: LLMs handle
  messy input, and cleaning it server-side would break the encryption promise.
- **iOS suspends background pages.** App must be foregrounded, screen on.
- **Selectors will break** when Claude or ChatGPT reship their UI.
  `div[contenteditable="true"]` is the generic fallback.
- **Analytics persist to a JSON file** (`SOTTO_DATA_DIR/stats.json`), written
  atomically and flushed on SIGTERM, which is what Render sends on redeploy.

  **This needs a Render disk to actually work.** Attach one to the service and
  set `SOTTO_DATA_DIR` to its mount path. Render's filesystem is writable
  without a disk, so the write succeeds either way and durability cannot be
  inferred from success — which is why `/stats` reports `persistence` as
  `disk` (configured volume), `ephemeral` (writable, but wiped next deploy) or
  `memory` (not writable). **If it is not `disk` during the pilot,
  `returningUsers.d7` is not being collected**, and that is the number
  CLAUDE.md says decides the project.

---

## Next steps

**Submitted to the Chrome Web Store on 2026-09-22**, version 1.9.0, as
**Unlisted**. Awaiting review (typically 1–3 days). Package built with
`store/build-zip.sh`; listing text, permission justifications and screenshots
are in `store/`.

**Blocking the pilot:**

1. **A real-device pass on 1.9.0.** 1.2.0 was the last build verified end to
   end on hardware. Everything since — pairing-code resolution, permanent
   pairing, decrypt self-healing, the generated manifest, the presence fix,
   the install bar — is covered by tests and browser checks only. Confirm in
   particular that the **home screen icon launches already paired**, which no
   test can prove.
2. Watch for the review email. A rejection names the specific policy; the
   usual causes are screenshot dimensions, a privacy policy URL that 404s, or
   a permission justification that does not match the code.

*Done 2026-09-22: 1.2.0 → 1.9.0. Privacy policy live at
https://jakefuller8.github.io/sotto/ (GitHub Pages, `main` + `/docs`). Render
confirmed on the paid `0.5c-512mb` instance, with a disk attached and
`SOTTO_DATA_DIR` set, so `/stats` reports `persistence: disk`.*

**After approval:**

- Pilot with ~30 Wharton classmates
- Watch `returningUsers.d7` at `/stats`. Downloads measure curiosity; day-7
  return measures whether there's a product. This one number decides whether the
  hardware idea comes back and what happens over the summer

**Deferred, in rough priority:** native macOS helper for universal injection;
persistent analytics store; hosted speech model for better accuracy (breaks the
current privacy claim, so needs a user-facing toggle).

---

## Working style

Jake communicates directly and wants concise answers with all relevant detail
kept. He challenges assumptions and expects either an updated position with
reasoning or a clear rationale for holding ground — don't cave to pushback that
isn't substantively right, and don't defend a position that is wrong.

Flag uncertainty explicitly. Several things in this project were shipped without
full verification (the QR scanning in particular) and saying so mattered more
than sounding confident.

---

## Background: this used to be hardware

Sotto began as a pen with a built-in Bluetooth microphone, aimed at students. The
spec got fully worked out — $69 price floor, 10.5mm barrel, pogo-pin charging, D1
mini refill, composite audio + BLE HID, accelerometer wake, 800ms pre-roll — and
a 7-tab financial model exists for it (not in this repo).

It was parked, not killed, because the software version tests the same
hypothesis in weeks instead of a year and for almost no money. If people use
this daily and complain about phone-specific friction (notifications, battery,
unlocking), that's the evidence justifying $69 of hardware — written by paying
users instead of a survey. If they don't complain, the pen was never necessary.

A cheap middle path if universal injection ever becomes the priority: a ~$8
USB-C dongle (nRF52840) that receives BLE from the phone and presents to the
laptop as a plain USB keyboard. Any app, any OS, no permissions, nothing to
notarize.
