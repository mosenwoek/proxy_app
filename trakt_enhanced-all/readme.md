# Trakt 增强插件 - 观看记录上报修复版

## 📁 文件清单

| 文件 | 平台 | 大小 | 说明 |
|------|------|------|------|
| **trakt_enhanced_v2.lpx** | Loon 3.5.1+ | 13.9 KB | 新版 v2 语法（推荐） |
| **trakt_enhanced_fixed.lpx** | Loon 旧版 | 13.3 KB | 旧版语法兼容 |
| **trakt_enhanced_fixed.sgmodule** | Surge | 13.9 KB | Surge 模块 |
| **trakt_enhanced_qx.snippet** | Quantumult X | 7.8 KB | QX 配置片段 |
| **trakt_simplified_chinese_fixed.js** | 通用 | 300 KB | 脚本文件（可选） |

---

## 🎯 核心修复

**问题:** 开启「篡改应用授权」后，播放历史无法上报  
**原因:** 脚本改写 API key 时丢失请求体  
**修复:** 给关键规则添加 `requires-body=true` / 使用 `script-request-header`  

---

## 🚀 快速导入

### Loon
```
配置 → 插件 → + → 粘贴 trakt_enhanced_v2.lpx 全部内容
开启「篡改应用授权」→ 在应用中重新授权 Trakt
```

### Surge
```
配置 → 模块 → 安装新模块 → 粘贴 trakt_enhanced_fixed.sgmodule
编辑参数 tamperAppAuthorizationEnabled = true
```

### Quantumult X
```
复制 trakt_enhanced_qx.snippet 中的规则到 [rewrite_local]
添加 hostname 到 [mitm]
如需篡改授权：下载脚本到本地，第 1 行添加 $argument
```

---

## ✅ 验证通过

- ✅ Loon 3.5.3 (1007) + ePlayerX
- ✅ POST /scrobble/stop 返回 201
- ✅ Trakt 历史记录正常显示

---

## 📖 详细文档

- **完整使用说明**: [README_全平台配置.md](./README_全平台配置.md)
- **项目信息与致谢**: [README_项目说明.md](./README_项目说明.md)

---

## 👤 致谢

**原作者**: DemoJameson  
**原项目**: https://github.com/DemoJameson/Proxy.Modules  
**修复者**: mosenwoek (GitHub: @mosenwoek | Telegram: @m8p8m)  
**修复日期**: 2024-10-13  

---

## ⚠️ 重要提示

1. **播放进度要求**: 必须达到 80% 以上才会写入历史记录
2. **退出方式**: 使用播放器的停止/返回按钮，不要杀进程
3. **QX 用户**: 默认不开启篡改授权，需手动配置脚本
4. **Loon 用户**: 推荐使用 v2 语法版本

---

**当前版本**: 1.0  
**基于**: DemoJameson/trakt_simplified_chinese (2026-10-12)  
**状态**: ✅ 已测试通过
