// Status only. Pairing itself happens on the onboarding page, which has room
// for the QR code.

const els = {
  dot: document.getElementById("dot"),
  status: document.getElementById("status"),
  sas: document.getElementById("sas"),
  setup: document.getElementById("setup"),
  relay: document.getElementById("relay"),
  room: document.getElementById("room"),
  save: document.getElementById("save"),
};

const MESSAGES = {
  "no-relay": ["", "Can't reach the relay"],
  "no-phone": ["wait", "Open Sotto on your phone"],
  pairing: ["wait", "Finishing pairing…"],
  "no-tab": ["wait", "Open Claude in a tab"],
  ready: ["ok", "Ready · encrypted"],
};

async function tick() {
  const s = await SottoPair.status();
  const [tone, text] = MESSAGES[s.stage] || MESSAGES["no-relay"];
  els.dot.dataset.s = tone;
  els.status.textContent = s.stage === "ready" ? `${text} · v${s.version}` : text;

  if (s.sas) {
    els.sas.textContent = s.sas;
    els.sas.classList.remove("pending");
  } else {
    els.sas.textContent = "····";
    els.sas.classList.add("pending");
  }

  if (!els.relay.value) els.relay.value = SottoPair.host(s.relay);
  if (!els.room.value) els.room.value = s.room;
}

els.setup.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
  window.close();
});

els.save.addEventListener("click", async () => {
  const relay = SottoPair.host(els.relay.value) || SottoPair.RELAY;
  const room = els.room.value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 6);
  if (room.length !== 6) {
    els.status.textContent = "Code must be 6 characters";
    return;
  }
  await chrome.storage.local.set({ relay, room, aesJwk: null, sas: null });
  await SottoPair.pair(true).catch(() => {});
  tick();
});

tick();
setInterval(tick, 2500);
