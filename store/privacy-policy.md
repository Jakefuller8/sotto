# Sotto — Privacy Policy

**Last updated: 21 September 2026**

Sotto lets you speak quietly into your phone and have the text appear in an AI
chat box on your laptop. This policy explains exactly what happens to your words.

## The short version

Your speech is turned into text on your phone. That text is encrypted on your
phone before it is sent, and decrypted only in your browser. The server that
passes it between your devices has no key and cannot read it.

We do not sell data. We do not show ads. We do not build advertising profiles.

## What we handle, and what we don't

**Dictated text.** Encrypted on your phone using AES-GCM with a key derived on
your own devices via an ECDH key exchange. The relay server forwards ciphertext
it cannot decrypt. It is never written to disk, never logged, and is deleted
from memory as soon as your laptop collects it — or within 30 minutes if your
laptop never does.

**Audio.** Never transmitted to us and never stored anywhere by Sotto. Speech
recognition runs through your phone browser's built-in engine. On iPhone, Safari
may send audio to Apple for processing under
[Apple's privacy policy](https://www.apple.com/legal/privacy/); on Android,
Chrome may send audio to Google under
[Google's privacy policy](https://policies.google.com/privacy). That processing
is between you and those companies. Sotto neither receives nor retains audio.

**Pairing keys.** Your devices exchange ECDH public keys through the relay.
Public keys alone cannot decrypt anything. Private keys never leave your
devices.

**Usage counts.** We keep aggregate counters: how many dictations happen, their
approximate length, and how many distinct devices are in use. Pairing codes are
hashed with SHA-256 before they appear in any counter or log line, so a count
cannot be traced back to a specific person. We do not log text, audio, IP
addresses, or any content.

**What we never collect:** your name, email address, phone number, contacts,
location, browsing history, or the contents of the pages you visit.

## What the extension can access

The Sotto browser extension requests two things:

- **Storage** — to keep your pairing code and encryption key on your own device.
- **Access to our relay address only** — to receive your dictated text. It
  cannot read or send data to any other website.

The extension runs on claude.ai, chatgpt.com, gemini.google.com,
aistudio.google.com and perplexity.ai, where it does one thing: place your
dictated text into the message box. It does not read your conversations, your
chat history, or anything else on those pages.

## Third parties

Our relay is hosted on [Render](https://render.com), which processes network
traffic on our behalf under its own privacy terms. Because the text is encrypted
before it reaches the relay, Render cannot read it either.

We use no analytics services, no trackers, no advertising networks, and no
third-party cookies.

## Retention

| Data | Kept for |
|---|---|
| Encrypted text awaiting pickup | Until collected, or 30 minutes |
| Pairing public keys | 30 minutes after last activity |
| Aggregate usage counters | Until the server restarts |
| Your pairing code and key | On your devices, until you re-pair or uninstall |

## Your control

Remove everything at any time: uninstall the extension, and delete the Sotto
page from your phone's home screen and browser data. That erases your keys and
pairing code. Nothing identifiable about you remains on our side, because we
never had it.

Re-pairing from the extension's Advanced menu generates fresh keys and
immediately invalidates the old ones.

## Verifying these claims

The safety number shown on both your phone and your laptop is a fingerprint of
your shared encryption key. If the two match, no one — including us — has
intercepted the key exchange. If they ever differ, re-pair before dictating
anything sensitive.

## Children

Sotto is not directed at children under 13 and we do not knowingly collect
information from them.

## Changes

If this policy changes materially, the date at the top will change and the
updated version will be posted at this address.

## Contact

Questions about privacy: **[YOUR EMAIL ADDRESS]**
