# 安装

## 0. 你需要先有的东西

**一台安卓手机**，Android 11+、arm64、剩 4GB 空间。不要求 root。

**一个 shell 权限通道**，二选一：

- **Shizuku**（推荐）：装 [Shizuku](https://shizuku.rikka.app/)，用无线调试激活，然后给 DSH 授权
- **root**：有 root 直接跑也行

> **这一步绕不过去。** 手机里跑 Linux QQ 靠的是 shell 进程，它熄屏也不会被系统冻住。普通 App（包括 DSH 自己）一熄屏就会被后台管理冻住，无障碍服务也就管用亮屏那一会儿——收不到也发不出，整套链路等于没有。华为 / 鸿蒙机型尤其要先确认能拿到 Shizuku，很多机型 ADB 调试受限，拿不到就别往下装了。

**一个能用的 DSH**：这个项目的大脑子是 DSH，没有它只有嘴巴没有手。

## 1. 拿代码

```sh
git clone https://github.com/linxin-520/phone-ai-body.git
cd phone-ai-body
```

没装 git 就下 zip 解压。注意 `assets/` 里有 29MB 的 rootfs，别漏了。

## 2. 给权限

如果用 Shizuku，确认 DSH 已经拿到 shell 权限，能用这一句验证：

```sh
id
# 应该是 uid=2000(shell)
```

不是 2000 就去 Shizuku 里给 DSH 授权，再重进会话。

## 3. 跑安装

```sh
sh install.sh
```

脚本会依次问你：

| 问题 | 填什么 |
|---|---|
| 机器人 QQ 号 | 要登录的小号 |
| BOSS QQ 号 | 只回谁的私聊 |
| OneBot token | 自己起一个字符串，记牢 |
| 模型 API key | DSH 用的模型 key，可回车跳过 |

然后它会：解压 rootfs → 装 proot → 装 Linux QQ → 装 NapCat → 配 OneBot → 部署桥 → 起栈。

**第一次要十几分钟**，大部分时间在下 QQ（约 200MB）。

## 4. 扫码

第一次登录必须扫码。

```sh
# 二维码在哪
ls /data/local/tmp/qq/ubuntu/opt/QQ/resources/app/app_launcher/napcat/cache/qrcode.png
```

拷到相册：

```sh
cp /data/local/tmp/qq/ubuntu/opt/QQ/resources/app/app_launcher/napcat/cache/qrcode.png \
   /sdcard/Pictures/napcat-login.png
```

手机 QQ → 右上角 `+` → 扫一扫 → 右下角**相册** → 选它 → 确认登录。

扫完等 20 秒左右。

## 5. 验收

```sh
cat /sdcard/DeepSeekHarness/qq/status.txt
# 看到 online qq=4 就算成了
```

手机浏览器打开 `http://127.0.0.1:3099`，四盏灯全绿。

然后用你自己的 QQ 给机器人发一句话，它在十几秒内应该回你。

## 6. 日常

| 干什么 | 命令 |
|---|---|
| 看状态 | `cat /sdcard/DeepSeekHarness/qq/status.txt` |
| 重启 | `sh /data/local/tmp/qq/relogin.sh` |
| 停止 | `sh /data/local/tmp/qq/stop.sh` |
| 看 QQ 日志 | `tail -f /sdcard/DeepSeekHarness/napcat.log` |
| 看桥日志 | `tail -f /sdcard/DeepSeekHarness/qq/bridge.log` |
| 改配置 | 编辑 `/data/local/tmp/qq/config.sh` 后重启 |

## 升级

把代码 `git pull` 下来，再跑一次 `sh install.sh`。已存在的 rootfs、QQ 数据、配置都不会动，只更新脚本和桥。

## 卸载

```sh
sh /data/local/tmp/qq/stop.sh
rm -rf /data/local/tmp/qq
rm -rf /sdcard/DeepSeekHarness/qq
rm -rf /sdcard/DeepSeekHarness/qq-oss
```

注意这会把 QQ 登录态一起删掉，下次要重新扫码。
