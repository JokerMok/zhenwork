#!/bin/bash
set -euo pipefail
[[ $# == 1 ]] || exit 2
umask 077
root=/srv/apps/zhenwork
out="$1/zhenwork"
mkdir -p "$out"
# Do not interrupt an employee Core, including a still-idle Core awaiting recycling.
root_key=$(printf '%s' "$root/shared/profiles" | sha256sum | cut -c1-20)
if [[ -n $(docker ps -q --filter label=aionui.enterprise=1 --filter "label=aionui.root=$root_key" --filter name=-core) ]]; then
    echo 'ZhenWork backup deferred: employee Core still running; existing backups retained.' >&2
    exit 1
fi
web=0; rc2=0; monitor=0; monitor_unit=0
systemctl is-active --quiet zhenwork-web && web=1
systemctl is-active --quiet zhenwork-rc2 && rc2=1
systemctl cat zhenwork-monitor.service >/dev/null 2>&1 && monitor_unit=1
if [[ $monitor_unit == 1 ]]; then systemctl is-active --quiet zhenwork-monitor && monitor=1; fi
restore_services() {
    if [[ $rc2 == 1 ]]; then systemctl start zhenwork-rc2; fi
    if [[ $monitor == 1 || $web == 1 ]]; then
        for _ in $(seq 1 90); do
            if curl -fsS --max-time 2 http://127.0.0.1:18890/ai/bootstrap >/dev/null 2>&1; then break; fi
            sleep 1
        done
    fi
    if [[ $monitor == 1 ]]; then systemctl start zhenwork-monitor; fi
    if [[ $web == 1 ]]; then systemctl start zhenwork-web; fi
}
trap restore_services EXIT
systemctl stop zhenwork-web
if [[ $monitor_unit == 1 ]]; then systemctl stop zhenwork-monitor; fi
systemctl stop zhenwork-rc2
# App writers are quiesced. PostgreSQL native dump remains consistent independently.
dc=(docker compose -p zhenwork -f "$root/compose.yaml" --env-file "$root/.env")
"${dc[@]}" exec -T db pg_dump -U workspace_rc2 -d workspace_rc2 -Fc > "$out/rc2.dump"
"${dc[@]}" exec -T db psql -X -U workspace_rc2 -d workspace_rc2 -At -c "SELECT json_build_object('users',(SELECT count(*) FROM sys_user),'models',(SELECT count(*) FROM ai_model),'migrations',(SELECT count(*) FROM ai_schema_migrations));" > "$out/counts.json"
tar --anchored --no-wildcards-match-slash --exclude='./config' --exclude='./data' --exclude='./logs' --exclude='./monitor.jar' --exclude='./profiles/profiles/*/*/cache' --exclude='./profiles/profiles/*/*/logs' --exclude='./profiles/profiles/*/*/runtime/node' --exclude='./profiles/profiles/*/*/runtime-temp/node-compile-cache' -czf "$out/shared.tar.gz" -C "$root/shared" .
tar -czf "$out/deploy.tar.gz" -C "$root" deploy
mkdir -p "$out/units"
cp /etc/systemd/system/zhenwork-{infra,rc2,web}.service "$out/units/"
if [[ $monitor_unit == 1 ]]; then cp /etc/systemd/system/zhenwork-monitor.service "$out/units/"; fi
grep '# zhenwork local HTTPS routing' /etc/hosts > "$out/hosts-snippet.txt"
(cd "$out" && sha256sum rc2.dump shared.tar.gz counts.json > SHA256SUMS)
echo 'ZhenWork native database dump and quiesced profile/upload snapshot completed.'
