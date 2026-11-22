#!/system/bin/sh
# NapCat 栈启动脚本
# 三件事：
#   ① 快速登录免扫码（Linux QQ 带 -q $QQ_NUM，2026-11-18 实测可行）
#   ② 防重复启动（两套 proot 抢同一个 rootfs 会把 CPU 烧到 200%+）
#   ③ 顺手把桥和看门狗拉起来
# 部署位置：$QQ_HOME/start.sh，和 config.sh 同目录

HERE=$(dirname "$0")
. "$HERE/config.sh"

LOG=$DATA_DIR
mkdir -p "$LOG/qq"

# 0) 防重入：已经有一套 proot 在跑就不动
if ps -A -o NAME 2>/dev/null | grep -qx proot; then
  echo "$(date +%H:%M:%S) already running, skip" >> "$LOG/napcat.log"
else
  setsid sh "$QQ_HOME/run.sh" "rm -f /tmp/.X99-lock; (Xvfb :99 -nolock -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &); sleep 3; cd /opt/QQ; export DISPLAY=:99; exec ./qq --no-sandbox --disable-gpu --disable-dev-shm-usage -q $QQ_NUM" >> "$LOG/napcat.log" 2>&1 < /dev/null &
  echo "$(date +%H:%M:%S) stack started" >> "$LOG/napcat.log"
fi

# 1) 等 OneBot HTTP 端口
i=0
while [ $i -lt 45 ]; do
  sleep 2; i=$((i + 1))
  if (unset LD_LIBRARY_PATH; curl -s -m 2 -o /dev/null "http://127.0.0.1:$NAPCAT_HTTP/" 2>/dev/null); then break; fi
done

# 2) 桥（bridge.mjs 自带 pid 锁，重复起会自己退出）
if ! ps -A -o ARGS 2>/dev/null | grep -q 'bridge.mjs'; then
  setsid env LD_LIBRARY_PATH="$NODE_LIB" \
    "$NODE_BIN" "$DATA_DIR/tools/qq/bridge.mjs" >> "$LOG/qq/bridge.log" 2>&1 < /dev/null &
fi

# 3) 看门狗
if ! ps -A -o ARGS 2>/dev/null | grep -q 'watch.sh'; then
  setsid sh "$QQ_HOME/watch.sh" >/dev/null 2>&1 < /dev/null &
fi

# 3.5) 控制面板（手机浏览器打开 127.0.0.1:$PANEL_PORT）
if ! ps -A -o ARGS 2>/dev/null | grep -q 'panel\.mjs'; then
  setsid env LD_LIBRARY_PATH="$NODE_LIB" "$NODE_BIN" "$DATA_DIR/tools/qq/panel.mjs" >> "$LOG/qq/panel.log" 2>&1 < /dev/null &
fi

# 4) 登录状态回写
(unset LD_LIBRARY_PATH; curl -s -m 5 -X POST "http://127.0.0.1:$NAPCAT_HTTP/get_login_info" \
  -H "Authorization: Bearer $NAPCAT_TOKEN" 2>/dev/null) | head -c 200 > "$LOG/qq/login.json"
echo "started $(date)"
