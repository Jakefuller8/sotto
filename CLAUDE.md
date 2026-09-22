# Sotto

Speak quietly into your phone; the text appears in an AI chat box on your
laptop. Built for working in cafés and libraries without talking at a screen.

Owner: Jake (first-year Wharton MBA). This is a full-time venture in place of a
summer internship, so speed to a testable product matters more than polish.

---

## Current state

Working end to end and tested on real devices. Version 1.2.0.

**Immediate blocker:** GitHub still has `server.js` at VERSION `1.0.1`. The
local copy is `1.2.0`. GitHub's web drag-and-drop silently skipped the file
because it had been browser-edited earlier, so Render keeps deploying the old
build. Two files need pushing:

- `server/server.js` — must reach `const VERSION = "1.2.0";`
- `server/public/index.html` — must contain `streamUpdate`

Verify after pushing: `curl -s https://sotto-relay.onrender.com/health` should
report `"version":"1.2.0"`.

**Live relay:** https://sotto-relay.onrender.com (Render, should be Starter tier
— free tier sleeps and wipes the in-memory analytics counters).

**Repo:** github.com/Jakefuller8/sotto

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

**Streaming replaces rather than appends.** The phone sends the whole current
utterance every ~180ms because the recogniser revises interim words. The
extension only ever deletes characters it can *prove* are its own — it checks
the text before the caret still matches exactly what it last inserted. If the
user typed in the box, that check fails and it appends instead. Worst case is a
duplicated phrase, never eating the user's own words. Do not weaken this check.

---

## Testing

```bash
cd server && npm test          # 67 assertions, no dependencies needed
cd extension && node qr.test.js # 25 assertions against ISO reference values
```

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
- **Analytics are in memory** and reset on redeploy or sleep.

---

## Next steps

**Blocking the pilot:**

1. Push the two files above; confirm `/health` shows 1.2.0
2. Host `store/privacy-policy.html` on GitHub Pages (needs a real contact email
   substituted for `[YOUR EMAIL ADDRESS]`) — required for store submission
3. Submit to the Chrome Web Store. Everything to paste is in
   `store/SUBMISSION.md`. Strip `qr.test.js` and `test-page.html` from the
   upload zip; `manifest.json` must sit at the zip root
4. Confirm Render is on Starter, not Free

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
