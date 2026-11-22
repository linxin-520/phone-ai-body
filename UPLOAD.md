# 怎么传到 GitHub

手机上没装 git，这个仓库先在本地整理好了，传的时候在电脑上做。

## 1. 把包拿到电脑

手机上的位置：

```
/sdcard/DeepSeekHarness/phone-ai-body.tar.gz   （28MB）
```

用数据线拷下来，或者用 QQ / 网盘传。Windows 上解压，得到 `qq-oss/` 目录。

## 2. 建仓库

去 GitHub 点 **New repository**：

- **Repository name**：`phone-ai-body`（或者你喜欢的）
- **Description**：`让 AI 住进安卓手机，用 QQ 远程指挥它干活`
- **Public**
- **不要**勾 Add a README / .gitignore / license（本地都有了）

## 3. 推上去

```bash
cd qq-oss

git init
git add .
git commit -m "init: 手机里的 AI 身体"

# 换成你自己的仓库地址
git remote add origin https://github.com/YOUR-GITHUB-NAME/phone-ai-body.git
git branch -M main
git push -u origin main
```

第一次 push 会要 GitHub 的 Personal Access Token，不是密码。生成方法：
GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token → 勾 `repo`。

## 4. 推之前检查这四件事

1. **有没有 `config.sh`**：`ls config.sh`。有的话删掉，里面是 QQ 号和 token。仓库里只该有 `config.example.sh`。
2. **没有私人信息**：QQ 号、API key、真人姓名、私人服务器地址都别带进去。扫一遍：

   ```sh
   grep -rnE '[1-9][0-9]{8,10}|sk-[A-Za-z0-9]{16,}' . | grep -v 'config.example' | head
   ```

   `another-me/notes.md` 是分身自己的笔记本，发布前扫一眼，别把自己的私人习惯和账号写进去。
3. **`.gitignore` 在里面**：确认没漏。
4. **大文件**：`du -sh .`，应该在 30MB 左右。超了说明把日志或模型带进去了。

## 5. 推完改这几处

`README.md`、`get.sh`、`docs/INSTALL.md` 里都有 `YOUR-GITHUB-NAME` 这个占位符：

```sh
# get.sh 里
REPO=${REPO:-https://github.com/YOUR-GITHUB-NAME/phone-ai-body}
```

全局替换成你自己的账号名：

```sh
grep -rln 'YOUR-GITHUB-NAME' . | xargs sed -i 's/YOUR-GITHUB-NAME/你的账号/g'
```

仓库名如果你改了，顺手把 `phone-ai-body` 也换掉。

## 6. 建议加的标签

GitHub 仓库页右上角 **About** → 加 topic：

```
qq-bot  napcat  android  termux  proot  onebot  ai-agent  dsh
```

## 7. 如果想发版

打 tag 会让人更敢用：

```bash
git tag -a v0.1.0 -m "第一个能跑通的版本"
git push origin v0.1.0
```

然后 GitHub → Releases → **Draft a new release** → 选 v0.1.0 → 描述写「能装、能聊、能干活」。
