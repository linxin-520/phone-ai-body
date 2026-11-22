# 排错

这里全是真踩过的坑，按「现象 → 原因 → 解法」写。遇到问题先来这里搜关键词。

---

## 1. QQ 起不来，日志里有 `Operation not permitted` 或解包失败

**现象**：在 proot 里 `dpkg -i` 装包，报硬链接错误。

**原因**：安卓的 `/data` 是 f2fs 文件系统，不支持硬链接。dpkg 装包必用硬链接。

**解法**：别用 `dpkg -i`。用 `dpkg -x 包.deb /tmp/xx` 解出来再 `cp -a /tmp/xx/. /`。仓库里的 `install.sh` 已经这么做了。

---

## 2. Xvfb 起不来，报锁文件错误

**现象**：`Xvfb :99` 报 `Server is already active for display 99` 或者卡住。

**原因**：Xvfb 要在 `/tmp` 下建硬链接锁文件，f2fs 又不支持。

**解法**：启动参数加 `-nolock`。

```sh
Xvfb :99 -nolock -screen 0 1280x800x24
```

---

## 3. 手机发烫、耗电快得离谱

**现象**：电池一晚上掉 40%，`top` 看到 proot 占 200% CPU。

**原因**：跑了两套 NapCat 栈。两套 proot 抢同一个 rootfs，内核在文件系统层面打起来了。常见于：看门狗以为挂了就重启，但旧的其实还在。

**解法**：

```sh
# 看看有几套
ps -A -o PID,NAME | grep -E 'proot|qq|Xvfb'

# 杀之前先精确确认，别宽匹配 qq（会误杀手机 QQ）
ps -A -o PID,NAME | awk '$2=="qq"||$2=="proot"||$2=="Xvfb"{print $1}'
```

`start.sh` 里有防重入：看到 `proot` 进程就不重复起。

---

## 4. 看门狗写的状态一直不更新

**现象**：`status.txt` 停在几天前。

**原因**两个可能：

1. **看门狗根本没跑**。查的时候用 `ps | grep watch.sh` 会匹配到 `grep` 自己，看起来像在跑：

   ```sh
   # 错的（永远匹配自己）
   ps -A | grep watch.sh

   # 对的
   ps -A -o PID,NAME,ARGS | awk '$2=="sh" && $3~/watch\.sh$/'
   ```

2. **看门狗在跑但探测失败**。如果 `LD_LIBRARY_PATH` 被设成了 node 的库路径，系统 `curl` 会崩（`EVP_MD_CTX_create` 找不到之类），探测恒失败。

   ```sh
   # 调系统 curl 前先剥掉
   (unset LD_LIBRARY_PATH; curl -s -m 5 http://127.0.0.1:3000/...)
   ```

仓库里的脚本都做了这个处理。

---

## 5. 同一条消息回两遍

**现象**：你说一句，机器人回两条，内容还不完全一样。

**原因**两个：

1. **两个 bridge 进程**。各自连 WS，各收一份。桥有 pid 锁，理论上不可能，但杀了硬重启可能绕过去。

2. **WS 断线重连后 NapCat 重放消息**。桥如果没去重，就会再处理一遍。

**解法**：桥里用 `message_id` 做 Set 去重。

---

## 6. `bridge.log` 里几万条 `ws closed`

**现象**：日志被 `ws closed` 刷爆，每 5 秒一条。

**原因**：WebSocket 半死——连接是 open 的，但 NapCat 那边已经不推数据。旧代码只看 `close` 事件，半死状态感知不到。

**解法**：加心跳 + 超时判定。

```js
// 90 秒没数据就主动断开重连
if (Date.now() - lastData > 90000) ws.close();
```

重连用指数退避，别固定 5 秒。

---

## 7. 唤醒不生效，QQ 说「递过去了」但没动静

**现象**：嘴说已经交给手了，手一直睡着。

**原因**：`wake.json` 格式不对。三个常见错误：

1. 缺顶层 `"version": 1`
2. entry 缺 `min_idle_seconds` → 会话忙的时候重试几次就被丢弃
3. `target` 没写或者模式不对 → 会开新对话而不是叫醒当前会话

**正确的样子**：

```json
{
  "version": 1,
  "entries": [{
    "id": "qq-当前消息id",
    "after_seconds": 2,
    "min_idle_seconds": 8,
    "prompt": "要干的话",
    "target": { "mode": "resume", "session_id": "session-xxx" }
  }]
}
```

---

## 8. 每次重启都要扫码

**现象**：Linux QQ 重启后弹二维码。

**情况一：没带 `-q` 参数**

QQ 不知道要快速登录。启动命令里要有：

```sh
./qq --no-sandbox --disable-gpu -q 你的QQ号
```

前提是之前登录过一次，登录态还在手机里。

**情况二：带了 `-q` 还是要扫**

登录态失效了，或者被要求做二次验证（现在常见的是国家网络数字身份验证）。自用经验：大约一个月两次，验一次就恢复，之后 `-q` 又能用。

⚠️ 别靠反复重启去"撞"进去。短时间内的异常登录会加重风控，越撞要求越严。撞上了就老老实实拿手机 QQ 验一遍。

**情况三：掉线了，但看门狗会自动救**

网络抖一下、IPv6 地址变了，QQ 可能自己判断"断网"然后丢掉登录态。看门狗每 45 秒查一次，发现登录态没了会：

1. 先自动跑一次带 `-q` 的重登（10 分钟内最多一次，避免频繁重启加重风控）
2. 能登回来就继续挂着，不打扰你
3. 登不回来才在相册放二维码 + 发通知

所以不用守着它——登录态有效时它会自己恢复，只有真失效了才叫你扫码。

另外两处防抖：

- **崩溃重启也有节流**：QQ 进程自己崩掉时，看门狗会拉起来，但 3 分钟内不会重复拉。连崩连拉会变成一串"新设备登录"，反而更容易被风控。
- **日志自动轮转**：`napcat.log` 超过 10MB 会切一份 `.1` 再截断，不会把手机塞满。

---

## 9. 二维码不刷新 / 扫了没反应

**现象**：相册里的码是十分钟前的。

**原因**：NapCat 只在拉起时生成一次码，之后不会刷新。

**解法**：删缓存再重启。

```sh
rm -rf /data/local/tmp/qq/ubuntu/opt/QQ/resources/app/app_launcher/napcat/cache/qrcode.png
sh /data/local/tmp/qq/relogin.sh
```

---

## 10. Shizuku 的 shell 命令跑 30 秒就被杀

**现象**：下载大文件时命令中途断掉。

**原因**：Shizuku 通道有 30 秒上限，`timeout_ms` 参数不一定生效。

**解法**：长任务放后台。

```sh
setsid 命令 > /tmp/out.log 2>&1 < /dev/null &
```

---

## 11. 在 `/sdcard` 上 `chmod` 无效

**现象**：拷到 `/sdcard` 的脚本 `chmod 755` 之后还是 `644`，跑不了。

**原因**：`/sdcard` 是 fuse 挂载，不保留 Unix 权限位。

**解法**：先在 `/sdcard` 放文件，启动时拷到 `/data/local/tmp`（ext4 支持权限）再 `chmod`。`install.sh` 就是这么做的。

---

## 12. 读不到 `/data/local/tmp/qq/out/`

**现象**：普通 App 进程 `ls` 报 Permission denied。

**原因**：`/data/local/tmp/qq/out` 是 shell 用户建的 700 目录，别的 uid 进不去。

**解法**：要么用 shell 权限跑，要么 `chmod -R a+rX` 放开。

---

## 13. 语音转不出来

**现象**：发语音给机器人，它说「语音转不了」。

**原因**两个：

1. **缺 ffmpeg**。QQ 的语音是 SILK 格式，SILK 能直接解；但 forwarded 或者下载的 m4a/mp3 需要 ffmpeg 先转 wav。
2. 模型路径不对。

**解法**：

```sh
# 手动测一个文件
node stt.mjs /path/to/voice.amr
# 看输出里的 error 字段
```

ffmpeg 放 `/data/local/tmp/bin/ffmpeg`，静态 arm64 版就行。

---

## 14. 面板打不开

**现象**：浏览器访问 `127.0.0.1:3099` 没反应。

**原因**：面板进程挂了，或者端口被占。

**解法**：

```sh
# 看进程
ps -A -o PID,ARGS | awk '$2=="node" && $3~/panel/'

# 看端口
(unset LD_LIBRARY_PATH; curl -s -m 2 http://127.0.0.1:3099/ >/dev/null && echo ok)

# 手动起
setsid sh -c '. /data/local/tmp/qq/config.sh; exec env LD_LIBRARY_PATH=$NODE_LIB $NODE_BIN /sdcard/DeepSeekHarness/tools/qq/panel.mjs' &
```

---

## 15. ColorOS / MIUI 上 Shizuku 提示「制造商限制了 adb 权限」

**现象**：装好 Shizuku 但激活失败。

**原因**：国产 ROM 限制。ColorOS 要进「开发者选项 → 权限监控」把开关关掉。

**解法**（ColorOS 16 实测）：设置 → 系统设置 → 开发者选项 → 权限监控 → 关。

---

## 16. 重启手机后什么都不跑

**现象**：重启后 QQ 彻底离线。

**原因**：没 root 就没有 init.d，`start.sh` 不会自动执行。

**解法**：手动跑一次。

```sh
sh /data/local/tmp/qq/start.sh
```

想做自启：
- 有 root：写 init.d 脚本
- 装了 Termux：用 [Termux:Boot](https://f-droid.org/packages/com.termux.boot/)
- 没有：DSH 的定时任务里挂一个开机检查（不稳定，仅供参考）

---

## 还是搞不定

开 issue 的时候带上这几样，能省很多来回：

```sh
# 1. 状态
cat /sdcard/DeepSeekHarness/qq/status.txt

# 2. 进程
ps -A -o PID,NAME | grep -E 'proot|qq|Xvfb|node|watch'

# 3. 日志尾巴（注意别贴出账号和 token）
tail -50 /sdcard/DeepSeekHarness/napcat.log
tail -50 /sdcard/DeepSeekHarness/qq/bridge.log
```
