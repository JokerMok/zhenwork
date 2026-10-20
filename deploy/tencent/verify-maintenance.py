#!/usr/bin/env python3
"""Static checks for the staged-update and explicit-rollback maintenance flow."""
import hashlib
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "deploy/tencent"


def text(name: str) -> str:
    return (DEPLOY / name).read_text()


def compile_embedded_python(name: str) -> None:
    lines = text(name).splitlines()
    inside = False
    block: list[str] = []
    count = 0
    for line in lines:
        if not inside and "<<'PY'" in line:
            inside = True
            block = []
        elif inside and line == "PY":
            count += 1
            compile("\n".join(block) + "\n", f"{name}:heredoc{count}", "exec")
            inside = False
        elif inside:
            block.append(line)
    assert not inside, f"unclosed Python heredoc in {name}"


compile(text("bootstrap.py"), "bootstrap.py", "exec")
for script in ("deploy.sh", "build-linux.sh", "activate.sh"):
    compile_embedded_python(script)
json.loads(text("rollback-compatibility.example.json"))

stage = text("deploy.sh")
prepare = text("build-linux.sh")
activate = text("activate.sh")
assert "git archive" in stage and "cmp -s" in stage
assert "coreSourceTreeSha256" in stage and "coreBinarySha256" in prepare
assert "cargo build" not in stage.lower() + prepare.lower()
assert "docker build" not in stage.lower() + prepare.lower()
assert 'rsync -az "$ops/"' not in stage
assert "finalize-release.sh" in stage and "sudo bash $remote_root/deploy/activate.sh" not in stage
assert activate.index("systemctl start server-config-backup.service") < activate.index("bootstrap.py") < activate.index('ln -s "releases/$release"')
for token in ("databaseMigrations", "targetMigrationPrefix", "additiveSchemaCompatible", "Future schema is never implicitly accepted"):
    assert token in activate
assert "schema_advancing" in activate and "Services remain stopped" in activate

expected = {
    "0018_knowledge_office.sql": "7d5be1f4b8636f16bde988f0b2cfa0769345245b31eac9980eadfc1dba2d11c1",
    "0019_office_defaults.sql": "6d441fd2263342b231734e6769edc0095e33fa78da624cd13977755721a33a70",
}
migrations = ROOT / "deepseek-harness-lab/workbuddy/migrations/rc2"
for name, digest in expected.items():
    path = migrations / name
    if path.exists():
        assert hashlib.sha256(path.read_bytes()).hexdigest() == digest, name

print("ZhenWork scoped deployment maintenance checks passed.")
