#!/system/bin/sh
# 在 Android 上跑 Linux（proot + Ubuntu 24.04 arm64）
# 用法：run.sh '<要在 ubuntu 里跑的命令>'
# 依赖：$QQ_HOME/out/data/data/com.termux/files/usr 里的 proot（从 Termux 包里扒的）

HERE=$(dirname "$0")
[ -f "$HERE/config.sh" ] && . "$HERE/config.sh"

BASE=${QQ_HOME:-/data/local/tmp/qq}
PR=$BASE/out/data/data/com.termux/files/usr
export LD_LIBRARY_PATH=$PR/lib
export PROOT_LOADER=$PR/libexec/proot/loader
export PROOT_TMP_DIR=$BASE/tmp
export PROOT_NO_SECCOMP=1
exec "$PR/bin/proot" \
  -0 -r "$BASE/ubuntu" \
  -b /dev -b /proc -b /sys \
  -b /data \
  -b /storage/emulated/0:/sdcard \
  -w /root \
  /usr/bin/env -i HOME=/root TERM=dumb PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  LANG=C.UTF-8 SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
  /bin/bash -lc "$1"
