# 原生图像库源码与替换说明

本包针对 Sharp 0.35.4、sharp-libvips 1.3.3、libvips 8.18.6。版本来自实际 Linux ARM64 Web 镜像内的 `sharp.versions`；最终 ARM64 与 AMD64 Web/Runtime 均已完成加载与 PNG 转换验证；对应记录为 `web-{arch}-native-final.json` 与 `runtime-{arch}-final-smoke.json`。库保持上游原样，产品没有修改其原生源码。

`native-source-downloads.json` 记录 35 份上游源码、补丁和构建资料的下载位置与 SHA256；`rsvg-crates.json` 记录 librsvg Cargo.lock 中 350 个注册表依赖及经锁文件校验的归档。`build/` 保存上游构建脚本、版本表和 Cargo.lock；`licenses/` 保留归档内许可原文。Fontconfig 使用上游官方发布包替代被拒绝访问的 GitLab tag 归档，记录实际来源；GLib 补丁由固定 revision 的 Gist API 获取。

可以在解包后修改这些库，并按 sharp-libvips 1.3.3 归档内的 build.sh、build/posix.sh 和平台 Dockerfile 重建。librsvg 的 crates 可从随附归档生成 Cargo vendor 目录，必须保持 Cargo.lock 校验值。完整构建还需要对应平台的编译工具链和系统依赖，本轮没有执行从这些源码完整重建 libvips 的验证。

Web 镜像以动态方式加载 Sharp 及平台 libvips 包。替换时先使用 `docker scout sbom IMAGE` 或镜像内 `find /app -path '*sharp*'` 确认路径；在衍生镜像中用同架构、兼容 ABI 的重建库替换平台库，或按 Sharp 官方源码构建方法让 Sharp 链接修改后的系统 libvips。保留库与绑定之间的 ABI 匹配，执行 `node -e 'const s=require("sharp"); console.log(s.versions); s({create:{width:2,height:2,channels:4,background:"red"}}).png().toBuffer().then(b=>console.log(b.length))'` 验证加载和转换，再运行实际文件上传预览。产品不禁止为调试这些修改而进行 LGPL 允许的逆向工程。

上游构建依据：[sharp-libvips 1.3.3](https://github.com/lovell/sharp-libvips/tree/v1.3.3)、[Sharp 安装和源码构建](https://sharp.pixelplumbing.com/install/)。LGPL/GPL/Mozilla 等许可要求以随附许可全文为准。这个源码包只覆盖原生图像库及其构建依赖，不代表整个 Runtime、系统镜像及所有第三方依赖已经完成分发许可验收。
