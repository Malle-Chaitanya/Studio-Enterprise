/**
 * How do we ask Microsoft "who holds Copilot Studio?" — measured, not assumed.
 *
 * `listGraphUsersFiltered` reads every user and filters `assignedPlans` in memory, because
 * the comment at microsoft.ts:209 says there is no usable OData filter for it. That is true
 * for "holds ANY enabled plan". It is a different question whether Graph can filter on ONE
 * NAMED plan server-side — if it can, the licensed grid becomes a single scoped query
 * instead of a full directory read plus a client-side pass, and it stops being capped by
 * `max`.
 *
 * Four things this answers:
 *   1. Which SKUs in this tenant actually contain CCIBOTSPROD, and its servicePlanId.
 *   2. Whether $filter on assignedPlans/any(...) is accepted (advanced query).
 *   3. Whether the filtered count matches the in-memory count — a filter that is ACCEPTED
 *      but silently wrong is the failure mode that already bit us on Discovery Engine's
 *      userLicenses `filter=` (gemini.ts:309), so acceptance alone proves nothing.
 *   4. What licenseDetails says for one user, as an independent third opinion.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { graphTokenFromRefresh, listGraphUsersFiltered } from '../auth/microsoft.js';

const PLAN = 'CCIBOTSPROD';

await connectMongo();
const s = await getDb().collection('migrationSessions').find({}).sort({ _id: -1 }).limit(1).next() as any;
const token = await graphTokenFromRefresh(s.tenantId, s.refreshToken);
if (!token) throw new Error('no graph token');
const H = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

// ── 1. Which SKUs carry the plan, and what is its id? ────────────────────────
const skuRes = await fetch('https://graph.microsoft.com/v1.0/subscribedSkus', { headers: H });
const skus = (await skuRes.json()) as any;
console.log(`subscribedSkus: ${skuRes.status}`);
let planId = '';
const carrying: string[] = [];
for (const sku of skus.value ?? []) {
  const hit = (sku.servicePlans ?? []).find((p: any) => p.servicePlanName === PLAN);
  if (hit) {
    planId = hit.servicePlanId;
    carrying.push(
      `${sku.skuPartNumber}  (skuId=${sku.skuId})  consumed=${sku.consumedUnits}` +
      `  enabled=${sku.prepaidUnits?.enabled}`,
    );
  }
}
console.log(`\nSKUs containing ${PLAN}:`);
for (const c of carrying) console.log(`  ${c}`);
console.log(`servicePlanId: ${planId || '(not found in any subscribed SKU)'}`);

// ── 1b. subscribedSkus needs Organization.Read.All and 403s on our token. The SAME
//        servicePlanId is available per-user from licenseDetails, which our token CAN read,
//        so the filter test does not have to be abandoned.
if (!planId) {
  const { users: probe } = await listGraphUsersFiltered(token, { max: 999, licensedOnly: false });
  const holder = probe.find((u) => (u.servicePlans ?? []).some((p) => p.includes(PLAN)));
  if (holder) {
    const r = await fetch(
      `https://graph.microsoft.com/v1.0/users/${holder.id}/licenseDetails`, { headers: H });
    const b = (await r.json()) as any;
    const names: string[] = [];
    for (const d of b.value ?? []) {
      for (const sp of d.servicePlans ?? []) {
        if (/CCIBOTS|COPILOT_STUDIO/i.test(sp.servicePlanName ?? '')) {
          names.push(`${sp.servicePlanName} (${sp.servicePlanId}) via ${d.skuPartNumber}`);
          if (!planId) planId = sp.servicePlanId;
        }
      }
    }
    console.log('plan ids recovered from licenseDetails:');
    for (const n of names) console.log(`  ${n}`);
  }
}

// ── 2/3. Server-side filter, and does it AGREE with reading everything? ──────
const { users: allUsers } = await listGraphUsersFiltered(token, { max: 999, licensedOnly: false });
const inMemory = allUsers.filter((u) => (u.servicePlans ?? []).some((p) => p.includes(PLAN)));
console.log(`\nin-memory: ${inMemory.length} of ${allUsers.length} active users hold ${PLAN}`);

if (planId) {
  // Advanced query: assignedPlans/any() needs ConsistencyLevel eventual + $count.
  const filter =
    `assignedPlans/any(a:a/servicePlanId eq ${planId} and a/capabilityStatus eq 'Enabled')`;
  const url =
    'https://graph.microsoft.com/v1.0/users?$count=true&$top=999' +
    `&$select=id,displayName,mail,userPrincipalName&$filter=${encodeURIComponent(filter)}`;
  const r = await fetch(url, { headers: { ...H, ConsistencyLevel: 'eventual' } });
  const body = (await r.json()) as any;
  console.log(`\nserver-side $filter: ${r.status}`);
  if (!r.ok) {
    console.log(`  error: ${body?.error?.code} — ${body?.error?.message}`);
  } else {
    const got: any[] = body.value ?? [];
    console.log(`  returned: ${got.length}   @odata.count: ${body['@odata.count'] ?? '(none)'}`);

    // The real test. Accepted-but-wrong is the trap, so compare the SETS, not the counts.
    const fromFilter = new Set(
      got.map((u) => (u.mail ?? u.userPrincipalName ?? '').toLowerCase()).filter(Boolean),
    );
    const fromMemory = new Set(inMemory.map((u) => u.email.toLowerCase()));
    const onlyFilter = [...fromFilter].filter((e) => !fromMemory.has(e));
    const onlyMemory = [...fromMemory].filter((e) => !fromFilter.has(e));
    console.log(`  agree: ${onlyFilter.length === 0 && onlyMemory.length === 0 ? 'YES' : 'NO'}`);
    for (const e of onlyFilter.slice(0, 10)) console.log(`    only server-side: ${e}`);
    for (const e of onlyMemory.slice(0, 10)) console.log(`    only in-memory:   ${e}`);
    if (got.length === 0 && inMemory.length > 0) {
      console.log('  ^ ACCEPTED BUT MATCHED NOTHING — same shape as the Discovery Engine bug.');
    }
  }
}

// ── 4. licenseDetails, as an independent opinion on one real holder ──────────
const sample = inMemory[0];
if (sample) {
  const r = await fetch(
    `https://graph.microsoft.com/v1.0/users/${sample.id}/licenseDetails`,
    { headers: H },
  );
  const body = (await r.json()) as any;
  console.log(`\nlicenseDetails for ${sample.email}: ${r.status}`);
  for (const d of body.value ?? []) {
    const plans = (d.servicePlans ?? [])
      .filter((p: any) => p.servicePlanName?.includes('CCIBOTS') || p.servicePlanName?.includes('COPILOT'))
      .map((p: any) => `${p.servicePlanName}=${p.provisioningStatus}`);
    console.log(`  ${d.skuPartNumber}: ${plans.join(', ') || '(no copilot plans)'}`);
  }
}

process.exit(0);
