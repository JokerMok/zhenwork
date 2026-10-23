#!/bin/bash
set -euo pipefail
root=/srv/apps/zhenwork
dc=(docker compose -p zhenwork -f "$root/compose.yaml" --env-file "$root/.env")
ready_rc2() {
  for _ in $(seq 1 90); do
    if curl -fsS --max-time 2 http://127.0.0.1:18890/ai/bootstrap >/dev/null 2>&1; then return; fi
    sleep 1
  done
  echo 'RC2 readiness timeout' >&2; return 1
}
ready_host() {
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 2 -H "Host: zhenwork.shizibandu.icu" http://127.0.0.1:18891/enterprise/login >/dev/null 2>&1; then return; fi
    sleep 1
  done
  echo 'Web Host readiness timeout' >&2; return 1
}
monitor_available() {
  systemctl cat zhenwork-monitor.service >/dev/null 2>&1 &&
    [[ -f "$root/current/monitor.jar" && -f "$root/shared/config/monitor.env" && -f "$root/shared/config/monitor-proxy.env" ]]
}
ready_monitor() {
  set -a; source "$root/shared/config/monitor.env"; set +a
  for _ in $(seq 1 45); do
    if curl -fsS --max-time 2 -u "ruoyi:$ZHENWORK_SPRING_SECURITY_USER_PASSWORD" http://127.0.0.1:18909/actuator/health >/dev/null 2>&1; then return; fi
    sleep 1
  done
  echo 'Monitor readiness timeout' >&2; return 1
}
case "${1:-status}" in
 status)
   units=(zhenwork-rc2 zhenwork-web); monitor_available && units+=(zhenwork-monitor)
   systemctl --no-pager status "${units[@]}"; "${dc[@]}" ps ;;
 logs)
   units=(-u zhenwork-rc2 -u zhenwork-web); monitor_available && units+=(-u zhenwork-monitor)
   journalctl "${units[@]}" -n "${2:-100}" --no-pager ;;
 restart)
   "${dc[@]}" up -d --wait db redis bridge-anchor
   systemctl restart zhenwork-rc2; ready_rc2
   if monitor_available; then
     systemctl restart zhenwork-monitor; ready_monitor
   else
     systemctl stop zhenwork-monitor 2>/dev/null || true
   fi
   systemctl restart zhenwork-web; ready_host ;;
 backup) systemctl start server-config-backup.service; journalctl -u server-config-backup.service -n 8 --no-pager ;;
 update) exec bash "$root/deploy/activate.sh" "${2:?release ID required}" ;;
 rollback)
   [[ -L "$root/previous" ]] || { echo 'First deployment: no previous verified release exists.' >&2; exit 1; }
   target=$(basename "$(readlink -f "$root/previous")")
   review=${2:?rollback requires /srv/apps/zhenwork/shared/config/rollback-reviews/REVIEW.json}
   exec bash "$root/deploy/activate.sh" "$target" --rollback "$review" ;;
 *) echo 'Usage: manage.sh status|logs [lines]|restart|backup|update RELEASE|rollback REVIEW.json' >&2; exit 2 ;;
esac
