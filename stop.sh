#!/system/bin/sh
# 停整栈。只用精确进程名匹配——宽匹配 grep qq 会误杀手机上真正的 com.tencent.mobileqq
HERE=$(dirname "$0")
[ -f "$HERE/config.sh" ] && . "$HERE/config.sh"

for n in qq Xvfb proot; do
  for p in $(ps -A -o PID,NAME | awk -v n="$n" '$2==n{print $1}'); do
    kill -9 "$p" 2>/dev/null
  done
done

for p in $(ps -A -o PID,ARGS | awk '$2=="node" && $3 ~ /bridge\.mjs/{print $1}'); do
  kill -9 "$p" 2>/dev/null
done

for p in $(ps -A -o PID,ARGS | awk '$2=="sh" && $3 ~ /watch\.sh/{print $1}'); do
  kill -9 "$p" 2>/dev/null
done

echo "已停：qq / Xvfb / proot / 桥 / 看门狗"
