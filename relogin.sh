#!/system/bin/sh
# 整栈重启：杀掉 qq / Xvfb / proot 再拉起来
# 只精确匹配这三个名字，别用宽匹配 grep qq——会误杀手机上的 com.tencent.mobileqq
HERE=$(dirname "$0")
. "$HERE/config.sh"

Q=$QQ_HOME
L=$DATA_DIR/napcat.log

for p in $(ps -A -o PID,NAME | awk '$2=="qq"{print $1}'); do kill -9 $p 2>/dev/null; done
for p in $(ps -A -o PID,NAME | awk '$2=="Xvfb"{print $1}'); do kill -9 $p 2>/dev/null; done
for p in $(ps -A -o PID,NAME | awk '$2=="proot"{print $1}'); do kill -9 $p 2>/dev/null; done
sleep 2

echo "=== relogin $(date +%H:%M:%S) ===" >> $L
nohup sh $Q/run.sh "rm -f /tmp/.X99-lock; (Xvfb :99 -nolock -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &); sleep 3; cd /opt/QQ; export DISPLAY=:99; exec ./qq --no-sandbox --disable-gpu --disable-dev-shm-usage -q $QQ_NUM" >> $L 2>&1 &
