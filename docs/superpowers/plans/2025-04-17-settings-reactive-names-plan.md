# Settings Reactive Names Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make username and AI nickname changes in settings immediately update all rendered chat messages without page refresh.

**Architecture:** Add `data-role` attributes to avatar and name elements in rendered messages. Add a name label below each avatar. On settings save, call `updateDisplayedNames()` which uses `querySelectorAll` to batch-update all marked elements from `state`.

**Tech Stack:** Vanilla JS, CSS (no framework)

**Spec:** `docs/superpowers/specs/2025-04-17-settings-reactive-names-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `public/style.css:372-417` | Modify | Add `.message-avatar-wrap`, `.message-name` styles; adjust `.message-avatar` |
| `public/app.js:303-332` | Modify | Update `appendUserMessage()`, `appendAssistantMessage()` HTML structure |
| `public/app.js:646` | Modify | Add `updateDisplayedNames()` call in `saveSettings()` |
| `public/app.js:333` | Insert | New `updateDisplayedNames()` function |

---

## Chunk 1: CSS + JS Changes

### Task 1: Add CSS for avatar wrap and name label

**Files:**
- Modify: `public/style.css:372-392`

- [ ] **Step 1: Add `.message-avatar-wrap` and `.message-name` styles after `.message.user` block**

Insert after line 370 (after `.message.user { ... }`):

```css
.message-avatar-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex-shrink: 0;
    gap: 2px;
}

.message-name {
    font-size: 11px;
    color: var(--text-muted);
    max-width: 48px;
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
```

- [ ] **Step 2: Adjust `.message-avatar` — remove `flex-shrink: 0` (now on wrap)**

In `.message-avatar` (line 372-382), remove `flex-shrink: 0;` since it's now on `.message-avatar-wrap`.

### Task 2: Update `appendUserMessage()` HTML structure

**Files:**
- Modify: `public/app.js:303-315`

- [ ] **Step 1: Replace `appendUserMessage()` inner HTML**

In `public/app.js`, replace the `appendUserMessage` function body (lines 303-314):

```js
function appendUserMessage(content) {
    const container = $('#messages');
    const div = document.createElement('div');
    div.className = 'message user';
    const userName = state.userName || 'User';
    const initial = userName[0].toUpperCase();
    div.innerHTML = `
        <div class="message-avatar-wrap">
            <div class="message-avatar" data-role="user-avatar">${escapeHtml(initial)}</div>
            <div class="message-name" data-role="user-name">${escapeHtml(userName)}</div>
        </div>
        <div class="message-body"><div class="message-bubble">${escapeHtml(content)}</div></div>
    `;
    container.appendChild(div);
    scrollToBottom();
    return div;
}
```

### Task 3: Update `appendAssistantMessage()` HTML structure

**Files:**
- Modify: `public/app.js:317-332`

- [ ] **Step 1: Replace `appendAssistantMessage()` inner HTML**

Replace the `appendAssistantMessage` function body (lines 317-332):

```js
function appendAssistantMessage(content) {
    const container = $('#messages');
    const div = document.createElement('div');
    div.className = 'message assistant';
    const aiName = state.aiNickname || 'AI';
    const avatar = aiName[0].toUpperCase();
    div.innerHTML = `
        <div class="message-avatar-wrap">
            <div class="message-avatar" data-role="ai-avatar">${escapeHtml(avatar)}</div>
            <div class="message-name" data-role="ai-name">${escapeHtml(aiName)}</div>
        </div>
        <div class="message-body"><div class="message-bubble"></div></div>
    `;
    container.appendChild(div);
    if (content) {
        div.querySelector('.message-bubble').textContent = content;
    }
    scrollToBottom();
    return div;
}
```

### Task 4: Add `updateDisplayedNames()` function

**Files:**
- Modify: `public/app.js` (insert after `appendStatusMessage` around line 334)

- [ ] **Step 1: Add the function**

Insert after `appendStatusMessage` function:

```js
function updateDisplayedNames() {
    const userName = state.userName || 'User';
    const aiName = state.aiNickname || 'AI';

    document.querySelectorAll('[data-role="user-avatar"]').forEach(el => {
        el.textContent = userName[0].toUpperCase();
    });
    document.querySelectorAll('[data-role="user-name"]').forEach(el => {
        el.textContent = userName;
    });
    document.querySelectorAll('[data-role="ai-avatar"]').forEach(el => {
        el.textContent = aiName[0].toUpperCase();
    });
    document.querySelectorAll('[data-role="ai-name"]').forEach(el => {
        el.textContent = aiName;
    });
}
```

### Task 5: Call `updateDisplayedNames()` in `saveSettings()`

**Files:**
- Modify: `public/app.js:646`

- [ ] **Step 1: Add call after state update**

In `saveSettings()`, after line 645 (`localStorage.setItem(LS_USER_NAME, res.name);`) and before `closeSettings();`, insert:

```js
        updateDisplayedNames();
```

Also update the status message from `'设置已保存，下条消息生效'` to `'设置已保存'` since changes are now immediate.

### Task 6: Manual verification

- [ ] **Step 1: Start dev server and verify**

Run: `npx wrangler dev`

Verify:
1. Send a chat message — confirm user/AI names appear below avatars
2. Open Settings, change username and AI nickname, save
3. Confirm all existing messages immediately update both avatar initials and name labels
4. Send a new message — confirm it uses the updated names
5. Check mobile responsive layout
