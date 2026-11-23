const STORAGE_KEY = 'meow-large-summary-panel-v1';
const mounted = new WeakMap();
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;

export function clampPanelFrame(frame = {}, viewport) {
    if (!frame || typeof frame !== 'object') frame = {};
    const mobile = viewport.width <= 600;
    // Leave travel space on phones, including when loading an old full-screen frame.
    const roomWidth = Math.max(1, Math.min(viewport.width - 24, mobile ? Math.max(300, viewport.width - 48) : Infinity));
    const roomHeight = Math.max(1, Math.min(viewport.height - 24, mobile ? Math.max(280, Math.round(viewport.height * .8)) : Infinity));
    const width = Math.min(roomWidth, Math.max(Math.min(300, roomWidth), finite(frame.width, 400)));
    const height = Math.min(roomHeight, Math.max(Math.min(280, roomHeight), finite(frame.height, mobile ? Math.min(560, roomHeight) : Math.min(680, roomHeight - 64))));
    const x = Math.max(12, Math.min(viewport.width - width - 12, finite(frame.x, viewport.width - width - 20)));
    const y = Math.max(12, Math.min(viewport.height - height - 12, finite(frame.y, viewport.height - height - 88)));
    return { x, y, width, height };
}

export function clampLauncherPosition(position = {}, size, viewport) {
    if (!position || typeof position !== 'object') position = {};
    return {
        x: Math.max(12, Math.min(viewport.width - size.width - 12, finite(position.x, viewport.width - size.width - 20))),
        y: Math.max(12, Math.min(viewport.height - size.height - 12, finite(position.y, viewport.height - size.height - 88))),
    };
}

export function launcherDockSide(position, size, viewport) {
    const left = position.x - 12;
    const right = viewport.width - size.width - 12 - position.x;
    if (Math.min(left, right) > 24) return null;
    return left <= right ? 'left' : 'right';
}

export function dockedLauncherPosition(side, fraction, size, viewport) {
    const travel = Math.max(0, viewport.height - size.height - 24);
    return clampLauncherPosition({
        x: side === 'left' ? 12 : viewport.width - size.width - 12,
        y: 12 + Math.max(0, Math.min(1, finite(fraction, .5))) * travel,
    }, size, viewport);
}

export function launcherTokenText(tokens) {
    if (!Number.isFinite(tokens)) return '—';
    return tokens >= 1000 ? (tokens / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(tokens);
}

export function mountFloatingPanel(root, { onOpen = () => {} } = {}) {
    if (mounted.has(root)) return mounted.get(root);
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') ?? {}; } catch { /* Preferences are optional. */ }
    let open = false;
    let visible = saved.visible !== false;
    let drag = null;
    let frame = saved.frame ?? null;
    let launcherPosition = saved.launcherPosition ?? null;
    let autoCompact = saved.autoCompact !== false;
    let dockSide = autoCompact && ['left', 'right'].includes(saved.dockSide) ? saved.dockSide : null;
    let dockY = finite(saved.dockY, .5);
    let dockInView = false;
    let externalContainer = null;
    let externalWasOpen = false;
    let saveTimer;
    const lifecycle = new AbortController();
    const options = { signal: lifecycle.signal };
    const viewport = () => ({ width: window.innerWidth, height: window.visualViewport?.height ?? window.innerHeight });
    const home = document.createElement('div');
    home.className = 'als-dock-placeholder';
    home.hidden = true;
    const dock = document.createElement('button');
    dock.type = 'button';
    dock.className = 'menu_button';
    dock.innerHTML = '<span>喵喵大总结 · 悬浮窗已打开</span><span class="als-dock-action">收回这里</span>';
    home.append(dock);
    root.before(home);

    const shell = document.createElement('div');
    shell.className = 'als-settings als-floating-shell';
    const launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.className = 'als-float-launcher';
    launcher.setAttribute('aria-label', '打开总结悬浮窗口');
    launcher.setAttribute('aria-controls', root.id);
    launcher.setAttribute('aria-expanded', 'false');
    launcher.innerHTML = '<span class="als-mascot als-launcher-mascot" aria-hidden="true"></span><span class="als-launcher-label"><span class="als-launcher-caption"><span>总结</span><small class="als-launcher-count"></small></span><span class="als-float-mode als-launcher-mode">自动</span></span><span class="als-launcher-status" aria-hidden="true"></span>';
    shell.append(launcher);
    shell.hidden = !visible;
    document.body.append(shell);

    const header = document.createElement('div');
    header.className = 'als-floating-header';
    header.hidden = true;
    header.innerHTML = '<div class="als-floating-title"><button type="button" class="als-floating-grip" aria-label="移动悬浮窗口，方向键微调位置，Home 键复位" title="拖动标题栏移动；方向键微调，Home 键复位"><span class="als-mascot als-header-mascot" aria-hidden="true"></span><span>喵喵大总结</span><span class="als-grip-dots" aria-hidden="true">⠿</span></button></div><button type="button" class="als-icon-button als-floating-minimize" aria-label="收起悬浮窗口" title="收起悬浮窗口"><span aria-hidden="true">−</span></button><button type="button" class="als-text-button als-floating-close" title="关闭悬浮窗和猫咪入口，可从扩展面板重新打开">关闭悬浮窗</button>';
    root.prepend(header);
    const handle = header.querySelector('.als-floating-grip');
    const opener = root.querySelector('.als-open-floating');
    const settingsButton = root.querySelector('.als-open-settings');
    const navigation = root.querySelector('.als-navigation');
    const visibilityToggle = root.querySelector('.als-floating-visible');
    const compactToggle = root.querySelector('.als-floating-compact');
    const syncVisibility = () => {
        // Temporary phone avoidance is separate from the user's display and
        // position preferences. The launcher returns when the panel leaves view.
        shell.hidden = Boolean(externalContainer) || open || !visible || (viewport().width <= 600 && dockInView);
        if (visibilityToggle) visibilityToggle.checked = visible;
        if (compactToggle) compactToggle.checked = autoCompact;
        shell.dataset.dock = dockSide ?? '';
    };
    const focusHome = () => {
        if (opener?.getClientRects().length) { opener.focus(); return; }
        const drawerHeader = root.querySelector('.inline-drawer-header');
        if (!drawerHeader) return;
        if (!drawerHeader.hasAttribute('tabindex')) drawerHeader.setAttribute('tabindex', '-1');
        drawerHeader.focus();
    };

    const persist = (immediate = false) => {
        clearTimeout(saveTimer);
        const write = () => {
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ open: externalContainer ? externalWasOpen : open, visible, frame, launcherPosition, autoCompact, dockSide, dockY })); } catch { /* Private mode can reject writes. */ }
        };
        if (immediate) write();
        else saveTimer = setTimeout(write, 120);
    };
    const applyFrame = next => {
        frame = clampPanelFrame(next, viewport());
        Object.assign(root.style, { left: frame.x + 'px', top: frame.y + 'px', width: frame.width + 'px', height: frame.height + 'px' });
    };
    const applyLauncherPosition = (next, free = false) => {
        if (shell.hidden) return;
        const size = shell.getBoundingClientRect();
        launcherPosition = dockSide && !free && drag?.target !== launcher
            ? dockedLauncherPosition(dockSide, dockY, size, viewport())
            : clampLauncherPosition(next, size, viewport());
        Object.assign(shell.style, { left: launcherPosition.x + 'px', top: launcherPosition.y + 'px', right: 'auto', bottom: 'auto' });
    };
    const finishLauncherMovement = key => {
        const rect = shell.getBoundingClientRect();
        const candidate = launcherDockSide(rect, rect, viewport());
        const inward = (candidate === 'left' && key === 'ArrowRight') || (candidate === 'right' && key === 'ArrowLeft');
        const freeVertical = !dockSide && (key === 'ArrowUp' || key === 'ArrowDown');
        dockSide = autoCompact && !inward && !freeVertical ? candidate : null;
        syncVisibility();
        const size = shell.getBoundingClientRect();
        dockY = Math.max(0, Math.min(1, (rect.y - 12) / Math.max(1, viewport().height - size.height - 24)));
        applyLauncherPosition(rect);
    };
    const stopDrag = () => {
        const current = drag;
        drag = null;
        if (current?.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
    };
    const close = ({ focusDock = false, focus = true, save = true } = {}) => {
        if (!open) return;
        open = false;
        stopDrag();
        header.hidden = true;
        navigation.insertBefore(settingsButton, opener);
        root.classList.remove('als-floating');
        root.removeAttribute('role');
        root.removeAttribute('aria-label');
        root.removeAttribute('aria-modal');
        for (const property of ['left', 'top', 'width', 'height']) root.style.removeProperty(property);
        home.after(root);
        home.hidden = true;
        syncVisibility();
        if (launcherPosition || dockSide) applyLauncherPosition(launcherPosition);
        launcher.setAttribute('aria-expanded', 'false');
        if (save) persist(true);
        if (focus) {
            if (focusDock || shell.hidden) focusHome();
            else launcher.focus();
        }
    };
    const setVisible = value => {
        visible = Boolean(value);
        if (!visible && open) close({ focusDock: true });
        syncVisibility();
        if (visible && (launcherPosition || dockSide)) applyLauncherPosition(launcherPosition);
        persist(true);
    };
    const dismiss = () => {
        setVisible(false);
        focusHome();
    };
    const show = ({ focus = true } = {}) => {
        if (externalContainer) return;
        if (open) { if (focus) handle.focus(); return; }
        visible = true;
        open = true;
        document.body.append(root);
        root.classList.add('als-floating');
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'false');
        root.setAttribute('aria-label', '喵喵大总结悬浮面板');
        header.hidden = false;
        header.insertBefore(settingsButton, header.querySelector('.als-floating-minimize'));
        home.hidden = false;
        syncVisibility();
        launcher.setAttribute('aria-expanded', 'true');
        applyFrame(frame ?? saved.frame);
        onOpen();
        persist(true);
        if (focus) handle.focus();
    };
    const on = (target, event, callback) => target?.addEventListener(event, callback, options);
    on(opener, 'click', () => show());
    on(visibilityToggle, 'change', () => setVisible(visibilityToggle.checked));
    on(compactToggle, 'change', () => {
        autoCompact = compactToggle.checked;
        if (!autoCompact) dockSide = null;
        syncVisibility();
        if (launcherPosition) applyLauncherPosition(launcherPosition);
        persist(true);
    });
    on(dock, 'click', () => close({ focusDock: true }));
    on(header.querySelector('.als-floating-minimize'), 'click', () => close());
    on(header.querySelector('.als-floating-close'), 'click', dismiss);
    on(root, 'keydown', event => {
        if (open && event.key === 'Escape' && !event.defaultPrevented && event.target.tagName !== 'SELECT') {
            event.preventDefault();
            close();
        }
    });
    const bindMovement = (target, enabled, getPosition, move, reset, finish = () => {}, touchTap = null) => {
        let suppressClick = false;
        on(target, 'pointerdown', event => {
            if (!enabled() || drag || event.button !== 0 || event.isPrimary === false) return;
            suppressClick = false;
            const position = getPosition();
            drag = { target, pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: position.x, y: position.y };
            target.focus({ preventScroll: true });
            target.setPointerCapture(event.pointerId);
            event.preventDefault();
        });
        on(target, 'pointermove', event => {
            if (drag?.target !== target || drag.pointerId !== event.pointerId) return;
            const dx = event.clientX - drag.clientX, dy = event.clientY - drag.clientY;
            if (!suppressClick && Math.hypot(dx, dy) < 5) return;
            suppressClick = true;
            move({ x: drag.x + dx, y: drag.y + dy });
        });
        const endDrag = event => {
            if (drag?.target !== target || drag.pointerId !== event.pointerId) return;
            stopDrag();
            if (suppressClick && event.type === 'pointerup') finish();
            else if (target === launcher && dockSide) applyLauncherPosition(launcherPosition);
            // Browsers can suppress the first synthetic click after a touch drag.
            // Activate a stationary touch directly, then consume its optional click.
            if (event.type === 'pointerup' && event.pointerType === 'touch' && !suppressClick && touchTap) {
                suppressClick = true;
                event.preventDefault();
                touchTap();
            }
            persist(true);
        };
        on(target, 'pointerup', endDrag);
        on(target, 'pointercancel', endDrag);
        on(target, 'lostpointercapture', endDrag);
        // Register before the launcher's open handler: releasing a drag is not a tap.
        on(target, 'click', event => {
            if (suppressClick && event.detail !== 0) {
                event.preventDefault();
                event.stopImmediatePropagation();
            }
            suppressClick = false;
        });
        on(target, 'keydown', event => {
            if (!enabled() || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
            event.preventDefault();
            if (event.key === 'Home') reset();
            else {
                const position = getPosition();
                const step = event.shiftKey ? 40 : 8;
                move({ x: position.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
                    y: position.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0) });
                finish(event.key);
            }
            persist(true);
        });
    };
    bindMovement(handle, () => open, () => root.getBoundingClientRect(), position => applyFrame({ ...frame, ...position }), () => applyFrame({ ...frame, x: undefined, y: undefined }));
    bindMovement(launcher, () => !open && visible, () => shell.getBoundingClientRect(), position => applyLauncherPosition(position, true), () => {
        dockSide = null;
        launcherPosition = null;
        syncVisibility();
        for (const property of ['left', 'top', 'right', 'bottom']) shell.style.removeProperty(property);
    }, finishLauncherMovement, () => show());
    on(launcher, 'click', () => show());
    const resize = () => {
        stopDrag();
        syncVisibility();
        if (open) applyFrame(frame);
        else if (launcherPosition || dockSide) applyLauncherPosition(launcherPosition);
        persist();
    };
    on(window, 'resize', resize);
    on(window.visualViewport, 'resize', resize);
    const observer = new ResizeObserver(entries => {
        if (!open && !drag && (launcherPosition || dockSide) && entries.some(entry => entry.target === shell)) applyLauncherPosition(launcherPosition);
        if (!open || drag) return;
        const rect = root.getBoundingClientRect();
        if (Math.abs(rect.width - frame.width) < 1 && Math.abs(rect.height - frame.height) < 1) return;
        applyFrame({ ...frame, width: rect.width, height: rect.height });
        persist();
    });
    observer.observe(root);
    observer.observe(shell);
    const dockObserver = new IntersectionObserver(entries => {
        dockInView = entries.some(entry => entry.isIntersecting && entry.intersectionRect.height > 0);
        syncVisibility();
        if (launcherPosition || dockSide) applyLauncherPosition(launcherPosition);
    });
    dockObserver.observe(root.querySelector('.inline-drawer-content'));
    syncVisibility();
    if (launcherPosition || dockSide) applyLauncherPosition(launcherPosition);
    // Observe only while embedded. A removed host returns the original panel,
    // including its event listeners, unsaved drafts and in-flight task controls.
    const embeddingObserver = new MutationObserver(() => {
        if (externalContainer && (!externalContainer.isConnected || root.parentElement !== externalContainer)) {
            controller.unmount(externalContainer);
        }
    });
    const controller = {
        open: show, close, setVisible,
        mount(container) {
            if (!(container instanceof HTMLElement) || container.ownerDocument !== root.ownerDocument || !container.isConnected
                || container === root || root.contains(container)) throw new TypeError('请提供当前页面内已挂载的 HTML 容器。');
            if (externalContainer && externalContainer !== container) return false;
            if (externalContainer === container) return true;
            externalWasOpen = open;
            close({ focus: false, save: false });
            stopDrag();
            externalContainer = container;
            root.classList.add('als-embedded');
            container.append(root);
            syncVisibility();
            embeddingObserver.observe(document.body, { childList: true, subtree: true });
            return true;
        },
        unmount(container) {
            if (!externalContainer || externalContainer !== container) return false;
            embeddingObserver.disconnect();
            externalContainer = null;
            root.classList.remove('als-embedded');
            home.after(root);
            syncVisibility();
            if (launcherPosition || dockSide) applyLauncherPosition(launcherPosition);
            return true;
        },
        update({ busy = false, enabled = true, autoEnabled = true, tokens } = {}) {
            const pluginState = enabled ? '插件已开启' : '插件已关闭';
            const autoState = !autoEnabled ? (enabled ? '自动总结已关闭，可手动总结' : '自动总结已关闭，启用插件后可手动总结')
                : enabled ? '自动总结已开启，达到阈值后自动整理' : '自动总结开关已开启，插件关闭时暂停';
            const updateMode = (node, text, state, description) => {
                if (node.textContent !== text) node.textContent = text;
                node.dataset.state = state;
                node.title = description;
                node.setAttribute('aria-label', description);
            };
            updateMode(shell.querySelector('.als-launcher-mode'), !enabled ? '停用' : autoEnabled ? '自动' : '手动', !enabled ? 'off' : autoEnabled ? 'on' : 'manual', `${pluginState}；${autoState}`);
            launcher.classList.toggle('als-launcher-busy', busy);
            launcher.classList.toggle('als-launcher-paused', !enabled);
            const countDescription = Number.isFinite(tokens) ? `最近一次计数 ${tokens.toLocaleString()} token` : '尚无 token 计数';
            launcher.setAttribute('aria-label', `打开总结悬浮窗口，${countDescription}，${busy ? '任务处理中，' : ''}${pluginState}，${autoState}`);
            launcher.title = (busy ? '总结任务处理中' : '打开总结与记忆面板') + ` · ${countDescription} · ${pluginState} · ${autoState} · 拖动靠边可精简，拖离恢复；点击打开，方向键微调，Home 键复位`;
            launcher.querySelector('.als-launcher-count').textContent = launcherTokenText(tokens);
        },
        destroy() {
            controller.unmount(externalContainer);
            embeddingObserver.disconnect();
            stopDrag();
            close({ focusDock: true });
            lifecycle.abort();
            observer.disconnect();
            dockObserver.disconnect();
            clearTimeout(saveTimer);
            shell.remove();
            header.remove();
            home.remove();
            mounted.delete(root);
        },
    };
    mounted.set(root, controller);
    if (saved.open && visible) show({ focus: false });
    return controller;
}
