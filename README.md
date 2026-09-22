# Sotto

Speak quietly into your phone. The text appears in the AI chat box on your laptop.

Your phone transcribes your speech locally and encrypts the result before it
leaves the device. The relay forwards ciphertext it has no key for.

```
phone mic → transcribed on phone → encrypted → relay → decrypted in browser → typed into the chat box
```

Works on claude.ai, chatgpt.com, gemini.google.com, aistudio.google.com and
perplexity.ai — in Chrome, in a browser tab.

---

## Before you deploy: set your relay address

The relay hostname is baked in so nobody has to type it. It appears once in each
of two files, and you need to change both to whatever Render gives you:

- `extension/content.js` line 11 — `const RELAY = "https://..."`
- `extension/popup.js` line 5 — `const RELAY = "https://..."`

Render appends a suffix when your chosen subdomain is taken, so the address is
often not the name you picked. Check your Render dashboard.

If you forget, you can still set it once in the popup under **Advanced** — it
persists to storage. But then every pilot user would have to do the same, which
defeats the point.

---

## Setup, from a student's point of view

1. Tap the Chrome Web Store link **on a laptop** and click Add to Chrome
2. The setup page opens by itself with a QR code
3. Point the phone camera at it, tap the notification
4. Add Sotto to the home screen, allow the microphone
5. Open Claude and talk

Nothing typed. No account, no email, no password. The WhatsApp message must say
"open on your laptop" — a store link tapped on a phone goes nowhere useful, and
that is the most likely real-world failure.

## What's here

| Path | What it is |
|---|---|
| `server/server.js` | Relay. Long-polling, ECDH brokerage, event-only analytics. No dependencies. |
| `extension/qr.js` | QR encoder written from scratch. Byte mode, EC level M, versions 1-10. |
| `extension/qr-test.js` | QR self-checks. `node qr-test.js` — 25 assertions. |
| `extension/onboarding.html` | Setup page, opened automatically on install. |
| `extension/pair.js` | Shared ECDH pairing used by the popup and onboarding. |
| `server/public/index.html` | The phone app. |
| `server/public/manifest.webmanifest`, `sw.js` | Makes it installable as a PWA. |
| `server/test.js` | 48 assertions including a real ECDH + AES-GCM round trip. |
| `extension/` | Chrome extension. |
| `extension/onboarding.html` | Setup page with QR pairing. Opens automatically on install. |
| `extension/qr.js` | QR encoder, written from scratch (MV3 forbids remote scripts). |
| `extension/qr.test.js` | Validates the encoder against ISO/IEC 18004 constants. 25 assertions. |
| `store/` | Privacy policy and Chrome Web Store submission guide. |
| `extension/test-page.html` | Tests text insertion in your browser, no relay needed. |

---

## Deploy

**1. Relay.** Push to GitHub, create a Render **Web Service**: root directory
`server`, build command `npm install`, start command `npm start`. Zero
dependencies, so the build is instant.

Verify at `https://your-address.onrender.com/health` — you want
`{"ok":true,"name":"sotto","version":"1.1.0"}`.

**Upgrade off the free tier before sending this to anyone.** Free instances sleep
after 15 minutes and take ~30 seconds to wake. The first person who tries it
during a cold start will decide it's broken.

**2. Extension.** `chrome://extensions` → Developer mode → Load unpacked →
`extension/`. For the pilot, publish to the Chrome Web Store instead ($5 one-off,
1–3 day review) so classmates get a one-click install with no Developer mode.

**3. Phone.** Open the popup, tap the link on your phone, then **Add to Home
Screen**. It launches fullscreen with its own icon.

---

## How pairing works

Neither device ever sends a key through the relay.

1. Each side generates an ECDH P-256 keypair and publishes only its public key.
2. Each derives the same 256-bit secret locally, used as an AES-GCM key.
3. Both display a four-character **safety number** — a fingerprint of that
   shared secret.

If the safety numbers match, nobody has tampered with the exchange. A passive
relay learns nothing; an active one swapping keys would produce mismatched
safety numbers. This is the same pattern as Signal's safety numbers.

Ciphertext is authenticated, so tampering is detected rather than silently
decrypted into garbage. The test suite verifies this.

---

## Analytics

`GET /stats` returns aggregate counters:

```
uniqueUsers, pairings, dictations, submits,
avgCiphertextChars, returningUsers {d1, d7, d14}, activeRooms
```

Room codes are SHA-256 hashed before they touch a counter or a log line. No
transcript, plaintext or ciphertext is ever logged or persisted. Logs are of the
form `event=dictation user=<hash> size=<n>`.

Counters are in memory, so they reset on redeploy or sleep. Fine for a pilot; for
anything longer, write events to a real store.

**The number that matters is `returningUsers.d7`.** Downloads measure curiosity.
Day-7 return measures whether you have a product.

---

## Why the QR encoder is hand-written

Manifest V3 forbids loading remote scripts, and a hosted QR image service would
send the pairing code to a third party — which would defeat the point of
end-to-end encryption. So `qr.js` implements the spec directly: Reed-Solomon
over GF(256), all eight mask patterns with penalty scoring, BCH-coded format
and version information.

It was verified module-for-module against OpenCV's reference encoder across
versions 2 through 9 — codewords, format bits, remainder bits and version info
all matched exactly. Two bugs surfaced that way, both of which produce a QR
that looks perfect and scans as nothing:

1. The two format-info copies were swapped (bits 0-7 run along row 8 from the
   right edge, not down column 8).
2. Format info is placed MSB-first — bit 14 at (8,0), not bit 0.

## Test status

`cd server && npm test` — 61 assertions. Covers validation, ECDH pairing,
safety-number agreement, encrypted delivery, tamper rejection, proof that
plaintext never appears in payloads or logs, unicode, long dictations, queueing,
room isolation, latency and the analytics shape.

`extension/qr.test.js` — `node qr.test.js` checks format strings against the
ISO table, byte-mode capacities, Reed-Solomon syndromes, finder and timing
patterns, and the quiet zone.

`extension/test-page.html` — open in Chrome. Also covers streaming:
extension, revision, a new utterance, and the case where the user has typed in
the box first. Runs the real `content.js` against a
mock ProseMirror box: appends rather than replaces, fires the `beforeinput` and
`input` events frameworks depend on, handles multibyte text, finds the send
button.

`cd extension && node qr-test.js` — 25 assertions on the QR encoder.

Untested because it needs real devices: iOS Safari speech recognition, the
home-screen install flow, and whether a phone camera scans the rendered QR.
That last one takes ten seconds to check — point a phone at the setup page. The
"open this on your phone" link below the QR is the fallback if it doesn't.

---

## Known limits

**Chrome browser tabs only.** Not the Claude desktop app, Word or a terminal.
That needs a native helper that synthesizes keystrokes — the macOS Accessibility
API, or `SendInput` on Windows. Roughly 300 lines per platform, plus a $99/year
Apple account to avoid Gatekeeper warnings.

**Safari plays a chime** when a recognition session starts. iOS triggers it and
no web API can suppress it. It used to fire on every press; the session now
stays alive across presses, so you hear it once per session rather than once
per sentence. The cost is that the microphone stays open for 10 seconds after
you release, and on iOS that audio goes to Apple for recognition — a deliberate
trade, not an oversight. Removing the chime entirely would mean transcribing
server-side, which would break the end-to-end encryption promise.

Worth trying: the chime appears to follow the ringer volume on iOS, so turning
the ringer down may quiet it further. Unverified.

**Text appears as you speak.** The phone sends the whole current utterance on
each update (throttled to ~180ms) and the extension replaces what it wrote,
because the recogniser revises interim words as it hears more. The extension
only ever deletes characters it can prove are its own — it checks that the text
before the caret still matches exactly what it last inserted. If you typed in
the box mid-dictation that check fails and it appends instead, so the worst case
is a duplicated phrase rather than losing your own words.

**Transcription is literal.** Every "um" and false start survives. Deliberate:
LLMs handle messy input fine, and cleaning it up server-side would mean decrypting
it there.

**iOS suspends background pages.** The app must be foregrounded and the screen on.
No always-listening mode.

**Home screen install is required**, with a small "continue in the browser"
escape hatch. Add to Home Screen lives in a share sheet the page cannot control,
so gating on it without an exit would leave a stuck user with nowhere to go.

**Selectors will break** when Claude or ChatGPT reship their UI. The generic
`div[contenteditable="true"]` fallback absorbs most redesigns.

---

## If nothing happens

- **No pill in the top-right of the chat page** — reload the tab. Content scripts only inject on page load.
- **"Sotto offline"** — wrong relay address, or the instance is asleep. Open `/health` to wake it.
- **"Sotto: open the app on your phone"** — not paired yet. Open the phone app.
- **"Sotto: pairing expired"** — the shared key is stale. Popup → **Set up or re-pair** → **Re-pair with a new code**.
- **"Laptop not connected" / "Phone not connected"** — the two devices ended up on different pairing codes. Scan the laptop's QR again; that always fixes it. Not a security problem — only a mismatched *safety number* is. (Each device's code is in its own settings if you need it for support.)
- **Pill says ready, no text** — the extension focuses the prompt box itself, so you shouldn't need to click into it first. If nothing lands, the site has probably reshipped its UI and the selectors in `content.js` need updating. Clicking into the box is a useful workaround meanwhile, since a focused editable element is preferred over the selector search.
- **Safety numbers differ** — re-pair with a new code before dictating anything sensitive.
- **Phone shows no grey preview** — wrong browser (Safari on iPhone, Chrome on Android) or mic denied.
