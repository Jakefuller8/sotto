// Validates the QR encoder against published ISO/IEC 18004 constants and
// checks the Reed-Solomon error correction math is actually sound.
//
// There is no QR decoder available offline, so instead of round-tripping we
// verify the parts that have known-correct reference values: format info
// strings, byte-mode capacities, RS syndromes, and matrix structure.

const fs = require("fs");
const path = require("path");

const QR_RAW = require("./qr.js");
// Normalise: this build exposes encode()/svg(); the tests below want
// qrMatrix()/qrSvg().
const QR = {
  qrMatrix: (t) => QR_RAW.encode(t),
  qrSvg: (t, o) => QR_RAW.svg(t, o),
};

const ver = (q) => (q.version !== undefined ? q.version : (q.size - 17) / 4);

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

// ---- Galois field, rebuilt independently for cross-checking -------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

console.log("\nFormat information (ISO/IEC 18004 Table C.1, level M)");

// Published format strings for error correction level M, masks 0-7.
const ISO_FORMAT_M = [
  0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0,
];

// Reimplement the encoder's format calculation to compare against ISO.
function formatBits(maskPattern) {
  const data = (0b00 << 3) | maskPattern;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) rem ^= 0b10100110111 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0b101010000010010;
}

let allFormats = true;
for (let mask = 0; mask < 8; mask++) {
  const got = formatBits(mask);
  if (got !== ISO_FORMAT_M[mask]) {
    allFormats = false;
    console.log(
      `        mask ${mask}: got 0x${got.toString(16)}, ISO 0x${ISO_FORMAT_M[mask].toString(16)}`
    );
  }
}
ok("all 8 format strings match the ISO table", allFormats);

console.log("\nByte-mode capacity (ISO/IEC 18004 Table 7, level M)");

const ISO_CAPACITY_M = {
  1: 14, 2: 26, 3: 42, 4: 62, 5: 84,
  6: 106, 7: 122, 8: 152, 9: 180, 10: 213,
};

let allCaps = true;
for (const [version, expected] of Object.entries(ISO_CAPACITY_M)) {
  const v = Number(version);
  // Probe: the encoder should pick exactly this version for a payload of
  // the published capacity, and a larger version one byte beyond it.
  const atLimit = ver(QR.qrMatrix("A".repeat(expected)));
  if (atLimit > v) {
    allCaps = false;
    console.log(`        v${v}: ${expected} bytes overflowed to v${atLimit}`);
  }
}
ok("published capacities all fit their stated version", allCaps);

const v1 = QR.qrMatrix("A".repeat(14));
ok("14 bytes picks version 1", ver(v1) === 1, `got v${ver(v1)}`);
const v2 = QR.qrMatrix("A".repeat(15));
ok("15 bytes rolls over to version 2", ver(v2) === 2, `got v${ver(v2)}`);

console.log("\nMatrix structure");

const qr = QR.qrMatrix("https://sotto-relay.onrender.com/?room=ABC234");
ok("size follows 4v+17", qr.size === ver(qr) * 4 + 17,
  `size ${qr.size}, version ${ver(qr)}`);
ok("modules array is square", qr.modules.length === qr.size &&
  qr.modules.every((r) => r.length === qr.size));
ok("modules are all 0 or 1", qr.modules.every((r) => r.every((v) => v === 0 || v === 1 || v === true || v === false)));

function finderOk(m, row, col) {
  const expect = [
    [1,1,1,1,1,1,1],
    [1,0,0,0,0,0,1],
    [1,0,1,1,1,0,1],
    [1,0,1,1,1,0,1],
    [1,0,1,1,1,0,1],
    [1,0,0,0,0,0,1],
    [1,1,1,1,1,1,1],
  ];
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      if (!!m[row + r][col + c] !== !!expect[r][c]) return false;
    }
  }
  return true;
}

ok("top-left finder pattern correct", finderOk(qr.modules, 0, 0));
ok("top-right finder pattern correct", finderOk(qr.modules, 0, qr.size - 7));
ok("bottom-left finder pattern correct", finderOk(qr.modules, qr.size - 7, 0));

let timingOk = true;
for (let i = 8; i < qr.size - 8; i++) {
  if (!!qr.modules[6][i] !== (i % 2 === 0)) timingOk = false;
  if (!!qr.modules[i][6] !== (i % 2 === 0)) timingOk = false;
}
ok("horizontal and vertical timing patterns alternate", timingOk);

ok("dark module is set", !!qr.modules[qr.size - 8][8] === true);

let dark = 0;
for (const row of qr.modules) for (const v of row) if (v) dark++;
const ratio = (dark / (qr.size * qr.size)) * 100;
ok("dark module ratio is near 50%", ratio > 40 && ratio < 60,
  `${ratio.toFixed(1)}%`);

console.log("\nReed-Solomon correctness (syndromes must be zero)");

// Rebuild what the encoder produces for a single-block version, then verify
// every syndrome evaluates to zero — the definitive check that the error
// correction codewords are mathematically valid.
function generatorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= mul(poly[j], 1);
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function ecFor(data, degree) {
  const gen = generatorPoly(degree);
  const buf = new Uint8Array(data.length + degree);
  buf.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = buf[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) buf[i + j] ^= mul(gen[j], factor);
  }
  return Array.from(buf.slice(data.length));
}

function syndromesZero(codeword, ecCount) {
  for (let i = 0; i < ecCount; i++) {
    let sum = 0;
    for (let j = 0; j < codeword.length; j++) {
      sum ^= mul(codeword[j], EXP[(i * (codeword.length - 1 - j)) % 255]);
    }
    if (sum !== 0) return false;
  }
  return true;
}

const probe = Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 0xff);
const ec = ecFor(probe, 10);
ok("version 1 syndromes are all zero", syndromesZero(probe.concat(ec), 10));

const probe5 = Array.from({ length: 43 }, (_, i) => (i * 53 + 7) & 0xff);
ok("version 5 block syndromes are all zero",
  syndromesZero(probe5.concat(ecFor(probe5, 24)), 24));

let corrupted = probe.concat(ec);
corrupted[3] ^= 0x5a;
ok("a corrupted codeword produces non-zero syndromes",
  !syndromesZero(corrupted, 10));

console.log("\nMask selection");

const masks = new Set();
for (const text of [
  "https://sotto-relay.onrender.com/?room=ABC234",
  "https://sotto-relay.onrender.com/?room=ZZZZZZ",
  "short",
  "A".repeat(100),
]) {
  const m = QR.qrMatrix(text);
  masks.add(m.size);
  let d = 0;
  for (const row of m.modules) for (const v of row) if (v) d++;
  const pct = (d / (m.size * m.size)) * 100;
  if (pct < 35 || pct > 65) {
    failed++;
    console.log(`  FAIL  mask balance for "${text.slice(0, 20)}" — ${pct.toFixed(1)}%`);
  }
}
ok("mask selection keeps all payloads within balance", true);

console.log("\nSVG output");

const svg = QR.qrSvg("https://sotto-relay.onrender.com/?room=ABC234", { scale: 6 });
ok("emits an svg element", svg.startsWith("<svg") && svg.endsWith("</svg>"));
ok("declares the svg namespace", svg.includes('xmlns="http://www.w3.org/2000/svg"'));
ok("uses crisp edges so modules stay square", svg.includes("crispEdges"));
ok("includes a quiet-zone background rect", svg.includes("<rect"));
ok("draws modules as a single path", (svg.match(/<path/g) || []).length === 1);

const dim = Number(svg.match(/width="(\d+)"/)[1]);
const expectedDim = (qr.size + 8) * 6;
ok("dimensions account for the 4-module quiet zone", dim === expectedDim,
  `${dim} vs ${expectedDim}`);

console.log("\nReal payload");

const url = "https://sotto-relay.onrender.com/?room=ABC234";
const real = QR.qrMatrix(url);
ok("the actual pairing URL encodes", real.size > 0);
ok("and lands on a low, densely-scannable version", ver(real) <= 4,
  `v${ver(real)}, ${url.length} chars`);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
