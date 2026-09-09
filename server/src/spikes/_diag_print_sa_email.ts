import 'dotenv/config';
import { serviceAccountEmail } from '../auth/google.js';
console.log('SA email:', serviceAccountEmail() ?? 'not configured / not found');
process.exit(0);
