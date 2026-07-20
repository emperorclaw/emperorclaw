import paramiko, os, time
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect('212.227.22.193', username='root', password=os.environ['VPS_PASS'], timeout=10)
def run(cmd, timeout=60):
    stdin, stdout, stderr = c.exec_command(cmd, timeout=timeout)
    return stdout.read().decode().strip(), stderr.read().decode().strip()

# Switch compose to build
out, err = run("cd /var/www/emperorclaw && sed -i 's|image: ghcr.io/emperorclaw/emperorclaw:latest|# image: ghcr.io/emperorclaw/emperorclaw:latest|' docker-compose.yml && sed -i 's|# build: .|build: .|' docker-compose.yml && echo SWITCHED")
print('SWITCH:', out)

# Build
print('Building...')
out, err = run('cd /var/www/emperorclaw && docker compose build app 2>&1', timeout=600)
lines = out.split('\n')
for line in lines[-15:]:
    if line.strip():
        print(line[:200])

# Switch back
out, err = run("cd /var/www/emperorclaw && sed -i 's|# image: ghcr.io/emperorclaw/emperorclaw:latest|image: ghcr.io/emperorclaw/emperorclaw:latest|' docker-compose.yml && sed -i 's|build: .|# build: .|' docker-compose.yml && echo SWITCHED")
print('\nRESTORE:', out)

# Stop old, start new
out, err = run('docker stop emperorclaw-app 2>&1; docker rm emperorclaw-app 2>&1')
out, err = run('cd /var/www/emperorclaw && docker compose run -d --service-ports --name emperorclaw-app app node server.js 2>&1')
print('RUN:', out[:200])

time.sleep(5)
out, err = run('curl -s -o /dev/null -w "%{http_code}" http://localhost:3000')
print('HTTP:', out)
c.close()
