#!/system/bin/sh
# 一键下载 + 安装（给不想 git clone 的人）
#
# 用法：
#   sh get.sh
#   GH_PROXY=https://ghfast.top sh get.sh     # 国内加速
#
# 它会：下载仓库 zip → 解压到临时目录 → 跑 install.sh
set -e

# 默认从官方仓库拉；想换分叉就 REPO=https://github.com/xxx/phone-ai-body sh get.sh
REPO=${REPO:-https://github.com/linxin-520/phone-ai-body}
BRANCH=${BRANCH:-main}
PROXY=${GH_PROXY:-}
TMP=${TMPDIR:-/data/local/tmp}/phone-ai-body.$$

echo "下载 $REPO ..."
mkdir -p "$TMP"
if ! curl -fL --connect-timeout 20 --max-time 600 \
    "${PROXY:+$PROXY/}$REPO/archive/refs/heads/$BRANCH.tar.gz" \
    | tar xz -C "$TMP"; then
  echo "下载失败。国内网络可以加前缀：" >&2
  echo "  GH_PROXY=https://ghfast.top sh get.sh" >&2
  rm -rf "$TMP"
  exit 1
fi

DIR=$(find "$TMP" -maxdepth 1 -mindepth 1 -type d | head -1)
[ -d "$DIR" ] || { echo "解压后没找到目录" >&2; exit 1; }

cd "$DIR"
echo "开始安装：" $(pwd)
sh install.sh "$@"
