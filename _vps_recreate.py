import paramiko, sys, time

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

run(client, "cd /var/www/emperorclaw && docker compose up -d --force-recreate app 2>&1", "force recreate")
time.sleep(8)
run(client, "docker ps --format '{{.Names}} {{.Status}}' | grep emperorclaw", "status")
run(client, "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/api/mcp/pricing 2>&1", "pricing api")
run(client, "curl -s http://localhost:3000/api/mcp/runtime/health 2>&1", "health")

# Also test the budgets page
run(client, "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/budgets 2>&1", "budgets page")

client.close()
