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
compile(text("configure.py"), "configure.py", "exec")
for script in ("deploy.sh", "restage-host.sh", "restage-web.sh", "build-linux.sh", "activate.sh"):
    compile_embedded_python(script)
json.loads(text("rollback-compatibility.example.json"))

stage = text("deploy.sh")
prepare = text("build-linux.sh")
activate = text("activate.sh")
restage = text("restage-host.sh")
configure = text("configure.py")
office_dependencies = text("prepare-office-host.sh")
assert 'bash "$root/deploy/prepare-office-host.sh"' in activate
assert "--index-url https://pypi.org/simple python-pptx==1.0.2" in office_dependencies
assert "--system-site-packages /opt/zhenwork-office" in office_dependencies
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
assert "git diff --name-only --no-renames -z" in restage
assert "packages/web-host/src/*|AionUi-enterprise-poc/packages/web-cli/src/*" in restage
assert "packages/desktop" in restage and "full reviewed stage" in restage
assert "Host-only restage refused changed path" in restage and "*)" in restage
assert "packages/web-cli/src/enterprise-entry.ts" in restage and "build-web.mjs" not in restage
assert "artifactReusedFrom" in restage and "artifactReusedFrom" in prepare
assert "systemctl" not in restage and "sudo bash '$remote_root/deploy/activate.sh'" not in restage and "current.next" not in restage
assert "assert reuse['reusedArtifacts'] in (['admin','control-source','employee','rc2.jar'], ['admin','control-source','rc2.jar'], ['control-source','rc2.jar'], ['employee','web-host.cjs'])" in prepare
for source in (configure,activate):
    assert "shared/uploads" in source and "shared/config/uploads" in source
    assert "target.is_symlink() or not target.is_dir()" in source
    assert "link.resolve(strict=False)!=target.resolve(strict=True)" in source
    assert "link.symlink_to('../uploads',target_is_directory=True)" in source
    assert "os.lchown(link,0,0)" in source and "target.chmod(0o700)" in source
assert activate.index("shared/config/uploads") < activate.index("server-config-backup.service")

expected = {
    "0018_knowledge_office.sql": "7d5be1f4b8636f16bde988f0b2cfa0769345245b31eac9980eadfc1dba2d11c1",
    "0019_office_defaults.sql": "08ad472cb0fb5189fb1e7912f58695c55c1d2601fbc87f7695f4877def0316c1",
}
migrations = ROOT / "deepseek-harness-lab/workbuddy/migrations/rc2"
for name, digest in expected.items():
    path = migrations / name
    if path.exists():
        assert hashlib.sha256(path.read_bytes()).hexdigest() == digest, name

print("ZhenWork scoped deployment maintenance checks passed.")

web_restage = text("restage-web.sh")
assert "git archive" in web_restage and "build-web.mjs" in web_restage
assert "['control-source','rc2.jar']" in web_restage
assert 'packages/desktop/src/renderer/*' in web_restage
assert 'packages/desktop/src/common/chat/normalizeToolCall.ts)' in web_restage
assert 'full reviewed stage' in web_restage and '*)' in web_restage
assert 'systemctl' not in web_restage and 'current.next' not in web_restage

assert 'git diff --quiet "$base_sha" "$sha" -- AionUi-enterprise-poc deploy/tencent/build-web.mjs' in stage
assert "['employee','web-host.cjs']" in prepare and 'artifact_hash(after)==hashes[name]' in prepare
