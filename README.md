# pi-tree-code-checkpoint

一个 Pi 扩展：使用 `/tree` 切换会话树节点时，可以选择：

1. **恢复代码到目标节点**
2. **保留当前代码**
3. **取消此次树导航**

扩展只追踪 Pi 内建 `edit` 和 `write` 工具造成的普通文件变化，不依赖 Git。

## 安装

### 从本地目录全局安装

```bash
pi install /absolute/path/to/pi-tree-code-checkpoint
```

该命令把本地包路径写入用户级 `~/.pi/agent/settings.json`。包仍从原目录加载，因此不要随意移动或删除原目录。

检查安装：

```bash
pi list
```

已运行的 Pi 需要执行：

```text
/reload
```

加载成功后，底部显示：

```text
tree code checkpoints on
```

也可以运行：

```text
/tree-checkpoint-status
```

### 从 Git 安装

```bash
pi install git:https://github.com/OWNER/pi-tree-code-checkpoint@v0.1.0
```

也支持：

```bash
pi install https://github.com/OWNER/pi-tree-code-checkpoint
```

### 从 npm 安装

发布到 npm 后：

```bash
pi install npm:pi-tree-code-checkpoint@0.1.0
```

如果 npm 包名已被占用，请发布为自己的 scope，例如：

```bash
pi install npm:@OWNER/pi-tree-code-checkpoint@0.1.0
```

> Pi 扩展拥有当前用户的完整系统权限。安装第三方版本前应审查源码。

## 使用方法

1. 让 Pi 使用 `edit` 或 `write` 修改项目内文件。
2. 执行 `/tree` 并选择旧节点。
3. 完成 Pi 原有的 branch summary 选择。
4. 在插件菜单中选择恢复、保留或取消。

选择用户消息时，Pi 会导航到该消息的父节点并把消息放回编辑器；插件按照该实际目标节点恢复文件。

## 工作原理

- 通过公开 API 覆盖同名 `edit`、`write` 工具，同时复用 Pi 官方工具实现和渲染器。
- 修改前镜像和完整后镜像都在 Pi 的文件 mutation queue 内准备。
- 后镜像对象先于项目文件持久化，再通过同目录临时文件与原子 rename 提交。
- 检查点元数据作为 session custom entry 写入会话树，因此天然跟随分支。
- 文件内容按 SHA-256 保存到当前工作项目：

  ```text
  .pi/tree-code-checkpoints/<session-id>/objects/
  ```

- 相同内容只保存一份；目录权限尽量设为 `0700`，对象文件为 `0600`。
- 重启同一项目和会话后，会从 session custom entry 重建文件状态。

## 安全策略

工具写入先持久化前、后镜像，再原子提交。如果 session mutation 元数据追加失败，则使用前镜像回滚。对象存储失败或输出超过 25 MiB 会发生在项目文件提交之前。

树恢复分两个阶段：

1. `session_before_tree`：计算目标状态，验证当前哈希、检查点对象和可写性。
2. `session_tree`：再次验证并提交恢复；失败时回滚本次已完成的文件操作。

检测到 Bash、外部编辑器或其他进程造成的内容/权限不匹配时，扩展停止并提示冲突，不强制覆盖。

若会话树已切换后恢复失败：

- 文件保持或回滚到切换前状态；
- UI 明确报错；
- 会话仍位于目标节点。

这是 Pi 公开 API 的限制：`session_tree` 通知中没有安全撤销树导航的接口。扩展没有调用私有 API 或 monkey patch Pi。

## 明确限制

当前版本不追踪或恢复：

- `bash`、`!`、`!!` 命令造成的文件变化，包括通过 `rm` 删除文件；
- 外部编辑器、其他进程、子代理或第三方工具的修改；
- `/fork`、`/clone`、`/resume` 的代码状态；
- 项目根目录以外的路径；
- 符号链接或经过符号链接目录的路径；
- 目录本身及空目录；恢复删除新建文件后，不自动清理父目录；
- 单个超过 25 MiB 的文件。

这与 Claude Code checkpoint 对 Bash 文件操作（包括 `rm`）不保证恢复的边界一致。

内建 `edit`、`write` 被设为顺序执行，以保证检查点条目和真实写入顺序一致，因此不同文件并行写入性能低于原生默认行为。

检查点包含源码的本地副本，可能含敏感内容。不要提交或分享 `.pi/tree-code-checkpoints/`。

完整设计及验证记录见 [`docs/feasibility-and-verification.md`](docs/feasibility-and-verification.md)。

## 开发与验证

要求 Node.js 22+：

```bash
npm install
npm run check
```

当前测试覆盖已有/新建文件恢复、连续修改、跨分支、会话重启、恢复/保留/取消、冲突、缺失对象、不可写、事务回滚、写入后元数据失败、符号链接和项目外路径保护。

验证发布包内容：

```bash
npm pack --dry-run
```

## 分享给其他人

### 推荐：GitHub + 版本标签

1. 把仓库推送到 GitHub。
2. 创建版本标签，例如 `v0.1.0`。
3. 让使用者执行：

   ```bash
   pi install git:https://github.com/OWNER/pi-tree-code-checkpoint@v0.1.0
   ```

4. 发布新版本时创建新标签，使用者安装新的 ref。固定 ref 不会被 `pi update --extensions` 自动移动到其他版本。

### npm

1. 确认 `package.json` 的包名唯一，推荐使用 scope。
2. 执行测试及包内容检查：

   ```bash
   npm run check
   npm pack --dry-run
   ```

3. 登录并发布：

   ```bash
   npm login
   npm publish --access public
   ```

4. 使用者执行：

   ```bash
   pi install npm:@OWNER/pi-tree-code-checkpoint@0.1.0
   ```

`package.json` 已包含 `pi-package` keyword、Pi extension manifest、发布文件白名单以及 Pi 核心包的 peer dependency。

## 更新与卸载

更新已安装的 npm/Git 包：

```bash
pi update --extensions
```

本地路径安装会直接读取原目录，修改源码后执行 `/reload` 即可。

卸载时使用 `pi list` 显示的 source：

```bash
pi remove /absolute/path/to/pi-tree-code-checkpoint
```

清理某个项目生成的检查点（会使该项目的历史代码恢复不可用）：

```bash
rm -rf .pi/tree-code-checkpoints
```
