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

## What's here

| Path | What it is |
|---|---|
| `server/server.js` | Relay. Long-polling, ECDH brokerage, event-only analytics. No dependencies. |
| `server/public/index.html` | The phone app. |
| `server/public/manifest.webmanifest`, `sw.js` | Makes it installable as a PWA. |
| `server/test.js` | 48 assertions including a real ECDH + AES-GCM round trip. |
| `extension/` | Chrome extension. |
| `extension/test-page.html` | Tests text insertion in your browser, no relay needed. |

---

## Deploy

**1. Relay.** Push to GitHub, create a Render **Web Service**: root directory
`server`, build command `npm install`, start command `npm start`. Zero
dependencies, so the build is instant.

Verify at `https://your-address.onrender.com/health` — you want
`{"ok":true,"name":"sotto","version":"1.0.0"}`.

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

## Test status

`cd server && npm test` — 48 assertions. Covers validation, ECDH pairing,
safety-number agreement, encrypted delivery, tamper rejection, proof that
plaintext never appears in payloads or logs, unicode, long dictations, queueing,
room isolation, latency and the analytics shape.

`extension/test-page.html` — open in Chrome. Runs the real `content.js` against a
mock ProseMirror box: appends rather than replaces, fires the `beforeinput` and
`input` events frameworks depend on, handles multibyte text, finds the send
button.

Untested because it needs real devices: iOS Safari speech recognition, PWA
install, and whether phone noise suppression preserves quiet speech.

---

## Known limits

**Chrome browser tabs only.** Not the Claude desktop app, Word or a terminal.
That needs a native helper that synthesizes keystrokes — the macOS Accessibility
API, or `SendInput` on Windows. Roughly 300 lines per platform, plus a $99/year
Apple account to avoid Gatekeeper warnings.

**Safari plays a chime** on every recognition session. iOS triggers it and no API
can suppress it. The page now avoids needless restarts, so you hear it less, but
removing it entirely means transcribing server-side instead of on-device — which
would break the end-to-end encryption promise.

**Transcription is literal.** Every "um" and false start survives. Deliberate:
LLMs handle messy input fine, and cleaning it up server-side would mean decrypting
it there.

**iOS suspends background pages.** The app must be foregrounded and the screen on.
No always-listening mode.

**Selectors will break** when Claude or ChatGPT reship their UI. The generic
`div[contenteditable="true"]` fallback absorbs most redesigns.

---

## If nothing happens

- **No pill in the top-right of the chat page** — reload the tab. Content scripts only inject on page load.
- **"Sotto offline"** — wrong relay address, or the instance is asleep. Open `/health` to wake it.
- **"Sotto: open the app on your phone"** — not paired yet. Open the phone app.
- **"Sotto: pairing expired"** — the shared key is stale. Popup → Advanced → **Re-pair with a new code**.
- **Pill says ready, no text** — you didn't click into the chat box.
- **Safety numbers differ** — re-pair with a new code before dictating anything sensitive.
- **Phone shows no grey preview** — wrong browser (Safari on iPhone, Chrome on Android) or mic denied.
