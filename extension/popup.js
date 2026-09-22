// The popup owns pairing. It generates the laptop's ECDH keypair, publishes the
// public half, derives the shared AES key once the phone appears, and stores
// that key for the content script to use.

const RELAY = "https://sotto-relay.onrender.com";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const els = {
  dot: document.getElementById("dot"),
  status: document.getElementById("status"),
  phoneLink: document.getElementById("phoneLink"),
  copy: document.getElementById("copy"),
  sas: document.getElementById("sas"),
  relay: document.getElementById("relay"),
  room: document.getElementById("room"),
  save: document.getElementById("save"),
  reset: document.getElementById("reset"),
};

function newCode() {
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => ALPHABET[b % ALPHABET.length]).join("");
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

function render(tone, text) {
  els.dot.dataset.state = tone;
  els.status.textContent = text;
}

let state = { relay: RELAY, room: "", privJwk: null, sas: null };

async function importPriv(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
}

// Publishes our public key and, if the phone has already published its own,
// derives the shared secret. The relay only ever sees public keys.
async function pair(force) {
  const stored = await chrome.storage.local.get(["privJwk", "pubB64", "room", "relay"]);

  let privJwk = stored.privJwk;
  let pubB64 = stored.pubB64;
  const room = state.room;

  if (force || !privJwk || !pubB64) {
    const kp = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    );
    privJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    pubB64 = b64(await crypto.subtle.exportKey("raw", kp.publicKey));
    await chrome.storage.local.set({ privJwk, pubB64, aesJwk: null });
    state.sas = null;
    els.sas.textContent = "····";
    els.sas.classList.add("pending");
  }

  state.privJwk = privJwk;

  const res = await fetch(`https://${host(state.relay)}/pair?room=${room}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "laptop", pub: pubB64 }),
  });
  const data = await res.json();
  if (!data.peer) return false;

  const priv = await importPriv(privJwk);
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

  // Safety number: a short fingerprint of the shared secret. Shown on both
  // devices so an active relay cannot swap keys without being noticed.
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bits));
  let sas = "";
  for (let i = 0; i < 2; i++) {
    sas += ALPHABET[hash[i] % ALPHABET.length];
    sas += ALPHABET[hash[i + 8] % ALPHABET.length];
  }
  state.sas = sas;
  els.sas.textContent = sas;
  els.sas.classList.remove("pending");

  // Export as JWK so the content script can import it without needing the
  // raw ECDH material.
  const aesKey = await crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, true, [
    "encrypt",
    "decrypt",
  ]);
  const aesJwk = await crypto.subtle.exportKey("jwk", aesKey);
  await chrome.storage.local.set({ aesJwk });
  return true;
}

function renderLink() {
  const url = `https://${host(state.relay)}/#${state.room}`;
  els.phoneLink.href = url;
  els.phoneLink.textContent = url;
}

async function probe() {
  if (!/^[A-Z2-9]{6}$/.test(state.room)) {
    render("off", "No pairing code");
    return;
  }
  try {
    const health = await fetch(`https://${host(state.relay)}/health`, {
      cache: "no-store",
    });
    if (!health.ok) throw new Error();
    const info = await health.json();

    const pres = await fetch(
      `https://${host(state.relay)}/presence?room=${state.room}`,
      { cache: "no-store" }
    );
    const p = await pres.json();

    if (!p.phone) {
      render("waiting", `Relay up · waiting for your phone`);
      return;
    }
    if (!state.sas) {
      const done = await pair(false);
      if (!done) {
        render("waiting", "Phone seen · finishing pairing");
        return;
      }
    }
    render("paired", `Paired and encrypted · v${info.version}`);
  } catch {
    render("off", "Can't reach the relay");
  }
}

async function load() {
  const stored = await chrome.storage.local.get(["relay", "room", "aesJwk"]);
  state.relay = stored.relay || RELAY;
  state.room = (stored.room || "").toUpperCase();

  if (!/^[A-Z2-9]{6}$/.test(state.room)) {
    state.room = newCode();
    await chrome.storage.local.set({ room: state.room, relay: state.relay });
  }

  els.relay.value = host(state.relay);
  els.room.value = state.room;
  renderLink();

  await pair(false).catch(() => {});
  probe();
}

els.copy.addEventListener("click", async () => {
  await navigator.clipboard.writeText(els.phoneLink.href);
  els.copy.textContent = "Copied";
  setTimeout(() => (els.copy.textContent = "Copy link"), 1400);
});

els.save.addEventListener("click", async () => {
  const relay = host(els.relay.value) || RELAY;
  const room = els.room.value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 6);
  if (room.length !== 6) {
    render("off", "Code must be 6 characters");
    return;
  }
  state.relay = relay;
  state.room = room;
  state.sas = null;
  await chrome.storage.local.set({ relay, room, aesJwk: null });
  renderLink();
  await pair(true).catch(() => {});
  probe();
});

els.reset.addEventListener("click", async () => {
  state.room = newCode();
  state.sas = null;
  els.room.value = state.room;
  await chrome.storage.local.set({ room: state.room, aesJwk: null });
  renderLink();
  await pair(true).catch(() => {});
  probe();
});

load();
setInterval(probe, 2500);
