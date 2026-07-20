import paramiko, os, time

host = '212.227.22.193'
user = 'root'
password = os.environ['VPS_PASS']

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, username=user, password=password, timeout=10)

def run(cmd, timeout=60):
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    return stdout.read().decode().strip(), stderr.read().decode().strip()

# Override the app container's entrypoint to skip migrations (DB already restored)
print('=== FIX APP CONTAINER ===')
# Stop it
out, err = run('docker compose -f /var/www/emperorclaw/docker-compose.yml stop app 2>&1')
print(out[:200])

# Remove the old container
out, err = run('docker compose -f /var/www/emperorclaw/docker-compose.yml rm -f app 2>&1')
print(out[:200])

# Override docker-compose to add a command override
out, err = run(
    "cd /var/www/emperorclaw && "
    "sed -i '/^  app:/,/^  [a-z]/{/^    image:/a\\    command: [\"node\", \"server.js\"]' docker-compose.yml} 2>&1 || "
    "echo 'trying alt approach'"
)
print(out[:200])

# Actually, let's just update the docker-compose to add command override properly
# First, read current compose
out, err = run('cat /var/www/emperorclaw/docker-compose.yml')
print('CURRENT COMPOSE:', out[-500:] if len(out) > 500 else out)

client.close()
