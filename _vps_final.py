import paramiko, sys

HOST = '212.227.22.193'
USER = 'root'
PW = 'rUPXj6w4csdhUnEitpaXAKQM!A1'
DIR = '/var/www/emperorclaw'

# Fix: app with resilient CMD, Watchtower replaced with cron-based pull
COMPOSE = """services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: emperor
      POSTGRES_PASSWORD: emperor
      POSTGRES_DB: emperor
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U emperor -d emperor"]
      interval: 5s
      timeout: 5s
      retries: 5
    ports:
      - "5432:5432"

  app:
    image: ghcr.io/emperorclaw/emperorclaw:latest
    ports:
      - "3000:3000"
    env_file:
      - .env
    environment:
      - POSTGRES_CONNECTION_STRING=postgres://emperor:emperor@postgres:5432/emperor
      - APP_URL=http://localhost:3000
      - NEXTAUTH_URL=http://localhost:3000
      - STORAGE_BACKEND=local
      - STORAGE_LOCAL_DIR=./.data/storage
    volumes:
      - app-storage:/app/.data/storage
      - /var/run/docker.sock:/var/run/docker.sock
    command: ["sh", "-c", "npx tsx src/db/migrate.ts 2>/dev/null; node server.js"]
    depends_on:
      postgres:
        condition: service_healthy

  # Auto-update: cron-based docker pull every 10 min
  updater:
    image: docker:cli
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    entrypoint: ["/bin/sh"]
    command:
      - "-c"
      - |
        while true; do
          sleep 600
          docker pull ghcr.io/emperorclaw/emperorclaw:latest 2>/dev/null
          CONTAINERS=$$(docker ps -q --filter "name=emperorclaw-app")
          if [ -n "$$CONTAINERS" ]; then
            CURRENT_IMG=$$(docker inspect --format='{{.Config.Image}}' $$CONTAINERS 2>/dev/null)
            LATEST_ID=$$(docker image inspect ghcr.io/emperorclaw/emperorclaw:latest --format='{{.Id}}' 2>/dev/null)
            RUNNING_ID=$$(docker inspect --format='{{.Image}}' $$CONTAINERS 2>/dev/null)
            if [ -n "$$LATEST_ID" ] && [ -n "$$RUNNING_ID" ] && [ "$$LATEST_ID" != "$$RUNNING_ID" ]; then
              docker stop $$CONTAINERS 2>/dev/null
              docker rm $$CONTAINERS 2>/dev/null
              cd /var/www/emperorclaw && docker compose up -d app 2>/dev/null
            fi
          fi
        done
    restart: unless-stopped

volumes:
  pgdata:
  app-storage:
"""

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

# Write compose
stdin, stdout, stderr = client.exec_command("cat > " + DIR + "/docker-compose.yml << 'EOF'\n" + COMPOSE + "\nEOF")
stdout.channel.recv_exit_status()
print("Compose written.")

run(client, f"cd {DIR} && docker compose down 2>&1", "compose down")
run(client, f"cd {DIR} && docker compose up -d 2>&1", "compose up -d")

import time
time.sleep(8)

run(client, "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>&1", "ps")
run(client, "docker logs emperorclaw-app-1 --tail 5 2>&1", "app logs")
run(client, "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000 2>&1", "app health")

print("\nDone.")
client.close()
