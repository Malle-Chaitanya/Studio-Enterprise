"""Live test: can we connect to the test Cloud SQL Postgres instance using IAM database
auth (the SA's own identity token), with NO stored password -- the second blocking
assumption from the architect's design. Creates a tiny table, inserts a row, reads it back.
python src/spikes/_diag_test_cloudsql_iam_connect.py"""
import google.auth
from google.cloud.sql.connector import Connector, IPTypes
import pg8000

PROJECT = "agentmigrations"
INSTANCE = "csge-feasibility-test"
REGION = "us-central1"
DATABASE = "csgetest"
# IAM auth: the Postgres username is the SA email WITHOUT ".gserviceaccount.com" per
# Cloud SQL's IAM-auth convention for Postgres (already used this exact form when
# creating the CLOUD_IAM_SERVICE_ACCOUNT user via the Admin API).
IAM_USER = "studio-enterprise-migration@studio-enterprise-migration.iam"

creds, project = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])

# Same quota-project quirk found earlier with plain REST calls: without this, Google
# silently falls back to some other default project (here, studio-enterprise-migration)
# instead of the one we actually mean (agentmigrations), and every call 403s.
# credentials.with_quota_project() alone did NOT work -- the Connector's internal
# aiohttp client builds its own headers from the `quota_project` kwarg below, not from
# the credentials object's quota_project_id.
connector = Connector(credentials=creds, quota_project=PROJECT)

def getconn():
    return connector.connect(
        f"{PROJECT}:{REGION}:{INSTANCE}",
        "pg8000",
        user=IAM_USER,
        db=DATABASE,
        enable_iam_auth=True,
        ip_type=IPTypes.PUBLIC,
    )

print("Connecting via IAM auth, no password...")
conn = getconn()
cur = conn.cursor()
cur.execute("CREATE TABLE IF NOT EXISTS feasibility_test (id SERIAL PRIMARY KEY, note TEXT)")
cur.execute("INSERT INTO feasibility_test (note) VALUES (%s) RETURNING id", ("IAM auth works, no stored password",))
new_id = cur.fetchone()[0]
conn.commit()
cur.execute("SELECT id, note FROM feasibility_test WHERE id = %s", (new_id,))
row = cur.fetchone()
print("SUCCESS. Row read back:", row)
cur.close()
conn.close()
connector.close()
