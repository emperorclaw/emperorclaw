import paramiko, sys

HOST = '212.227.22.193'
USER = 'root'
PW = 'rUPXj6w4csdhUnEitpaXAKQM!A1'
DIR = '/var/www/emperorclaw'

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
    depends_on:
      postgres:
        condition: service_healthy

  watchtower:
    image: containrrr/watchtower
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command: --interval 300 --cleanup emperorclaw-app-1
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
print(f"Connecting to {HOST}...")
client.connect(HOST, username=USER, password=PW, timeout=30)

print("Writing docker-compose.yml...")
stdin, stdout, stderr = client.exec_command("cat > " + DIR + "/docker-compose.yml << 'EOF'\n" + COMPOSE + "\nEOF")
stdout.channel.recv_exit_status()
print("Written.")

run(client, f"cd {DIR} && docker compose pull 2>&1", "docker compose pull")
run(client, f"cd {DIR} && docker compose up -d 2>&1", "docker compose up -d")
run(client, f"cd {DIR} && docker compose ps 2>&1", "docker compose ps")

print("\nDone. VPS updated: latest + Watchtower + docker.sock.")
client.close()
