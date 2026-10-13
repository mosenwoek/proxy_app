# Trakt 观看记录上报修复 - 全平台配置

## 📦 文件清单

| 文件 | 平台 | 大小 | 说明 |
|------|------|------|------|
| **trakt_enhanced_v2.plugin** | Loon | 13.9 KB | Loon 新版语法（推荐） |
| **trakt_enhanced_fixed.plugin** | Loon | 13.3 KB | Loon 旧版语法兼容 |
| **trakt_enhanced_fixed.sgmodule** | Surge | 13.9 KB | Surge 模块 |
| **trakt_enhanced_qx.snippet** | Quantumult X | 7.8 KB | QX 配置片段 |
| **trakt_simplified_chinese_fixed.js** | 通用 | 300 KB | 修复后的脚本（备用） |

---

## 🎯 核心修复内容

### 问题根源
使用「篡改应用授权」功能突破 10 个应用限制后，脚本改写 `trakt-api-key` 时丢失请求体，导致 `POST /scrobble/*` 和 `POST /sync/history` 发送空 body，Trakt 服务器拒绝记录观看历史。

### 修复方案
给匹配所有非 OAuth 的 Trakt API 请求的规则添加 `requires-body=true`（Loon/Surge）或使用 `script-request-header`（QX），确保脚本处理后请求体完整透传。

---

## 🚀 使用方法

### Loon（推荐使用新版 v2 语法）

#### 方法 1：Loon 3.5.1(983)+ 新版语法
```
1. 导入插件：配置 → 插件 → + → 本地插件
2. 粘贴 trakt_enhanced_v2.plugin 的全部内容
3. 开启「篡改应用授权」参数
4. 在第三方应用中重新授权 Trakt
```

**特点：**
- ✅ 使用 `request if ${url} ~= /.../ then script(...)` 新语法
- ✅ 参数用对象形式 `{${param1}, ${param2}}`
- ✅ Build 1007+ 完美兼容

#### 方法 2：Loon 旧版本或兼容模式
```
导入 trakt_enhanced_fixed.plugin（旧版 http-request 语法）
```

---

### Surge

```
1. 配置 → 模块 → 安装新模块
2. 粘贴 trakt_enhanced_fixed.sgmodule 内容或 URL
3. 编辑模块，找到「篡改应用授权」参数
4. 将 tamperAppAuthorizationEnabled 改为 true
5. 在第三方应用中重新授权 Trakt
```

**参数格式：**
```
#!arguments=...,tamperAppAuthorizationEnabled:true,...
```

**或在配置界面：**
- 点击模块 → 配置参数 → 篡改应用授权 = 开启

---

### Quantumult X

#### 基础配置（使用默认参数）

1. **添加重写规则**
   ```
   配置文件 → [rewrite_local] → 粘贴 trakt_enhanced_qx.snippet 中的规则
   ```

2. **添加 MitM 域名**
   ```
   [mitm] → hostname = 添加以下域名（逗号分隔）
   apiz.trakt.tv, api.trakt.tv, auth.trakt.tv, trakt.tv, 
   api.themoviedb.org, image.tmdb.org, loon-plugins.demojameson.de5.net
   ```

3. **默认参数**
   - 伪装 VIP: 开启
   - 目标语言: 简体中文
   - **篡改应用授权: 关闭** ⚠️

#### 开启「篡改应用授权」

QX 不支持插件参数系统，需要修改脚本开启。

**方法 1：使用修改后的脚本（推荐）**

1. 使用提供的 `trakt_simplified_chinese_fixed.js`
2. 在脚本**第 1 行**添加：
   ```javascript
   var $argument = "true,简体中文,原片语言,谷歌翻译,true,true,1,2,3,https://proxy-modules.demojameson.de5.net,true,关闭";
   ```
3. 将配置中所有规则的 URL 改为本地文件路径：
   ```
   ^https://... url script-request-header /path/to/trakt_simplified_chinese_fixed.js, tag=...
   ```

**方法 2：修改官方脚本源码**

1. 下载官方脚本：`trakt_simplified_chinese.js`
2. 搜索：`defaultValue:!1,type:"boolean",tag:"篡改应用授权"`
3. 将 `defaultValue:!1` 改为 `defaultValue:!0`
4. 保存并使用本地路径

**参数说明（逗号分隔的字符串）：**
```
位置 1: fakeVipEnabled (true/false)
位置 2: chineseLocale (简体中文/繁體中文（台灣）/繁體中文（香港）)
位置 3: posterImageMode (原片语言/简体中文/繁體中文（台灣）/繁體中文（香港）/原图)
位置 4: translationEngine (谷歌翻译/DeepLX/关闭)
位置 5: characterTranslationEnabled (true/false)
位置 6: historyEpisodesMergedByShow (true/false)
位置 7: forwardButtonOrder (0-3)
位置 8: infuseButtonOrder (0-3)
位置 9: rexButtonOrder (0-3)
位置 10: backendBaseUrl (URL 或留空)
位置 11: tamperAppAuthorizationEnabled (true/false) ← 关键参数
位置 12: debugMode (关闭/禁用本地缓存/禁用远端缓存/禁用所有缓存)
```

---

## ✅ 验证成功

### 1. 授权成功
在第三方应用（Infuse/Plex/Emby/Jellyfin/ePlayerX 等）中能成功连接 Trakt。

### 2. 观看记录上报成功

**测试方法：**
1. 在播放器中播放视频，拖动进度条到 **80% 以后**
2. 正常退出播放（用播放器的返回/停止按钮，不要杀进程）
3. 检查 Trakt 网站历史记录

**成功标志：**

**Loon/Surge 日志：**
```
POST https://api.trakt.tv/scrobble/stop
Status: 201 Created
Response Body: {"action":"scrobble","progress":85,...}
```

**QX 日志：**
```
[Trakt API Key Rewrite] script-request-header
Request Body: 存在（非空）
Response: 201 Created
```

**Trakt 网站：**
- 历史页面出现该影片
- 观看进度正确（>80%）
- 时间戳准确

---

## ⚠️ 重要说明

### Trakt Scrobble 规则
- `POST /scrobble/start` → 标记"正在播放"
- `POST /scrobble/stop` 且进度 < 80% → 不写历史，只更新"继续观看"
- `POST /scrobble/stop` 且进度 ≥ 80% → **写入历史记录** ✅

**常见误解：**
播放几分钟就退出，历史里看不到记录 → 这是正常的，需要看到 80% 以上。

### QX 特殊限制
Quantumult X 文档明确说明：**"The body related rewrite will not be executed if the body is empty."**

因此 `Trakt API Key Rewrite` 规则（同时匹配 GET 和 POST）必须用 `script-request-header`，不能用 `script-request-body`。QX 的 header 级别脚本会自动保留原始请求体。

### 播放器行为差异
不同播放器的 scrobble 实现不同：
- **Infuse**：实时 scrobble（start/pause/stop）
- **Plex**：通常用 `/sync/history` 批量上报
- **Emby/Jellyfin**：依赖插件，可能只发 start 不发 stop
- **ePlayerX**：已验证支持完整 scrobble 流程 ✅

---

## 🔧 故障排查

### 问题 1：授权成功但历史记录空白

**检查清单：**
1. ✅ 播放进度是否达到 80%
2. ✅ 是否正常退出播放（不是杀进程）
3. ✅ 播放器是否支持 scrobble
4. ✅ 查看代理日志是否有 `/scrobble/stop` 或 `/sync/history` 请求

**如果有上报请求但 Trakt 没记录：**
- 查看请求的 `content-length` 是否为 0
- 查看响应状态码（400/422 表示请求体有问题）

### 问题 2：Loon 插件脚本区不显示

参考 [导入故障排查.md](kelivo://workspace/导入故障排查.md)

### 问题 3：QX 规则不生效

1. 检查 MitM 是否启用并信任证书
2. 检查 hostname 是否包含所有必需域名
3. 如需开启篡改授权，确认已修改脚本或添加 `$argument`

---

## 📊 技术细节对比

| 平台 | 参数语法 | body 处理 | 修复方式 |
|------|----------|-----------|----------|
| **Loon v2** | `{${param}}` | `requires_body=true` | 配置添加参数 |
| **Loon 旧版** | `{param}` | `requires-body=true` | 配置添加参数 |
| **Surge** | `{{{param}}}` | `requires-body=true, max-size=0` | 配置添加参数 |
| **QX** | 位置式逗号字符串 | `script-request-header` 保留 body | 使用 header 级脚本 |

---

## 📝 更新日志

**2024-10-13 版本：**
- ✅ 修复观看记录上报失败（`POST /scrobble/*` 和 `/sync/history`）
- ✅ Loon 支持新版 v2 语法（build 983+）
- ✅ Surge 使用 `%APPEND%` 和三重花括号参数
- ✅ QX 使用 header 级脚本规避空 body 限制
- ✅ 已验证 ePlayerX 上报成功

**基于：**
- 原脚本：DemoJameson/trakt_simplified_chinese (2026-10-12)
- 测试平台：Loon 3.5.3(1007)、ePlayerX

---

## 🎬 使用建议

1. **首次使用：** 先在测试影片上拖到结尾验证，确认历史正常记录后再日常使用
2. **播放器选择：** 推荐 Infuse（实时 scrobble）或 Plex（批量同步）
3. **参数配置：** 日常使用默认参数即可，需要突破 10 个应用限制时再开启篡改授权
4. **定期检查：** 偶尔查看 Trakt 历史，确认上报正常

---

**修复完成 ✅**
**支持平台：** Loon / Surge / Quantumult X
**修复状态：** 已验证通过
**贡献者：** DemoJameson（原作者）+ 社区反馈
