#!/usr/bin/env bash
# Checks the Docker setup end to end and prints PASS/FAIL per check.
# Run from the repo folder: bash tools/docker-check.sh   (asks for your sudo password once)
set -u
cd "$(dirname "$0")/.."
fails=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; fails=$((fails + 1)); }

sudo -v || exit 1
sudo docker compose down >/dev/null 2>&1

# The container uses host networking: if anything else holds the port, the container's server
# can't bind and the HTTP checks below would test that other server instead (2026-11-09).
# CHECK_PORT is for the script's own test only; the container always uses 2567.
port=${CHECK_PORT:-2567}
if (: </dev/tcp/127.0.0.1/"$port") 2>/dev/null; then
  fail "port $port is already in use (a dev server still running?). Stop it, then run this again."
  exit 1
fi

before=$(ls logs/*.jsonl 2>/dev/null | wc -l)

echo "Starting the container..."
sudo docker compose up -d --build >/dev/null 2>&1 || fail "docker compose up"

# Wait up to 30 s for the server to answer.
for _ in $(seq 30); do
  curl -sf http://localhost:2567/api/lan >/dev/null && break
  sleep 1
done

if sudo docker compose logs 2>&1 | grep -q 'listening on 0.0.0.0:2567'; then
  pass "server started in the container"
else
  fail "server did not start; last log lines:"
  sudo docker compose logs --tail 15
fi

lan=$(curl -s http://localhost:2567/api/lan)
[[ "$lan" == *addresses* ]] && pass "/api/lan answers: $lan" || fail "/api/lan did not answer"

code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:2567/host)
[[ "$code" == 200 ]] && pass "host page answers 200" || fail "host page answered $code"

smoke=$(URL=http://127.0.0.1:2567 npx tsx tools/smoke-server.ts 2>&1)
[[ "$smoke" == *"running -> ended"* ]] && pass "full run from this laptop (lobby -> running -> ended)" \
  || { fail "full run did not end:"; echo "$smoke" | tail -5; }

lanip=$(hostname -I | awk '{print $1}')
host=$(npx tsx -e "import('@colyseus/sdk').then(({Client}) => new Client('http://$lanip:2567').create('hold',{role:'host'})).then(() => console.log('ALLOWED'), e => console.log('refused: ' + e.message)).finally(() => process.exit(0))" 2>&1)
[[ "$host" == *"only works on the host laptop"* ]] && pass "LAN address $lanip is not accepted as host ($host)" \
  || fail "LAN address $lanip: expected the not-host refusal, got: $host"

bot=$(URL=http://127.0.0.1:2567 npx tsx tools/host-bot-check.ts 2>&1)
[[ "$bot" == *"bot joined"* ]] && pass "Add bot works in the container ($bot)" \
  || { fail "Add bot did not work:"; echo "$bot" | tail -5; sudo docker compose logs --tail 15; }

after=$(ls logs/*.jsonl 2>/dev/null | wc -l)
newest=$(ls -t logs/*.jsonl 2>/dev/null | head -1)
if [[ "$after" -gt "$before" ]] && [[ "$(stat -c %u "$newest")" == "$(id -u)" ]]; then
  pass "match log written and owned by you: $newest"
else
  fail "no new match log owned by you in logs/"
fi

who=$(sudo docker compose exec -T crossfire id -un 2>&1)
[[ "$who" == node ]] && pass "container runs as user node" || fail "container user is: $who"

ro=$(sudo docker compose exec -T crossfire sh -c 'touch /app/x 2>&1')
[[ "$ro" == *"Read-only"* ]] && pass "root filesystem is read-only" || fail "root filesystem is writable"

sudo docker compose down >/dev/null 2>&1
echo
[[ $fails -eq 0 ]] && echo "All Docker checks passed." || echo "$fails check(s) failed."
exit $fails
