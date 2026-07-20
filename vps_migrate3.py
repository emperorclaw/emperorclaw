import paramiko, os, time

host = '212.227.22.193'
user = 'root'
password = os.environ['VPS_PASS']

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, username=user, password=password, timeout=10)
print('CONNECTED')

def run(cmd, timeout=60):
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode().strip()
    err = stderr.read().decode().strip()
    return out, err

# Fix docker-compose to build from source instead of pulling image
print('\n=== FIXING DOCKER COMPOSE ===')
out, err = run(
    "cd /var/www/emperorclaw && "
    "sed -i 's|image: ghcr.io/emperorclaw/emperorclaw:latest|# image: ghcr.io/emperorclaw/emperorclaw:latest|' docker-compose.yml && "
    "sed -i 's|# build: .|build: .|' docker-compose.yml && "
    "echo 'FIXED'",
    timeout=10
)
print(out)

# Verify
out, err = run('grep -A1 "app:" /var/www/emperorclaw/docker-compose.yml | head -10')
print('COMPOSE:', out[:300])

# Build and start
print('\n=== DOCKER COMPOSE BUILD & UP ===')
out, err = run(
    'cd /var/www/emperorclaw && docker compose up -d --build 2>&1',
    timeout=600  # 10 min for build
)
# Show last part of output
lines = out.split('\n')
for line in lines[-30:]:
    if line.strip():
        print(line)
if err:
    err_lines = err.split('\n')
    for line in err_lines[-10:]:
        if line.strip():
            print('ERR:', line[:200])

# Check status
time.sleep(5)
print('\n=== CONTAINERS ===')
out, err = run('docker compose -f /var/www/emperorclaw/docker-compose.yml ps 2>&1')
print(out)

# Restore DB if postgres is up
out, err = run('docker compose -f /var/www/emperorclaw/docker-compose.yml exec -T postgres pg_isready -U emperor -d emperor 2>&1', timeout=10)
if 'accepting' in out:
    print('\n=== RESTORING DB ===')
    out, err = run(
        'docker cp /tmp/emperor_claw_dump.sql $(docker compose -f /var/www/emperorclaw/docker-compose.yml ps -q postgres):/tmp/dump.sql 2>&1 && '
        'docker compose -f /var/www/emperorclaw/docker-compose.yml exec -T postgres pg_restore -U emperor -d emperor --clean --if-exists --no-owner /tmp/dump.sql 2>&1',
        timeout=120
    )
    print(out[-500:] if len(out) > 500 else out)
    if err:
        print('ERR:', err[-300:])

# Test
print('\n=== TEST ===')
time.sleep(3)
out, err = run('curl -s -o /dev/null -w "%{http_code}" http://localhost:3000')
print('HTTP:', out)

client.close()
