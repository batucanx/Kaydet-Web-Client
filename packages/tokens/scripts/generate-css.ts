import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateCss } from '../src/css.ts';

const target = fileURLToPath(new URL('../tokens.css', import.meta.url));
writeFileSync(target, generateCss(), 'utf8');
console.log(`tokens.css written (${target})`);
