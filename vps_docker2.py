import paramiko, os

host = '212.227.22.193'
user = 'root'
password = os.environ['VPS_PASS']

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, username=user, password=password, timeout=10)

def run(cmd, timeout=60):
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    return stdout.read().decode().strip(), stderr.read().decode().strip()

# First, get the app back online via PM2
print('=== RESTARTING PM2 ===')
out, err = run('pm2 restart emperorclaw 2>&1')
print(out[:300])

# Now try Docker build separately to see the error
print('\n=== DOCKER BUILD ===')
out, err = run(
    'cd /var/www/emperorclaw && docker build -t emperorclaw:local . 2>&1',
    timeout=600
)
# Show last 30 lines
lines = out.split('\n')
for line in lines[-30:]:
    if line.strip():
        print(line)
if err:
    err_lines = err.split('\n')
    for line in err_lines[-15:]:
        if line.strip():
            print('ERR:', line[:300])

client.close()
