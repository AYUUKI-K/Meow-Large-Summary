// Internal host imports live here so version adaptation has one boundary.
export async function nativeScript() { return await import('/script.js'); }
export async function chatCompletionApi() { return await import('/scripts/openai.js'); }
export async function tokenizerApi() { return await import('/scripts/tokenizers.js'); }
export async function regexApi() { return await import('/scripts/extensions/regex/engine.js'); }

export function isTauriTavernHost() {
    // TT 2.3.0 exposes the public ABI and early flag, but not the newer host identity.
    // These are TT-specific; generic Tauri globals alone must not enable its preview.
    return Boolean(globalThis.__TAURITAVERN__?.abiVersion >= 1
        || globalThis.__TAURI_RUNNING__ === true
        || globalThis.__TAURITAVERN_HOST__);
}

export async function inputTokenBudget(context) {
    const native = await nativeScript();
    const read = native.getMaxPromptTokens ?? native.getMaxContextSize;
    if (typeof read === 'function') {
        const budget = Number(read());
        return Number.isFinite(budget) && budget > 0 ? budget : null;
    }
    if (context.mainApi === 'openai') {
        const budget = Number(context.chatCompletionSettings?.openai_max_context)
            - Number(context.chatCompletionSettings?.openai_max_tokens);
        return Number.isFinite(budget) && budget > 0 ? budget : null;
    }
    return null;
}

export async function worldInfoNames(context) {
    if (typeof context.getWorldInfoNames === 'function') return context.getWorldInfoNames();
    // ST 1.14–1.17 expose the live list from world-info, but not from context.
    const { world_names } = await import('/scripts/world-info.js');
    if (!Array.isArray(world_names)) throw new Error('酒馆没有返回有效的世界书列表，请刷新后重试。');
    return [...world_names];
}
