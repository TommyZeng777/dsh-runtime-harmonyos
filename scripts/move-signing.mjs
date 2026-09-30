// `devecocli signature generate` writes the signing config (certificate paths and
// encrypted passwords) into example-app/build-profile.json5, which is committed.
// Run this afterwards: it moves the config to example-app/signing.local.json
// (git-ignored), which example-app/hvigorfile.ts loads at build time.
import {readFile, writeFile} from 'node:fs/promises';

const app = new URL('../example-app/', import.meta.url);
const profileUrl = new URL('build-profile.json5', app);
const text = await readFile(profileUrl, 'utf8');
// build-profile.json5 is JSON5 written by local tools; evaluate it as an object literal.
const profile = Function(`"use strict"; return (${text});`)();
const configs = profile.app?.signingConfigs ?? [];
if (!configs.length) { console.log('build-profile.json5 has no signing config; nothing to move'); process.exit(0); }
await writeFile(new URL('signing.local.json', app), JSON.stringify({signingConfigs: configs}, null, 2) + '\n', {mode: 0o600});
profile.app.signingConfigs = [];
await writeFile(profileUrl, JSON.stringify(profile, null, 2) + '\n');
console.log(`moved ${configs.length} signing config(s) to example-app/signing.local.json`);
