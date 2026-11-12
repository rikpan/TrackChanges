# Track Changes

在 VS Code 中仿照 Visual Studio 的 **Track Changes**（跟踪更改）功能：在编辑器左侧行号旁显示一条彩色竖条，标出本次打开文件以来修改过的行。

| 颜色 | 含义 |
| --- | --- |
| 🟨 黄色 | 已修改，尚未保存 |
| 🟩 绿色 | 已修改，并且已保存 |
| 🟦 蓝色斜纹 | 修改已保存，之后又用撤销（Ctrl+Z）撤回了 |

与 Visual Studio 一样，标记来自**编辑操作和撤销历史**，而不是比较文件内容（与 Git 无关）：

- 每次编辑都会标记它碰到的行。输入一个字符再用 Backspace 删掉，内容虽然没变，这一行仍然是黄色。
- 按回车会标记光标原来所在的行和新产生的行（两行）。
- 撤销会恢复编辑之前的标记：按回车再 Ctrl+Z，什么都不留下。
- 撤销**已保存**的修改，该行显示蓝色斜纹；再保存后恢复为这次修改之前的标记（例如：回车 → 保存 → Ctrl+Z → 保存，最后什么标记都没有）。重做（Ctrl+Y）恢复成绿色。
- 每次打开文件都从零开始，关闭文件后记录清空。

## 命令

| 命令 | 说明 | 快捷键 |
| --- | --- | --- |
| `Track Changes: Toggle Track Changes` | 开/关显示 | |
| `Track Changes: Reset Tracking for Current File` | 清除当前文件的所有标记，相当于重新打开 | |
| `Track Changes: Reset Tracking for All Files` | 对所有打开的文件执行上述操作 | |
| `Track Changes: Go to Next Change` | 跳到下一处修改 | `Ctrl+Alt+↓` / `Cmd+Alt+↓` |
| `Track Changes: Go to Previous Change` | 跳到上一处修改 | `Ctrl+Alt+↑` / `Cmd+Alt+↑` |

## 设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `trackChanges.enabled` | `true` | 是否显示标记 |
| `trackChanges.unsavedColor` | `#EFD700` | 未保存修改的颜色 |
| `trackChanges.savedColor` | `#57A64A` | 已保存修改的颜色 |
| `trackChanges.revertedColor` | `#3E8FD8` | 已保存后又撤销的修改（斜纹）的颜色 |
| `trackChanges.showInOverviewRuler` | `true` | 同时在滚动条概览中显示 |
| `trackChanges.maxFileLines` | `100000` | 超过此行数的文件不跟踪 |
| `trackChanges.debounceMs` | `150` | 输入停止后多久刷新标记（毫秒） |

## 说明

- 标记画在 gutter 图标位置。如果同时启用了 VS Code 自带的 Git 修改标记（`scm.diffDecorations`），两者会并排显示；不想重复可以把它设为 `"overview"` 或 `"none"`。
- 插件启动之前就已有的撤销历史无法对应，撤销这些修改时按普通编辑显示为黄色。
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
