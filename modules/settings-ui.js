// Memory notebook: quiet theme-derived surfaces, a single primary action,
// and a message-range ribbon that explains summary/original overlap.
const ICONS = {
    book: '<path d="M12 7c-3-3-7-3-9-2v14c3-1 6-1 9 2 3-3 6-3 9-2V5c-2-1-6-1-9 2Z"/><path d="M12 7v14M6 9h3M6 13h3M16 9h2M16 13h2"/>',
    tune: '<path d="M4 6h16M4 12h16M4 18h16"/><path d="M8 3v6M16 9v6M10 15v6"/>',
    pen: '<path d="m16 3 5 5-12 12-6 1 1-6Z"/><path d="m13 6 5 5"/>',
    archive: '<path d="M4 8h16v13H4Z"/><path d="M3 3h18v5H3zM9 12h6"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    back: '<path d="M19 12H5m5-5-5 5 5 5"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 2M4 16l2 2a7 7 0 0 0 12-1"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    undo: '<path d="M4 4v6h6"/><path d="M4 10a8 8 0 1 1 1 8"/>',
    window: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M16 13h3v5h-7v-5Z"/>',
};

export function uiIcon(name) {
    return `<svg class="als-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] ?? ''}</svg>`;
}

export function settingsMarkup(version) {
    const tab = (name, label, icon, selected = false) => `<button type="button" class="als-tab${selected ? ' als-tab-active' : ''}" id="als-tab-${name}" data-tab="${name}" role="tab" aria-selected="${selected}" aria-controls="als-panel-${name}" tabindex="${selected ? '0' : '-1'}">${uiIcon(icon)}<span>${label}</span></button>`;
    return `
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <div class="als-heading"><span class="als-mascot als-brand-mark" aria-hidden="true"></span><b>喵喵大总结</b><span class="als-update-badge" hidden>meow!!</span></div>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <div class="als-topline"><span class="als-tagline">让故事继续，让记忆留下。</span><button type="button" class="als-icon-button als-open-floating" aria-label="打开悬浮面板" title="打开悬浮面板（也可恢复已关闭的入口）">${uiIcon('window')}</button><label class="als-switch als-master"><span>启用</span><input class="als-enabled" type="checkbox" aria-label="启用插件"><span class="als-switch-track" aria-hidden="true"></span></label></div>
          <div class="als-update-notice" hidden><span class="als-update-title"></span><button type="button" class="menu_button als-update-apply">更新</button><button type="button" class="als-update-dismiss als-icon-button" aria-label="关闭更新提示">×</button></div>
          <div class="als-tabs" role="tablist" aria-label="喵喵大总结">
            ${tab('overview', '概览', 'book', true)}${tab('settings', '设置', 'tune')}${tab('prompt', '提示词', 'pen')}${tab('directory', '记录', 'archive')}
          </div>
          <div class="als-notice"><span class="als-status-dot" aria-hidden="true"></span><div class="als-status" role="status" aria-live="polite">正在读取当前存档…</div></div>
          <div class="als-task-row"><div class="als-task-track"><span aria-hidden="true"></span><small class="als-task-state" role="status"></small></div><button type="button" class="menu_button als-cancel" hidden>取消本次任务</button></div>
          <details class="als-live-result als-disclosure" hidden><summary>查看正在生成的正文</summary><div class="als-disclosure-body"><p class="als-help">完整结束后才会保存并隐藏旧消息；中断内容会留在概览中供复制。</p><textarea class="text_pole als-live-text" rows="6" readonly aria-label="正在生成的总结正文"></textarea></div></details>

          <div class="als-panel" id="als-panel-overview" data-panel="overview" role="tabpanel" aria-labelledby="als-tab-overview">
            <section class="als-overview">
              <div class="als-section-heading"><span class="als-eyebrow">当前存档</span><span class="als-state-badge">读取中</span></div>
              <h3 class="als-chat-title">请选择一个聊天存档</h3><p class="als-chat-detail als-muted"></p>
              <div class="als-token-line"><span><small>最近计数</small><strong class="als-token-count">—</strong><small>token</small></span><button type="button" class="als-icon-button als-refresh-context" aria-label="重新计算上下文 token" title="重新计算上下文 token">${uiIcon('refresh')}</button></div><p class="als-token-threshold als-help"></p>
              <div class="als-scope">
                <div class="als-scope-heading"><span>总结当前上下文，保留最近原文</span><button type="button" class="als-text-button als-go-settings">调整</button></div>
                <div class="als-range-ribbon" aria-hidden="true"><span class="als-range-hidden"></span><span class="als-range-old"></span><span class="als-range-recent"></span></div>
                <div class="als-range-labels"><div><span class="als-range-key als-range-key-hidden"><i></i>已经隐藏</span><strong class="als-hidden-count">—</strong><small>当前实际状态</small></div><div><span class="als-range-key"><i></i>还将隐藏</span><strong class="als-hide-count">—</strong><small class="als-hide-range"></small></div><div><span class="als-range-key als-range-key-recent"><i></i>继续保留</span><strong class="als-keep-count">—</strong><small class="als-keep-range"></small></div></div>
              </div>
              <div class="als-runtime"><span class="als-runtime-style"></span><span class="als-runtime-mode"></span><span class="als-runtime-api"></span></div>
              <p class="als-auto-status als-help" role="status"></p>
              <p class="als-action-context als-muted"></p>
              <button type="button" class="menu_button als-primary als-next-action" hidden></button>
              <button type="button" class="menu_button als-primary als-run"><span>立即总结并隐藏旧消息</span>${uiIcon('arrow')}</button>
              <button type="button" class="menu_button als-compact">仅合并已有总结</button>
              <p class="als-action-hint als-muted">仅合并只整理已有总结，不改变消息可见状态。</p>
              <p class="als-help als-source-warning" role="status" hidden>原文已改变，可选择更新记忆或保留现有总结继续使用。</p>
              <button type="button" class="menu_button als-rebuild" hidden>更新记忆（从有效总结接续）</button>
              <button type="button" class="menu_button als-retain-memory" hidden>不重构，保留现有总结</button>
            </section>
            <section class="als-last-section"><div class="als-section-heading"><h4>最近一次记忆</h4><button type="button" class="als-text-button als-view-current">查看正文 ${uiIcon('arrow')}</button></div><p class="als-summary-result" role="status"></p><p class="als-token-comparison als-help"></p><p class="als-last-operation als-muted">当前存档暂无总结。</p></section>
            <button type="button" class="menu_button als-carry-current" disabled>带总结开新聊天</button>
            <button type="button" class="menu_button als-choose-import" hidden>从旧档导入总结</button>
            <details class="als-incomplete-result als-disclosure" hidden><summary>未完成的总结草稿</summary><div class="als-disclosure-body"><p class="als-incomplete-reason als-help"></p><p class="als-draft-state als-help" role="status"></p><textarea class="text_pole als-incomplete-text" rows="8" readonly aria-label="未完成的总结正文"></textarea><div class="als-actions"><button type="button" class="menu_button als-incomplete-copy">复制未完成结果</button><button type="button" class="menu_button als-incomplete-download">下载未完成正文</button><button type="button" class="menu_button als-incomplete-retry" hidden>重试本地存储</button><button type="button" class="als-text-button als-incomplete-delete">删除这份草稿</button></div></div></details>
            <details class="als-recovery als-disclosure"><summary>${uiIcon('undo')}<span>恢复与撤销</span><span class="als-disclosure-note">最近一次操作</span></summary>
              <p class="als-help">一键退回本次整理前的记忆与原文，也可以分别处理。此前隐藏的消息保持原样。</p>
              <div class="als-recovery-actions">
                <div><button type="button" class="menu_button als-undo-restore" disabled>撤销本次整理并恢复原文</button><small>本次总结保留在历史中，不重新调用模型。</small></div>
                <div><button type="button" class="menu_button als-retry-hide" disabled>只重试隐藏</button><small>总结已保存，直接完成隐藏，不再调用模型。</small></div>
                <div><button type="button" class="menu_button als-restore" disabled>恢复本轮隐藏的消息</button><small>仅恢复本轮改变的消息，原先隐藏的保持原样。</small></div>
                <div><button type="button" class="menu_button als-undo" disabled>撤销最近一次总结</button><small>恢复之前的注入正文，本次输出保留在历史中。</small></div>
              </div><p class="als-help">后续修改过原文或隐藏状态时，自动恢复会停止，避免覆盖你的操作。</p>
            </details>
            <div class="als-book-state"><span class="als-book-status als-muted">正在读取世界书状态…</span><button type="button" class="als-icon-button als-book-check" aria-label="刷新世界书状态" title="刷新世界书状态">${uiIcon('refresh')}</button></div>
          </div>

          <div class="als-panel" id="als-panel-settings" data-panel="settings" role="tabpanel" aria-labelledby="als-tab-settings" hidden>
            <div class="als-page-heading"><h3>让总结按你的节奏进行</h3><p>修改后保存生效。总开关会立即生效。</p></div>
            <section class="als-form-section"><h4>自动与保留</h4>
              <label class="als-switch als-switch-row"><span><strong>自动总结</strong><small>达到阈值时自动整理；关闭后仍可手动总结。</small></span><input class="als-auto-enabled" type="checkbox" aria-label="自动总结"><span class="als-switch-track" aria-hidden="true"></span></label>
              <div class="als-grid"><label class="als-field">触发 token 数<input class="text_pole als-threshold" type="number" min="1" step="1000"></label><label class="als-field">保留最近消息条数<input class="text_pole als-keep" type="number" min="1" step="1"></label></div>
              <small class="als-keep-help als-help">20 条消息通常约为 10 轮问答；保留数量只决定隐藏边界。</small>
              <p class="als-help als-budget-warning" role="status" hidden></p>
            </section>
            <section class="als-form-section"><h4>总结方式</h4>
              <div class="als-grid"><label class="als-field">提示词风格<select class="text_pole als-style als-settings-style"><option value="traditional">传统详述</option><option value="memory">结构记忆</option></select></label><label class="als-field">运行模式<select class="text_pole als-mode als-settings-mode"><option value="incremental">多次大总结</option><option value="merged">合并大总结</option></select></label></div>
              <p class="als-style-description als-help"></p><p class="als-mode-description als-help"></p>
            </section>
            <section class="als-form-section"><h4>API 与模型</h4><label class="als-field">总结使用的 API<select class="text_pole als-api-mode"><option value="main">主 API · 跟随当前酒馆连接</option><option value="secondary">副 API · OpenAI 兼容接口</option></select></label>
              <label class="als-switch als-switch-row"><span><strong>流式接收总结</strong><small>显示实时进度与正文。仅影响总结；接口不支持时可关闭。</small></span><input class="als-stream-summary" type="checkbox" aria-label="流式接收总结"><span class="als-switch-track" aria-hidden="true"></span></label>
              <p class="als-help">支持聊天补全主 API 和副 API；其他主 API 沿用完整响应。模型长时间无响应或中转缓冲时，流式仍可能超时。</p>
              <div class="als-secondary-settings" hidden><p class="als-help">只用于总结，不改变聊天连接。采样使用副接口默认值，输出上限 65536 token，不继承主 API 的采样参数、停止词和随机种子喵。</p>
                <label class="als-field">副 API 基础 URL<input class="text_pole als-secondary-url" type="url" placeholder="https://api.example.com/v1" autocomplete="off" spellcheck="false"></label>
                <label class="als-field">副 API Key<input class="text_pole als-secondary-key" type="password" placeholder="无密钥服务可留空" autocomplete="new-password" spellcheck="false"></label>
                <div class="als-model-state"><small class="als-model-status als-muted" role="status">填写连接信息后自动拉取模型。</small><button type="button" class="menu_button als-model-fetch">拉取模型</button></div>
                <label class="als-field">副 API 模型<select class="text_pole als-model-select" aria-label="选择副 API 模型"></select></label>
                <label class="als-field als-model-manual-field" hidden>手动填写模型名<input class="text_pole als-secondary-model" type="text" placeholder="输入完整模型 ID" autocomplete="off" spellcheck="false"></label>
              </div>
            </section>
            <section class="als-form-section"><h4>界面</h4>
              <label class="als-switch als-switch-row"><span><strong>显示悬浮入口</strong><small>立即生效，记住当前浏览器的选择。关闭后仍可从扩展面板打开。</small></span><input class="als-floating-visible" type="checkbox" aria-label="显示悬浮入口"><span class="als-switch-track" aria-hidden="true"></span></label>
              <label class="als-switch als-switch-row"><span><strong>靠边自动精简</strong><small>拖到左右边缘松手后，只显示最近 token 计数；点击展开，拖离恢复。立即生效，记住当前浏览器的选择。</small></span><input class="als-floating-compact" type="checkbox" aria-label="靠边自动精简"><span class="als-switch-track" aria-hidden="true"></span></label>
            </section>
            <details class="als-disclosure als-advanced"><summary>${uiIcon('tune')}<span>世界书与指令位置</span><span class="als-disclosure-note">高级设置</span></summary><div class="als-disclosure-body">
              <label class="als-field">世界书名称<input class="text_pole als-book" type="text" maxlength="80"></label>
              <label class="als-field">世界书插入深度<input class="text_pole als-depth" type="number" min="0" step="1"></label><p class="als-help">首次总结自动创建并挂载世界书，每个存档独立保存。</p>
              <label class="als-field">总结指令模式<select class="text_pole als-instruction-position"><option value="tail">独立总结任务（默认）</option><option value="before">角色定义之前（↑ Char）</option><option value="after">角色定义之后（↓ Char）</option><option value="depth">聊天深度（@D）</option></select></label>
              <div class="als-grid"><label class="als-field als-instruction-depth-field" hidden>指令深度<input class="text_pole als-instruction-depth" type="number" min="0" max="10000" step="1"></label><label class="als-field als-instruction-role-field" hidden>指令角色<select class="text_pole als-instruction-role"><option value="0">system（系统）</option><option value="1">user（用户）</option><option value="2">assistant（助手）</option></select></label></div>
              <p class="als-help">默认将完整上下文作为资料，独立执行总结，避免续写预设干扰；其他选项沿用原生位置注入。世界书深度只影响保存后的记忆注入。</p>
              <button type="button" class="als-text-button als-settings-reset">回到默认设置</button>
            </div></details>
            <div class="als-savebar"><small class="als-settings-state" role="status">设置已保存</small><div class="als-save-actions"><button type="button" class="menu_button als-settings-discard">撤回修改</button><button type="button" class="menu_button als-primary als-settings-save">保存设置</button></div></div>
          </div>

          <div class="als-panel" id="als-panel-prompt" data-panel="prompt" role="tabpanel" aria-labelledby="als-tab-prompt" hidden>
            <div class="als-page-heading"><h3>决定哪些细节值得留下</h3><p>两套风格各有新增、合并模板，分别保存，支持酒馆宏。</p></div>
            <div class="als-running-template"><span class="als-eyebrow">实际运行模板</span><strong class="als-running-template-name"></strong><button type="button" class="als-text-button als-edit-running">编辑当前运行模板</button></div>
            <div class="als-grid"><label class="als-field">编辑风格<select class="text_pole als-style als-prompt-style"><option value="traditional">传统详述</option><option value="memory">结构记忆</option></select></label><label class="als-field">编辑模式<select class="text_pole als-mode als-prompt-mode"><option value="incremental">多次大总结</option><option value="merged">合并大总结</option></select></label></div>
            <p class="als-prompt-context als-help"></p><small class="als-prompt-usage" role="status"></small>
            <label class="als-prompt-label"><span class="als-editor-heading">总结指令 <span class="als-prompt-length"></span></span><textarea class="text_pole als-prompt" rows="15" spellcheck="false" aria-label="大总结提示词"></textarea></label>
            <details class="als-disclosure als-prompt-help"><summary><span>编辑提示</span></summary><p class="als-help">传统详述沿用事件与角色表，结构记忆按六类信息整理。{{user}} 等宏会在发送时展开。此处切换只改变编辑对象；“保存并使用此模板”会同时启用对应风格和模式。普通保存仅更新模板；两种保存都保留其他草稿。恢复默认只影响正在编辑的一份模板，保存后生效。</p><button type="button" class="als-text-button als-prompt-reset">回到默认提示词</button></details>
            <div class="als-savebar"><small class="als-prompt-state" role="status">提示词已保存</small><div class="als-save-actions"><button type="button" class="menu_button als-prompt-discard">撤回修改</button><button type="button" class="menu_button als-prompt-save">仅保存模板</button><button type="button" class="menu_button als-primary als-prompt-use">保存并使用此模板</button></div></div>
          </div>

          <div class="als-panel" id="als-panel-directory" data-panel="directory" role="tabpanel" aria-labelledby="als-tab-directory" hidden>
            <div class="als-directory-list">
              <div class="als-page-heading"><h3>故事的记忆存档</h3><p>查看当前注入内容，也可以回到某一次总结。</p></div>
              <div class="als-directory-tools"><input class="text_pole als-directory-search" type="search" placeholder="搜索角色或存档" aria-label="搜索角色或聊天存档"><select class="text_pole als-card-filter" aria-label="筛选角色"><option value="">所有角色</option></select></div>
              <div class="als-directory-heading"><small class="als-directory-count als-muted">暂无记录</small><button type="button" class="als-icon-button als-directory-refresh" aria-label="刷新目录" title="刷新目录">${uiIcon('refresh')}</button></div>
              <div class="als-tree"></div><div class="als-pagination"><button type="button" class="menu_button als-page-prev">上一页</button><span class="als-page-label">1 / 1</span><button type="button" class="menu_button als-page-next">下一页</button></div>
            </div>
            <div class="als-preview-box" hidden>
              <div class="als-reader-toolbar"><button type="button" class="als-text-button als-preview-close">${uiIcon('back')} 返回记录</button><div class="als-actions"><button type="button" class="als-text-button als-download-summary">下载原文</button><button type="button" class="als-icon-button als-copy-summary" aria-label="复制总结原文" title="复制总结原文">${uiIcon('copy')}</button></div></div>
              <h3 class="als-preview-title"></h3>
              <label class="als-field">查看内容<select class="text_pole als-history-select" aria-label="选择总结轮次"></select></label>
              <div class="als-record-actions"><button type="button" class="menu_button als-import-record" hidden>导入到当前聊天</button><button type="button" class="als-text-button als-carry-record" hidden>带总结开新聊天</button><button type="button" class="als-text-button als-danger als-delete-round" disabled>删除选中轮次</button><button type="button" class="als-text-button als-danger als-delete-archive">删除整档总结</button></div>
              <div class="als-reader-views" role="group" aria-label="总结显示方式"><button type="button" class="als-reader-mode" data-view="reading" aria-pressed="true">阅读</button><button type="button" class="als-reader-mode" data-view="source" aria-pressed="false">原文</button></div>
              <small class="als-record-detail als-muted"></small><article class="als-reading" aria-label="总结阅读内容" tabindex="0"></article><textarea class="text_pole als-preview" rows="12" readonly aria-label="总结原文" hidden></textarea>
            </div>
          </div>
          <footer class="als-footer"><span class="als-version">v${version} · NUE-喵喵电波</span><div class="als-update-state"><small class="als-update-status als-muted">尚未检查更新</small><button type="button" class="als-text-button als-update-check">检查更新</button></div></footer>
        </div>
      </div>`;
}
