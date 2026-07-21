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

run(client, "docker logs emperorclaw-watchtower-1 --tail 5 2>&1", "watchtower logs")
run(client, "docker logs emperorclaw-app-1 --tail 20 2>&1", "app logs")
run(client, "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000 2>&1", "app health")

client.close()
