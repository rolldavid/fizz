/**
 * Generate placeholder icon PNGs for the extension.
 * No external dependencies — hand-encodes PNG with zlib + CRC32.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "../src/assets");
mkdirSync(OUT_DIR, { recursive: true });

const SIZES = [16, 32, 48, 128];
const BG = [0x14, 0x14, 0x1a, 0xff];
const FG = [0xb7, 0x94, 0xf4, 0xff];
const TRANSPARENT = [0, 0, 0, 0];

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function u32(v) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v >>> 0, 0);
    return b;
}

function chunk(type, data) {
    const typeBuf = Buffer.from(type, "ascii");
    return Buffer.concat([u32(data.length), typeBuf, data, u32(crc32(Buffer.concat([typeBuf, data])))]);
}

function encodePng(size, pixels) {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.concat([u32(size), u32(size), Buffer.from([8, 6, 0, 0, 0])]);
    const stride = size * 4 + 1;
    const raw = Buffer.alloc(stride * size);
    for (let y = 0; y < size; y++) {
        raw[y * stride] = 0;
        pixels.copy(raw, y * stride + 1, y * size * 4, y * size * 4 + size * 4);
    }
    return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function setPx(buf, size, x, y, rgba) {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i] = rgba[0]; buf[i + 1] = rgba[1]; buf[i + 2] = rgba[2]; buf[i + 3] = rgba[3];
}

function drawIcon(size) {
    const px = Buffer.alloc(size * size * 4);
    const radius = Math.max(2, Math.floor(size * 0.22));

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            // Squared-distance test against each rounded corner.
            const cornerOut =
                (x < radius && y < radius && (x - radius + 0.5) ** 2 + (y - radius + 0.5) ** 2 > radius ** 2) ||
                (x >= size - radius && y < radius &&
                    (x - (size - radius) + 0.5) ** 2 + (y - radius + 0.5) ** 2 > radius ** 2) ||
                (x < radius && y >= size - radius &&
                    (x - radius + 0.5) ** 2 + (y - (size - radius) + 0.5) ** 2 > radius ** 2) ||
                (x >= size - radius && y >= size - radius &&
                    (x - (size - radius) + 0.5) ** 2 + (y - (size - radius) + 0.5) ** 2 > radius ** 2);
            setPx(px, size, x, y, cornerOut ? TRANSPARENT : BG);
        }
    }

    // Upward filled triangle (the Aztec mark).
    const apexX = size / 2;
    const apexY = size * 0.22;
    const baseY = size * 0.78;
    const baseHalf = size * 0.28;
    for (let y = Math.floor(apexY); y <= Math.ceil(baseY); y++) {
        const t = (y - apexY) / (baseY - apexY);
        const halfWidth = baseHalf * t;
        for (let x = Math.floor(apexX - halfWidth); x <= Math.ceil(apexX + halfWidth); x++) {
            setPx(px, size, x, y, FG);
        }
    }
    return px;
}

for (const size of SIZES) {
    const png = encodePng(size, drawIcon(size));
    const out = resolve(OUT_DIR, `icon-${size}.png`);
    writeFileSync(out, png);
    console.log(`wrote ${out} (${png.length} bytes)`);
}
