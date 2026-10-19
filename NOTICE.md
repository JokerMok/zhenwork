# License and source notices

ZhenWork is a source aggregation and enterprise integration project. It is not affiliated with Tencent WorkBuddy.

| Component | Upstream | Existing license |
| --- | --- | --- |
| AionUi-derived workspace | https://github.com/iOfficeAI/AionUi | Apache-2.0; see `AionUi-enterprise-poc/LICENSE` and file headers |
| AionCore | https://github.com/iOfficeAI/AionCore | Apache-2.0; see `AionUi-enterprise-poc/upstream-core/LICENSE` |
| aionrs | https://github.com/iOfficeAI/aionrs | Apache-2.0; see `AionUi-enterprise-poc/upstream-aionrs/LICENSE` |
| RuoYi-Vue-Plus | https://github.com/dromara/RuoYi-Vue-Plus | MIT; see `deepseek-harness-lab/workbuddy/platform/ruoyi/LICENSE` |
| plus-ui | https://github.com/CrazyLionCat/plus-ui | MIT; see `deepseek-harness-lab/workbuddy/platform/plus-ui/LICENSE` |
| Legacy Harness integration | https://github.com/deepseek-ai/deepseek-harness | See the pinned source reference and `deepseek-harness-lab/workbuddy/third-party/licenses/deepseek-harness-MIT.txt` |

The AionUi-derived workspace and Rust snapshots contain local enterprise integration changes. Patch files and pinned upstream commits are retained. Public-export changes include product packaging identity, anonymized examples, environment-based credential configuration and support for the included prepared source snapshots.

Additional third-party notices are preserved in `deepseek-harness-lab/workbuddy/THIRD_PARTY_NOTICES.md`, `third-party/licenses/`, and component source files. Dependency licenses remain subject to the actual source or binary distribution. A root-level blanket license is not added for previously unlicensed original integration code; public visibility alone does not grant an additional license.
