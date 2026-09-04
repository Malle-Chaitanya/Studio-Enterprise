/** Does discovery now name the project by id rather than number? */
import { discoverGeminiProject } from '../auth/google.js';
import { getSaToken } from '../auth/google.js';
const t = await getSaToken();
const ref = await discoverGeminiProject(t);
console.log('discovered:', ref, /^[0-9]+$/.test(ref ?? '') ? '  <-- STILL A NUMBER' : '  <-- project id');
