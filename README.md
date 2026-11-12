# Track Changes

在 VS Code 中仿照 Visual Studio 的 **Track Changes**（跟踪更改）功能：在编辑器左侧行号旁显示一条彩色竖条，标出本次打开文件以来修改过的行。

| 颜色 | 含义 |
| --- | --- |
| 🟨 黄色 | 已修改，尚未保存 |
| 🟩 绿色 | 已修改，并且已保存 |
| 🟧 橙色 | 保存后又改回了打开时的原始内容（例如保存后撤销） |

与 Visual Studio 一样，跟踪以**文件打开时的内容**为基准，与 Git 无关；关闭文件后记录清空。

## 命令

| 命令 | 说明 | 快捷键 |
| --- | --- | --- |
| `Track Changes: Toggle Track Changes` | 开/关显示 | |
| `Track Changes: Reset Tracking for Current File` | 以磁盘上的当前版本作为新基准，清除绿色/橙色标记 | |
| `Track Changes: Reset Tracking for All Files` | 对所有打开的文件执行上述操作 | |
| `Track Changes: Go to Next Change` | 跳到下一处修改 | `Ctrl+Alt+↓` / `Cmd+Alt+↓` |
| `Track Changes: Go to Previous Change` | 跳到上一处修改 | `Ctrl+Alt+↑` / `Cmd+Alt+↑` |

## 设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `trackChanges.enabled` | `true` | 是否显示标记 |
| `trackChanges.unsavedColor` | `#EFD700` | 未保存修改的颜色 |
| `trackChanges.savedColor` | `#57A64A` | 已保存修改的颜色 |
| `trackChanges.revertedColor` | `#F2A33A` | 已还原修改的颜色 |
| `trackChanges.showInOverviewRuler` | `true` | 同时在滚动条概览中显示 |
| `trackChanges.maxFileLines` | `100000` | 超过此行数的文件不跟踪 |
| `trackChanges.debounceMs` | `150` | 输入停止后多久刷新标记（毫秒） |

## 说明

- 标记画在 gutter 图标位置。如果同时启用了 VS Code 自带的 Git 修改标记（`scm.diffDecorations`），两者会并排显示；不想重复可以把它设为 `"overview"` 或 `"none"`。
- 如果打开文件时它已有未保存的修改（例如重启后恢复的编辑），基准取磁盘上的内容，这些修改显示为黄色。
- 删除行时，标记落在删除位置的下一行（与 Visual Studio 一致）。

## 开发

```bash
npm install
npm test          # 编译并运行单元测试
```

在 VS Code 中打开本目录，按 `F5` 启动扩展开发宿主进行调试。打包：

```bash
npx @vscode/vsce package
```
