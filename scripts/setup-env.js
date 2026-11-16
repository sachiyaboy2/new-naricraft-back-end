import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const target = fileURLToPath(new URL('../.env', import.meta.url));
if (fs.existsSync(target)) {
  console.log('Existing .env kept. Compare it with .env.example and SETUP-SINHALA.md.');
} else {
  const template = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  fs.writeFileSync(target, template.replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${crypto.randomBytes(48).toString('hex')}`), { mode: 0o600 });
  console.log('Created .env with a random JWT secret. Set MONGO_URI and optional service credentials.');
}
