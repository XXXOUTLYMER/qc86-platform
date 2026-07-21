import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.chdir(__dirname);
const req = createRequire(__dirname + '/server.js');
req('./server.js');

console.log('QC86 Platform server started from ESM wrapper');
process.title = 'qc86-platform';
export default true;
