# Trakt 增强插件 - 观看记录上报修复版

## 📌 项目说明

本项目基于 [DemoJameson/Proxy.Modules](https://github.com/DemoJameson/Proxy.Modules) 的 `trakt_simplified_chinese` 模块进行修复和适配。

### 原作者信息
- **作者**: DemoJameson
- **原项目**: https://github.com/DemoJameson/Proxy.Modules
- **原始模块**: trakt_simplified_chinese
- **功能**: Trakt App 中文化 + 历史记录合并 + 跳转按钮 + VIP 伪装

### 修复者信息
- **修复者**: mosenwoek
- **GitHub**: [@mosenwoek](https://github.com/mosenwoek)
- **Telegram**: @m8p8m (moyan)
- **修复日期**: 2024-10-13
- **修复内容**: 解决「篡改应用授权」功能开启后观看记录无法上报的问题

---

## 🔧 修复内容

### 问题描述

使用原版插件开启「篡改应用授权」功能（用于突破 Trakt 10 个应用连接限制）后，出现以下问题：

1. ✅ 第三方应用能成功授权连接 Trakt
2. ✅ 播放视频时能看到"正在播放"状态
3. ❌ 但播放历史记录始终为空，`POST /scrobble/stop` 和 `POST /sync/history` 上报失败

### 根本原因

脚本的 `Trakt API Key Rewrite` 规则负责将第三方应用的 `client_id` 替换为 Trakt 官方 ID，匹配模式为：

```
^https:\/\/apiz?\.trakt\.tv\/(?!oauth\/).*$
```

这条规则同时匹配 GET（读取接口）和 POST（上报接口），但**原配置未声明需要读取请求体**。在 Loon/Surge 中，当脚本只改写请求头时，代理会丢弃原有请求体，导致 POST 请求变成空 body，Trakt 服务器返回 400/422 错误。

### 修复方案

**Loon / Surge:**
给 `Trakt API Key Rewrite` 规则添加 `requires-body=true`（Loon v2 语法为 `requires_body=true`），确保脚本处理后请求体完整透传。

**Quantumult X:**
使用 `script-request-header` 而非 `script-request-body`，因为 QX 的 body 级脚本不会在请求体为空时触发，会导致 GET 请求失效。Header 级脚本会自动保留原始请求体。

---

## 📦 文件列表

| 文件名 | 平台 | 说明 |
|--------|------|------|
| `trakt_enhanced_v2.plugin` | Loon 3.5.1(983)+ | 新版 Script v2 语法 |
| `trakt_enhanced_fixed.plugin` | Loon 旧版 | http-request 旧语法兼容 |
| `trakt_enhanced_fixed.sgmodule` | Surge | 模块配置文件 |
| `trakt_enhanced_qx.snippet` | Quantumult X | 配置片段 |
| `trakt_simplified_chinese_fixed.js` | 通用 | 修复后的脚本文件（备用） |

---

## 🚀 安装使用

详细的安装和配置说明请参阅 [README_全平台配置.md](./README_全平台配置.md)

### 快速开始

**Loon (推荐):**
```
1. 配置 → 插件 → + → 本地插件
2. 粘贴 trakt_enhanced_v2.plugin 全部内容
3. 开启「篡改应用授权」参数
4. 在第三方应用中重新授权 Trakt
```

**Surge:**
```
1. 配置 → 模块 → 安装新模块
2. 粘贴 trakt_enhanced_fixed.sgmodule 内容
3. 编辑参数：tamperAppAuthorizationEnabled = true
4. 在第三方应用中重新授权 Trakt
```

**Quantumult X:**
```
1. 复制 trakt_enhanced_qx.snippet 中的规则到 [rewrite_local]
2. 添加 hostname 到 [mitm]
3. 如需开启篡改授权，需下载脚本到本地并修改参数
```

---

## ✅ 验证测试

### 测试环境
- **测试平台**: Loon 3.5.3 (1007)
- **测试播放器**: ePlayerX
- **测试内容**: The Silence of the Lambs (沉默的羔羊)

### 测试结果
✅ 授权成功  
✅ 播放器能连接 Trakt  
✅ 播放进度达到 80% 后退出  
✅ `POST /scrobble/stop` 返回 201 Created  
✅ Trakt 网站历史记录正常显示  
✅ 观看进度和时间戳准确  

---

## 📝 修改记录

### 版本 1.0 (2024-10-13)

**Loon 插件 (v2 语法):**
```diff
# 第 53 行
- request if ${url} ~= /^https:\/\/apiz?\.trakt\.tv\/(?!oauth\/).*$/i then script("...") with tag="Trakt API Key Rewrite", timeout=10
+ request if ${url} ~= /^https:\/\/apiz?\.trakt\.tv\/(?!oauth\/).*$/i then script("...") with tag="Trakt API Key Rewrite", timeout=10, requires_body=true
```

**Loon 插件 (旧语法):**
```diff
# 第 53 行
- http-request ^https:\/\/apiz?\.trakt\.tv\/(?!oauth\/).*$ script-path=..., timeout=10, argument=[...]
+ http-request ^https:\/\/apiz?\.trakt\.tv\/(?!oauth\/).*$ script-path=..., requires-body=true, timeout=10, argument=[...]
```

**Surge 模块:**
```diff
# 第 40 行
- Trakt API Key Rewrite = type=http-request, pattern=^https:\/\/apiz?\.trakt\.tv\/(?!oauth\/).*$, timeout=10, argument="..."
+ Trakt API Key Rewrite = type=http-request, pattern=^https:\/\/apiz?\.trakt\.tv\/(?!oauth\/).*$, requires-body=true, max-size=0, timeout=10, argument="..."
```

**Quantumult X:**
```diff
# 使用 script-request-header 而非 script-request-body
- ^https:\/\/apiz?\.trakt\.tv\/(?!oauth\/).*$ url script-request-body ...
+ ^https:\/\/apiz?\.trakt\.tv\/(?!oauth\/).*$ url script-request-header ...
```

**JavaScript 脚本:**
- 无需修改，脚本本身支持 body 处理
- QX 用户如需开启篡改授权，可在脚本第 1 行添加 `var $argument = "..."`

---

## ⚠️ 注意事项

### Trakt Scrobble 规则
- 播放进度必须达到 **80% 以上**才会写入历史记录
- 低于 80% 的播放只会出现在"继续观看"，不进历史
- 必须正常退出播放（使用播放器的停止/返回按钮），不要直接杀进程

### 平台差异
- **Loon**: 原生支持插件参数，推荐使用新版 v2 语法
- **Surge**: 使用 `%APPEND%` hostname 和三重花括号参数 `{{{param}}}`
- **Quantumult X**: 不支持插件参数系统，需手动配置脚本

### 播放器兼容性
已验证支持：
- ✅ ePlayerX (已测试通过)
- ✅ Infuse (实时 scrobble)
- ✅ Plex (批量同步)
- ⚠️ Emby/Jellyfin (依赖插件，可能需要额外配置)

---

## 🙏 致谢

### 原作者
感谢 **DemoJameson** 开发了功能强大的 Trakt 增强模块，包括：
- Trakt App 完整中文化（简体/繁体台湾/繁体香港）
- 历史记录按电视剧智能合并
- 一键跳转 Forward/Infuse/Rex 等播放器
- VIP 功能伪装（去广告）
- 篡改应用授权突破 10 个应用限制

### 社区贡献
- 感谢 Loon/Surge/QX 社区提供的技术支持和文档
- 感谢用户反馈帮助定位问题

---

## 📄 许可证

本修复版本遵循原项目的许可证。

原项目地址: https://github.com/DemoJameson/Proxy.Modules

---

## 🔗 相关链接

- **原项目仓库**: https://github.com/DemoJameson/Proxy.Modules
- **Trakt 官网**: https://trakt.tv
- **Loon 官网**: https://nsloon.app
- **Surge 官网**: https://nssurge.com
- **Quantumult X**: https://quantumult.app

---

## 📧 反馈与支持

如果在使用过程中遇到问题：

1. **先检查**: 阅读 [README_全平台配置.md](./README_全平台配置.md) 的故障排查部分
2. **确认版本**: Loon 需 3.2.1+，Surge 需 5.0+，QX 需最新版
3. **查看日志**: 检查代理日志中的请求/响应内容
4. **提供信息**: 反馈时请附上平台版本、播放器、错误日志

---

## 🔄 更新计划

- [x] 修复观看记录上报问题
- [x] 支持 Loon Script v2 语法
- [x] 适配 Surge 模块格式
- [x] 提供 Quantumult X 配置
- [ ] 等待原作者合并修复（如果可能）

---

**最后更新**: 2024-10-13  
**当前版本**: 1.0  
**基于**: DemoJameson/trakt_simplified_chinese (2026-10-12)  
**测试状态**: ✅ 已通过验证
