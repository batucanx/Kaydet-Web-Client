// Design-system guard: raw color literals may only live in packages/tokens.
// Scans apps/web/src (CSS + TS/TSX, excluding tests) for hex colors and rgb()/hsl() functions.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../apps/web/src', import.meta.url));
const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const FUNC = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g;
// `#root`, `#main`, `#RRGGBB` inside URLs or ids are not colors: require the hex to look like a value
// after a colon/space/paren in CSS, or inside quotes in TS.
const isNoise = (line, match) => /href=|id=|url\(|#(root|main)\b/.test(line) && !/[:(,]\s*#[0-9a-fA-F]{3,8}/.test(line) && match.length < 4;

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(css|ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) files.push(path);
  }
})(root);

const problems = [];
for (const file of files) {
  readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .forEach((line, i) => {
      const code = line.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '');
      for (const re of [HEX, FUNC]) {
        for (const m of code.matchAll(re)) {
          if (!isNoise(code, m[0])) problems.push(`${relative(root, file)}:${i + 1}  ${m[0]}`);
        }
      }
    });
}

if (problems.length) {
  console.error('Raw color literals found outside packages/tokens:\n' + problems.join('\n'));
  process.exit(1);
}
console.log(`no raw colors in ${files.length} files`);
