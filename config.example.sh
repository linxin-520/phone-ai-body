#!/system/bin/sh
# 手机跑 NapCat + DSH 的统一配置。
# 用法：cp config.example.sh config.sh，然后把下面【必改】的几项换成你自己的。
# 其他脚本（start.sh / watch.sh / relogin.sh / ensure-app.sh）都 source 这个文件。

# ===== 必改 =====
QQ_NUM=xxx                   # 要登录的 QQ 号（快速登录 -q 用的就是它）
NAPCAT_TOKEN=xxx             # OneBot 的 token，NapCat 配置里设的
DEEPSEEK_API_KEY=sk-xxx      # 分身（me.mjs）用的模型 key

# ===== 人物 =====
BOSS_QQ=xxx                  # 只跟这个人聊，别人的消息一律不回
# 机器人自己就是 QQ_NUM

# ===== 路径（一般不用改）=====
QQ_HOME=/data/local/tmp/qq                 # 栈根目录：proot + Ubuntu rootfs + Linux QQ
DATA_DIR=/sdcard/DeepSeekHarness           # 桥、日志、对话记录的落地目录
NODE_BIN=/data/local/tmp/nodert/bin/node   # bionic 版 node（从 payload 里拷出来的）
NODE_LIB=/data/local/tmp/nodert/lib        # 上面那个 node 的库路径
FFMPEG_BIN=/data/local/tmp/bin/ffmpeg      # 可选：静态 ffmpeg，转非 SILK 语音用

# ===== DSH 本体 =====
APP_PKG=com.deepseek.harness
APP_ACT=com.deepseek.harness/.MainActivity
DSH_PORT=3080                # 引擎 HTTP 端口（探活用）
SAY_PORT=3002                # 桥的「说一句」接口

# ===== 端口 =====
NAPCAT_HTTP=3000             # OneBot HTTP
NAPCAT_WS=3001               # OneBot WebSocket
NAPCAT_WEBUI=6099            # NapCat WebUI
PANEL_PORT=3099              # 控制面板，手机浏览器打开 http://127.0.0.1:3099

export QQ_NUM NAPCAT_TOKEN DEEPSEEK_API_KEY BOSS_QQ
export QQ_HOME DATA_DIR NODE_BIN NODE_LIB FFMPEG_BIN
export APP_PKG APP_ACT DSH_PORT SAY_PORT
export NAPCAT_HTTP NAPCAT_WS NAPCAT_WEBUI PANEL_PORT
