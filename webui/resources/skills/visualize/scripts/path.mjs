#!/usr/bin/env node
/**
 * Allocate the output path for a new visualization and print it. Zero dependencies.
 *
 *   node path.mjs <title>
 *
 * Creates <root>/attachments/<uuid>/ (root = the .sema directory this skill is installed under) and prints
 * the absolute path <root>/attachments/<uuid>/<title>.html on a single line. The model writes the file there.
 * The title is normalized to ASCII lowercase-hyphenated; a non-ASCII title falls back to `visualization`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// <root>/skills/visualize/scripts → <root>
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const raw = process.argv.slice(2).join(' ').trim();
const title = raw.toLowerCase().replace(/\.html?$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'visualization';
const dir = path.join(ROOT, 'attachments', randomUUID());
fs.mkdirSync(dir, { recursive: true });
console.log(path.join(dir, `${title}.html`));
