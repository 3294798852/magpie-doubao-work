# 来源与第三方声明 / Sources and third-party notices

## 网关来源 / Gateway source

本插件从 [3294798852/doubao-work-gateway v0.5.0](https://github.com/3294798852/doubao-work-gateway/tree/v0.5.0) 拆分，代码基线为 `f2ad231bdae291d8ca20ab90336a0fac86e6f796`。原生协议、浏览器登录、文件权限和账号备份解析源于该项目。账号备份、北京时间日历和浏览器路径模块按插件调用范围提取。

This plugin was extracted from the gateway's v0.5.0 source. Native protocol, browser sign-in, file permissions and backup parsing retain that source's provenance. Calendar, backup and browser-path modules contain the portions used by the plugin.

最初的网关来源为 [245678000000/doubao-work-gateway](https://github.com/245678000000/doubao-work-gateway)，提交 `a816f9bcb46d5ea0d7510214fca49c75e5bddd34`。该基线声明未另行选择仓库级复用许可。继承代码与素材保留原始声明。新增 Magpie 集成采用 [MIT 许可证](magpie/LICENSE)，范围见 [LICENSE](LICENSE)。

The original gateway baseline did not specify a repository-wide reuse license. Inherited code and assets retain their declarations. The original Magpie integration uses MIT within the scope described in LICENSE.

## 协议与接口 / Protocol and interfaces

接口与事件格式的上游参考包括豆包官网资源、[Agent2Providers](https://github.com/ProvidersPlugin/Agent2Providers)（提交 `3055f416841c1393ec04294a702603fd41e840aa`，项目声明 AGPL-3.0）和 [EchoBird](https://github.com/edison7009/EchoBird)。

Protocol references inherited from the gateway include Doubao web resources, Agent2Providers and EchoBird.

插件接口参考 [Magpie](https://github.com/yetone/magpie) 的 OpenCode 风格供应商钩子。浏览器会话通过 [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) 获取。Magpie 自身采用 MIT 许可。

The provider uses Magpie's OpenCode-style hooks and Chrome DevTools Protocol for isolated browser sessions.

## 品牌素材 / Brand asset

豆包头像用于供应商识别，品牌权益归原权利人。本插件由第三方维护。

The Doubao avatar identifies the provider. Brand rights remain with their owners. This plugin is maintained by an independent third party.
