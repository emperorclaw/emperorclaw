import paramiko, os

host = '212.227.22.193'
user = 'root'
password = os.environ['VPS_PASS']

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, username=user, password=password, timeout=10)

# Add the missing column directly via the app's DB connection
print('--- ADDING scope_json ---')
stdin, stdout, stderr = client.exec_command(
    'cd /var/www/emperorclaw && node -e "'
    'const { db } = require(\"./.next/standalone/.next/server/chunks/ssr/[root-of-the-server]__0c2s0yp._.js\");'
    'console.log(\"loaded\")" 2>&1',
    timeout=10
)
print('Attempt 1:', stdout.read().decode().strip()[:300])

# Better: use drizzle-kit push (dangerous but targeted) or raw SQL via the app
# Actually, let's just use the drizzle client from a script
stdin, stdout, stderr = client.exec_command(
    'cd /var/www/emperorclaw && npx tsx -e "'
    'import { db } from \"./src/db\";'
    'import { sql } from \"drizzle-orm\";'
    'await db.execute(sql`ALTER TABLE company_members ADD COLUMN IF NOT EXISTS scope_json JSONB DEFAULT \'{}\'`);'
    'console.log(\"scope_json added\");'
    '" 2>&1',
    timeout=30
)
out = stdout.read().decode().strip()
err = stderr.read().decode().strip()
print('Attempt 2:', out[:500])
if err:
    print('ERR:', err[:500])

# Restart
print('\n--- RESTART ---')
stdin, stdout, stderr = client.exec_command('pm2 restart emperorclaw --update-env 2>&1', timeout=15)
print(stdout.read().decode().strip()[:500])

# Verify
import time
time.sleep(3)
stdin, stdout, stderr = client.exec_command('curl -sS http://localhost:3000 2>&1 | head -5', timeout=10)
print('\n--- PAGE ---')
print(stdout.read().decode().strip()[:300])

client.close()
