#!/usr/bin/env python3
"""Prepare private monitor/edge configuration without rotating existing secrets."""
import json
import os
import pathlib
import secrets
import stat

ROOT = pathlib.Path('/srv/apps/zhenwork')
CONFIG = ROOT / 'shared/config'
os.umask(0o077)


def atomic(name: str, value: str) -> None:
    target = CONFIG / name
    temporary = target.with_suffix(target.suffix + '.next')
    previous = target.stat() if target.exists() else None
    temporary.write_text(value)
    if previous:
        os.chown(temporary, previous.st_uid, previous.st_gid)
        temporary.chmod(stat.S_IMODE(previous.st_mode))
    else:
        temporary.chmod(0o600)
    temporary.replace(target)


def persistent_secret(name: str) -> str:
    target = CONFIG / name
    if not target.exists():
        atomic(name, secrets.token_urlsafe(48))
    value = target.read_text().strip()
    if not value:
        raise RuntimeError(f'{name} is empty')
    return value


pilot = json.loads((CONFIG / 'pilot-credentials.json').read_text())
application_path = CONFIG / 'application-rc2.yml'
application = json.loads(application_path.read_text())
monitor_password = persistent_secret('monitor-password')
edge_token = persistent_secret('edge-token')
monitor_proxy_token = persistent_secret('monitor-proxy-token')

spring = application.setdefault('spring', {})
spring.setdefault('boot', {}).setdefault('admin', {})['client'] = {
    'enabled': True,
    'url': 'http://127.0.0.1:18909/monitor',
    'username': 'ruoyi',
    'password': monitor_password,
    'connect-timeout': '3s',
    'read-timeout': '5s',
    'instance': {
        'name': 'ZhenWork RC2',
        'service-url': 'http://127.0.0.1:18890',
        'management-url': 'http://127.0.0.1:18890/actuator',
        'metadata': {
            'user.name': 'ruoyi',
            'user.password': monitor_password,
            'tags.environment': 'production',
        },
    },
}
application['management'] = {
    'endpoints': {'web': {'exposure': {'include': 'health,info,metrics'}}},
    'endpoint': {'health': {'show-details': 'always'}},
}
atomic('application-rc2.yml', json.dumps(application, indent=2) + '\n')
atomic('monitor.env', (
    'ZHENWORK_MONITOR_ADDRESS=127.0.0.1\n'
    'ZHENWORK_MONITOR_PORT=18909\n'
    'ZHENWORK_MONITOR_CONTEXT_PATH=/monitor\n'
    'ZHENWORK_MONITOR_UI_PUBLIC_URL=https://zhenwork-admin.shizibandu.icu/monitor/\n'
    'ZHENWORK_MONITOR_PUBLIC_URL=http://127.0.0.1:18909/monitor\n'
    f'ZHENWORK_SPRING_SECURITY_USER_PASSWORD={monitor_password}\n'
    f'ZHENWORK_SPRING_BOOT_ADMIN_CLIENT_PASSWORD={monitor_password}\n'
))
atomic('edge.env', f'ZHENWORK_EDGE_TOKEN={edge_token}\nZHENWORK_CLIENT_ID={pilot["clientId"]}\n')
atomic('monitor-proxy.env', f'ZHENWORK_MONITOR_PROXY_TOKEN={monitor_proxy_token}\n')
