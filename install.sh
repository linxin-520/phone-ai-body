#!/system/bin/sh
# ============================================================
#  手机跑 NapCat + DSH 身体 · 一键安装
# ============================================================
#  用法：
#    sh install.sh                 # 空环境从零装；已装的只更新脚本
#    sh install.sh --force         # 强制重装 rootfs（会清掉现有 QQ 数据，慎用）
#    QQ_NUM=xxx BOSS_QQ=xxx sh install.sh   # 不走交互
#
#  前提：
#    - Android 11+ / arm64，已经拿到 shell 权限（Shizuku 或 root）
#    - 可用空间 4GB 以上
#
#  它会做：
#    准备 proot+rootfs → 装 Linux QQ+NapCat → 配 OneBot → 部署桥和面板 → 起栈
# ============================================================

SELF=$(cd "$(dirname "$0")" && pwd)
QQ_HOME=${QQ_HOME:-/data/local/tmp/qq}
DATA_DIR=${DATA_DIR:-/sdcard/DeepSeekHarness}
NODE_BIN=${NODE_BIN:-/data/local/tmp/nodert/bin/node}
NODE_LIB=${NODE_LIB:-/data/local/tmp/nodert/lib}
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

ok()   { echo "  ✓ $1"; }
warn() { echo "  ! $1"; }
step() { echo ""; echo "▶ $1"; }
hr()   { echo "------------------------------------------------"; }
die()  { echo ""; echo "✗ $1" >&2; exit 1; }
ask()  { printf '%s' "$1"; read -r _a; echo "$_a"; }

# proot 环境（从 assets 装到 $QQ_HOME/out）
PR=$QQ_HOME/out/data/data/com.termux/files/usr

in_root() {  # 在 proot 里跑一段命令
  sh "$QQ_HOME/run.sh" "$1"
}

echo ""
echo "  手机跑 NapCat · 一键安装"
hr

# ---------------- 1. 环境检测 ----------------
step "1/7 检测环境"
[ "$(id -u)" = "2000" ] || warn "uid=$(id -u) 不是 shell(2000)，特权操作可能失败"
[ "$(uname -m)" = "aarch64" ] || die "只支持 arm64，你这台是 $(uname -m)"
ok "架构 arm64"

avail=$(df -P /data/local/tmp 2>/dev/null | awk 'NR==2{print $4}')
[ -n "$avail" ] && [ "$avail" -lt 4000000 ] && die "空间不够：剩 $((avail/1024))MB，需要 4GB 左右"
ok "空间够"
mkdir -p "$QQ_HOME" "$DATA_DIR/qq" || die "目录建不了，检查 shell 权限"

# ---------------- 2. 从零装 rootfs ----------------
step "2/7 准备 rootfs"
if [ -d "$QQ_HOME/ubuntu" ] && [ "$FORCE" = "0" ]; then
  ok "rootfs 已存在，跳过（要重装加 --force）"
else
  [ -f "$SELF/assets/ubuntu.tgz" ] || die "缺 assets/ubuntu.tgz（Ubuntu base rootfs）"
  [ -d "$QQ_HOME/ubuntu" ] && { warn "清掉旧 rootfs"; rm -rf "$QQ_HOME/ubuntu"; }

  mkdir -p "$QQ_HOME/ubuntu"
  echo "  解压 rootfs（约 30MB → 300MB，慢）…"
  tar xzf "$SELF/assets/ubuntu.tgz" -C "$QQ_HOME/ubuntu" || die "解压失败"
  ok "rootfs 解开"

  # proot
  mkdir -p "$PR/bin" "$PR/lib" "$PR/libexec"
  cp "$SELF/assets/proot/bin/proot" "$PR/bin/proot"
  cp "$SELF/assets/proot/lib/"*.so* "$PR/lib/"
  cp "$SELF/assets/proot/libexec/loader" "$PR/libexec/loader"
  chmod 755 "$PR/bin/proot" "$PR/libexec/loader"
  ok "proot 就位"

  # DNS
  cp /system/etc/resolv.conf "$QQ_HOME/ubuntu/etc/resolv.conf" 2>/dev/null \
    || echo "nameserver 223.5.5.5" > "$QQ_HOME/ubuntu/etc/resolv.conf"
  ok "DNS 写好"
fi

# 时区：容器默认 UTC，日志差 8 小时容易误读，统一设北京时间
if [ -f "$QQ_HOME/ubuntu/usr/share/zoneinfo/Asia/Shanghai" ]; then
  echo "Asia/Shanghai" > "$QQ_HOME/ubuntu/etc/timezone" 2>/dev/null || true
  cp "$QQ_HOME/ubuntu/usr/share/zoneinfo/Asia/Shanghai" "$QQ_HOME/ubuntu/etc/localtime" 2>/dev/null || true
  ok "时区设为 Asia/Shanghai"
fi

# run.sh 要先有才能进 proot
cp "$SELF/run.sh" "$QQ_HOME/run.sh" 2>/dev/null
chmod 755 "$QQ_HOME/run.sh"

# ---------------- 3. 装 Linux QQ + NapCat ----------------
step "3/7 装 Linux QQ + NapCat"
if [ -f "$QQ_HOME/ubuntu/opt/QQ/qq" ] || [ -f "$QQ_HOME/ubuntu/root/Napcat/opt/QQ/qq" ]; then
  ok "QQ 已装，跳过"
else
  echo "  这一步要下 QQ（约 200MB）和 NapCat，慢慢等"
  in_root '
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates xz-utils libgbm1 libasound2t64 libnss3 libxkbcommon0 libxdamage1 libxfixes3 libxrandr2 libxcomposite1 libatk1.0-0 libcups2 libdrm2 libxcb1 libx11-xcb1 libgbm1 xvfb >/dev/null 2>&1 || apt-get install -y -qq curl ca-certificates xz-utils xvfb
curl -fL --connect-timeout 20 --max-time 1800 https://raw.githubusercontent.com/NapNeko/NapCat-Installer/main/script/install.sh -o /root/napcat-install.sh
bash /root/napcat-install.sh --docker n --cli n --github-proxy 0
' || die "NapCat 安装失败，看上面的报错"
  ok "NapCat 安装器跑完"
fi

# QQ 可能在 /opt/QQ 也可能在 /root/Napcat/opt/QQ，统一建软链
in_root 'if [ -d /root/Napcat/opt/QQ ] && [ ! -e /opt/QQ ]; then ln -sfn /root/Napcat/opt/QQ /opt/QQ; fi; true' >/dev/null 2>&1
if in_root 'test -f /opt/QQ/qq' 2>/dev/null; then
  ok "QQ 在 /opt/QQ"
else
  warn "没找到 /opt/QQ/qq —— 后面起栈会失败，检查 NapCat 安装日志"
fi

# ---------------- 4. 配置 ----------------
step "4/7 配置"
CFG="$QQ_HOME/config.sh"
if [ -f "$CFG" ]; then
  warn "已有 config.sh，直接复用"
  . "$CFG"
else
  [ -n "${QQ_NUM:-}" ] || QQ_NUM=$(ask "机器人 QQ 号：")
  [ -n "${BOSS_QQ:-}" ] || BOSS_QQ=$(ask "只跟谁聊（你的 QQ 号）：")
  [ -n "${NAPCAT_TOKEN:-}" ] || NAPCAT_TOKEN=$(ask "OneBot token（自己起一个，记牢）：")
  [ -n "${DEEPSEEK_API_KEY:-}" ] || DEEPSEEK_API_KEY=$(ask "模型 API key（回车跳过）：")
  [ -n "$QQ_NUM" ] || die "QQ 号不能空"
  [ -n "$BOSS_QQ" ] || die "BOSS QQ 不能空"
  [ -n "$NAPCAT_TOKEN" ] || die "token 不能空"

  cat > "$CFG" <<EOF
# 本机配置（600，别提交到仓库）
QQ_NUM=$QQ_NUM
NAPCAT_TOKEN=$NAPCAT_TOKEN
DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY
BOSS_QQ=$BOSS_QQ
QQ_HOME=$QQ_HOME
DATA_DIR=$DATA_DIR
NODE_BIN=$NODE_BIN
NODE_LIB=$NODE_LIB
FFMPEG_BIN=/data/local/tmp/bin/ffmpeg
APP_PKG=com.deepseek.harness
APP_ACT=com.deepseek.harness/.MainActivity
DSH_PORT=3080
SAY_PORT=3002
NAPCAT_HTTP=3000
NAPCAT_WS=3001
NAPCAT_WEBUI=6099
PANEL_PORT=3099
EOF
  chmod 600 "$CFG"
  ok "配置写好：$CFG"
fi
. "$CFG"

# OneBot 配置：把 token 写进 NapCat 的配置文件
NC_CFG_DIR="$QQ_HOME/ubuntu/opt/QQ/resources/app/app_launcher/napcat/config"
if [ -d "$NC_CFG_DIR" ]; then
  NC_ONEBOT="$NC_CFG_DIR/onebot11_$QQ_NUM.json"
  if [ ! -f "$NC_ONEBOT" ]; then
    cat > "$NC_ONEBOT" <<EOF
{
  "network": {
    "httpServers": [
      { "name": "http", "enable": true, "host": "127.0.0.1", "port": $NAPCAT_HTTP, "enableCors": true, "enableWebsocket": true, "messagePostFormat": "array", "token": "$NAPCAT_TOKEN", "debug": false }
    ],
    "websocketServers": [
      { "name": "ws", "enable": true, "host": "127.0.0.1", "port": $NAPCAT_WS, "messagePostFormat": "array", "reportSelfMessage": true, "token": "$NAPCAT_TOKEN", "debug": false }
    ]
  },
  "musicSignUrl": "",
  "enableLocalFile2Url": true,
  "parseMultMsg": true
}
EOF
    ok "OneBot 配置写好"
  else
    warn "OneBot 配置已存在，没动它"
  fi
fi

# ---------------- 5. 部署我们的东西 ----------------
step "5/7 部署桥和脚本"
for f in start.sh stop.sh relogin.sh run.sh watch.sh ensure-app.sh config.sh; do
  [ -f "$SELF/$f" ] && cp "$SELF/$f" "$QQ_HOME/$f" && chmod 755 "$QQ_HOME/$f"
done
ok "脚本 → $QQ_HOME"

mkdir -p "$DATA_DIR/tools/qq"
for f in bridge.mjs stt.mjs panel.mjs; do
  [ -f "$SELF/$f" ] && cp "$SELF/$f" "$DATA_DIR/tools/qq/$f"
done
[ -d "$SELF/lib" ] && mkdir -p "$DATA_DIR/tools/qq/lib" && cp -r "$SELF/lib/"* "$DATA_DIR/tools/qq/lib/" 2>/dev/null
ok "桥和面板 → $DATA_DIR/tools/qq"

# 分身（嘴）：仓库里只有模板，用户自己填的那几份永远不覆盖
AME="$DATA_DIR/qq/another-me"
mkdir -p "$AME"
if [ -d "$SELF/another-me" ]; then
  cp "$SELF/another-me/me.mjs" "$AME/me.mjs" 2>/dev/null
  cp "$SELF/another-me/"*.example.* "$AME/" 2>/dev/null
fi
[ -f "$AME/identity.md" ] || { cp "$AME/identity.example.md" "$AME/identity.md" 2>/dev/null; warn "分身人格是模板，改 $AME/identity.md"; }
[ -f "$AME/stance.md" ]   || cp "$AME/stance.example.md" "$AME/stance.md" 2>/dev/null
[ -f "$AME/config.json" ] || cp "$AME/config.example.json" "$AME/config.json" 2>/dev/null
ok "分身 → $AME"

# ---------------- 6. 起栈 ----------------
step "6/7 启动"
if ps -A -o NAME 2>/dev/null | grep -qx proot; then
  warn "已有 proot 在跑，跳过（避免双栈）"
else
  sh "$QQ_HOME/start.sh"
  ok "已发启动指令"
fi

# ---------------- 7. 等上线 ----------------
step "7/7 等 OneBot 上线（最多 120 秒）"
i=0; online=0
while [ $i -lt 60 ]; do
  sleep 2; i=$((i + 1))
  r=$(unset LD_LIBRARY_PATH; curl -s -m 2 -X POST "http://127.0.0.1:$NAPCAT_HTTP/get_login_info" \
      -H "Authorization: Bearer $NAPCAT_TOKEN" 2>/dev/null)
  case "$r" in
    *'"user_id"'*) ok "上线了，账号 $QQ_NUM"; online=1; break ;;
  esac
done

if [ "$online" = "0" ]; then
  warn "还没上线。首次登录要扫码："
  echo "    二维码：$QQ_HOME/ubuntu/opt/QQ/resources/app/app_launcher/napcat/cache/qrcode.png"
  echo "    手机 QQ → + → 扫一扫 → 右下角相册 → 选它"
  echo "    扫完等十几秒，再跑一次 sh install.sh 看状态"
else
  hr
  echo "装好了。"
  echo ""
  echo "  面板   手机浏览器开 http://127.0.0.1:3099"
  echo "  状态   cat $DATA_DIR/qq/status.txt"
  echo "  重启   sh $QQ_HOME/relogin.sh"
  echo "  停止   sh $QQ_HOME/stop.sh"
fi
