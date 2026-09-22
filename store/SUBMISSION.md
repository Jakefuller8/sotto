# Chrome Web Store submission

Everything you need to paste, plus the steps. Budget 45 minutes, most of it
hosting the privacy policy and taking screenshots.

---

## Part 1 — Host the privacy policy (10 min)

You need a public URL before you can submit. GitHub Pages is free and you
already have the repo.

1. In `store/privacy-policy.html`, replace `[YOUR EMAIL ADDRESS]` with a real
   address. A contact address is mandatory.
2. Create a folder called `docs` in your repo root and put `privacy-policy.html`
   inside it, renamed to `index.html`.
3. Repo → **Settings** → **Pages** → under Source pick **Deploy from a branch**,
   branch `main`, folder `/docs` → **Save**.
4. Wait about two minutes. Your URL becomes:
   `https://jakefuller8.github.io/sotto/`
5. Open it and confirm it renders.

Keep that URL. You'll paste it twice during submission.

---

## Part 2 — Package the extension (5 min)

The zip must have `manifest.json` at its **root**, not inside a folder.

**macOS:** open the `extension` folder, select all the files *inside* it
(Cmd+A), right-click → **Compress**. You'll get `Archive.zip` — rename it
`sotto-1.8.0.zip`.

Do **not** zip the `extension` folder itself. That nests everything one level
down and the upload will be rejected.

Before zipping, delete these two development-only files:

- `qr.test.js`
- `test-page.html`

They're harmless but reviewers flag unexplained files, and neither ships any
value to users.

---

## Part 3 — Register and upload (10 min)

1. Go to `https://chrome.google.com/webstore/devconsole`
2. Sign in and pay the **one-time $5** registration fee
3. Click **Items** → **+ New Item**
4. Drag in `sotto-1.8.0.zip`
5. Wait for it to process, then fill in the fields below

---

## Part 4 — Store listing fields

### Name
```
Sotto — speak quietly to AI
```

### Summary (132 characters max)
```
Speak quietly into your phone and the text appears in your AI chat box. Encrypted end to end.
```

### Description
```
Talk to Claude and ChatGPT without talking at your laptop.

Dictating to AI is faster than typing, but nobody wants to speak at their screen in a café, a library, or an open office. Sotto moves the microphone to where it should be: your phone, held close, at a volume only you can hear.

HOW IT WORKS

1. Install this extension
2. Scan the QR code that appears with your phone's camera
3. Hold the button on your phone and speak quietly
4. The text appears in your AI chat box

No app to download. No account. No subscription.

WHERE IT WORKS

claude.ai, chatgpt.com, gemini.google.com, aistudio.google.com and perplexity.ai.

ENCRYPTED END TO END

Your speech is transcribed on your phone and encrypted before it leaves the device. Our relay forwards text it has no key to read — not as a policy, but by construction.

Your phone and laptop exchange keys directly using ECDH, and both display a matching safety number so you can verify no one intercepted the exchange. Encryption is AES-GCM.

We never receive your audio. We never store your text. We keep no account, no email address, no advertising profile.

WHAT THIS IS NOT

Sotto is a microphone, not an assistant. It does not record, transcribe to a file, summarise, or process your speech with AI. It puts your words in a text box. That's the whole product.

PERMISSIONS

Storage, to keep your pairing key on your own device. Access to our relay address only — nothing else. The extension cannot read your conversations or any other site.

BUILT AT WHARTON

Made because talking to a laptop in a library feels ridiculous. If it's useful, or if something breaks, I'd like to hear about it.
```

### Category
```
Productivity
```

### Language
```
English (United States)
```

---

## Part 5 — Graphics

**Icon** — already in the zip at 128×128. Nothing to do.

**Screenshots** — at least one, at exactly **1280×800** or **640×400**. Take
three:

1. The onboarding page with the QR code visible
2. Claude with the green "Sotto ready" pill and dictated text in the box
3. Your phone screen showing the hold-to-talk button — photograph it or use
   QuickTime screen mirroring

On macOS, capture a region with **Cmd+Shift+4**, then resize to exactly 1280×800
in Preview (Tools → Adjust Size). Wrong dimensions are the most common rejection
reason, so check them.

**Small promo tile (440×280)** — optional. Skip it for now.

---

## Part 6 — Privacy tab

This is the section that decides how fast you get reviewed. Be precise.

**Single purpose description:**
```
Sotto inserts text dictated on the user's paired phone into the message box of AI chat sites, so users can speak quietly instead of typing.
```

**Permission justifications:**

`storage`
```
Stores the user's pairing code and their end-to-end encryption key locally on their own device. No data is stored remotely.
```

`host permission (sotto-relay.onrender.com)`
```
The extension retrieves the user's own dictated text from this relay, which is the only server it contacts. Text is encrypted on the user's phone before it reaches the relay and is decrypted locally by the extension.
```

**Are you using remote code?**
```
No
```
All code is in the package. Nothing is fetched or evaluated at runtime.

**Data usage — check these:**

- Does your extension collect user data? → **Yes**
- Which types? → **Website content** only. This covers the dictated text. Do
  not check personally identifiable information, health, financial, location,
  authentication, personal communications, or web history.

**Then check all three certification boxes:**
- Not being sold to third parties
- Not being used for purposes unrelated to the item's core functionality
- Not being used to determine creditworthiness or for lending

**Privacy policy URL:** your GitHub Pages URL from Part 1.

---

## Part 7 — Distribution and submit

**Visibility:** choose **Unlisted** for the pilot.

It won't appear in search or in the public category listings, but anyone with
the link can install it. Fewer eyes, usually quicker review, and you can switch
to Public later without resubmitting.

**Distribution:** all regions is fine.

Then click **Submit for review**.

---

## What happens next

Expect **1–3 days**. Simple permission scopes like yours usually clear at the
fast end. You'll get an email either way.

If it's rejected, the email names the specific policy. The usual causes are
screenshot dimensions, a privacy policy URL that 404s, or a permission
justification that doesn't match what the code does. All are quick to fix, and
resubmission goes back into the same queue.

While you wait:

- Test with 3–5 friends using **Load unpacked** so you find problems before 30
  people see them
- Draft your WhatsApp message
- Leave Render on the paid tier so nobody hits a cold start

---

## After approval

1. Install the store version yourself
2. **Remove the unpacked copy** from `chrome://extensions` — two copies both
   inserting text into the same box produces duplicated text and very confusing
   debugging
3. Copy your store link
4. Post it

Suggested WhatsApp message:

```
Built a thing. You speak quietly into your phone and the text appears in Claude or ChatGPT on your laptop — made for working in Huntsman without talking at your screen.

Encrypted end to end, I genuinely can't see what you dictate.

Setup is about a minute: install, scan a QR with your phone, done. [LINK]

Only ask: if you try it, tell me whether you used it more than once.
```

That last line is doing real work. It primes people to notice their own
behaviour, which is the thing you actually need to measure.
