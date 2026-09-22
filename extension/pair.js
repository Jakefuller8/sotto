// Shared pairing logic for the popup and the onboarding page.
//
// Pairing is an ECDH exchange brokered by the relay: each side publishes only
// its public key, both derive the same AES-GCM key locally, and both display a
// four-character fingerprint of it so a tampering relay would be visible.

const SottoPair = (function () {
  "use strict";

  const RELAY = "https://sotto-relay.onrender.com";
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  function newCode() {
    const buf = new Uint8Array(6);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => ALPHABET[b % ALPHABET.length]).join("");
  }

  function newInstallId() {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function b64(bytes) {
    return btoa(String.fromCharCode(...new Uint8Array(bytes)));
  }

  function unb64(str) {
    const raw = atob(str);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function host(relay) {
    return (relay || RELAY).replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }

  function base(relay) {
    return "https://" + host(relay);
  }

  // A query parameter, not a fragment. A fragment is never sent to the server,
  // so the relay could not know the room while serving the page — and it has to
  // know, because it must emit <link rel="manifest" href="...?room=CODE"> in
  // the HTML itself. iOS parses that link when the page loads; rewriting the
  // href from JavaScript afterwards is too late, which is why an installed icon
  // came up unpaired. The phone accepts both forms.
  function phoneUrl(relay, room) {
    return `${base(relay)}/?room=${room}`;
  }

  // Ensures relay, room and installId exist in storage. Returns them.
  async function config() {
    const stored = await chrome.storage.local.get(["relay", "room", "installId"]);
    const patch = {};
    if (!stored.relay) patch.relay = RELAY;
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(stored.room || "")) patch.room = newCode();
    if (!stored.installId) patch.installId = newInstallId();
    if (Object.keys(patch).length) await chrome.storage.local.set(patch);
    return { ...stored, ...patch };
  }

  function sasFrom(hashBytes) {
    let sas = "";
    for (let i = 0; i < 2; i++) {
      sas += ALPHABET[hashBytes[i] % ALPHABET.length];
      sas += ALPHABET[hashBytes[i + 8] % ALPHABET.length];
    }
    return sas;
  }

  // Publishes our public key; derives and stores the shared key if the phone
  // has already published its own. Returns the safety number, or null.
  async function pair(force) {
    const { relay, room } = await config();
    const stored = await chrome.storage.local.get(["privJwk", "pubB64", "sas"]);

    let privJwk = stored.privJwk;
    let pubB64 = stored.pubB64;

    if (force || !privJwk || !pubB64) {
      const kp = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"]
      );
      privJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
      pubB64 = b64(await crypto.subtle.exportKey("raw", kp.publicKey));
      await chrome.storage.local.set({ privJwk, pubB64, aesJwk: null, sas: null });
    }

    const res = await fetch(`${base(relay)}/pair?room=${room}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "laptop", pub: pubB64 }),
    });
    const data = await res.json();
    if (!data.peer) return null;

    const priv = await crypto.subtle.importKey(
      "jwk",
      privJwk,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    );
    const peerKey = await crypto.subtle.importKey(
      "raw",
      unb64(data.peer),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      []
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "ECDH", public: peerKey },
      priv,
      256
    );

    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bits));
    const sas = sasFrom(hash);

    const aesKey = await crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, true, [
      "encrypt",
      "decrypt",
    ]);
    const aesJwk = await crypto.subtle.exportKey("jwk", aesKey);
    await chrome.storage.local.set({ aesJwk, sas });
    return sas;
  }

  async function reset() {
    const room = newCode();
    await chrome.storage.local.set({ room, aesJwk: null, sas: null });
    await pair(true);
    return room;
  }

  // One call that reports the whole chain, in the order a user must fix it.
  async function status() {
    const { relay, room } = await config();
    const stored = await chrome.storage.local.get(["sas"]);

    try {
      const health = await fetch(`${base(relay)}/health`, { cache: "no-store" });
      if (!health.ok) throw new Error();
      const info = await health.json();

      const pres = await fetch(`${base(relay)}/presence?room=${room}`, {
        cache: "no-store",
      });
      const p = await pres.json();

      let sas = stored.sas || null;

      // `paired` goes false whenever the relay has dropped the room — 30
      // minutes idle, or any redeploy — even though both devices still hold a
      // usable key. Republish so the phone can find us again. pair(false)
      // returns null and leaves the stored key untouched when the relay has no
      // peer key yet, so this cannot downgrade a working pairing.
      if (p.phone && (!sas || !p.paired)) sas = (await pair(false)) || sas;

      let stage = "ready";
      if (!p.phone) stage = "no-phone";
      else if (!sas) stage = "pairing";
      else if (!p.laptop) stage = "no-tab";

      return { stage, sas, relay, room, version: info.version };
    } catch {
      return { stage: "no-relay", sas: stored.sas || null, relay, room };
    }
  }

  return {
    RELAY,
    newCode,
    host,
    base,
    phoneUrl,
    config,
    pair,
    reset,
    status,
  };
})();
