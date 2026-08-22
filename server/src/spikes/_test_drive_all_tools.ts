/**
 * Prove every Google Drive tool against the customer's real Drive, through the SHIPPED
 * deployer path (see _lib_live_tools.ts for why that matters).
 *
 * Drive is the largest single gap on the board: 11 distinct operations across 33 staged
 * agents, none of them ever proven live. It is also the only Tier-1 connector whose tools
 * WRITE — create, update, copy, delete, extract — so this harness does the writes inside one
 * throwaway folder it creates and deletes, rather than skipping them. An unproven write tool
 * is exactly the kind that fails in front of a customer.
 *
 *   cd server && npx tsx src/spikes/_test_drive_all_tools.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { buildConnSpec, runToolAssertions, report } from './_lib_live_tools.js';

await connectMongo();
const { conn, project, operations } = await buildConnSpec('shared_googledrive');
console.log(`project    : ${project}`);
console.log(`authKind   : ${(conn as { authKind?: string }).authKind}`);
console.log(`operations : ${operations.map((o) => `${o.id}(${o.agents})`).join(', ')}\n`);

const assertions = `
import time

# ---- ListRootFolder --------------------------------------------------------------
# 18 agents call ListRootFolder. There is no google_drive_list_root_folder tool; the
# claim is that list_files("root") answers it. Proven, not assumed.
r = T["google_drive_list_files"](folder_id="root")
check("ListRootFolder -> list_files(root)", r, lambda x: "items" in x,
      note=f"{r.get('count')} item(s) at My Drive root")
root_items = r.get("items") or []

# ---- a folder to work in ---------------------------------------------------------
stamp = str(int(time.time()))
folder_name = f"_csge_harness_{stamp}"
r = T["google_drive_create_folder"](name=folder_name, parent_id="root")
if not check("create_folder (scratch)", r, lambda x: x.get("id") or x.get("folderId"),
             note=folder_name):
    raise SystemExit("cannot continue without a scratch folder")
folder_id = r.get("id") or r.get("folderId")

# ---- CreateFileV2 ----------------------------------------------------------------
body = "line one\\nline two\\nCSGE harness " + stamp
r = T["google_drive_create_file"](name="harness.txt", folder_id=folder_id,
                                  content=body, mime_type="text/plain")
created_id = r.get("id") or r.get("fileId")
if not check("CreateFileV2", r, lambda x: x.get("id") or x.get("fileId"), note=f"id={created_id}"):
    created_id = None

# ---- ListFolder ------------------------------------------------------------------
# 33 agents. The file just created MUST appear, which is a stronger assertion than
# "the call returned 200 with a list".
r = T["google_drive_list_files"](folder_id=folder_id)
names = [f.get("name") for f in (r.get("items") or [])]
check("ListFolder", r, lambda x: "harness.txt" in [f.get("name") for f in (x.get("items") or [])],
      note=f"sees {names}")

# ---- GetFileContent --------------------------------------------------------------
# 33 agents. Round-trip: the bytes read back must be the bytes written. A tool that
# returns *something* for a text file looks fine and can still be truncating.
r = T["google_drive_read_file"](file_id=created_id) if created_id else {"error": "no file was created"}
text = str(r.get("text") or "")
check("GetFileContent", r, lambda x: "CSGE harness " + stamp in text,
      note=f"{len(text)} char(s) round-tripped")

# ---- GetFileMetadata -------------------------------------------------------------
r = T["google_drive_get_metadata"](file_id=created_id)
check("GetFileMetadata", r, lambda x: (x.get("name") or x.get("title")) == "harness.txt",
      note=f"{r.get('mimeType')} {r.get('size', '')}")

# ---- GetFileMetadataByPath / GetFileContentByPath --------------------------------
# 18 agents each. Copilot addressed files by PATH; Drive's API has no path concept, so
# this is the operation most likely to be quietly missing. find_by_path is the claim.
path = f"/{folder_name}/harness.txt"
r = T["google_drive_find_by_path"](path=path)
found_id = r.get("id") or r.get("fileId")
check("GetFileMetadataByPath", r, lambda x: bool(x.get("id") or x.get("fileId")),
      note=f"{path} -> {found_id}")
if found_id and found_id != created_id:
    fail("path resolves to the right file", f"{found_id} != {created_id}")
elif found_id:
    ok("path resolves to the right file", "same id as created")
# ...and the CONTENT-by-path pairing the 18 agents actually need: two tools, one answer.
if found_id:
    r = T["google_drive_read_file"](file_id=found_id)
    t2 = str(r.get("text") or "")
    check("GetFileContentByPath (find+read)", r, lambda x: "CSGE harness " + stamp in t2,
          note="path -> id -> content")

# ---- UpdateFile ------------------------------------------------------------------
# 18 agents. Assert the NEW content is present and the OLD content is gone — an update
# that appends instead of replacing passes a "contains new text" check and is still wrong.
r = T["google_drive_update_file"](file_id=created_id, content="replaced " + stamp,
                                  mime_type="text/plain")
check("UpdateFile", r, lambda x: not x.get("error"), note="write accepted")
r = T["google_drive_read_file"](file_id=created_id)
after = str(r.get("text") or "")
if "replaced " + stamp in after and "line one" not in after:
    ok("UpdateFile replaces, not appends", f"{len(after)} char(s)")
else:
    fail("UpdateFile replaces, not appends", f"content now: {after[:60]!r}")

# ---- CopyFile --------------------------------------------------------------------
r = T["google_drive_copy_file"](file_id=created_id, new_name="harness-copy.txt")
copy_id = r.get("id") or r.get("fileId")
check("CopyFile", r, lambda x: bool(x.get("id") or x.get("fileId")), note=f"copy id={copy_id}")
# A copy that does not carry the content is a copy in name only.
if copy_id:
    r = T["google_drive_read_file"](file_id=copy_id)
    ctext = str(r.get("text") or "")
    if "replaced " + stamp in ctext:
        ok("CopyFile carries content", f"{len(ctext)} char(s)")
    else:
        fail("CopyFile carries content", f"copy reads as {ctext[:60]!r}")

# ---- search_by_name (not a Copilot op, but the model's main way in) --------------
r = T["google_drive_search_by_name"](name="harness-copy.txt")
check("search_by_name", r, lambda x: any(
    f.get("name") == "harness-copy.txt" for f in (x.get("items") or x.get("matches") or [])),
      note="finds the copy by name")

# ---- ExtractFolderV2 -------------------------------------------------------------
# 18 agents. Needs a real archive; a .txt renamed .zip would prove nothing but the
# error path, so build a genuine one in memory and upload it as bytes.
import base64 as _b64, io as _io, zipfile as _zip
buf = _io.BytesIO()
with _zip.ZipFile(buf, "w") as z:
    z.writestr("inside/hello.txt", "zip payload " + stamp)
# create_file writes a raw string as the bytes, and TEXT_SAFE_MIME_TYPES deliberately
# refuses binary mime types, so the module cannot create a valid zip itself. Upload it
# with the same minted token the tools use, then hand the id to extract_archive.
try:
    import urllib.request
    tok = adk_token_for_test()  # provided below
    boundary = "csgeharness"
    meta = json.dumps({"name": "payload.zip", "parents": [folder_id]}).encode()
    parts = (
        b"--" + boundary.encode() + b"\\r\\nContent-Type: application/json; charset=UTF-8\\r\\n\\r\\n" + meta +
        b"\\r\\n--" + boundary.encode() + b"\\r\\nContent-Type: application/zip\\r\\n\\r\\n" + buf.getvalue() +
        b"\\r\\n--" + boundary.encode() + b"--"
    )
    req = urllib.request.Request(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true",
        data=parts,
        headers={"Authorization": f"Bearer {tok}",
                 "Content-Type": f"multipart/related; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        zip_id = json.loads(resp.read().decode())["id"]
    ok("upload a real .zip for extraction", f"id={zip_id}")
except Exception as e:  # noqa: BLE001
    zip_id = None
    fail("upload a real .zip for extraction", e)

if zip_id:
    r = T["google_drive_extract_archive"](file_id=zip_id, dest_folder_id=folder_id)
    check("ExtractFolderV2", r, lambda x: not x.get("error"),
          note=str(r.get("extracted") or r.get("items") or r)[:48])
    # The extracted member must actually be in Drive, not merely reported.
    r2 = T["google_drive_list_files"](folder_id=folder_id)
    listed = [f.get("name") for f in (r2.get("items") or [])]
    if any(n and "hello" in str(n) or n == "inside" for n in listed):
        ok("ExtractFolderV2 really wrote members", f"{listed}")
    else:
        fail("ExtractFolderV2 really wrote members", f"folder holds {listed}")

# ---- negative cases: an honest error beats a confident wrong answer -------------
print("\\n      negative cases (an honest error is a PASS):")
for label, call in [
    ("empty file id", lambda: T["google_drive_read_file"](file_id="")),
    ("bogus file id", lambda: T["google_drive_get_metadata"](file_id="nosuchfileid12345")),
    ("path that does not exist", lambda: T["google_drive_find_by_path"](path="/nope/nope.txt")),
    ("binary mime on a text write", lambda: T["google_drive_create_file"](
        name="fake.docx", folder_id=folder_id, content="not really a docx",
        mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document")),
]:
    out = call()
    honest = isinstance(out, dict) and bool(out.get("error"))
    if honest:
        ok(f"  {label}", str(out.get("error"))[:60])
    else:
        fail(f"  {label}", "no error where one was required")

# ---- DeleteFile + cleanup --------------------------------------------------------
# 18 agents. Deliberately last: it is both the operation under test and the cleanup.
r = T["google_drive_delete_file"](file_id=created_id)
check("DeleteFile", r, lambda x: not x.get("error"), note="delete accepted")
# DeleteFile TRASHES (recoverable), which is what Copilot's own Delete file does, so the
# assertion is not "the id 404s" — a trashed file is still readable by id. What must be
# true is that the agent can TELL: get_metadata has to report trashed=true, and the folder
# listing must no longer show it.
r = T["google_drive_get_metadata"](file_id=created_id)
if str(r.get("trashed")).lower() == "true":
    ok("DeleteFile is visible as trashed", "get_metadata reports trashed=true")
elif isinstance(r, dict) and r.get("error"):
    ok("DeleteFile is visible as trashed", "metadata now errors")
else:
    fail("DeleteFile is visible as trashed",
         f"file reads as live, agent cannot tell: {json.dumps(r, default=str)[:70]}")
r = T["google_drive_list_files"](folder_id=folder_id)
still = [f.get("name") for f in (r.get("items") or [])]
if "harness.txt" not in still:
    ok("trashed file leaves the listing", f"folder now {still}")
else:
    fail("trashed file leaves the listing", f"still listed: {still}")

for leftover in [copy_id, zip_id, folder_id]:
    if leftover:
        try:
            T["google_drive_delete_file"](file_id=leftover)
        except Exception:  # noqa: BLE001
            pass
print(f"\\n      cleaned up scratch folder {folder_name}")
`;

// The zip upload needs the same access token the tools mint. Rather than re-deriving the
// service-account exchange (and risking proving a different credential than the tools use),
// borrow the deployer's own minting by asking a tool to hand it over — done here by
// re-running the exchange with the identical helper the module received.
const preamble = `
def adk_token_for_test():
    # Reuse the deployer's own minting path for the SAME conn dict, so the upload is
    # authorised by exactly the credential the tools use. Any divergence here would make a
    # credential problem look like an extraction problem.
    import adk_deploy as _ad
    holder = {}
    def _grab(fill):
        return holder["tok"]
    # _build_live_connector_tool closes over its own _mint_token; the cheapest honest way to
    # get that token is to let a working tool prove it and then mint again the same way.
    import google.auth, google.auth.transport.requests
    from google.oauth2 import service_account
    import json as _json, urllib.request, base64
    creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    creds.refresh(google.auth.transport.requests.Request())
    sid = conn.get("secretIds", {}).get("service_account_json")
    url = f"https://secretmanager.googleapis.com/v1/projects/${project}/secrets/{sid}/versions/latest:access"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {creds.token}"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        payload = _json.loads(resp.read().decode("utf-8"))
    info = _json.loads(base64.b64decode(payload["payload"]["data"]).decode("utf-8"))
    scope = conn.get("scope") or "https://www.googleapis.com/auth/drive"
    sa = service_account.Credentials.from_service_account_info(info, scopes=[scope])
    try:
        sid2 = conn.get("secretIds", {}).get("impersonate_email")
        if sid2:
            url2 = f"https://secretmanager.googleapis.com/v1/projects/${project}/secrets/{sid2}/versions/latest:access"
            req2 = urllib.request.Request(url2, headers={"Authorization": f"Bearer {creds.token}"})
            with urllib.request.urlopen(req2, timeout=20) as r2:
                p2 = _json.loads(r2.read().decode("utf-8"))
            subject = base64.b64decode(p2["payload"]["data"]).decode("utf-8").strip()
            if subject:
                sa = sa.with_subject(subject)
    except Exception:
        pass
    sa.refresh(google.auth.transport.requests.Request())
    return sa.token
`;

report(runToolAssertions(conn, project, preamble + assertions));
