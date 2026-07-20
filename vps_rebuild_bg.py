import paramiko, os, time
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect('212.227.22.193', username='root', password=os.environ['VPS_PASS'], timeout=10)
def run(cmd, timeout=30):
    stdin, stdout, stderr = c.exec_command(cmd, timeout=timeout)
    return stdout.read().decode().strip(), stderr.read().decode().strip()

# Broader search
out, err = run("docker exec emperorclaw-app grep -c 'created_at' /app/.next/server/chunks/src_0j2vl9.._.js 2>/dev/null")
print('COUNT:', out)

# Get lines with created_at
out, err = run("docker exec emperorclaw-app grep 'created_at' /app/.next/server/chunks/src_0j2vl9.._.js 2>/dev/null | head -5")
print('LINES:', out[:500])

# Just do a simple sed replacement on all chunks - replace "> " with ">= " near "created_at"
# Actually the safest: rebuild in background via nohup
out, err = run("nohup sh -c 'cd /var/www/emperorclaw && sed -i \"s|image: ghcr.io/emperorclaw/emperorclaw:latest|# image: ghcr.io/emperorclaw/emperorclaw:latest|\" docker-compose.yml && sed -i \"s|# build: .|build: .|\" docker-compose.yml && docker compose build app && docker stop emperorclaw-app; docker rm emperorclaw-app; docker compose run -d --service-ports --name emperorclaw-app app node server.js && sed -i \"s|# image: ghcr.io/emperorclaw/emperorclaw:latest|image: ghcr.io/emperorclaw/emperorclaw:latest|\" docker-compose.yml && sed -i \"s|build: .|# build: .|\" docker-compose.yml' > /tmp/rebuild.log 2>&1 &")
print('REBUILD STARTED:', out[:100])

c.close()
