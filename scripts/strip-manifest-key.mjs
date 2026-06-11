/**
 * Strip the `key` field from dist/manifest.json for a Chrome Web Store upload.
 *
 * The FIRST upload of a new item must NOT contain `key` — the dashboard
 * rejects it ("key field not allowed in manifest"). After that first upload,
 * copy the store's public key (Dashboard → Package → View public key) into
 * src/manifest.ts so every later build — dev and store alike — carries the
 * PUBLISHED id, and update EXTENSION_ID in web/src/config.ts to match
 * (fizzwallet.com messages the wallet by that id).
 */
import fs from "node:fs";

const path = "dist/manifest.json";
const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
if (!("key" in manifest)) {
    console.log("dist/manifest.json has no key field — nothing to strip.");
    process.exit(0);
}
delete manifest.key;
fs.writeFileSync(path, JSON.stringify(manifest, null, 2));
console.log("Stripped key from dist/manifest.json (first Web Store upload only).");
