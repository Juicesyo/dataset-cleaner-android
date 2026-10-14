# 数据集人工清理 (Dataset Cleaner)

手机上清理 ShareGPT 格式对话数据集的 Android 应用。支持导入多个数据集文件或整个目录、逐轮人工编辑（改动实时彩色高亮）、以及通过自定义 OpenAI 兼容接口批量改写。

## 功能

**导入**
- 文件多选（`.json` 单条 / `.jsonl` `.ndjson` 多条），或选择目录递归导入
- 格式自动识别；无法解析的数据行会被跳过并给出带行号的警告，不影响其余数据
- 字段容错：`from`/`value` 之外，也接受 `role`/`content` 等常见变体

**编辑**
- 逐轮编辑，编辑框随内容自动增高，适配手机
- **实时彩色 diff**：新增文字绿底、删除文字红底并带删除线，字符级对齐
- 轮次操作全部使用文字标签：`AI 改写` / `关闭高亮` / `还原本轮` / `＋ 插入轮次` / `删除轮次`
- 复制样本、软删除样本（可恢复）；工具栏的 `还原全部` 回到刚导入的状态
- 撤销 / 重做（Ctrl+Z / Ctrl+Y），连续输入自动合并为一步
- 搜索筛选（全文 / 角色 / 仅已修改 / 按源行号）、分页浏览

**AI 修改**
- **单轮改写**：每个轮次旁的 `AI 改写` 只把这一轮发给模型，改完可用「撤销」回退
- **批量修改**：主界面「用 AI 批量修改」面板内直接选择范围与轮次类型，
  并实时显示会处理多少条样本、多少个轮次、约发出多少次请求
- **模型列表**：设置里「获取列表」会请求 `/models`，点击即可选用；也可手动输入
- **模型类型**：可选「普通模型 / 思考模型（推理模型）」。普通模型完全不做思考内容处理；
  从模型列表里选择推理模型（R1、QwQ、o 系列等）时会自动切换并说明
- **思考模型支持**：可自定义思考标签（默认 `<think>` … `</think>`）与剥离方式。
  推理模型的思考过程会在写回前被剥离；**数据集本身含思维链时不会被误删**
- 自定义 Base URL、API Key、temperature、max_tokens、附加请求体
- 自定义系统提示词，可一键恢复默认
- 范围可选：当前筛选结果 / 仅已手动改动 / 仅勾选；可只改 `gpt`、只改 `human` 或两者；并发可调
- 逐项独立容错：单条失败不中断整批，失败原因可点击跳转到对应行
- **拒绝写入被截断的结果**：命中 `max_tokens` 上限时会报错跳过，
  而不是把变短的文本写进数据集

**保存**
- `保存` 一键写入上次使用的目录，`另存为` 可改文件名与位置
- **导入的原始文件永远不会被修改**：导出始终写到新文件，且文件名与任何导入文件
  同名时会直接拦截并给出建议名（原生写入会覆盖同名文件）
- `_input_fingerprint` 与其他未知顶层字段原样保留，键顺序与原始一致
- 可另存改动记录（diff 报告），含新增/移除轮次与角色变更，便于复核

## 数据结构

```json
{
  "conversations": [
    { "from": "human", "value": "" },
    { "from": "gpt", "value": "" }
  ],
  "_input_fingerprint": ""
}
```

`_input_fingerprint` 被视为不透明字段，读写全程原样保留，不会重新生成。

## 构建 APK

推送到 `main` 分支，或手动触发 **Build Android APK** workflow，构建完成后在 Actions 页面的 Artifacts 中下载 `dataset-cleaner-debug-apk`。

本机构建需要 Android SDK 与 JDK 17：

```bash
npm install
npm run build
npx cap add android
npx cap sync android
npm run android:apk
```

## 本地开发

```bash
npm install
npm run dev            # 局域网可访问，手机浏览器也能打开调试
npm run typecheck      # TypeScript 类型检查
npm run verify         # 数据层：解析 / 往返 / fingerprint / diff / 思考标签 (113 项)
npm run verify:ui      # 浏览器端真实交互：导入、编辑、撤销、还原、保存、模型选择 (76 项)
npm run verify:layout  # 移动端布局、编辑框自适应与溢出、diff 对比度 (22 项)
npm run build          # 产出 dist/
```

首次运行 UI 测试需要安装浏览器：`npx playwright install chromium`。

浏览器环境下同样可用，只是导出走浏览器下载而非指定目录。

## 项目结构

```
src/
  App.tsx                      应用外壳
  types.ts                     领域模型
  styles.css                   样式（含 diff 配色与移动端布局）
  components/
    AutoGrowTextarea.tsx       随内容自增高的输入框
    DiffHighlight.tsx          彩色 diff 图层
    TurnEditor.tsx             单轮编辑器
    SampleCard.tsx             单条样本卡片
    Toolbar.tsx / SearchBar.tsx / BatchPanel.tsx / SettingsDrawer.tsx
  lib/
    sharegpt.ts                解析与序列化
    diff.ts                    字符级 diff
    llm.ts                     OpenAI 兼容客户端与批量并发
    useDatasets.ts             状态与撤销栈
    useBatch.ts                批量改写编排
    fs/                        文件后端（原生 SAF / 浏览器）
android-plugin/SafPlugin.java  Android 原生 SAF 插件
scripts/verify.ts              数据层验证
scripts/ui-check.ts            端到端交互验证
scripts/layout-check.ts        布局与配色验证
```

## 实现要点

**彩色高亮怎么做的**：编辑框是一个真实的 `<textarea>`，背景透明；正后方对齐放置一个
`<pre>` 图层绘制彩色 diff 文本（新增绿底、删除红底带删除线）。两个图层共用同一套字体、
内边距和边框度量，所以彩色文字与光标始终对齐。这样保留了原生输入体验（光标、选区、中文
输入法、软键盘行为），是 `contenteditable` 方案做不到的。

**为什么需要原生插件**：Capacitor 内置的 Filesystem 只能访问应用自身沙箱，无法读取用户
自己的数据集目录。`SafPlugin` 走 Storage Access Framework，因此**清单里不需要任何存储
权限**，在 Android 10+ 的分区存储下也能正常读写。

**改动基线**：diff 对比的是**导入时**的原始值，而不是上一次编辑后的值，所以整个清理过程中
看到的始终是相对原始数据的总改动。撤销/重做是独立的栈，连续输入会自动合并为一步。

## 已知限制

- 数据全部保存在内存中；数十万条以上的数据集建议分批处理。
- Android 端验证覆盖数据层与布局；APK 为调试签名，正式分发需自行配置签名。
- 浏览器端无法真正“写入指定目录”，只能下载文件；完整目录读写需要 APK。
- LLM 批量修改是逐轮调用，条数很多时耗时与费用随轮次数线性增长。
