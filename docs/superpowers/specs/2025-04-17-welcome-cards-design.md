# Welcome Cards Design

## Background

When a user creates a new thread, the chat area is blank with no guidance. Users don't know what the agent can do. Need a welcome screen with clickable capability cards.

## Goal

Show a card-based welcome screen on new empty threads. Each card represents a capability with a sample question. Clicking a card sends the sample question as a chat message.

## Cards

4 cards in 2x2 CSS Grid layout:

| Card | Icon | Title | Description | Sample Question |
|------|------|-------|-------------|-----------------|
| Task Management | 📋 | 任务管理 | 创建、查看、更新和删除任务 | "帮我创建一个高优先级任务：完成季度报告" |
| Web Search | 🔍 | 网络搜索 | 搜索互联网获取最新信息 | "搜索一下最新的 AI Agent 框架对比" |
| Document Search | 📄 | 文档检索 | 在已上传的文档中搜索相关内容 | "帮我查一下项目中关于部署的文档" |
| Web Fetch | 🌐 | 网页抓取 | 抓取指定URL的内容并分析 | "帮我抓取并总结这个网页的内容" |

## Behavior

- **Display**: Only when `activateChat()` creates a new thread with no messages
- **Dismiss**: When user sends first message (or clicks a card)
- **No re-show**: Switching back to an existing thread with messages does not show cards
- **Click action**: Fill input with sample question and auto-send

## Welcome Header

Above the cards, show a personalized greeting:

```
你好，{userName}！
我是{aiNickname}，你的AI助手
我可以帮你做这些事情：
```

## Implementation

### HTML Structure

Replace `#empty-state` content dynamically. Current `#empty-state` shows "Select a thread or start a new chat". Add a `#welcome-cards` container inside it:

```html
<div id="empty-state" class="empty-state">
    <div id="welcome-content" class="welcome-content">
        <h2 class="welcome-greeting"></h2>
        <p class="welcome-subtitle">我可以帮你做这些事情：</p>
        <div class="welcome-cards">
            <div class="welcome-card" data-message="...">
                <span class="card-icon">📋</span>
                <h3>任务管理</h3>
                <p>创建、查看、更新和删除任务</p>
            </div>
            <!-- ... 3 more cards -->
        </div>
    </div>
    <p class="empty-state-fallback">Select a thread or start a new chat</p>
</div>
```

### JS Changes

- `showWelcomeCards()`: Build greeting with `state.userName`/`state.aiNickname`, show `#welcome-content`, hide fallback text
- `showEmptyState()`: Hide welcome cards, show fallback text (original behavior)
- `activateChat()`: Call `showWelcomeCards()` for new threads
- Card click handler: Set `#message-input` value, call `sendMessage()`

### CSS

- `.welcome-content`: Centered, max-width 600px
- `.welcome-cards`: CSS Grid 2 columns, gap 12px
- `.welcome-card`: Rounded, border, hover effect (shadow + border-color change), cursor pointer
- `.card-icon`: Font-size 24px
- Responsive: Single column on mobile

## Files

| File | Change |
|------|--------|
| `public/app.js` | Add `showWelcomeCards()`, modify `showEmptyState()`/`activateChat()`, add card click handlers |
| `public/style.css` | Add `.welcome-content`, `.welcome-cards`, `.welcome-card` styles |
| `public/index.html` | Add `#welcome-content` structure inside `#empty-state` |
