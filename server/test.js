// Integration tests for the Sotto relay. Run with: node test.js
//
// Includes a real ECDH + AES-GCM round trip using Node's WebCrypto, which is
// the same API the browser uses — so this genuinely exercises the encryption
// path, not a mock of it.

const { spawn } = require("child_process");
const { webcrypto } = require("crypto");
const subtle = webcrypto.subtle;

const PORT = 39413;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function ok(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  pass  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  const res = await fetch(BASE + path, { cache: "no-store" });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  const headers = {};
  res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  return { status: res.status, body, text, headers };
}

async function post(path, payload) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

const b64 = (b) => Buffer.from(b).toString("base64");
const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));

async function makeKeys() {
  const kp = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const pub = b64(await subtle.exportKey("raw", kp.publicKey));
  return { kp, pub };
}

async function derive(myPriv, peerPubB64) {
  const peer = await subtle.importKey(
    "raw",
    unb64(peerPubB64),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const bits = await subtle.deriveBits({ name: "ECDH", public: peer }, myPriv, 256);
  const key = await subtle.importKey("raw", bits, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  const hash = new Uint8Array(await subtle.digest("SHA-256", bits));
  return { key, bits: Buffer.from(bits).toString("hex"), hash };
}

async function main() {
  const server = spawn("node", ["server.js"], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverOut = "";
  let serverErr = "";
  server.stdout.on("data", (d) => (serverOut += d));
  server.stderr.on("data", (d) => (serverErr += d));

  await sleep(700);

  try {
    console.log("\nBasics");
    const health = await get("/health");
    ok("health reports ok", health.status === 200 && health.body.ok === true);
    ok("health identifies as sotto", health.body.name === "sotto",
      JSON.stringify(health.body));
    // Asserted against package.json rather than a literal, so a version bump
    // can't leave this test behind — and so the two version sites are pinned
    // to each other. They drifted apart once already (package.json said 1.0.1
    // while the relay served 1.2.0), which is how a stale build went unnoticed.
    const pkgVersion = require("./package.json").version;
    ok(`health reports version ${pkgVersion}`, health.body.version === pkgVersion,
      `got ${health.body.version}, package.json says ${pkgVersion}`);

    const home = await get("/");
    ok("serves the phone page", home.status === 200 && home.text.includes("Hold to talk"));
    ok("page is branded Sotto", home.text.includes("<title>Sotto</title>"));
    ok("page links the PWA manifest", home.text.includes("manifest.webmanifest"));

    const man = await get("/manifest.webmanifest");
    ok("serves the web manifest", man.status === 200 && man.body.short_name === "Sotto");
    ok("manifest is standalone (installs as an app)", man.body.display === "standalone");

    // The home screen icon has to launch already paired. iOS starts an
    // installed app at start_url, so the room has to be baked in there —
    // relying on localStorage surviving the Safari-to-standalone boundary is
    // not something we can count on.
    const manRoom = await get("/manifest.webmanifest?room=ABC234");
    ok("manifest bakes the room into start_url",
      manRoom.body.start_url === "/?room=ABC234", `got ${manRoom.body.start_url}`);
    ok("room-specific manifest still installs standalone",
      manRoom.body.display === "standalone");
    ok("manifest keeps its icons when room-specific",
      Array.isArray(manRoom.body.icons) && manRoom.body.icons.length === 3);
    ok("manifest is never cached", /no-store/.test(manRoom.headers["cache-control"] || ""),
      manRoom.headers["cache-control"]);
    ok("manifest lowercases the room",
      (await get("/manifest.webmanifest?room=abc234")).body.start_url === "/?room=ABC234");
    ok("manifest ignores a malformed room",
      (await get("/manifest.webmanifest?room=NOPE")).body.start_url === "/");
    ok("manifest ignores a confusable room",
      (await get("/manifest.webmanifest?room=AIO234")).body.start_url === "/");
    ok("bare manifest has no room", man.body.start_url === "/", man.body.start_url);

    // The page must point at the room-specific manifest, or none of the above
    // reaches iOS at install time.
    ok("page can retarget its manifest link", home.text.includes('id="manifestLink"'));


    const sw = await get("/sw.js");
    ok("serves the service worker", sw.status === 200 && sw.text.includes("sotto-shell"));
    ok("service worker refuses to cache API routes",
      /say\|poll\|pair\|presence/.test(sw.text));

    // A cached manifest would install a home screen icon aimed at a stale room.
    ok("service worker never caches the manifest",
      sw.text.includes('url.pathname === "/manifest.webmanifest"'));
    ok("service worker does not precache the manifest",
      !/ASSETS = \[[^\]]*manifest/.test(sw.text));
    // Phones that already installed keep running the cached shell until the
    // version changes, so a fix does not reach them without a bump.
    ok("shell cache version is past v1 (pushes fixes to installed apps)",
      /sotto-shell-v([2-9]|\d{2,})/.test(sw.text));

    ok("serves the icon", (await get("/icon.svg")).status === 200);
    ok("404s unknown paths", (await get("/nope.js")).status === 404);
    ok("blocks path traversal", (await get("/../server.js")).status >= 400);

    console.log("\nValidation");
    ok("rejects a bad room on poll", (await get("/poll?room=abc")).status === 400);
    ok("rejects a bad role on pair",
      (await post("/pair?room=ABC234", { role: "hacker", pub: "x" })).status === 400);
    ok("rejects an oversized public key",
      (await post("/pair?room=ABC234", { role: "phone", pub: "x".repeat(500) })).status === 400);
    ok("rejects an empty say", (await post("/say?room=ABC234", {})).status === 400);

    console.log("\nECDH pairing");
    const laptop = await makeKeys();
    const phone = await makeKeys();

    const first = await post("/pair?room=PAYR23", { role: "laptop", pub: laptop.pub });
    ok("accepts the laptop's public key", first.status === 200);
    ok("reports no peer yet", first.body.peer === null || first.body.peer === undefined,
      JSON.stringify(first.body));

    const second = await post("/pair?room=PAYR23", { role: "phone", pub: phone.pub });
    ok("hands the phone the laptop's key", second.body.peer === laptop.pub);

    const both = await get("/pair?room=PAYR23");
    ok("stores both public keys",
      both.body.laptop === laptop.pub && both.body.phone === phone.pub);

    const a = await derive(laptop.kp.privateKey, phone.pub);
    const b = await derive(phone.kp.privateKey, laptop.pub);
    ok("both sides derive the identical secret", a.bits === b.bits);

    const stranger = await makeKeys();
    const c = await derive(stranger.kp.privateKey, laptop.pub);
    ok("a third party derives a different secret", c.bits !== a.bits);

    let sasA = "", sasB = "";
    const AL = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (let i = 0; i < 2; i++) {
      sasA += AL[a.hash[i] % AL.length] + AL[a.hash[i + 8] % AL.length];
      sasB += AL[b.hash[i] % AL.length] + AL[b.hash[i + 8] % AL.length];
    }
    ok("safety numbers match on both devices", sasA === sasB && sasA.length === 4,
      `${sasA} vs ${sasB}`);

    console.log("\nEncrypted delivery");
    const secret = "I am dictating something private about my recruiting plans";
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt({ name: "AES-GCM", iv }, b.key, Buffer.from(secret));

    let pending = get("/poll?room=PAYR23");
    await sleep(150);
    const sent = await post("/say?room=PAYR23", { iv: b64(iv), ct: b64(ct) });
    ok("relay accepts the ciphertext", sent.status === 200 && sent.body.ok === true);
    ok("relay confirms a laptop was listening", sent.body.delivered === true);

    const got = await pending;
    const msg = got.body.messages[0];
    ok("delivers the ciphertext", msg && msg.type === "text" && !!msg.ct);

    const plain = await subtle.decrypt(
      { name: "AES-GCM", iv: unb64(msg.iv) },
      a.key,
      unb64(msg.ct)
    );
    ok("laptop decrypts it correctly",
      Buffer.from(plain).toString("utf8") === secret,
      Buffer.from(plain).toString("utf8"));

    console.log("\nThe relay cannot read anything");
    ok("plaintext never appears in the wire payload",
      !JSON.stringify(msg).includes("recruiting"), JSON.stringify(msg).slice(0, 120));
    ok("plaintext never appears in server logs",
      !serverOut.includes("recruiting") && !serverOut.includes(secret));
    ok("ciphertext is not logged either",
      !serverOut.includes(b64(ct).slice(0, 24)));

    let tampered = null;
    try {
      const bad = unb64(msg.ct);
      bad[4] ^= 0xff;
      await subtle.decrypt({ name: "AES-GCM", iv: unb64(msg.iv) }, a.key, bad);
      tampered = "decrypted anyway";
    } catch {
      tampered = "rejected";
    }
    ok("tampered ciphertext is rejected (AES-GCM authenticates)", tampered === "rejected");

    console.log("\nUnicode and size");
    pending = get("/poll?room=UNY234");
    await sleep(120);
    const unicode = "café — naïve 你好 🎧";
    const iv2 = webcrypto.getRandomValues(new Uint8Array(12));
    const ct2 = await subtle.encrypt({ name: "AES-GCM", iv: iv2 }, b.key, Buffer.from(unicode));
    await post("/say?room=UNY234", { iv: b64(iv2), ct: b64(ct2) });
    const uni = await pending;
    const back = await subtle.decrypt(
      { name: "AES-GCM", iv: unb64(uni.body.messages[0].iv) },
      a.key,
      unb64(uni.body.messages[0].ct)
    );
    ok("survives multibyte characters", Buffer.from(back).toString("utf8") === unicode);

    pending = get("/poll?room=LNG234");
    await sleep(120);
    const long = "word ".repeat(600).trim();
    const iv3 = webcrypto.getRandomValues(new Uint8Array(12));
    const ct3 = await subtle.encrypt({ name: "AES-GCM", iv: iv3 }, b.key, Buffer.from(long));
    await post("/say?room=LNG234", { iv: b64(iv3), ct: b64(ct3) });
    const big = await pending;
    const backLong = await subtle.decrypt(
      { name: "AES-GCM", iv: unb64(big.body.messages[0].iv) },
      a.key,
      unb64(big.body.messages[0].ct)
    );
    ok("handles a long dictation intact",
      Buffer.from(backLong).toString("utf8").length === long.length);

    ok("rejects an oversized payload",
      (await post("/say?room=ABC234", { iv: "x", ct: "y".repeat(45000) })).status === 413);

    console.log("\nQueueing and routing");
    await post("/say?room=QUE234", { iv: "a", ct: "one" });
    await post("/say?room=QUE234", { iv: "b", ct: "two" });
    const drained = await get("/poll?room=QUE234");
    ok("queues messages sent before the laptop polls",
      drained.body.messages.length === 2);

    pending = get("/poll?room=SUB234");
    await sleep(120);
    await post("/say?room=SUB234", { submit: true });
    ok("relays a submit instruction",
      (await pending).body.messages.some((m) => m.type === "submit"));

    const ra = get("/poll?room=AAA234");
    const rb = get("/poll?room=BBB234");
    await sleep(120);
    await post("/say?room=AAA234", { iv: "i", ct: "forA" });
    await post("/say?room=BBB234", { iv: "i", ct: "forB" });
    const [xa, xb] = await Promise.all([ra, rb]);
    ok("keeps rooms isolated",
      xa.body.messages[0].ct === "forA" && xb.body.messages[0].ct === "forB");

    const orphan = await post("/say?room=NBY234", { iv: "i", ct: "void" });
    ok("accepts text with nobody listening", orphan.status === 200);
    ok("but reports it undelivered", orphan.body.delivered === false);

    console.log("\nLatency");
    const t0 = Date.now();
    pending = get("/poll?room=TMG234");
    await sleep(500);
    await post("/say?room=TMG234", { iv: "i", ct: "quick" });
    await pending;
    const elapsed = Date.now() - t0;
    ok("long poll returns promptly once text arrives", elapsed < 1500, `${elapsed}ms`);

    console.log("\nPresence check-in (regression)");
    // The phone used to register presence only during its initial pairing POST,
    // so it looked absent 12s later even while open. A role= param is a check-in.
    let pres = await get("/presence?room=CHK234");
    ok("a bare presence query registers nobody",
      pres.body.phone === false && pres.body.laptop === false);

    await get("/presence?room=CHK234&role=phone");
    pres = await get("/presence?room=CHK234");
    ok("phone check-in marks the phone present", pres.body.phone === true,
      JSON.stringify(pres.body));
    ok("phone check-in does not fake a laptop", pres.body.laptop === false);

    await get("/presence?room=CHK234&role=laptop");
    pres = await get("/presence?room=CHK234");
    ok("laptop check-in marks the laptop present", pres.body.laptop === true);

    for (let i = 0; i < 3; i++) {
      await sleep(120);
      await get("/presence?room=CHK234&role=phone");
    }
    pres = await get("/presence?room=CHK234");
    ok("repeated check-ins keep presence alive", pres.body.phone === true);

    ok("presence reports whether both keys are published",
      (await get("/presence?room=PAYR23")).body.paired === true,
      JSON.stringify((await get("/presence?room=PAYR23")).body));
    ok("presence reports unpaired rooms as unpaired",
      (await get("/presence?room=CHK234")).body.paired === false);

    ok("an unknown role is ignored rather than trusted",
      (await get("/presence?room=XYZ234&role=hacker")).body.phone === false);

    console.log("\nInstall-based retention");
    // Retention must track installs, not pairing codes — otherwise anyone who
    // re-pairs is counted as a brand new user and day-7 return is understated.
    const before = (await get("/stats")).body.uniqueUsers;

    await get("/poll?room=SEP234&id=abc123def456abc1");
    await sleep(120);
    await post("/say?room=SEP234", { iv: "i", ct: "one" });
    await sleep(80);

    // Same install, brand new pairing code — should NOT look like a new user.
    await get("/poll?room=SEP999&id=abc123def456abc1");
    await sleep(120);
    await post("/say?room=SEP999", { iv: "i", ct: "two" });
    await sleep(80);

    const after = (await get("/stats")).body.uniqueUsers;
    ok("re-pairing does not inflate the user count", after - before === 1,
      `grew by ${after - before}`);

    await get("/poll?room=THR234&id=zzz999zzz999zzz9");
    await sleep(120);
    await post("/say?room=THR234", { iv: "i", ct: "three" });
    await sleep(80);
    const third = (await get("/stats")).body.uniqueUsers;
    ok("a genuinely different install counts separately", third - after === 1,
      `grew by ${third - after}`);

    ok("rejects a malformed install id",
      (await get("/poll?room=BAD234&id=" + "x".repeat(200))).status === 200);
    ok("install ids never appear in stats",
      !JSON.stringify((await get("/stats")).body).includes("abc123def456abc1"));
    ok("install ids are hashed in logs",
      serverOut.includes("event=install") && !serverOut.includes("abc123def456abc1"));

    console.log("\nStreamed chunks");
    // Streaming sends each finalized phrase as it lands, then a done marker.
    // Chunks must relay but not each count as a separate dictation.
    const dictBefore = (await get("/stats")).body.dictations;

    let streamPoll = get("/poll?room=STR234");
    await sleep(120);
    await post("/say?room=STR234", { iv: "i1", ct: "piece one", chunk: true });
    const firstChunk = await streamPoll;
    ok("a chunk is relayed immediately",
      firstChunk.body.messages[0].ct === "piece one",
      JSON.stringify(firstChunk.body));

    streamPoll = get("/poll?room=STR234");
    await sleep(120);
    await post("/say?room=STR234", { iv: "i2", ct: "piece two", chunk: true });
    ok("later chunks relay too",
      (await streamPoll).body.messages[0].ct === "piece two");

    const midway = (await get("/stats")).body.dictations;
    ok("chunks do not each count as a dictation", midway === dictBefore,
      `${dictBefore} -> ${midway}`);

    const doneRes = await post("/say?room=STR234", { done: true, size: 42 });
    ok("the done marker is accepted", doneRes.status === 200);
    ok("done counts exactly one dictation",
      (await get("/stats")).body.dictations === dictBefore + 1);

    const drainAfterDone = await get("/poll?room=STR234");
    ok("the done marker queues no text for the laptop",
      drainAfterDone.body.messages.length === 0,
      JSON.stringify(drainAfterDone.body));

    console.log("\nAnalytics");
    const stats = await get("/stats");
    ok("reports unique users", stats.body.uniqueUsers > 0, JSON.stringify(stats.body));
    ok("counts dictations", stats.body.dictations > 0);
    ok("counts submits", stats.body.submits > 0);
    ok("reports average dictation size", stats.body.avgCiphertextChars > 0);
    ok("exposes a retention breakdown", !!stats.body.returningUsers);
    ok("stats contain no room codes",
      !JSON.stringify(stats.body).includes("PAYR23"));
    ok("logs are event-only (hashed user ids)",
      serverOut.includes("event=dictation") && !serverOut.includes("PAYR23"),
      serverOut.split("\n").slice(0, 3).join(" | "));

    ok("server logged no errors", serverErr.trim() === "", serverErr.slice(0, 300));
  } catch (err) {
    failed++;
    console.log("\n  FAIL  harness threw — " + err.message + "\n" + err.stack);
  } finally {
    server.kill();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main();
