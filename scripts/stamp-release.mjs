#!/usr/bin/env node
// Records when the current version was released. `npm version` runs this after bumping
// package.json and before committing, so the version and its release time always change together.
import { readFile, writeFile } from "node:fs/promises";

const path = new URL("../package.json", import.meta.url);
const manifest = JSON.parse(await readFile(path, "utf8"));
const now = new Date();
const pad = (value) => String(value).padStart(2, "0");
const offset = -now.getTimezoneOffset();
const zone = `${offset >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
manifest.releasedAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${zone}`;
await writeFile(path, JSON.stringify(manifest, null, 2) + "\n");
console.log(`${manifest.name} ${manifest.version} released at ${manifest.releasedAt}`);
