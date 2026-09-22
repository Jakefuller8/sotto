// Minimal QR encoder. Byte mode, error correction level M, versions 1-10.
//
// Written from scratch because Manifest V3 forbids loading remote scripts, and
// a hosted QR image service would send the pairing code to a third party —
// which would undermine the whole point of end-to-end encryption.
//
// Exposes SottoQR.svg(text, opts) -> SVG string.

const SottoQR = (function () {
  "use strict";

  // [ecCodewordsPerBlock, [[blockCount, dataCodewordsPerBlock], ...]]
  const EC_M = {
    1: [10, [[1, 16]]],
    2: [16, [[1, 28]]],
    3: [26, [[1, 44]]],
    4: [18, [[2, 32]]],
    5: [24, [[2, 43]]],
    6: [16, [[4, 27]]],
    7: [18, [[4, 31]]],
    8: [22, [[2, 38], [2, 39]]],
    9: [22, [[3, 36], [2, 37]]],
    10: [26, [[4, 43], [1, 44]]],
  };

  const ALIGN = {
    1: [],
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
    7: [6, 22, 38],
    8: [6, 24, 42],
    9: [6, 26, 46],
    10: [6, 28, 50],
  };

  // Remainder bits appended after the final codeword, by version.
  const REMAINDER = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0 };

  // ---- GF(256) arithmetic, primitive polynomial 0x11D ---------------------

  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function initGF() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gmul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  function generatorPoly(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gmul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function ecCodewords(data, count) {
    const gen = generatorPoly(count);
    const buf = data.concat(new Array(count).fill(0));
    for (let i = 0; i < data.length; i++) {
      const factor = buf[i];
      if (factor === 0) continue;
      for (let j = 0; j < gen.length; j++) {
        buf[i + j] ^= gmul(gen[j], factor);
      }
    }
    return buf.slice(data.length);
  }

  // ---- bit buffer ---------------------------------------------------------

  function BitBuffer() {
    this.bits = [];
  }
  BitBuffer.prototype.put = function (value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  };
  BitBuffer.prototype.toBytes = function () {
    const out = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | (this.bits[i + j] || 0);
      out.push(byte);
    }
    return out;
  };

  function utf8Bytes(str) {
    return Array.from(new TextEncoder().encode(str));
  }

  function pickVersion(byteLength) {
    for (let v = 1; v <= 10; v++) {
      const [ecPer, groups] = EC_M[v];
      let dataCodewords = 0;
      for (const [count, per] of groups) dataCodewords += count * per;
      const countBits = v < 10 ? 8 : 16;
      const needed = Math.ceil((4 + countBits + byteLength * 8) / 8);
      if (needed <= dataCodewords) return v;
    }
    throw new Error("payload too long for version 10");
  }

  function buildCodewords(text) {
    const bytes = utf8Bytes(text);
    const version = pickVersion(bytes.length);
    const [ecPer, groups] = EC_M[version];

    let totalData = 0;
    for (const [count, per] of groups) totalData += count * per;

    const bb = new BitBuffer();
    bb.put(0b0100, 4); // byte mode
    bb.put(bytes.length, version < 10 ? 8 : 16);
    for (const b of bytes) bb.put(b, 8);

    // Terminator, then pad to a byte boundary.
    const capacityBits = totalData * 8;
    const terminator = Math.min(4, capacityBits - bb.bits.length);
    bb.put(0, terminator);
    while (bb.bits.length % 8 !== 0) bb.bits.push(0);

    const data = bb.toBytes();
    const padBytes = [0xec, 0x11];
    let p = 0;
    while (data.length < totalData) data.push(padBytes[p++ % 2]);

    // Split into blocks, compute EC per block.
    const dataBlocks = [];
    const ecBlocks = [];
    let offset = 0;
    for (const [count, per] of groups) {
      for (let i = 0; i < count; i++) {
        const block = data.slice(offset, offset + per);
        offset += per;
        dataBlocks.push(block);
        ecBlocks.push(ecCodewords(block, ecPer));
      }
    }

    // Interleave.
    const result = [];
    const maxData = Math.max(...dataBlocks.map((b) => b.length));
    for (let i = 0; i < maxData; i++) {
      for (const block of dataBlocks) if (i < block.length) result.push(block[i]);
    }
    for (let i = 0; i < ecPer; i++) {
      for (const block of ecBlocks) result.push(block[i]);
    }

    return { version, codewords: result };
  }

  // ---- matrix ------------------------------------------------------------

  function makeMatrix(version) {
    const size = version * 4 + 17;
    const m = [];
    const reserved = [];
    for (let i = 0; i < size; i++) {
      m.push(new Array(size).fill(0));
      reserved.push(new Array(size).fill(false));
    }
    return { size, m, reserved };
  }

  function placeFinder(grid, row, col) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || rr >= grid.size || cc < 0 || cc >= grid.size) continue;
        const inner =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        grid.m[rr][cc] = inner ? 1 : 0;
        grid.reserved[rr][cc] = true;
      }
    }
  }

  function placeAlignment(grid, version) {
    const centers = ALIGN[version];
    for (const r of centers) {
      for (const c of centers) {
        // Skip the three corners occupied by finder patterns.
        if (
          (r === 6 && c === 6) ||
          (r === 6 && c === centers[centers.length - 1]) ||
          (r === centers[centers.length - 1] && c === 6)
        ) {
          continue;
        }
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const ring = Math.max(Math.abs(dr), Math.abs(dc));
            grid.m[r + dr][c + dc] = ring === 1 ? 0 : 1;
            grid.reserved[r + dr][c + dc] = true;
          }
        }
      }
    }
  }

  function placeTiming(grid) {
    for (let i = 8; i < grid.size - 8; i++) {
      const bit = i % 2 === 0 ? 1 : 0;
      if (!grid.reserved[6][i]) {
        grid.m[6][i] = bit;
        grid.reserved[6][i] = true;
      }
      if (!grid.reserved[i][6]) {
        grid.m[i][6] = bit;
        grid.reserved[i][6] = true;
      }
    }
  }

  function reserveFormat(grid, version) {
    const size = grid.size;
    for (let i = 0; i < 9; i++) {
      if (!grid.reserved[8][i]) grid.reserved[8][i] = true;
      if (!grid.reserved[i][8]) grid.reserved[i][8] = true;
    }
    for (let i = 0; i < 8; i++) {
      grid.reserved[8][size - 1 - i] = true;
      grid.reserved[size - 1 - i][8] = true;
    }
    // Dark module.
    grid.m[size - 8][8] = 1;
    grid.reserved[size - 8][8] = true;

    if (version >= 7) {
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 3; j++) {
          grid.reserved[size - 11 + j][i] = true;
          grid.reserved[i][size - 11 + j] = true;
        }
      }
    }
  }

  function placeData(grid, codewords) {
    const size = grid.size;
    let bitIndex = 0;
    const totalBits = codewords.length * 8;

    function nextBit() {
      if (bitIndex >= totalBits) return 0;
      const byte = codewords[bitIndex >> 3];
      const bit = (byte >>> (7 - (bitIndex & 7))) & 1;
      bitIndex++;
      return bit;
    }

    let upward = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--; // skip the vertical timing column
      for (let i = 0; i < size; i++) {
        const row = upward ? size - 1 - i : i;
        for (let c = 0; c < 2; c++) {
          const cc = col - c;
          if (grid.reserved[row][cc]) continue;
          grid.m[row][cc] = nextBit();
        }
      }
      upward = !upward;
    }
  }

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  function applyMask(grid, maskIndex) {
    const fn = MASKS[maskIndex];
    const out = grid.m.map((row) => row.slice());
    for (let r = 0; r < grid.size; r++) {
      for (let c = 0; c < grid.size; c++) {
        if (grid.reserved[r][c]) continue;
        if (fn(r, c)) out[r][c] ^= 1;
      }
    }
    return out;
  }

  function penalty(m) {
    const size = m.length;
    let score = 0;

    // Rule 1: runs of five or more.
    for (let r = 0; r < size; r++) {
      let run = 1;
      for (let c = 1; c < size; c++) {
        if (m[r][c] === m[r][c - 1]) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    for (let c = 0; c < size; c++) {
      let run = 1;
      for (let r = 1; r < size; r++) {
        if (m[r][c] === m[r - 1][c]) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }

    // Rule 2: 2x2 blocks of one colour.
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }

    // Rule 3: finder-like patterns.
    const pat = [1, 0, 1, 1, 1, 0, 1];
    function hasPattern(get, i, len) {
      if (i + 7 > len) return false;
      for (let k = 0; k < 7; k++) if (get(i + k) !== pat[k]) return false;
      const beforeClear = (() => {
        for (let k = i - 4; k < i; k++) {
          if (k < 0) continue;
          if (get(k) !== 0) return false;
        }
        return true;
      })();
      const afterClear = (() => {
        for (let k = i + 7; k < i + 11; k++) {
          if (k >= len) continue;
          if (get(k) !== 0) return false;
        }
        return true;
      })();
      return beforeClear || afterClear;
    }
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (hasPattern((i) => m[r][i], c, size)) score += 40;
        if (hasPattern((i) => m[i][c], r, size)) score += 40;
      }
    }

    // Rule 4: dark/light balance.
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
    const ratio = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

    return score;
  }

  // BCH(15,5) for format info, with the 0x5412 mask.
  function formatBits(ecLevelBits, maskIndex) {
    const data = (ecLevelBits << 3) | maskIndex;
    let value = data << 10;
    for (let i = 14; i >= 10; i--) {
      if ((value >>> i) & 1) value ^= 0x537 << (i - 10);
    }
    return ((data << 10) | value) ^ 0x5412;
  }

  // BCH(18,6) for version info, versions 7-10.
  function versionBits(version) {
    let value = version << 12;
    for (let i = 17; i >= 12; i--) {
      if ((value >>> i) & 1) value ^= 0x1f25 << (i - 12);
    }
    return (version << 12) | value;
  }

  // The 15-bit format string is placed MSB-first: bit 14 lands at (8,0) and
  // bit 0 at (0,8). Getting the cells right but the bit order backwards
  // produces a QR that looks flawless and scans as nothing.
  function formatCells(size) {
    const first = [
      [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
      [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
    ];
    const second = [
      [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8],
      [size - 5, 8], [size - 6, 8], [size - 7, 8],
      [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5],
      [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
    ];
    return { first, second };
  }

  function placeFormat(m, size, bits) {
    const { first, second } = formatCells(size);
    for (let k = 0; k < 15; k++) {
      const bit = (bits >>> (14 - k)) & 1;
      m[first[k][0]][first[k][1]] = bit;
      m[second[k][0]][second[k][1]] = bit;
    }
    m[size - 8][8] = 1; // dark module
  }

  function placeVersion(m, size, version) {
    if (version < 7) return;
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (bits >>> i) & 1;
      const r = Math.floor(i / 3);
      const c = i % 3;
      m[size - 11 + c][r] = bit;
      m[r][size - 11 + c] = bit;
    }
  }

  function encode(text, forceMask) {
    const { version, codewords } = buildCodewords(text);
    const grid = makeMatrix(version);

    placeFinder(grid, 0, 0);
    placeFinder(grid, 0, grid.size - 7);
    placeFinder(grid, grid.size - 7, 0);
    placeAlignment(grid, version);
    placeTiming(grid);
    reserveFormat(grid, version);

    const remainder = REMAINDER[version];
    const withRemainder = codewords.slice();
    placeData(grid, withRemainder);

    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      if (forceMask != null && mask !== forceMask) continue;
      const masked = applyMask(grid, mask);
      placeFormat(masked, grid.size, formatBits(0b00, mask)); // 00 = level M
      placeVersion(masked, grid.size, version);
      const score = penalty(masked);
      if (!best || score < best.score) best = { score, mask, m: masked };
    }

    return { size: grid.size, modules: best.m, version, mask: best.mask };
  }

  function svg(text, opts) {
    const options = opts || {};
    const quiet = options.quiet == null ? 4 : options.quiet;
    const scale = options.scale || 8;
    const dark = options.dark || "#14161b";
    const light = options.light || "#ffffff";

    const { size, modules } = encode(text);
    const total = (size + quiet * 2) * scale;

    let path = "";
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!modules[r][c]) continue;
        const x = (c + quiet) * scale;
        const y = (r + quiet) * scale;
        path += `M${x} ${y}h${scale}v${scale}h-${scale}z`;
      }
    }

    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}" ` +
      `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
      `<rect width="${total}" height="${total}" fill="${light}"/>` +
      `<path d="${path}" fill="${dark}"/></svg>`
    );
  }

  return { encode, svg };
})();

if (typeof module !== "undefined" && module.exports) module.exports = SottoQR;
