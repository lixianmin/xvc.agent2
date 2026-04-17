# 设置修改后即时更新聊天页面名字

## 背景

当前用户名和 AI 昵称仅以头像首字母的形式出现在聊天消息中。设置页面修改名字后，已渲染的历史消息不会更新，需要刷新页面才能看到变化。

## 目标

1. 在每条消息的头像下方新增完整名字标签
2. 设置保存后，所有已渲染消息的头像首字母和名字标签立即更新，无需刷新

## 方案

使用 data 属性标记 + `querySelectorAll` 批量更新（方案 A），适合纯 Vanilla JS 项目，精准、轻量。

## 改动清单

### 1. 消息 HTML 结构变更

`appendUserMessage()` 和 `appendAssistantMessage()` 中，为头像元素添加 `data-role` 属性，并在头像下方新增名字标签元素。

用户消息结构：
```html
<div class="message user">
  <div class="message-avatar-wrap">
    <div class="message-avatar" data-role="user-avatar">X</div>
    <div class="message-name" data-role="user-name">小明</div>
  </div>
  <div class="message-body">
    <div class="message-bubble">...</div>
  </div>
</div>
```

AI 消息结构：
```html
<div class="message assistant">
  <div class="message-avatar-wrap">
    <div class="message-avatar" data-role="ai-avatar">J</div>
    <div class="message-name" data-role="ai-name">Jarvis</div>
  </div>
  <div class="message-body">
    <div class="message-bubble">...</div>
  </div>
</div>
```

### 2. CSS 变更

新增 `.message-avatar-wrap` 样式：
- 纵向 flex 布局，居中对齐
- 控制头像圆圈和名字标签的间距

新增 `.message-name` 样式：
- 小号字体（如 11px），灰色
- 最大宽度限制，文本超出省略（text-overflow: ellipsis）
- 仅显示一行（white-space: nowrap）

调整 `.message-avatar` 和 `.message-body` 在 `.message` flex 布局中的对齐方式。

### 3. 新增 `updateDisplayedNames()` 函数

读取 `state.userName` 和 `state.aiNickname`，通过 `querySelectorAll` 查找所有带 `data-role` 的元素并更新内容。

### 4. `saveSettings()` 调用 `updateDisplayedNames()`

在 `state` 更新完成后、关闭设置弹窗之前调用。

### 5. 不受影响的部分

- `renderMessages()` 加载历史消息时使用最新 `state` 值，无需改动
- 流式输出中的 AI 消息不受影响
- 滚动位置不变
- `renderMessages()` 中的 tool_call badge 渲染不受影响

## 文件影响范围

| 文件 | 改动 |
|------|------|
| `public/app.js` | 修改 `appendUserMessage()`、`appendAssistantMessage()`；新增 `updateDisplayedNames()`；修改 `saveSettings()` |
| `public/style.css` | 新增 `.message-avatar-wrap`、`.message-name` 样式；调整 `.message` 相关布局 |
