# 开发快照原生依赖需求

## 目标与范围

`pnpm dev:install` 必须生成可独立运行的开发快照，使 `daynight-dev controller codex` 在加载生产原生依赖后进入正常 Controller 生命周期。安装成功不能仅表示 `--version` 或 `--build-info` 可用。

范围限于仓库维护的开发安装器、依赖复制及发布前验证。支持 Node.js 24 上的 Linux 和 macOS；Windows 开发安装与 Agent CLI alias 支持不在本范围内。不得改变 npm 发布包、稳定 `daynight` 和 `dn` 的命令归属、Provider 账号或系统动态库配置。安装命令及快照生命周期由[开发指南](../development.md#local-development-cli-channel)说明。

## 独立依赖闭包

快照必须保留每个源物理包的身份、包名和解析作用域。每个解析实体使用独立的 `.dev-store/<序号>/node_modules/<包名>/` 目录，在所属作用域中连接源环境实际解析到的 `dependencies`、`optionalDependencies` 与 peers。同一物理包可以去重；不同版本或不同 peer 解析实体不得合并为一个共享具名包。

包的物理位置及依赖链接必须满足原生模块的相对动态库查找。例如 `@img/sharp-linux-x64` 必须能通过其 RPATH 查找到具名的 `sharp-libvips-linux-x64` 依赖，不能只保证 JavaScript 的模块解析成功。

所有依赖链接必须落在快照内部，包内源文件符号链接必须复制为独立内容。源 `node_modules` 后续修改或在受控测试中不可访问时，已安装快照仍须保持原有行为。循环依赖、scoped packages、别名及同名不同版本依赖不得导致覆盖或解析串用。缺失必需依赖仍须失败；缺失可选依赖及显式可选 peer 沿用原有允许规则。

## 发布前验证与失败行为

替换开发入口前，安装器必须检查版本，并使用快照固定的 Node 可执行文件分别启动有时限的独立进程，执行以下真实操作：

- sharp 处理内存生成的极小图片并产生图片输出。
- better-sqlite3 打开内存数据库、执行查询并验证结果，随后关闭数据库。
- Koffi 完成最小模块加载。

各进程必须从快照解析模块，不能依赖先前进程已加载的源动态库。验证不得要求设置 `LD_LIBRARY_PATH`、修改系统动态库查找路径或补装全局 libvips；验证进程必须排除 `LD_LIBRARY_PATH`、`DYLD_LIBRARY_PATH` 和 `DYLD_FALLBACK_LIBRARY_PATH` 对依赖可达性的补救。

任一原生验证失败或超时，安装必须明确失败，诊断指出快照依赖验证失败及对应模块名称。失败不得替换现有开发入口，旧入口和旧快照须继续可用。全部准备和验证成功后才能原子替换入口；仍被执行使用的旧快照不得因新安装而删除。

快照必须继续记录源 checkout、commit、dirty 状态、版本、构建时间、固定 Node 路径与快照路径。更新开发入口不能改变已运行进程所使用的快照或 Node 身份。

## 验收

| 范围 | 必须观察的结果 |
|---|---|
| Linux 原生依赖 | 在 Linux x64、Node.js 24 的 clean checkout 中通过维护安装生成真实依赖快照；新进程无 `LD_LIBRARY_PATH` 补救即可完成 sharp 图片处理、SQLite 查询和 Koffi 加载。 |
| 闭包独立性 | 在自有临时安装中使旧源码依赖目录不可访问，快照仍可运行；逐一确认依赖链接均指向快照内部。不得删除共享源码依赖或停止其他用户执行来构造条件。 |
| 解析隔离 | 回归覆盖不同版本、scoped packages、optional dependencies、peers、别名及循环依赖，证明各调用者使用自身解析结果。 |
| 发布失败 | 模拟快照原生模块无法加载，确认安装失败、诊断包含模块名，现有开发入口保持原目标且旧快照仍可运行。 |
| Controller 生命周期 | 使用正常本地测试身份与现有 Provider，通过 `daynight-dev controller codex` 启动至 `Provider ready`，完成一次有限对话并取得实际回复，随后正常停止且完成归档。不得保留动态库环境变量补救。 |
| 维护回归 | 执行 `pnpm dev:test`；macOS 支持路径执行适用的维护安装回归。Linux 结果不能代替 macOS 结果，未执行的平台须明确列为未验证。 |

原生模块探测、版本检查与 Controller 生命周期分别提供不同证据。只有覆盖以上适用要求的实际结果才能证明完成；缺少的环境或平台验证必须如实保留，不得用安装器单元测试替代真实原生加载或 Provider 对话。
