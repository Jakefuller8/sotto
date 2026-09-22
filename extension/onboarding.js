// Opens automatically after install. Shows a QR carrying the relay address and
// pairing code, so nothing has to be typed on either device.
//
// Pairing itself lives in pair.js, shared with the popup — one implementation
// means the two surfaces can't drift apart or disagree about stored keys.

const els = {
  qrBox: document.getElementById("qrBox"),
  dot: document.getElementById("dot"),
  status: document.getElementById("status"),
  sas: document.getElementById("sas"),
  sasNote: document.getElementById("sasNote"),
  openChat: document.getElementById("openChat"),
  link: document.getElementById("link"),
  repair: document.getElementById("repair"),
};

const MESSAGES = {
  "no-relay": ["off", "Can't reach the relay"],
  "no-phone": ["waiting", "Waiting for your phone"],
  pairing: ["waiting", "Pairing"],
  "no-tab": ["waiting", "Paired — now open a chat tab"],
  ready: ["paired", "Paired and encrypted"],
};

// A wrong code and a phone that simply isn't open yet produce the same
// "no-phone" stage, so after a grace period we name the code instead of
// leaving both devices waiting on each other indefinitely.
const ABSENT_GRACE_MS = 8000;
let absentSince = 0;

function drawQR(url) {
  try {
    els.qrBox.innerHTML = SottoQR.svg(url, { scale: 6, quiet: 3, dark: "#14161b" });
  } catch {
    els.qrBox.innerHTML =
      '<p style="color:#14161b;font-size:13px;padding:24px;max-width:190px;margin:0">' +
      "Couldn't draw the code — use the link below instead.</p>";
  }
}

function showSas(sas) {
  if (!sas) {
    els.sas.hidden = true;
    els.sasNote.hidden = true;
    return;
  }
  els.sas.textContent = sas;
  els.sas.hidden = false;
  els.sasNote.hidden = false;
}

async function probe() {
  const s = await SottoPair.status();
  const [tone, text] = MESSAGES[s.stage] || MESSAGES["no-relay"];

  els.dot.dataset.s = tone;

  if (s.stage === "no-phone") {
    if (!absentSince) absentSince = Date.now();
    els.status.textContent =
      Date.now() - absentSince < ABSENT_GRACE_MS
        ? text
        : "Still waiting — scan the code above with your phone's camera";
  } else {
    absentSince = 0;
    els.status.textContent = text;
  }

  showSas(s.sas);

  if (s.stage === "pairing") await SottoPair.pair(false).catch(() => {});

  // Only enable the button once text can actually arrive.
  if (s.stage === "ready" || s.stage === "no-tab") {
    els.openChat.removeAttribute("aria-disabled");
  } else {
    els.openChat.setAttribute("aria-disabled", "true");
  }
}

async function render() {
  const cfg = await SottoPair.config();
  const url = SottoPair.phoneUrl(cfg.relay, cfg.room);

  els.link.textContent = url;
  drawQR(url);
  return cfg;
}

els.repair.addEventListener("click", async () => {
  els.repair.disabled = true;
  els.status.textContent = "Generating a new code…";
  absentSince = 0;
  showSas(null);
  try {
    // reset() publishes a fresh key to the relay; that network call can fail
    // while the new code is still valid locally, so render either way.
    await SottoPair.reset().catch(() => {});
    await render();
  } finally {
    els.repair.disabled = false;
  }
  probe();
});

async function start() {
  await render();
  await SottoPair.pair(false).catch(() => {});
  probe();
  setInterval(probe, 2500);
}

start();
