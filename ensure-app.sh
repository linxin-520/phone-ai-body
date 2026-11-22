#!/system/bin/sh
# 引擎探活 + 冷启动兜底（2026-11-18）
#
# 背景：QQ 分身递活是写 wake.json 让 proactive 叫醒当前会话。
# 但 proactive 的调度器活在 App 的引擎进程里，App 被杀就没人消费 wake.json，
# 用户在 QQ 上说一句等于对着空气说。
#
# 办法：先看 DSH_PORT 有没有响应（401 也算活着，说明引擎在）；没有就 am start 把 App 拉起来。
# am start 之后引擎要几秒才起来，所以再等一会儿复查，把结果写进 wake.log。

HERE=$(dirname "$0")
[ -f "$HERE/config.sh" ] && . "$HERE/config.sh"
APP_PKG=${APP_PKG:-com.deepseek.harness}
APP_ACT=${APP_ACT:-$APP_PKG/.MainActivity}
DSH_PORT=${DSH_PORT:-3080}
LOG=${DATA_DIR:-/sdcard/DeepSeekHarness}/qq/wake.log

alive() {
  code=$(unset LD_LIBRARY_PATH; curl -s -m 2 -o /dev/null -w "%{http_code}" "http://127.0.0.1:$DSH_PORT/" 2>/dev/null)
  [ -n "$code" ] && [ "$code" != "000" ]
}

if alive; then
  exit 0
fi

echo "$(date +%H:%M:%S) 引擎没响应，am start 拉起" >> "$LOG"
am start -n "$APP_ACT" >/dev/null 2>&1

i=0
while [ $i -lt 10 ]; do
  sleep 2
  i=$((i + 1))
  if alive; then
    echo "$(date +%H:%M:%S) 引擎已拉起（${i}次探测）" >> "$LOG"
    exit 0
  fi
done

echo "$(date +%H:%M:%S) am start 了但还是没响应" >> "$LOG"
exit 1
