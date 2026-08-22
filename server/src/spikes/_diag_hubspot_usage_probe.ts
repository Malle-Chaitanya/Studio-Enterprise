/** The usage endpoint our tool really calls (per PRIVATE APP — the account-level ones all 404,
 *  see the hubspot.py docstring). Confirms the earlier 404 was my probe URL, not a scope gap. */
const t = process.env.HUBSPOT_TOKEN;
if (!t) throw new Error('set HUBSPOT_TOKEN');
const r = await fetch('https://api.hubapi.com/account-info/v3/api-usage/daily/private-apps', {
  headers: { Authorization: `Bearer ${t}` },
});
const body = (await r.text()).replace(/pat-[A-Za-z0-9-]+/g, 'pat-[redacted]');
console.log(`per-private-app usage -> ${r.status} ${body.slice(0, 220)}`);
process.exit(0);
