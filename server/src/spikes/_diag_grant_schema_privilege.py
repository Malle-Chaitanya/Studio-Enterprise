"""Connect as postgres (password auth) and grant our IAM user CREATE on schema public.
python src/spikes/_diag_grant_schema_privilege.py"""
import sys
import google.auth
from google.cloud.sql.connector import Connector, IPTypes
import pg8000

PROJECT = "agentmigrations"
INSTANCE = "csge-feasibility-test"
REGION = "us-central1"
DATABASE = "csgetest"
IAM_USER = "studio-enterprise-migration@studio-enterprise-migration.iam"
PG_PASSWORD = sys.argv[1]

creds, project = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
connector = Connector(credentials=creds, quota_project=PROJECT)

conn = connector.connect(
    f"{PROJECT}:{REGION}:{INSTANCE}",
    "pg8000",
    user="postgres",
    password=PG_PASSWORD,
    db=DATABASE,
    ip_type=IPTypes.PUBLIC,
)
cur = conn.cursor()
cur.execute(f'GRANT CREATE, USAGE ON SCHEMA public TO "{IAM_USER}"')
conn.commit()
print("Granted CREATE, USAGE on schema public to", IAM_USER)
cur.close()
conn.close()
connector.close()
