# 更新记录 / Changelog

## 0.6.5 · Windows 浏览器进程接手

- 启动进程以 0 退出后，继续等待专用资料目录的登录端点，使用接手的 Chrome 或 Edge 完成初始化和关闭。
- 启动期间响应 Magpie 取消。启动、关闭和清理错误按发生顺序保存在同一份诊断中。
- Wait for the dedicated Windows browser endpoint across a launcher handoff. Preserve startup and cleanup errors in the same diagnostic.

## 0.5.0 · 2026-11-13

- 将 Magpie 供应商插件发布到独立仓库 `magpie-doubao-work`。
- 提取插件所需的协议、会话、浏览器登录、账号状态和备份解析。
- 增加中英文 README、安装与迁移说明。
- 名称与中英文摘要覆盖常用别名和搜索词组，提供检索回归测试。

- Publish the Magpie provider in the dedicated `magpie-doubao-work` repository.
- Extract the protocol, session, browser sign-in, account-state and backup modules used by the plugin.
- Add Chinese and English installation, migration and usage documentation.
- Cover common names, aliases and phrases in both localized search fields, with regression tests.
