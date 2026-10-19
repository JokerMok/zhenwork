# Third-party notices

Workbuddy is an internal repository codename. Third-party source and dependency provenance is recorded in `third-party-lock.json`; package versions and integrity are recorded in each package-lock.json.

R1 uses assistant-ui and Better Auth packages and selectively ports dashboard and tool-ui modules. Other entries remain research candidates. Candidate clones in `.research/` are not distributed. The following MIT notices are preserved in full for the R1 adoption/ports:

- assistant-ui — AgentbaseAI Inc. — `third-party/licenses/assistant-ui-MIT.txt`
- tool-ui — AgentbaseAI Inc. — `third-party/licenses/tool-ui-MIT.txt`
- Better Auth — Bekacru — `third-party/licenses/better-auth-MIT.txt`
- next-shadcn-dashboard-starter — Kiranism — `third-party/licenses/dashboard-MIT.txt`

Copied modules must add upstream file, original hash, destination file, modifications and final hash to the provenance lock. Package dependencies retain their packaged licenses and are included in release SBOM/license review.

Onyx EE paths and the restricted reference projects are excluded. No Onyx/RAGFlow/AnythingLLM/LibreChat/Tauri/Wails source has been ported at R0. Their licenses are not being used to sublicense any product code. Unknown or restricted entries are reference-only until a separate, exact-version review establishes permission.

Next.js 16.3.5 brings optional sharp/libvips native libraries under LGPL-3.0-or-later. No native code has been modified; the source-only local Spike does not distribute a product binary. Before image distribution, the release must include the relevant LGPL texts, notices, matching source and replacement/relinking instructions for the shipped platform libraries. This is a tracked P8 license obligation, not permission to strip native notices.

The production source skeleton reuses the same reviewed ports under `apps/web/src`; both original Spike and product paths are registered in `third-party-lock.json`. The root npm closure is regenerated from `package-lock.json`, including development tools. Lightning CSS platform packages are unmodified MPL-2.0 dependencies; distributed artifacts must retain their notices and source availability. LGPL-3.0-or-later obligations also cover optional Sharp Windows/Wasm packages if shipped. Only the actual shipped platform closure may be marked release-compliant in P8.

P5 adopts unmodified package dependencies: Busboy 1.6.0 and streamsearch 1.1.0 (Brian White, MIT), react-dropzone 20.1.2 (MIT), PDF.js/pdfjs-dist 6.3.289 (Apache-2.0), OfficeParser 8.0.0 (MIT), and yauzl 3.4.0 (MIT). License files for these direct dependencies and the two packages with missing npm license metadata are retained in `third-party/licenses/`. The parser runs as an isolated worker; it does not introduce another Agent runtime. OfficeParser's transitive PDF/OCR code remains in its package closure but is not enabled by this product. The full shipped dependency closure remains subject to the P8 artifact license gate.

P8 retains the unmodified DeepSeek Harness 0.1.6-alpha.2 core at ddefc45fbc7f8e46dd73185e68295696d1297887 under MIT, with its full notice at `third-party/licenses/deepseek-harness-MIT.txt`. Product adapters live outside the upstream tree. Harness remains the only active Agent runtime.

P8 native-image source materials and notices are recorded in `evidence/v1/p8/native-source-bundle.json`, `third-party/licenses/native/`, and `docs/v1/native-library-replacement.md`. The archive covers sharp/libvips native dependencies and librsvg Cargo sources; it is not a blanket compliance assertion for the entire OS/Harness image closure. Shipped-image SBOM, vulnerability and distribution gates must use the final image digest.

The final Runtime packaging excludes unused Claude Agent SDK, Codex CLI, CUA Driver and upstream LibreOffice Kit packages (including their platform binaries) before copying to the final image stage. The image-local exclusion manifest records exact removed package versions. No permission to redistribute proprietary packages is inferred from the MIT license of the surrounding Harness repository. Build caches and development images are not release artifacts.

## Caddy HTTPS Entry

Caddy v2.11.4, upstream commit `e2eee6a7fce366321294c9c2a79f3146891dcbdf`, is used as the unified reverse proxy under Apache-2.0. The standard module entry is rebuilt with Go 1.27.1 and pinned security fixes in its Go dependency graph. The upstream Caddy core is unmodified. The derived image upgrades OS packages and runs a capability-free binary on high ports. The exact build module files are included at `/usr/share/workspace-build` in the image. Full license: `third-party/licenses/caddy-Apache-2.0.txt`. Transitive binary dependencies remain part of the final image SBOM review.

## Runtime packaging security overlay

The pinned Harness source archive is retained unchanged. The product image replaces third-party `fast-uri`, `ip-address`, `js-yaml`, and `sharp` packages using the independent lock at `runtime/v1/security-dependencies/package-lock.json`. Exact versions, licenses, archive integrities and replacement records are included in `third-party-lock.json` and in the Runtime image under `/opt/harness/.workbuddy-security` and `/opt/harness/workbuddy-security-overlay.json`. Original package license files are retained in the installed modules. Sharp uses the same `@img/sharp-libvips` 1.3.3 source collection as the Web image.

## PostgreSQL image and gosu

The unmodified PostgreSQL 17.11 Alpine 3.24 image is selected from the official `docker-library/postgres` recipe at commit `2603e26e245e558218728ee14e0a42dcb020dc7f`. The index and separate ARM64/AMD64 manifest digests are recorded in `third-party-lock.json`. The container recipe MIT notice and database PostgreSQL License are retained in `third-party/licenses/postgres-container-MIT.txt` and `third-party/licenses/postgresql.txt`. The bundled gosu 1.19 binary retains its Apache-2.0 notice in `third-party/licenses/gosu-Apache-2.0.txt`. These notices do not replace the licenses or source-distribution obligations of the system packages bundled in the images.
