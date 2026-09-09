/** Print the exact SA email this tool uses for all its Google-side operations, so the
 *  user can grant it the right IAM roles for Cloud SQL. npx tsx src/spikes/_diag_print_sa_email_2.ts */
import 'dotenv/config';
import { serviceAccountEmail } from '../auth/google.js';
console.log('Service account email:', serviceAccountEmail());
process.exit(0);
