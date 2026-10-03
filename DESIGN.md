---
version: alpha
name: 到店
description: 本机 iPhone 自提检查与浏览器准备控制台
colors:
  background: "#f3f5f8"
  surface: "#ffffff"
  ink: "#172735"
  muted: "#5c6b78"
  line: "#dce3e9"
  accent: "#205adb"
typography:
  display:
    fontFamily: "Bahnschrift, Segoe UI, Microsoft YaHei, sans-serif"
  body:
    fontFamily: "Segoe UI, Microsoft YaHei, sans-serif"
  mono:
    fontFamily: "Cascadia Code, Consolas, monospace"
rounded:
  panel: "18px"
  control: "9px"
spacing:
  column-gap: "26px"
  page-max: "1248px"
omitted:
  - "components: single-screen component states specified below"
---

# 到店设计约定

## Overview
Product register。面向用户本人，支持云端看板与 Windows Chrome 本机使用；zh-CN，时间按用户浏览器显示。地区仅为 Bangkok，两家直营店可同时选择，再选择产品配置，下方展示实时库存。签名元素是紧凑配置台，不使用虚构商品图。避免营销落地页、大面积渐变与金融行情仪表盘样式。

## Colors
web/style.css 的 :root 是运行时 token 唯一所有者；此文件镜像其主要值。白色面板、蓝灰背景、蓝色主操作；琥珀色只用于尚未接入的购买流程说明，文字解释不依赖颜色。

## Typography
标题用系统 Bahnschrift，中文退回微软雅黑；正文 Segoe UI / 微软雅黑；时间用 Cascadia Code。无需下载字体。正文行高 1.6，日志紧凑，标题克制。

## Layout
最大宽 1248px，桌面 390px 配置栏加弹性状态栏；680px 以下单列。页面自然滚动，仅日志固定高度并内部滚动。表单与后台状态并列，不模拟执行动画。

## Elevation & Depth
细边框分层，不依赖阴影。无悬浮遮罩、无不可关闭弹窗。

## Shapes
面板圆角 18px，控件圆角 9px。配置确认条上下虚线，表示正在执行的购买条件。

## Components
唯一表单位于 web/index.html；地区使用原生单选 select，门店、型号、容量和颜色使用 checkbox。button、field、status、log 样式由全局 stylesheet 统一。可见 focus，错误用 #config-error（role=alert），进度用 #state-message（role=status），日志不逐条朗读。选择保存在 localStorage，并由 API 重新校验。

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Select/Listbox | native select in web/index.html | DESIGN.md | native | ui.test.mjs |
| Form | config-form + web/app.js | config.mjs | one configuration form | config.test.mjs, ui.test.mjs |
| Scrollbar | web/style.css | :root and global rule | log height only | ui.test.mjs |
| Toast | inline form-error / state-message | web/app.js | error / progress | ui.test.mjs |

## Motion
仅按钮 150ms hover；遵循 prefers-reduced-motion。无自动滚动，除非用户原先位于日志底部。

## Content
页面明确当前不能判断指定门店库存、不加购、不下单。必须区分接口失败与缺货；不显示虚构有货率或成功订单。无未经证实的官方隶属关系。
