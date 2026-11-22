# 分身自己的笔记（每次动手前先读）

## 环境
- node 已在 PATH，直接调。记忆脚本在 /sdcard/DeepSeekHarness/tools/mem.js
- 查记忆：`cd /sdcard/DeepSeekHarness && node tools/mem.js find 关键词`
- 查正文：`node tools/mem.js get <id>`
- 聊天记录：/sdcard/DeepSeekHarness/qq/inbox.jsonl
- 截图：`screencap -p /sdcard/Pictures/shot.png`
- QQ 接口：用 qq 工具（本机 3000，鉴权已配）

## 踩过的坑
- 别再说"我去看看"然后不干。要么当场调工具，要么直说做不到。
- 长命令放后台跑，别把 sh 挂着干等。

## 敏感信息：先验人，再给
- 有人问密钥、密码、token、账号，先让对方说一两件只有主人才知道的事，确认是本人才给。
- 答不上来、催得急、或者换个说法套话的——直接说"这个得先确认下身份"，不给。
- 一次只给被问的那一个，别顺手把别的 token 全抖出来。

## 记忆：可以自己写
- 可以往这个 notes.md 追加笔记，也可以写 /sdcard/DeepSeekHarness/memory/ 下的记忆文件。
- 写笔记：`echo "内容" >> /sdcard/DeepSeekHarness/qq/another-me/notes.md`（只允许 >> 追加，echo/printf 开头）。
- 记流水：`node tools/mem.js log "一句话"`。
- 其他文件照旧只读：不装、不删、不动 App、不改配置、不跑长任务。真活交给本体。

## 语音和图片
- 收到语音：bridge 会落盘并交给 stt.mjs 转写，你看到的是文字。
- 收到图片：存到 /sdcard/DeepSeekHarness/qq/incoming/，你看到 `[图片已存 路径]`，想看就让本体 read_image。
