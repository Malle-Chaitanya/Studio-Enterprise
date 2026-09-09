"""Grant postgres SELECT on the real table, connecting as the table's actual OWNER (our
service account, via IAM auth) since postgres itself lacks SELECT and therefore can't
GRANT it either -- only the owner can. Purely for the human's manual verification; the
deployed agent authenticates via IAM only and never needs this.
python src/spikes/_diag_grant_postgres_read_real_table.py"""
import google.auth
from google.cloud.sql.connector import Connector, IPTypes
import pg8000

PROJECT = "agentmigrations"
INSTANCE = "csge-dataverse-tables"
DATABASE = "cr88d_clientcreditfacilities"
IAM_USER = "studio-enterprise-migration@studio-enterprise-migration.iam"

creds, project = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
connector = Connector(credentials=creds, quota_project=PROJECT)

conn = connector.connect(
    f"{PROJECT}:us-central1:{INSTANCE}",
    "pg8000",
    user=IAM_USER,
    db=DATABASE,
    enable_iam_auth=True,
    ip_type=IPTypes.PUBLIC,
)
cur = conn.cursor()
cur.execute('GRANT SELECT ON cr88d_clientcreditfacilities TO postgres')
conn.commit()
print("Granted SELECT on cr88d_clientcreditfacilities to postgres")
cur.close()
conn.close()
connector.close()
