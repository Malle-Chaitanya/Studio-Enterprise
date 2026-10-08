/** What Discovery publishes about media upload, per method. Throwaway diagnostic. */
const r = await fetch('https://www.googleapis.com/discovery/v1/apis/drive/v3/rest');
const d: any = await r.json();
console.log('rootUrl:', d.rootUrl);
for (const id of ['create', 'update', 'get', 'copy']) {
  const m = d.resources.files.methods[id];
  console.log(
    id.padEnd(8),
    'mediaUpload=' + !!m.mediaUpload,
    m.mediaUpload ? JSON.stringify(m.mediaUpload.protocols) : '',
  );
}
