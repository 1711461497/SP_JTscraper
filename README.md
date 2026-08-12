# SP_JTscraper

Saucepan.ai companion 批量提取工具。无需浏览器，直接通过 REST API 提取角色卡数据（包括 Show Button 下的隐藏定义）。

## 功能

- 批量提取指定创作者的所有 companions
- 浏览并提取最新/热门 companions
- 从 URL 列表批量提取
- 自动处理 Saucepan 的 fragment 加密/混淆机制
- 支持 NSFW 内容

## 环境要求

- Node.js >= 18
- Saucepan.ai 账号

## 安装

```bash
git clone https://github.com/1711461497/SP_JTscraper.git
cd SP_JTscraper
```

无需安装依赖，脚本使用 Node.js 内置模块。

## 使用方法

### 提取某个创作者的所有角色

```bash
node batch-extract.js --user <用户名>
```

### 仅列出角色链接（不下载）

```bash
node batch-extract.js --user <用户名> --list-only
```

### 提取最新发布的角色

```bash
node batch-extract.js --browse [数量]
```

### 提取热门角色

```bash
node batch-extract.js --trending [数量]
```

### 从 URL 列表提取

创建 `urls.txt` 文件，每行一个链接：

```
https://saucepan.ai/companion/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
https://saucepan.ai/companion/yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy
```

然后运行：

```bash
node batch-extract.js
```

## 首次运行

首次运行时需要输入 Saucepan 用户名和密码，登录后 Token 会自动保存到 `.token` 文件（已在 `.gitignore` 中排除），下次运行无需重复登录。

## 输出

提取的角色数据以 JSON 格式保存在 `output/` 目录下，包含：

- 角色名称、简介
- Companion Core（角色定义）
- Example Dialogue（示例对话）
- Advanced Prompt（高级提示词）
- Response Formatting（回复格式）
- First Message 和 Alternate Greetings（问候语）
- 标签

## 致谢

本工具的 fragment 解密逻辑参考了 [JAR](https://github.com/hydall/JAR) 项目。
