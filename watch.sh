#!/system/bin/sh
# QQ 栈看门狗：45 秒体检一次
# 判定顺序：
#   HTTP 通               -> online，顺手确认桥/面板还活着
#   qq 进程没了           -> 重启整栈（有节流，防止崩溃后反复重启加重风控）
#   qq 在但 HTTP 不通     -> 先试一次 -q 快速登录（有节流），还不行再推码
# 为什么先试快速登录：登录态有效时 relogin 能免扫码登回；只有登录态真废了才需要扫码。
# 为什么要节流：每次重启都是一次"新登录"，太频繁会加重风控。
# 部署位置：$QQ_HOME/watch.sh，和 config.sh 同目录

HERE=$(dirname "$0")
. "$HERE/config.sh"

Q=$QQ_HOME
L=$DATA_DIR/napcat.log
QRDIR=$Q/ubuntu/opt/QQ/resources/app/app_launcher/napcat/cache
QR=$QRDIR/qrcode.png
PIC=/sdcard/Pictures/napcat-login.png
ST=$DATA_DIR/qq/status.txt
BL=$DATA_DIR/qq/bridge.log
NOTTS=$DATA_DIR/qq/.lastnotify
TOK=$NAPCAT_TOKEN
COOLDOWN=${WATCH_COOLDOWN:-1800}
RELOGIN_COOLDOWN=${RELOGIN_COOLDOWN:-600}
RESTACK_COOLDOWN=${RESTACK_COOLDOWN:-180}
LOG_MAX=${WATCH_LOG_MAX:-10485760}

lastqr=0
alerted=0
fail=0
lastrelogin=0
lastrestack=0

api() { (unset LD_LIBRARY_PATH; curl -s -m 5 -X POST "http://127.0.0.1:$NAPCAT_HTTP/get_login_info" -H "Authorization: Bearer $TOK" 2>/dev/null); }
notify() { cmd notification post -S bigtext -t "$1" qqwatch "$2" >/dev/null 2>&1; }
qrcnt() { grep -ac "请扫描下面的二维码" "$L" 2>/dev/null; }
qqnum() { ps -A -o NAME 2>/dev/null | grep -c '^qq$'; }
qrage() { a=$(stat -c %Y "$QR" 2>/dev/null || echo 0); echo $(( $(date +%s) - a )); }

# 日志太大就切一份再截断（QQ 持有句柄时 truncate 有效，cp 兜底留档）
rotate_log() {
  f=$1
  sz=$(stat -c %s "$f" 2>/dev/null || echo 0)
  if [ "$sz" -gt "$LOG_MAX" ]; then
    cp "$f" "$f.1" 2>/dev/null
    : > "$f" 2>/dev/null
  fi
}

ensure_bridge() {
  if ! ps -A -o NAME,ARGS 2>/dev/null | grep -q "bridge.mjs"; then
    sh -c ". $Q/config.sh; exec setsid env LD_LIBRARY_PATH=\"\$NODE_LIB\" DEEPSEEK_API_KEY=\"\$DEEPSEEK_API_KEY\" \"\$NODE_BIN\" \"\$DATA_DIR/tools/qq/bridge.mjs\"" >>"$BL" 2>&1 &
    echo "$(date +%H:%M:%S) restart bridge" >> "$ST"
  fi
}

ensure_panel() {
  if ! ps -A -o NAME,ARGS 2>/dev/null | grep -q "panel.mjs"; then
    sh -c ". $Q/config.sh; exec setsid env LD_LIBRARY_PATH=\"\$NODE_LIB\" \"\$NODE_BIN\" \"\$DATA_DIR/tools/qq/panel.mjs\"" >> "$DATA_DIR/qq/panel.log" 2>&1 &
    echo "$(date +%H:%M:%S) restart panel" >> "$ST"
  fi
}

restack() {
  lastrestack=$(date +%s)
  lastrelogin=$lastrestack
  echo "$(date +%H:%M:%S) $1，重启整栈" > "$ST"
  setsid sh "$Q/relogin.sh" >/dev/null 2>&1 &
  fail=0
  lastqr=0
  sleep 40
}

# 登录态掉线：先节流试一次 -q 快速登录，返回 0 表示已发起
try_fast_relogin() {
  now=$(date +%s)
  if [ $((now - lastrelogin)) -ge "$RELOGIN_COOLDOWN" ]; then
    lastrelogin=$now
    echo "$(date +%H:%M:%S) 登录态掉线，尝试 -q 快速重登" > "$ST"
    setsid sh "$Q/relogin.sh" >/dev/null 2>&1 &
    fail=0
    lastqr=0
    sleep 40
    return 0
  fi
  return 1
}

while true; do
  rotate_log "$L"
  r=$(api)
  q=$(qqnum)
  case "$r" in
    *'"user_id"'*)
      echo "$(date +%H:%M:%S) online qq=$q" > "$ST"
      fail=0
      ensure_bridge
      ensure_panel
      if [ "$alerted" = 1 ]; then
        notify "QQ 恢复了" "自动回消息已重新上线"
        alerted=0
      fi
      ;;
    *)
      fail=$((fail + 1))
      age=$(qrage)
      if [ "$q" = 0 ]; then
        # 进程都没了：要重启，但别连着重启
        now=$(date +%s)
        if [ $((now - lastrestack)) -ge "$RESTACK_COOLDOWN" ]; then
          restack "qq 进程不在"
        else
          echo "$(date +%H:%M:%S) qq 进程不在，$((now - lastrestack))s 前刚重启过，等它起来" > "$ST"
          sleep 20
        fi
      else
        ensure_bridge
        ensure_panel
        # 进程在但没登录。先试快速登录（有节流），失败才推码。
        if [ "$fail" -ge 2 ] && try_fast_relogin; then
          continue
        fi
        c=$(qrcnt)
        if [ "$c" != "$lastqr" ]; then
          lastqr=$c
          cp "$QR" "$PIC" 2>/dev/null
          chmod 644 "$PIC" 2>/dev/null
          now=$(date +%s)
          nt=0
          [ -f "$NOTTS" ] && nt=$(cat "$NOTTS" 2>/dev/null || echo 0)
          if [ $((now - nt)) -ge "$COOLDOWN" ]; then
            echo "$now" > "$NOTTS" 2>/dev/null
            notify "QQ 掉线了，需要扫码" "图在相册：Pictures/napcat-login.png（手机QQ → + → 扫一扫 → 相册）。扫完自动恢复。"
            alerted=1
          fi
          echo "$(date +%H:%M:%S) 等待扫码，QR 已更新($c) qa=${age}s fail=$fail" > "$ST"
        else
          echo "$(date +%H:%M:%S) 等待扫码（码未刷新）qa=${age}s fail=$fail" > "$ST"
        fi
      fi
      ;;
  esac
  sleep 45
done
