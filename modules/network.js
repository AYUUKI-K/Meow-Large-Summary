// Generation may be long, but should not wait forever on a silent connection.
// This timer belongs to one request and is never used to race host writes.
export function createIdleWatchdog(onTimeout, timeoutMs = 300000) {
    let timer;
    const touch = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            const error = new Error('总结请求连续 5 分钟没有收到新数据，已停止等待。可点击“继续总结”重试未完成部分。');
            error.name = 'TimeoutError';
            onTimeout(error);
        }, timeoutMs);
    };
    touch();
    return { touch, dispose: () => clearTimeout(timer) };
}

// Bound reads and body consumption together. Never race a host write: a late
// write must settle before another archive can be activated.
export async function withRequestSignal(operation, { signal, timeoutMs = 30000 } = {}) {
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => {
        const error = new Error('请求超时，请检查连接后重试。');
        error.name = 'TimeoutError';
        controller.abort(error);
    }, timeoutMs);
    try {
        if (controller.signal.aborted) throw controller.signal.reason ?? new Error('请求已取消。');
        return await operation(controller.signal);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
    }
}

// Older Android/iOS WebViews lack AbortSignal.any. Keep this local so other
// extensions and the host retain their own fetch/AbortSignal implementations.
export function combineRequestSignals(signals) {
    const controller = new AbortController();
    const listeners = [];
    const dispose = () => {
        for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
        listeners.length = 0;
    };
    for (const signal of signals.filter(Boolean)) {
        const cancel = () => { controller.abort(signal.reason); dispose(); };
        if (signal.aborted) { cancel(); break; }
        signal.addEventListener('abort', cancel, { once: true });
        listeners.push([signal, cancel]);
    }
    return { signal: controller.signal, dispose };
}

export async function fetchJson(url, init = {}, options = {}) {
    return await withRequestSignal(async signal => {
        const response = await fetch(url, { ...init, signal });
        // Report the requested path, never credentials, query parameters, the
        // redirect destination or an arbitrary HTML/error response body.
        const endpoint = String(url).replace(/^[a-z][a-z\d+.-]*:\/\/[^/]+/i, '').split(/[?#]/)[0];
        const failure = (message, code) => {
            const error = new Error(`${options.label ?? '请求失败'}（HTTP ${response.status}，${endpoint}）：${message}`);
            error.status = response.status;
            error.code = code;
            return error;
        };
        if (!response.ok) {
            throw failure('请检查酒馆服务、登录状态及反向代理配置。', 'HTTP_ERROR');
        }
        if (response.status === 204) return null;
        // Keep body reads inside the timeout and outside the parse catch so
        // cancellation and interrupted connections retain their real errors.
        const body = await response.text();
        try { return JSON.parse(body); }
        catch {
            const html = /^\s*</.test(body) || /\btext\/html\b/i.test(response.headers?.get('content-type') ?? '');
            throw failure(html
                ? '接口返回了 HTML 页面，未返回 JSON 数据。可能是登录页、代理错误页或当前宿主不支持此接口；请检查登录状态、反向代理和宿主版本。'
                : body.trim() ? '接口返回的数据不是有效 JSON，请检查酒馆后台或代理日志。'
                    : '接口返回了空响应，请检查酒馆后台或代理日志。',
            html ? 'HTML_RESPONSE' : 'INVALID_JSON_RESPONSE');
        }
    }, { signal: init.signal, ...options });
}
