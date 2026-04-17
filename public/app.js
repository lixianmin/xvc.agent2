const LS_USER_ID = 'ai_assistant_user_id';
const LS_USER_NAME = 'ai_assistant_user_name';

const state = {
    userId: null,
    userName: null,
    aiNickname: null,
    conversations: [],
    currentConvId: null,
    currentView: 'chat',
    isStreaming: false,
    abortController: null,
};

const $ = (sel) => document.querySelector(sel);

function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}

async function api(method, path, body = null) {
    const opts = {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(state.userId ? { 'X-User-Id': String(state.userId) } : {}),
        },
    };
    if (body !== null) opts.body = JSON.stringify(body);
    const res = await fetch(`/api${path}`, opts);
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
}

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function showError(msg, onRetry = null) {
    $('#error-message').textContent = msg;
    show($('#error-banner'));
    const retryBtn = $('#error-retry');
    if (onRetry) {
        retryBtn.onclick = () => { hideError(); onRetry(); };
        show(retryBtn);
    } else {
        hide(retryBtn);
    }
}

function hideError() {
    hide($('#error-banner'));
}

function showView(name) {
    ['registration-view', 'main-view'].forEach(id => {
        const el = $(`#${id}`);
        if (id === `${name}-view`) show(el);
        else hide(el);
    });
}

function showPanel(name) {
    state.currentView = name;
    const panels = { chat: '#chat-panel', workspace: '#workspace-panel' };
    Object.entries(panels).forEach(([key, sel]) => {
        const el = $(sel);
        if (key === name) show(el);
        else hide(el);
    });
    const wsBtn = $('#workspace-btn');
    if (name === 'workspace') wsBtn.classList.add('active');
    else wsBtn.classList.remove('active');
}

function scrollToBottom() {
    const msgs = $('#messages');
    requestAnimationFrame(() => { msgs.scrollTop = msgs.scrollHeight; });
}

function autoResizeInput() {
    const input = $('#message-input');
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function getFileIcon(mime) {
    if (!mime) return '\u{1F4CE}';
    if (mime.startsWith('image/')) return '\u{1F5BC}';
    if (mime.includes('pdf')) return '\u{1F4C4}';
    if (mime.includes('word') || mime.includes('docx')) return '\u{1F4DD}';
    if (mime.includes('text')) return '\u{1F4C3}';
    return '\u{1F4CE}';
}

function setInputEnabled(enabled) {
    $('#message-input').disabled = !enabled;
    $('#send-btn').disabled = !enabled;
}

async function register(e) {
    e.preventDefault();
    const name = $('#reg-name').value.trim();
    const email = $('#reg-email').value.trim();
    if (!name || !email) return;

    const errEl = $('#reg-error');
    const btn = $('#reg-submit');
    btn.disabled = true;
    hide(errEl);

    try {
        const res = await api('POST', '/user/create', { name, email });
        state.userId = res.id;
        state.userName = res.name;
        localStorage.setItem(LS_USER_ID, String(res.id));
        localStorage.setItem(LS_USER_NAME, res.name);
        await enterApp();
    } catch (err) {
        errEl.textContent = err.message;
        show(errEl);
    } finally {
        btn.disabled = false;
    }
}

async function checkAuth() {
    const storedId = localStorage.getItem(LS_USER_ID);
    const storedName = localStorage.getItem(LS_USER_NAME);
    if (!storedId) {
        showView('registration');
        return;
    }
    try {
        state.userId = parseInt(storedId);
        state.userName = storedName;
        const res = await api('GET', `/user/${state.userId}`);
        state.userName = res.name;
        state.aiNickname = res.ai_nickname;
        localStorage.setItem(LS_USER_NAME, res.name);
        await enterApp();
    } catch {
        localStorage.removeItem(LS_USER_ID);
        localStorage.removeItem(LS_USER_NAME);
        state.userId = null;
        showView('registration');
    }
}

async function enterApp() {
    showView('main');
    await loadConversations();
}

async function loadConversations() {
    try {
        state.conversations = await api('GET', `/conversations/list?userId=${state.userId}`);
        renderConversations();
    } catch (err) {
        showError('Failed to load conversations', loadConversations);
    }
}

function renderConversations() {
    const list = $('#conversation-list');
    list.innerHTML = '';
    if (state.conversations.length === 0) {
        list.innerHTML = '<div style="padding:16px;color:var(--text-muted);text-align:center;font-size:13px;">No conversations yet</div>';
        return;
    }
    state.conversations.forEach(conv => {
        const item = document.createElement('div');
        item.className = `conv-item${conv.id === state.currentConvId ? ' active' : ''}`;
        item.dataset.id = conv.id;
        item.innerHTML = `
            <span class="conv-title">${escapeHtml(conv.title || 'New Conversation')}</span>
            <button class="conv-delete" title="Delete" aria-label="Delete conversation">&times;</button>
        `;
        item.addEventListener('click', (e) => {
            if (e.target.classList.contains('conv-delete')) return;
            selectConversation(conv.id);
        });
        item.querySelector('.conv-delete').addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm('Delete this conversation?')) removeConversation(conv.id);
        });
        list.appendChild(item);
    });
}

async function createConversation() {
    if (state.isStreaming) return;
    try {
        const conv = await api('POST', '/conversations/create', { userId: state.userId, title: null });
        state.conversations.unshift(conv);
        state.currentConvId = conv.id;
        renderConversations();
        activateChat();
    } catch (err) {
        showError('Failed to create conversation');
    }
}

async function selectConversation(id) {
    if (state.isStreaming) return;
    state.currentConvId = id;
    renderConversations();
    showPanel('chat');
    await loadMessages();
    closeSidebarMobile();
}

async function removeConversation(id) {
    try {
        await api('POST', '/conversations/delete', { id });
        state.conversations = state.conversations.filter(c => c.id !== id);
        if (state.currentConvId === id) {
            state.currentConvId = null;
            showEmptyState();
        }
        renderConversations();
    } catch {
        showError('Failed to delete conversation');
    }
}

function showEmptyState() {
    showPanel('chat');
    show($('#empty-state'));
    hide($('#messages'));
    setInputEnabled(false);
}

function activateChat() {
    showPanel('chat');
    hide($('#empty-state'));
    show($('#messages'));
    $('#messages').innerHTML = '';
    setInputEnabled(true);
    $('#message-input').focus();
}

async function loadMessages() {
    const msgs = $('#messages');
    const empty = $('#empty-state');
    msgs.innerHTML = '';
    hide(empty);
    show(msgs);
    setInputEnabled(true);
    try {
        const messages = await api('GET', `/conversations/${state.currentConvId}/messages`);
        renderMessages(messages);
    } catch {
        showError('Failed to load messages', loadMessages);
    }
}

function renderMessages(messages) {
    const container = $('#messages');
    container.innerHTML = '';

    const toolResults = new Map();
    messages.forEach(msg => {
        if (msg.role === 'tool' && msg.tool_call_id) {
            toolResults.set(msg.tool_call_id, msg.content);
        }
    });

    messages.forEach(msg => {
        if (msg.role === 'tool') return;
        if (msg.role === 'user') {
            appendUserMessage(msg.content);
        } else if (msg.role === 'assistant') {
            const el = appendAssistantMessage(msg.content);
            const body = el.querySelector('.message-body');
            if (msg.tool_calls) {
                try {
                    const calls = JSON.parse(msg.tool_calls);
                    calls.forEach(call => {
                        let args = {};
                        try { args = JSON.parse(call.function.arguments); } catch {}
                        addToolCallBadge(body, call.function.name, args, call.id);
                        const result = toolResults.get(call.id);
                        if (result) updateToolCallBadge(call.id, result);
                    });
                } catch {}
            }
        }
    });
    scrollToBottom();
}

function appendUserMessage(content) {
    const container = $('#messages');
    const div = document.createElement('div');
    div.className = 'message user';
    const initial = (state.userName || 'U')[0].toUpperCase();
    div.innerHTML = `
        <div class="message-avatar">${escapeHtml(initial)}</div>
        <div class="message-body"><div class="message-bubble">${escapeHtml(content)}</div></div>
    `;
    container.appendChild(div);
    scrollToBottom();
    return div;
}

function appendAssistantMessage(content) {
    const container = $('#messages');
    const div = document.createElement('div');
    div.className = 'message assistant';
    div.innerHTML = `
        <div class="message-avatar">AI</div>
        <div class="message-body"><div class="message-bubble"></div></div>
    `;
    container.appendChild(div);
    if (content) {
        div.querySelector('.message-bubble').textContent = content;
    }
    scrollToBottom();
    return div;
}

function appendStatusMessage(content) {
    const container = $('#messages');
    const div = document.createElement('div');
    div.className = 'message status';
    div.innerHTML = `<div class="message-body"><div class="message-bubble">${escapeHtml(content)}</div></div>`;
    container.appendChild(div);
    scrollToBottom();
    return div;
}

function addToolCallBadge(parentEl, name, args, callId) {
    const badge = document.createElement('div');
    badge.className = 'tool-call-badge';
    badge.dataset.callId = callId;

    const entries = Object.entries(args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
    const display = entries.length > 60 ? entries.substring(0, 60) + '...' : entries;

    badge.innerHTML = `
        <div class="tool-call-header">
            <span class="tool-call-icon">\u{1F527}</span>
            <span class="tool-call-name">${escapeHtml(name)}(${escapeHtml(display)})</span>
            <span class="tool-call-toggle">\u25B6</span>
        </div>
        <div class="tool-call-result hidden"></div>
    `;

    badge.querySelector('.tool-call-header').addEventListener('click', () => {
        const result = badge.querySelector('.tool-call-result');
        const toggle = badge.querySelector('.tool-call-toggle');
        if (result.classList.contains('hidden')) {
            show(result);
            toggle.classList.add('expanded');
        } else {
            hide(result);
            toggle.classList.remove('expanded');
        }
    });

    parentEl.appendChild(badge);
    return badge;
}

function updateToolCallBadge(callId, result, isError = false) {
    const badge = document.querySelector(`.tool-call-badge[data-call-id="${callId}"]`);
    if (!badge) return;
    const resultEl = badge.querySelector('.tool-call-result');
    resultEl.textContent = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    if (isError) badge.classList.add('error');
    const toggle = badge.querySelector('.tool-call-toggle');
    show(resultEl);
    toggle.classList.add('expanded');
    scrollToBottom();
}

async function sendMessage() {
    const input = $('#message-input');
    const content = input.value.trim();
    if (!content || !state.currentConvId || state.isStreaming) return;

    input.value = '';
    autoResizeInput();
    state.isStreaming = true;
    setInputEnabled(false);
    hide($('#empty-state'));
    show($('#messages'));

    appendUserMessage(content);

    const conv = state.conversations.find(c => c.id === state.currentConvId);
    if (conv && !conv.title) {
        conv.title = content.length > 40 ? content.substring(0, 40) + '...' : content;
        renderConversations();
    }

    let statusEl = null;
    let assistantEl = null;
    let assistantBubble = null;
    let fullText = '';

    try {
        state.abortController = new AbortController();
        const res = await fetch(`/api/chat/${state.currentConvId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-User-Id': String(state.userId),
            },
            body: JSON.stringify({ content }),
            signal: state.abortController.signal,
        });

        console.log(`[chat] response status=${res.status}, content-type=${res.headers.get('content-type')}`);

        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || `HTTP ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6);
                if (data === '[DONE]') continue;

                try {
                    const event = JSON.parse(data);
                    switch (event.type) {
                        case 'text':
                            if (!assistantEl) {
                                if (statusEl) { statusEl.remove(); statusEl = null; }
                                assistantEl = appendAssistantMessage('');
                                assistantBubble = assistantEl.querySelector('.message-bubble');
                            }
                            fullText += event.content;
                            assistantBubble.textContent = fullText;
                            scrollToBottom();
                            break;
                        case 'tool_call':
                            if (!assistantEl) {
                                if (statusEl) { statusEl.remove(); statusEl = null; }
                                assistantEl = appendAssistantMessage(fullText);
                                assistantBubble = assistantEl.querySelector('.message-bubble');
                            }
                            addToolCallBadge(
                                assistantEl.querySelector('.message-body'),
                                event.name,
                                event.args || {},
                                event.call_id,
                            );
                            scrollToBottom();
                            break;
                        case 'tool_result':
                            updateToolCallBadge(event.call_id, event.result);
                            break;
                        case 'status':
                            statusEl = appendStatusMessage(event.content);
                            break;
                        case 'error':
                            if (statusEl) { statusEl.remove(); statusEl = null; }
                            showError(event.content || 'An error occurred');
                            break;
                        case 'limit_reached':
                            appendStatusMessage(event.content);
                            break;
                    }
                } catch {}
            }
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            appendStatusMessage('Request cancelled');
        } else {
            showError('Connection lost: ' + err.message, () => sendMessage());
        }
    } finally {
        state.isStreaming = false;
        state.abortController = null;
        setInputEnabled(true);
        $('#message-input').focus();
    }
}

async function loadFiles() {
    try {
        const files = await api('GET', `/files/list?userId=${state.userId}`);
        renderFiles(files);
    } catch {
        showError('Failed to load files', loadFiles);
    }
}

function renderFiles(files) {
    const list = $('#file-list');
    list.innerHTML = '';
    if (files.length === 0) {
        list.innerHTML = '<div style="padding:24px;color:var(--text-muted);text-align:center;">No files uploaded yet</div>';
        return;
    }
    files.forEach(file => {
        const item = document.createElement('div');
        item.className = 'file-item';
        item.innerHTML = `
            <span class="file-icon">${getFileIcon(file.mime_type)}</span>
            <div class="file-info">
                <div class="file-name">${escapeHtml(file.filename)}</div>
                <div class="file-meta">${formatSize(file.size)} &middot; ${escapeHtml(file.created_at || '')}</div>
            </div>
            <button class="file-delete" title="Delete" aria-label="Delete file">&times;</button>
        `;
        item.querySelector('.file-delete').addEventListener('click', () => removeFile(file.id));
        list.appendChild(item);
    });
}

async function uploadFiles(fileList) {
    if (!fileList || fileList.length === 0) return;
    const progressEl = $('#upload-progress');
    const fillEl = $('#progress-fill');
    const textEl = $('#progress-text');

    show(progressEl);

    for (let i = 0; i < fileList.length; i++) {
        const file = fileList[i];
        textEl.textContent = `Uploading ${file.name}...`;
        fillEl.style.width = '0%';

        try {
            const formData = new FormData();
            formData.append('file', file);

            await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.upload.addEventListener('progress', (e) => {
                    if (e.lengthComputable) {
                        fillEl.style.width = ((e.loaded / e.total) * 100) + '%';
                    }
                });
                xhr.addEventListener('load', () => {
                    if (xhr.status >= 200 && xhr.status < 300) resolve();
                    else reject(new Error(xhr.statusText || `HTTP ${xhr.status}`));
                });
                xhr.addEventListener('error', () => reject(new Error('Upload failed')));
                xhr.open('POST', '/api/files/upload');
                xhr.setRequestHeader('X-User-Id', String(state.userId));
                xhr.send(formData);
            });

            fillEl.style.width = '100%';
        } catch (err) {
            showError(`Failed to upload ${file.name}: ${err.message}`);
        }
    }

    hide(progressEl);
    fillEl.style.width = '0%';
    await loadFiles();
}

async function removeFile(id) {
    try {
        await api('POST', '/files/delete', { id });
        await loadFiles();
    } catch {
        showError('Failed to delete file');
    }
}

function openSettings() {
    show($('#settings-modal'));
    $('#settings-name').value = state.userName || '';
    $('#ai-nickname').value = state.aiNickname || '';
}

function closeSettings() {
    hide($('#settings-modal'));
}

async function saveSettings(e) {
    e.preventDefault();
    const name = $('#settings-name').value.trim();
    const nickname = $('#ai-nickname').value.trim();
    const errEl = $('#settings-error');
    hide(errEl);

    try {
        const res = await api('POST', '/user/update', {
            id: state.userId,
            ...(name ? { name } : {}),
            ...(nickname ? { ai_nickname: nickname } : {}),
        });
        state.userName = res.name;
        state.aiNickname = res.ai_nickname;
        localStorage.setItem(LS_USER_NAME, res.name);
        closeSettings();
    } catch (err) {
        errEl.textContent = err.message;
        show(errEl);
    }
}

function toggleSidebar() {
    $('#sidebar').classList.toggle('open');
}

function closeSidebarMobile() {
    $('#sidebar').classList.remove('open');
}

function bindEvents() {
    $('#registration-form').addEventListener('submit', register);
    $('#new-chat-btn').addEventListener('click', createConversation);
    $('#sidebar-toggle').addEventListener('click', toggleSidebar);

    $('#message-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
    $('#message-input').addEventListener('input', autoResizeInput);
    $('#send-btn').addEventListener('click', sendMessage);

    $('#workspace-btn').addEventListener('click', () => {
        if (state.currentView === 'workspace') {
            showPanel('chat');
        } else {
            showPanel('workspace');
            loadFiles();
        }
    });

    $('#settings-btn').addEventListener('click', openSettings);
    $('#close-settings').addEventListener('click', closeSettings);
    $('#settings-form').addEventListener('submit', saveSettings);
    $('#settings-modal .modal-overlay').addEventListener('click', closeSettings);

    $('#upload-area').addEventListener('click', () => $('#file-input').click());
    $('#file-input').addEventListener('change', (e) => {
        if (e.target.files.length > 0) uploadFiles(e.target.files);
        e.target.value = '';
    });

    $('#upload-area').addEventListener('dragover', (e) => {
        e.preventDefault();
        $('#upload-area').classList.add('dragover');
    });
    $('#upload-area').addEventListener('dragleave', () => {
        $('#upload-area').classList.remove('dragover');
    });
    $('#upload-area').addEventListener('drop', (e) => {
        e.preventDefault();
        $('#upload-area').classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) uploadFiles(e.dataTransfer.files);
    });

    $('#error-close').addEventListener('click', hideError);
}

async function init() {
    bindEvents();
    await checkAuth();
}

document.addEventListener('DOMContentLoaded', init);
