import paramiko, sys

HOST = '212.227.22.193'
USER = 'root'
PW = 'rUPXj6w4csdhUnEitpaXAKQM!A1'

def run(client, cmd, label=""):
    print(f"\n=== {label} ===")
    stdin, stdout, stderr = client.exec_command(cmd)
    out = stdout.read().decode()
    err = stderr.read().decode()
    if out: print(out[:1500])
    if err: print(err[:500], file=sys.stderr)

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PW, timeout=30)

# Run new migration
print("=== Running migration 0029 ===")
# Transfer migration file
sftp = client.open_sftp()
sftp.put("c:/Users/JZ/Documents/w/emperorclaw/src/db/migrations/0029_monthly-reset.sql", "/tmp/0029_monthly-reset.sql")
sftp.close()
run(client, "docker exec -i emperorclaw-postgres-1 psql -U emperor -d emperor -f - < /tmp/0029_monthly-reset.sql 2>&1", "migration 0029")

# Re-seed pricing with updated models
print("=== Re-seeding pricing ===")
sftp = client.open_sftp()
sftp.put("c:/Users/JZ/Documents/w/emperorclaw/src/db/migrations/0028_llm-pricing.sql", "/tmp/0028_llm-pricing.sql")
sftp.close()
# Only run the INSERT part (skip CREATE TABLE which already exists)
run(client, "docker exec -i emperorclaw-postgres-1 psql -U emperor -d emperor -c \"$(grep -A1000 'INSERT INTO llm_pricing' /tmp/0028_llm-pricing.sql)\" 2>&1", "re-seed pricing")

# Pull + restart app
run(client, "cd /var/www/emperorclaw && docker compose pull app 2>&1", "pull app")
run(client, "cd /var/www/emperorclaw && docker compose up -d app 2>&1", "restart app")

import time
time.sleep(5)
run(client, "docker ps --format '{{.Names}} {{.Status}}' | grep emperorclaw", "status")
run(client, "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/api/mcp/pricing 2>&1", "pricing api test")

client.close()
print("\nVPS deployed.")
