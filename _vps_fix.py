import paramiko, sys

HOST = '212.227.22.193'
USER = 'root'
PW = 'rUPXj6w4csdhUnEitpaXAKQM!A1'
DIR = '/var/www/emperorclaw'

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

# Stop old manually-created container
run(client, "docker stop emperorclaw-app 2>&1 || true", "stop old app")
run(client, "docker rm emperorclaw-app 2>&1 || true", "rm old app")

# Now bring up with compose
run(client, f"cd {DIR} && docker compose up -d 2>&1", "docker compose up -d")
run(client, f"cd {DIR} && docker compose ps 2>&1", "docker compose ps")

print("\nDone.")
client.close()
