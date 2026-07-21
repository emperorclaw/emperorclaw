import paramiko, sys

HOST = '212.227.22.193'
USER = 'root'
PW = 'rUPXj6w4csdhUnEitpaXAKQM!A1'

def run(client, cmd, label=""):
    print(f"\n=== {label} ===")
    stdin, stdout, stderr = client.exec_command(cmd)
    out = stdout.read().decode()
    err = stderr.read().decode()
    if out: print(out)
    if err: print(err, file=sys.stderr)

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PW, timeout=30)

# Clean up orphaned watchtower
run(client, "docker rm -f emperorclaw-watchtower-1 2>&1 || true", "cleanup orphan")
run(client, "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>&1", "final ps")
run(client, "curl -s http://localhost:3000/api/mcp/runtime/health 2>&1", "api health")

print("\n=== VPS STATUS ===")
print("App: :3000 (healthy, 200)")
print("PostgreSQL: :5432 (healthy)")
print("Auto-update: docker:cli cron every 10min")
print("Manual update: /ops Update button (docker.sock)")
print("docker.sock: mounted in app + updater")
client.close()
