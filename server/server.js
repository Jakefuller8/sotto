// Sotto relay. Plain HTTP long-polling, zero dependencies.
//
// The relay is deliberately dumb. It routes opaque ciphertext between two
// devices that share a room code, and brokers an ECDH handshake by passing
// public keys through. It never holds the decryption key, so it cannot read
// anything it forwards.
//
// Analytics count events only. No transcript, plaintext or ciphertext is ever
// logged or persisted.
//
// Endpoints
//   GET  /                      phone page
//   GET  /health                deploy + version check
//   GET  /stats                 aggregate usage counters
//   POST /pair?room=XXXXXX      {role, pub}  publish an ECDH public key
//   GET  /pair?room=XXXXXX      returns {laptop, phone} public keys
//   GET  /poll?room=XXXXXX      laptop waits here (held up to 25s)
//   POST /say?room=XXXXXX       phone posts {iv, ct} or {submit:true}
//   GET  /presence?room=XXXXXX  is the other device around?

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const VERSION = "1.9.0";
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");

const HOLD_MS = 25000;
const PRESENCE_MS = 12000;
const MAX_BODY = 40000;
const MAX_QUEUE = 20;
const ROOM_TTL_MS = 30 * 60 * 1000;

// Matches the generator alphabet on both clients: I and O are excluded so they
// cannot be confused with 1 and 0. Accepting them here would let a mistyped
// code open a real room that nothing else will ever join.
const ROOM_RE = /^[A-HJ-NP-Z2-9]{6}$/;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

// roomId -> { queue, waiters, lastPoll, lastSay, pub: {laptop, phone}, created }
const rooms = new Map();

// Aggregate counters only. Keys are hashed so a room code never lands in a log.
const stats = {
  startedAt: Date.now(),
  pairings: 0,
  dictations: 0,
  submits: 0,
  charsRelayed: 0, // ciphertext length, a proxy for dictation length
  seen: new Map(), // hashedRoom -> { first, last, days:Set, dictations }
  // date -> { users:Set<hashedId>, dictations }. Totals alone cannot show
  // whether a pilot is growing or dying — "47 dictations" reads the same for
  // eight steady users and one person on day one. Kept per day so the shape
  // is visible.
  daily: new Map(),
};

// A month of history is enough to see a trend; 90 bounds the file so it
// cannot grow without limit.
const DAILY_KEEP_DAYS = 90;

// ---- persistence -------------------------------------------------------
// returningUsers.d7 is the number this pilot exists to produce, and it needs
// seven days of history. In memory it reset on every deploy — ten in one day
// during development — so the measurement could never accumulate.
//
// Still no dependencies: one JSON file, written atomically. Point
// SOTTO_DATA_DIR at a Render disk, or this falls back to a local directory
// that does not survive a redeploy. /stats reports which, so a
// misconfiguration is visible rather than silently losing a week of data.
const CONFIGURED_DIR = !!process.env.SOTTO_DATA_DIR;
const DATA_DIR = process.env.SOTTO_DATA_DIR || path.join(__dirname, ".data");
const STATS_FILE = path.join(DATA_DIR, "stats.json");

// Three states, not two. Render's filesystem is writable without a disk
// attached, so a successful write proves nothing — it would still be wiped on
// the next deploy while reporting "disk" and quietly losing the pilot's only
// measurement. "ephemeral" is that case, named so it is visible in /stats.
let persistence = "memory";

function encodeStats() {
  return JSON.stringify({
    v: 1,
    startedAt: stats.startedAt,
    pairings: stats.pairings,
    dictations: stats.dictations,
    submits: stats.submits,
    charsRelayed: stats.charsRelayed,
    // Map and Set do not survive JSON, so both are flattened.
    seen: Array.from(stats.seen.entries()).map(([key, s]) => [
      key,
      { first: s.first, last: s.last, days: Array.from(s.days), dictations: s.dictations },
    ]),
    daily: Array.from(stats.daily.entries())
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .slice(0, DAILY_KEEP_DAYS)
      .map(([date, d]) => [date, { users: Array.from(d.users), dictations: d.dictations }]),
  });
}

function loadStats() {
  let raw;
  try {
    raw = fs.readFileSync(STATS_FILE, "utf8");
  } catch {
    // No file yet is the normal first run, not an error.
    return;
  }

  try {
    const d = JSON.parse(raw);
    if (!d || d.v !== 1) return;
    stats.startedAt = d.startedAt || stats.startedAt;
    stats.pairings = d.pairings || 0;
    stats.dictations = d.dictations || 0;
    stats.submits = d.submits || 0;
    stats.charsRelayed = d.charsRelayed || 0;
    stats.seen = new Map(
      (d.seen || []).map(([key, s]) => [
        key,
        { first: s.first, last: s.last, days: new Set(s.days || []), dictations: s.dictations || 0 },
      ])
    );
    stats.daily = new Map(
      (d.daily || []).map(([date, v]) => [
        date,
        { users: new Set(v.users || []), dictations: v.dictations || 0 },
      ])
    );
  } catch {
    // A truncated or corrupt file must not stop the relay from serving.
    console.log("event=stats_load_failed");
  }
}

let saveTimer = null;

function saveStatsNow() {
  saveTimer = null;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Write then rename, so a crash mid-write cannot leave a corrupt file
    // where a week of retention data used to be.
    const tmp = STATS_FILE + ".tmp";
    fs.writeFileSync(tmp, encodeStats());
    fs.renameSync(tmp, STATS_FILE);
    persistence = CONFIGURED_DIR ? "disk" : "ephemeral";
  } catch {
    persistence = "memory";
  }
}

// Every dictation would otherwise mean a write. Coalesce them.
function saveStats() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveStatsNow, 5000);
  saveTimer.unref();
}

loadStats();
saveStatsNow(); // establishes whether the directory is actually writable

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    // Render sends SIGTERM on redeploy; this is the flush that matters.
    saveStatsNow();
    process.exit(0);
  });
}

function tag(room) {
  return crypto.createHash("sha256").update("sotto:" + room).digest("hex").slice(0, 12);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function note(room, kind, size) {
  const r = rooms.get(room);
  // Prefer the extension's install id so re-pairing doesn't look like a new
  // user. Falls back to the room code before the laptop has checked in.
  const key = r && r.installId ? tag(r.installId) : tag(room);
  let s = stats.seen.get(key);
  if (!s) {
    s = { first: today(), last: today(), days: new Set(), dictations: 0 };
    stats.seen.set(key, s);
    stats.pairings++;
  }
  s.last = today();
  s.days.add(today());

  let day = stats.daily.get(today());
  if (!day) {
    day = { users: new Set(), dictations: 0 };
    stats.daily.set(today(), day);
  }
  day.users.add(key);
  if (kind === "dictation") day.dictations++;

  if (kind === "install") {
    console.log(`event=install user=${key}`);
    saveStats();
    return;
  }

  if (kind === "dictation") {
    s.dictations++;
    stats.dictations++;
    stats.charsRelayed += size || 0;
    console.log(`event=dictation user=${key} size=${size || 0}`);
  } else if (kind === "submit") {
    stats.submits++;
  }

  saveStats();
}

function dayKey(offset) {
  return new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
}

// Distinct users across the last n days, deduplicated — someone active on
// three of them counts once.
function activeSince(days) {
  const people = new Set();
  for (let i = 0; i < days; i++) {
    const d = stats.daily.get(dayKey(i));
    if (d) for (const u of d.users) people.add(u);
  }
  return people.size;
}

// Oldest first, and days with no activity are included as zeroes — a gap in
// the series is a signal, and omitting it would hide the shape.
function recentDays(days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = dayKey(i);
    const d = stats.daily.get(date);
    out.push({ date, users: d ? d.users.size : 0, dictations: d ? d.dictations : 0 });
  }
  return out;
}

// A laptop parked on a long poll is present by definition — that held request
// IS the connection. lastPoll alone could not express that: it is stamped once
// when the poll arrives and the request then hangs for up to HOLD_MS (25s),
// while presence expires after PRESENCE_MS (12s). So for over half of every
// poll cycle the relay reported a connected laptop as gone, and the phone
// flapped between "Paired" and "Laptop not connected" during normal use.
function laptopPresent(r) {
  if (!r) return false;
  if (r.waiters.length) return true;
  return Date.now() - r.lastPoll < PRESENCE_MS;
}

function room(id) {
  let r = rooms.get(id);
  if (!r) {
    r = {
      queue: [],
      waiters: [],
      lastPoll: 0,
      lastSay: 0,
      pub: { laptop: null, phone: null },
      installId: null,
      created: Date.now(),
    };
    rooms.set(id, r);
  }
  return r;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function flush(r) {
  if (!r.queue.length || !r.waiters.length) return;
  const batch = r.queue.splice(0, r.queue.length);
  const waiters = r.waiters.splice(0, r.waiters.length);
  for (const w of waiters) {
    clearTimeout(w.timer);
    json(w.res, 200, { messages: batch });
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let data = "";
    let over = false;
    req.on("data", (chunk) => {
      if (over) return;
      data += chunk;
      if (data.length > limit) {
        over = true;
        reject(new Error("too large"));
      }
    });
    req.on("end", () => {
      if (!over) resolve(data);
    });
    req.on("error", reject);
  });
}

function serveStatic(res, urlPath, room) {
  const filePath = path.join(PUBLIC, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC)) {
    json(res, 403, { error: "forbidden" });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    let out = data;

    if (path.extname(filePath) === ".html") {
      out = Buffer.from(data.toString("utf8").replace("SOTTO_VERSION_TOKEN", VERSION));
      data = out;
    }

    // Point the manifest at this room in the HTML itself. iOS parses
    // <link rel="manifest"> when the page loads and does not appear to honour
    // a later href change from JavaScript, so the page has to arrive with the
    // right one — otherwise "Add to Home Screen" captures start_url "/" and
    // the icon opens unpaired. This is why the QR carries ?room= rather than a
    // fragment: a fragment never reaches the server.
    if (path.extname(filePath) === ".html" && ROOM_RE.test(room || "")) {
      out = Buffer.from(
        data
          .toString("utf8")
          .replace(
            /href="\/manifest\.webmanifest"/,
            `href="/manifest.webmanifest?room=${room}"`
          )
      );
    }

    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": path.extname(filePath) === ".html" ? "no-cache" : "public, max-age=300",
      "Content-Length": Buffer.byteLength(out),
    });
    res.end(out);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const route = url.pathname;

  if (req.method === "OPTIONS") {
    json(res, 204, {});
    return;
  }

  if (route === "/health") {
    json(res, 200, {
      ok: true,
      name: "sotto",
      version: VERSION,
      rooms: rooms.size,
      uptimeSeconds: Math.round(process.uptime()),
    });
    return;
  }

  if (route === "/stats") {
    const retained = { d1: 0, d7: 0, d14: 0 };
    for (const s of stats.seen.values()) {
      const span = s.days.size;
      if (span >= 2) retained.d1++;
      if (span >= 5) retained.d7++;
      if (span >= 8) retained.d14++;
    }
    json(res, 200, {
      version: VERSION,
      uptimeHours: +((Date.now() - stats.startedAt) / 3600000).toFixed(1),
      uniqueUsers: stats.seen.size,
      pairings: stats.pairings,
      dictations: stats.dictations,
      submits: stats.submits,
      avgCiphertextChars: stats.dictations
        ? Math.round(stats.charsRelayed / stats.dictations)
        : 0,
      returningUsers: retained,

      // Totals say how much has happened; these say whether it is still
      // happening. A pilot that is working and one that stalled after day one
      // look identical in a running total.
      activeToday: (stats.daily.get(today()) || { users: new Set() }).users.size,
      activeThisWeek: activeSince(7),
      daily: recentDays(30),

      activeRooms: rooms.size,
      // "disk" = a configured volume, survives redeploys.
      // "ephemeral" = writable but no SOTTO_DATA_DIR, so the next deploy wipes
      //   it and d7 can never accumulate.
      // "memory" = not even writable.
      // Anything other than "disk" during the pilot means the number this
      // pilot exists to produce is not being collected.
      persistence,
      collectingSince: new Date(stats.startedAt).toISOString().slice(0, 10),
    });
    return;
  }

  const id = (url.searchParams.get("room") || "").toUpperCase();

  // ---- ECDH handshake brokerage ----------------------------------------
  // Public keys only. A passive relay learns nothing useful from these.

  if (route === "/pair") {
    if (!ROOM_RE.test(id)) {
      json(res, 400, { error: "bad room" });
      return;
    }
    const r = room(id);

    if (req.method === "POST") {
      let body;
      try {
        body = JSON.parse((await readBody(req, 4000)) || "{}");
      } catch {
        json(res, 400, { error: "bad body" });
        return;
      }
      if (body.role !== "laptop" && body.role !== "phone") {
        json(res, 400, { error: "bad role" });
        return;
      }
      if (typeof body.pub !== "string" || body.pub.length > 400) {
        json(res, 400, { error: "bad key" });
        return;
      }
      r.pub[body.role] = body.pub;
      if (body.role === "phone") r.lastSay = Date.now();
      json(res, 200, { ok: true, peer: r.pub[body.role === "laptop" ? "phone" : "laptop"] });
      return;
    }

    json(res, 200, { laptop: r.pub.laptop, phone: r.pub.phone });
    return;
  }

  if (route === "/poll") {
    if (!ROOM_RE.test(id)) {
      json(res, 400, { error: "bad room" });
      return;
    }
    const r = room(id);
    r.lastPoll = Date.now();

    const installId = url.searchParams.get("id");
    if (installId && /^[A-Za-z0-9_-]{8,64}$/.test(installId)) {
      // Assign before recording, or note() still sees a null installId and
      // keys the event on the room code — which is the thing we're trying to
      // stop counting.
      const firstSighting = !r.installId;
      r.installId = installId;
      if (firstSighting) note(id, "install");
    }

    if (r.queue.length) {
      const batch = r.queue.splice(0, r.queue.length);
      json(res, 200, { messages: batch });
      return;
    }

    const waiter = { res, timer: null };
    waiter.timer = setTimeout(() => {
      const i = r.waiters.indexOf(waiter);
      if (i !== -1) r.waiters.splice(i, 1);
      json(res, 200, { messages: [] });
    }, HOLD_MS);

    r.waiters.push(waiter);
    req.on("close", () => {
      clearTimeout(waiter.timer);
      const i = r.waiters.indexOf(waiter);
      if (i !== -1) r.waiters.splice(i, 1);
    });
    return;
  }

  if (route === "/say" && req.method === "POST") {
    if (!ROOM_RE.test(id)) {
      json(res, 400, { error: "bad room" });
      return;
    }

    let body;
    try {
      body = JSON.parse((await readBody(req, MAX_BODY)) || "{}");
    } catch (err) {
      const tooBig = err && err.message === "too large";
      json(res, tooBig ? 413 : 400, { error: tooBig ? "too long" : "bad body" });
      return;
    }

    const r = room(id);
    r.lastSay = Date.now();
    const laptopHere = laptopPresent(r);

    if (body.submit === true) {
      r.queue.push({ type: "submit" });
      note(id, "submit");
    } else if (body.done === true) {
      // End-of-utterance marker. Carries no text; it exists so a streamed
      // dictation counts once rather than once per chunk.
      note(id, "dictation", Number(body.size) || 0);
      json(res, 200, { ok: true, delivered: laptopPresent(r) });
      return;
    } else if (typeof body.iv === "string" && typeof body.ct === "string") {
      if (body.ct.length > MAX_BODY) {
        json(res, 413, { error: "too long" });
        return;
      }
      // Opaque to us. We never see the key.
      r.queue.push({
        type: "text",
        iv: body.iv,
        ct: body.ct,
        // Streaming metadata. Opaque routing hints; the relay does not
        // interpret them beyond passing them along.
        stream: body.stream === true || undefined,
        utt: typeof body.utt === "string" ? body.utt.slice(0, 24) : undefined,
        seq: Number.isFinite(body.seq) ? body.seq : undefined,
      });
      if (body.chunk !== true) note(id, "dictation", body.ct.length);
    } else {
      json(res, 400, { error: "nothing to say" });
      return;
    }

    if (r.queue.length > MAX_QUEUE) r.queue.splice(0, r.queue.length - MAX_QUEUE);
    flush(r);
    json(res, 200, { ok: true, delivered: laptopHere });
    return;
  }

  if (route === "/presence") {
    if (!ROOM_RE.test(id)) {
      json(res, 400, { error: "bad room" });
      return;
    }

    // A device that identifies itself with ?role= is checking in, not just
    // asking. Without this the phone would only ever register presence during
    // its initial pairing POST, and would appear to vanish 12 seconds later
    // even while sitting open on screen.
    const role = url.searchParams.get("role");
    const now = Date.now();
    const r = role === "phone" || role === "laptop" ? room(id) : rooms.get(id);

    if (r) {
      if (role === "phone") r.lastSay = now;
      else if (role === "laptop") r.lastPoll = now;
    }

    json(res, 200, {
      laptop: laptopPresent(r),
      phone: !!r && now - r.lastSay < PRESENCE_MS,
      paired: !!r && !!r.pub.laptop && !!r.pub.phone,
    });
    return;
  }

  // The home screen icon is the product: open it, hold, talk. For that to work
  // it has to launch already paired, and a static manifest cannot — its
  // start_url is "/" with no code, so the installed app depends on localStorage
  // surviving the Safari-to-standalone boundary, which is not guaranteed on
  // iOS. Serving a manifest whose start_url carries the room bakes the pairing
  // into the icon at install time, so it launches paired forever.
  //
  // The room is not a secret: it only names a mailbox, and everything in that
  // mailbox is encrypted with a key the relay never has. Anyone can join a room
  // and still read nothing.
  if (route === "/manifest.webmanifest") {
    const room = (url.searchParams.get("room") || "").toUpperCase();
    const start = ROOM_RE.test(room) ? `/?room=${room}` : "/";
    res.writeHead(200, {
      "Content-Type": MIME[".webmanifest"],
      // Must not be cached, or a re-pair keeps handing out the previous room.
      "Cache-Control": "no-store",
    });
    res.end(
      JSON.stringify({
        name: "Sotto",
        short_name: "Sotto",
        description: "Speak quietly into your phone; the text appears on your laptop.",
        start_url: start,
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        background_color: "#14161b",
        theme_color: "#14161b",
        icons: [
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      })
    );
    return;
  }

  serveStatic(res, route === "/" ? "/index.html" : route, id);
});

setInterval(() => {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [id, r] of rooms) {
    if (r.waiters.length) continue;
    if (r.lastPoll < cutoff && r.lastSay < cutoff && r.created < cutoff) {
      rooms.delete(id);
    }
  }
}, 60000).unref();

server.listen(PORT, () => {
  console.log(`Sotto relay ${VERSION} listening on port ${PORT}`);
});
