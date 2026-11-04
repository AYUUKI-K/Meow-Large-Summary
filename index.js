import { LEGACY_DEFAULT_PROMPT, DEFAULT_PROMPT, DEFAULT_MERGED_PROMPT, DEFAULT_SETTINGS, PROMPT_STYLE_LABELS, defaultPrompt, promptTemplates, migrateDefaultPrompt } from './modules/settings.js';
import { settingsMarkup, uiIcon } from './modules/settings-ui.js';
import { renderSummaryReader } from './modules/summary-reader.js';
import { mountFloatingPanel } from './modules/floating-panel.js';
import { nativeScript, chatCompletionApi, tokenizerApi, regexApi, worldInfoNames, inputTokenBudget } from './modules/host-api.js';
import { activeRecords, archiveTransition, branchRecords, combineRecords, consecutiveRanges, entryRevision, historyDigest, memoryUpdateCheckpoint, messageFingerprint, recoveryMatches, sourceChangeAccepted, sourceDescription, summarySourceChanged, summaryScope, summaryResultText, automaticStatus, tokenComparisonText, textDigest, visibilityChanges } from './modules/summary-model.js';
import { createCoveragePlan, captureCoverageSources, missingCoverage, thresholdBudgetWarning } from './modules/source-coverage.js';
import { readWorldBook, saveVerifiedBook } from './modules/world-book.js';
import { setTaskStage, taskLabel } from './modules/task-state.js';
import { fetchJson, combineRequestSignals } from './modules/network.js';
import { verifyLegacyInjection } from './modules/injection-proof.js';
import { tauriPromptPreview } from './modules/tauri-prompt-preview.js';
import { completionFailure, promptContainsText, summaryOutputFailure } from './modules/generation-validation.js';
import { buildSummaryMessages, buildSummaryTextPrompt, SUMMARY_TASK_INSTRUCTION } from './modules/summary-prompt.js';
import { readSummaryStream, summaryResponseError, supportsSummaryStream } from './modules/summary-stream.js';
import { downloadText } from './modules/text-export.js';
import { createIncompleteDraftStore } from './modules/incomplete-drafts.js';

const MODULE_NAME = 'auto_large_summary';
const ENTRY_MARKER = 'auto_large_summary';
const EXTENSION_VERSION = '1.2.21';
const SECONDARY_MAX_TOKENS = 65536;
const SUMMARY_INJECTION_ID = 'meow_large_summary_instruction';

let settings;
let ui;
let pendingGeneration = null;
let runInProgress = false;
let activeRun = null;
let generationToken = 0;
let summaryTimer = null;
let promptProbe = null;
let summaryRequest = null;
let requestPreview = false;
let thresholdCheckInProgress = false;
let sendLockDepth = 0;
const lockedControls = new Map();
const SEND_CONTROL_SELECTOR = '#send_but, #option_continue, #option_regenerate, .swipe_left, .swipe_right, .als-settings input:not(.als-enabled), .als-settings .als-mode, .als-settings .als-style, .als-settings .als-api-mode, .als-model-select, .als-model-fetch, .als-settings .als-instruction-position, .als-settings .als-instruction-role, .als-settings .als-prompt, .als-run, .als-compact, .als-rebuild, .als-retain-memory, .als-retry-hide, .als-restore, .als-undo, .als-undo-restore, .als-settings-save, .als-settings-reset, .als-prompt-save, .als-prompt-use, .als-edit-running, .als-next-action, .als-prompt-reset, .als-delete-archive, .als-delete-round, .als-update-apply';
const worldBookPreparations = new Map();
const MODE_LABELS = { incremental: '多次大总结', merged: '合并大总结' };
const DIRECTORY_PAGE_SIZE = 8;
let directoryData = null;
let directoryBookName = '';
let directoryPage = 0;
let directoryRequest = 0;
let selectedSummary = null;
let promptDrafts = {};
let currentTab = 'overview';
let chatSyncRevision = 0;
let chatSyncChain = Promise.resolve();
let disabledCleanupPending = 0;
let archiveEditInProgress = false;
let settingsDraft = {};
let promptEditorMode = 'incremental';
let promptEditorStyle = 'traditional';
let updateCheckInProgress = false;
let updateInProgress = false;
let availableUpdate = null;
let dismissedUpdate = '';
let enabledRevision = 0;
let manualVisibilityRevision = 0;
let summaryHideInProgress = false;
let visibilityRefreshRevision = 0;
let visibilityRefreshTimer = null;
const visibilityCommandCallbacks = new WeakSet();
let enabledSaveChain = Promise.resolve();
let modelFetchRevision = 0;
let modelFetchTimer = null;
let modelFetchController = null;
let taskTimer = null;
let currentSummaryEntry = null;
let operationSequence = 0;
let initialized = false;
let floatingPanel = null;
let summaryReturnFocus = null;
let budgetWarning = '';
let budgetCheckRevision = 0;
let currentInputBudget = null;
let integrationReady = false;
let lastPublicState = '';
const incompleteResults = new Map();
const incompleteDraftStore = createIncompleteDraftStore();
const loadedIncompleteDrafts = new Set();
const draftSaveTimers = new Map();
const SETTING_FIELDS = ['enabled', 'autoEnabled', 'streamSummary', 'threshold', 'keepRecent', 'worldBookName', 'depth', 'mode', 'promptStyle', 'instructionPosition', 'instructionDepth', 'instructionRole', 'apiMode', 'secondaryUrl', 'secondaryKey', 'secondaryModel', 'secondaryModels'];
const INSTRUCTION_POSITIONS = { tail: null, before: 2, after: 0, depth: 1 };

function setStatus(message) {
    const status = ui?.querySelector('.als-status');
    const notice = ui?.querySelector('.als-notice');
    if (notice) notice.hidden = /^(自动总结已暂停，可手动总结|总结条目已同步|请选择角色卡的聊天存档)/.test(message);
    if (status) status.textContent = meowText(message);
    publishIntegrationState();
}

// Optional integration surface. No settings, chat text or credentials leave it.
function integrationState() {
    const archive = getContext()?.chatMetadata?.[MODULE_NAME];
    const busy = Boolean(runInProgress || thresholdCheckInProgress || sendLockDepth || archiveEditInProgress || disabledCleanupPending || updateInProgress);
    const paused = Boolean(archive?.summaryStillOverThreshold || archive?.coverageBlocked || archive?.sourceChanged || archive?.branch?.needsRebuild);
    return Object.freeze({
        ready: integrationReady, enabled: Boolean(settings?.enabled), autoEnabled: Boolean(settings?.autoEnabled),
        busy, paused, stage: activeRun?.stage ?? null,
        tokens: Number.isFinite(archive?.lastPromptTokens) ? archive.lastPromptTokens : null,
        sourceVersion: EXTENSION_VERSION,
        message: !integrationReady ? '喵喵大总结正在准备' : busy ? taskLabel(activeRun) || '喵喵大总结正在处理'
            : !settings?.enabled ? '大总结已关闭' : paused ? '自动总结已暂停，请查看大总结面板'
                : settings.autoEnabled ? '自动总结已开启' : '手动总结已就绪 · 自动触发关闭',
    });
}

function publishIntegrationState() {
    const state = integrationState();
    const serialized = JSON.stringify(state);
    if (serialized === lastPublicState) return;
    lastPublicState = serialized;
    window.dispatchEvent(new CustomEvent('meow-large-summary-state', { detail: state }));
    // Keep integrations using the original misspelling working.
    window.dispatchEvent(new CustomEvent('mewo-large-summary-state', { detail: state }));
}

export const integration = Object.freeze({
    getState: integrationState,
    async setEnabled(value) {
        if (typeof value !== 'boolean') throw new TypeError('enabled 必须是布尔值。');
        if (!integrationReady || (value && integrationState().busy)) return false;
        return await applyEnabledState(value);
    },
    async runManual({ operation = 'summary', mode = null } = {}) {
        if (!['summary', 'compact'].includes(operation)) throw new TypeError('operation 必须是 summary 或 compact。');
        if (mode !== null && (!Object.hasOwn(MODE_LABELS, mode) || operation !== 'summary')) throw new TypeError('mode 仅支持普通总结的 incremental 或 merged。');
        if (!integrationReady || !settings?.enabled || integrationState().busy) return false;
        return await runLargeSummary({ manual: true, operation, modeOverride: mode }) === true;
    },
    mount(container) {
        if (!integrationReady) return false;
        return floatingPanel.mount(container);
    },
    unmount(container) {
        return floatingPanel?.unmount(container) ?? false;
    },
});

window.MeowLargeSummary = integration;
window.MewoLargeSummary = integration; // Compatibility with integrations before 1.2.18.

function meowText(message) {
    const text = String(message ?? '');
    return !text || /^喵[，,!！]|喵[，,。!！？?…]|喵$|喵喵正在/.test(text)
        ? text : `${text.replace(/[。！!]$/, '')}喵。`;
}

function notify(kind, message, title = '喵喵大总结', options) {
    return window.toastr?.[kind]?.(meowText(message), title, options);
}

function loadIncompleteDraft(archiveId) {
    if (!archiveId || loadedIncompleteDrafts.has(archiveId)) return;
    loadedIncompleteDrafts.add(archiveId);
    if (incompleteResults.has(archiveId)) return;
    try {
        const draft = incompleteDraftStore.read(archiveId);
        if (draft) incompleteResults.set(archiveId, { ...draft, persisted: true });
    } catch {
        incompleteResults.set(archiveId, { content: '', reason: '本地草稿读取失败。', storageError: true });
    }
}

function flushIncompleteDraft(archiveId) {
    clearTimeout(draftSaveTimers.get(archiveId));
    draftSaveTimers.delete(archiveId);
    const draft = incompleteResults.get(archiveId);
    if (!draft?.content) return;
    try {
        incompleteDraftStore.write(archiveId, draft);
        draft.persisted = true;
        delete draft.storageError;
    } catch { draft.persisted = false; draft.storageError = true; }
}

function flushPendingIncompleteDrafts() {
    for (const [id, draft] of incompleteResults) if (draft.content && !draft.persisted) flushIncompleteDraft(id);
}

function rememberIncompleteDraft(archiveId, content, reason, { immediate = true } = {}) {
    if (!archiveId || !content.trim()) return;
    const first = !incompleteResults.has(archiveId);
    incompleteResults.set(archiveId, { content, reason, updatedAt: new Date().toISOString(), persisted: false });
    loadedIncompleteDrafts.add(archiveId);
    if (immediate || first) flushIncompleteDraft(archiveId);
    else if (!draftSaveTimers.has(archiveId)) draftSaveTimers.set(archiveId, setTimeout(() => flushIncompleteDraft(archiveId), 1000));
}

function removeIncompleteDraft(archiveId) {
    clearTimeout(draftSaveTimers.get(archiveId));
    draftSaveTimers.delete(archiveId);
    // Keep the in-memory text when removal fails so it remains exportable and
    // the user can retry. Never report that a disk draft has been deleted.
    try {
        incompleteDraftStore.remove(archiveId);
        incompleteResults.delete(archiveId);
        return true;
    } catch {
        const draft = incompleteResults.get(archiveId);
        if (draft) draft.storageError = true;
        notify('warning', '本地草稿清理失败，正文仍保留；请下载后重试删除。');
        return false;
    }
}

function lockSending() {
    sendLockDepth += 1;
    if (sendLockDepth !== 1) return;
    document.body?.classList.add('als-send-locked');
    for (const control of document.querySelectorAll(SEND_CONTROL_SELECTOR)) {
        // Keep the input's send action usable for local /hide and /unhide.
        // Conversation sends are blocked in the capture handler below.
        if (control.id === 'send_but') continue;
        lockedControls.set(control, { disabled: control.disabled, aria: control.getAttribute('aria-disabled') });
        if ('disabled' in control) control.disabled = true;
        control.setAttribute('aria-disabled', 'true');
    }
    publishIntegrationState();
}

function unlockSending() {
    if (sendLockDepth === 0) return;
    sendLockDepth -= 1;
    if (sendLockDepth !== 0) return;
    document.body?.classList.remove('als-send-locked');
    for (const [control, saved] of lockedControls) {
        if ('disabled' in control) control.disabled = saved.disabled;
        if (saved.aria === null) control.removeAttribute('aria-disabled');
        else control.setAttribute('aria-disabled', saved.aria);
    }
    lockedControls.clear();
    // Directory rows may have been replaced while the send lock was held.
    for (const control of ui?.querySelectorAll('.als-delete-archive') ?? []) control.disabled = false;
    const deleteRound = ui?.querySelector('.als-delete-round');
    if (deleteRound) deleteRound.disabled = !selectedSummary || ui.querySelector('.als-history-select').value === 'all';
    const modelButton = ui?.querySelector('.als-model-fetch');
    if (modelButton) modelButton.disabled = Boolean(modelFetchController);
    syncOperationalControls();
    publishIntegrationState();
}

function blockSendInput(event) {
    if (!settings?.enabled && !disabledCleanupPending) return;
    const target = event.target;
    const isSend = event.type === 'click' && target?.closest?.(SEND_CONTROL_SELECTOR);
    const isEnter = event.type === 'keydown' && target?.id === 'send_textarea'
        && event.key === 'Enter' && !event.shiftKey && !event.isComposing;
    const isSubmit = event.type === 'submit' && target?.querySelector?.('#send_textarea');
    if (!isSend && !isEnter && !isSubmit) return;
    const fromChatInput = isEnter || isSubmit || (isSend && target.closest('#send_but'));
    const input = document.querySelector('#send_textarea');
    const command = input?.value?.trim() ?? '';
    // Observe user intent without intercepting the native command. It also
    // invalidates a pending check when /hide leaves the flags unchanged.
    if (settings.enabled && fromChatInput && /^\/(?:hide|unhide)(?:\s|$)/i.test(command)) manualVisibilityRevision += 1;
    if (!sendLockDepth && !disabledCleanupPending) return;
    // ST owns all slash parsing, including pipelines, macros, script controls
    // and commands added by other extensions. Never consume their input here.
    if (fromChatInput && command.startsWith('/')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    notify('info', !settings.enabled ? '正在停用旧总结条目，完成后就能发送喵。' : '正在检查上下文或进行大总结，保存并隐藏旧楼层后才能继续发送。', '', { preventDuplicates: true });
}

function installVisibilityCommandHooks() {
    if (!settings?.enabled) return;
    const commands = getContext()?.SlashCommandParser?.commands;
    if (!commands) return;
    for (const name of ['hide', 'unhide']) {
        const command = commands[name];
        const original = command?.callback;
        if (typeof original !== 'function' || visibilityCommandCallbacks.has(original)) continue;
        // Keep ST's parser, arguments, filters, return value and errors intact.
        // The callback is observed only to refresh counts after ST has saved.
        const callback = async function (...args) {
            if (!settings?.enabled) return await original.apply(this, args);
            const ownHide = summaryHideInProgress;
            const context = getContext();
            if (!ownHide) {
                manualVisibilityRevision += 1;
                const archive = context?.chatMetadata?.[MODULE_NAME];
                if (archive) archive.visibilityEpoch = `${randomId()}-${++operationSequence}`;
            }
            try {
                return await original.apply(this, args);
            } finally {
                if (!ownHide) scheduleVisibilityRefresh(context);
            }
        };
        visibilityCommandCallbacks.add(callback);
        command.callback = callback;
    }
}

function scheduleVisibilityRefresh(context = getContext(), { afterSummary = false } = {}) {
    if (!settings?.enabled || !context || !getCharacterAndChat(context)) return;
    const revision = ++visibilityRefreshRevision;
    if (visibilityRefreshTimer) clearTimeout(visibilityRefreshTimer);
    visibilityRefreshTimer = setTimeout(() => {
        visibilityRefreshTimer = null;
        void refreshVisibilityTokens(context, revision, { afterSummary });
    }, 150);
}

async function renderNativeTokenCounter(context) {
    if (context.mainApi !== 'openai') return;
    const { promptManager } = await chatCompletionApi();
    // Native dry preparation updates its count cache, but doesn't render it.
    // false renders that cache without starting a second dry generation.
    promptManager?.render(false);
}

async function refreshVisibilityTokens(context, revision = visibilityRefreshRevision, { afterSummary = false } = {}) {
    const startEnabledRevision = enabledRevision;
    const currentRequest = () => settings?.enabled && enabledRevision === startEnabledRevision && revision === visibilityRefreshRevision
        && getContext()?.chat === context.chat && getContext()?.chatId === context.chatId
        && getContext()?.characterId === context.characterId;
    let locked = false;
    try {
        if (!currentRequest()) return;
        const native = await nativeScript();
        const deadline = Date.now() + 30000;
        while (currentRequest()) {
            const current = getContext();
            const busy = runInProgress || thresholdCheckInProgress || promptProbe || sendLockDepth || archiveEditInProgress
                || native.is_send_press || native.isGenerating?.()
                || (current.streamingProcessor && !current.streamingProcessor.isFinished)
                || document.body.dataset.generating === 'true'
                || document.querySelector('#form_sheld')?.classList.contains('isExecutingCommandsFromChatInput');
            if (!busy) break;
            if (Date.now() >= deadline) return;
            await new Promise(resolve => setTimeout(resolve, 150));
        }
        if (!currentRequest()) return;
        lockSending();
        locked = true;
        const snapshot = captureMessageRange(context.chat, context.chat.length - 1);
        const assembled = await assemblePrompt(context);
        if (!currentRequest()) return;
        const count = await countAssembledPrompt(context, assembled);
        if (!currentRequest() || !messageRangeMatches(context.chat, snapshot)) return;
        if (!Number.isFinite(count)) throw new Error('酒馆返回了无效的 token 数。');
        await renderNativeTokenCounter(context);
        if (!currentRequest()) return;
        const archive = context.chatMetadata?.[MODULE_NAME];
        if (archive) archive.lastPromptTokens = count;
        if (afterSummary && archive) {
            reportSummaryTokenCount(archive, count);
            await context.saveMetadata?.();
        } else {
            if (archive?.summaryStillOverThreshold && count < Math.max(1, Number(settings.threshold) || DEFAULT_SETTINGS.threshold)) {
                archive.summaryStillOverThreshold = false;
                archive.autoTriggerArmed = true;
                await context.saveMetadata?.();
            }
            if (currentRequest()) setStatus(`最近一次上下文计数：${count.toLocaleString()} token。`);
        }
        // A manual visibility edit only refreshes counts. Never evaluate the
        // threshold for generation, sync world info, or issue another /hide.
        // Falling below the threshold only clears the over-limit pause.
    } catch (error) {
        if (currentRequest()) setStatus(`楼层状态由酒馆保存；token 刷新失败：${error.message}`);
    } finally {
        if (locked) unlockSending();
    }
}

function cancelPendingAutoSummary() {
    if (summaryTimer) clearTimeout(summaryTimer);
    summaryTimer = null;
    if (pendingGeneration?.locked) unlockSending();
    pendingGeneration = null;
    if (activeRun) {
        activeRun.cancelled = true;
        activeRun.controller?.abort();
        if (summaryRequest?.sending) {
            summaryRequest.cancelled = true;
            getContext()?.stopGeneration?.();
        }
    }
}

function stopPluginWork() {
    cancelPendingAutoSummary();
    chatSyncRevision += 1;
    visibilityRefreshRevision += 1;
    directoryRequest += 1;
    if (visibilityRefreshTimer) clearTimeout(visibilityRefreshTimer);
    visibilityRefreshTimer = null;
    if (modelFetchTimer) clearTimeout(modelFetchTimer);
    modelFetchTimer = null;
    modelFetchRevision += 1;
    modelFetchController?.abort();
    modelFetchController = null;
    const modelButton = ui?.querySelector('.als-model-fetch');
    if (modelButton) modelButton.disabled = Boolean(sendLockDepth);
    // Existing directory data remains readable while processing is disabled.
}

function applyEnabledState(value) {
    settings.enabled = Boolean(value);
    settingsDraft.enabled = settings.enabled;
    enabledRevision += 1;
    if (!settings.enabled) {
        const context = getContext();
        const archive = context?.chatMetadata?.[MODULE_NAME];
        if (archive) {
            archive.visibilityEpoch = `${randomId()}-${++operationSequence}`;
            context.saveMetadataDebounced?.();
        }
        stopPluginWork();
        setStatus('插件已关闭，正在关闭总结条目的注入喵…');
        void scheduleDisabledCleanup();
    } else void scheduleChatSync();
    syncSettingsState();
    // Serialize immediate saves so rapid on/off toggles cannot leave an older
    // setting as the last server write. No other settings drafts are applied.
    return persistSettingsNow().then(() => true, error => {
        notify('error', `启用状态保存失败：${error.message}`);
        return false;
    });
}

function scheduleDisabledCleanup({ bookName = settings.worldBookName } = {}) {
    if (settings.enabled) return Promise.resolve();
    disabledCleanupPending += 1;
    const revision = enabledRevision;
    const stillDisabled = () => !settings.enabled && revision === enabledRevision;
    // Finish any older save before switching the entries off. Enabling again
    // queues archive activation behind this operation, so an old cleanup
    // cannot overwrite the newly selected archive.
    const operation = chatSyncChain.catch(() => {}).then(async () => {
        const deadline = Date.now() + 30000;
        while (runInProgress || thresholdCheckInProgress || promptProbe || archiveEditInProgress) {
            if (!stillDisabled()) return;
            if (Date.now() >= deadline) throw new Error('上一轮处理尚未结束，请在世界书中手动关闭总结条目。');
            await new Promise(resolve => setTimeout(resolve, 80));
        }
        if (!stillDisabled()) return;
        const context = getContext();
        if (!context) return;
        archiveEditInProgress = true;
        lockSending();
        try {
            await context.updateWorldInfoList();
            if (!stillDisabled()) return;
            if (!(await worldInfoNames(context)).includes(bookName)) return;
            const data = await readWorldBookData(context, bookName);
            if (!stillDisabled()) return;
            const owned = listOwnedEntries(data);
            if (!owned.some(entry => entry.disable !== true || entry.constant !== false)) return;
            for (const entry of owned) { entry.disable = true; entry.constant = false; }
            await context.saveWorldInfo(bookName, data, true);
            if (!stillDisabled()) return;
            const persisted = await readWorldBookData(context, bookName);
            if (!stillDisabled()) return;
            if (listOwnedEntries(persisted).length !== owned.length || owned.some(entry => {
                const saved = persisted.entries[entry.uid];
                return !saved || saved.disable !== true || saved.constant !== false
                    || saved.content !== entry.content
                    || JSON.stringify(saved.extensions) !== JSON.stringify(entry.extensions);
            })) throw new Error('总结条目关闭后未能读回确认，请在世界书中手动关闭总结条目。');
            await context.updateWorldInfoList();
            if (!stillDisabled()) return;
            context.reloadWorldInfoEditor?.(bookName);
        } finally {
            archiveEditInProgress = false;
            unlockSending();
        }
    }).finally(() => { disabledCleanupPending -= 1; publishIntegrationState(); });
    chatSyncChain = operation.then(() => {
        if (stillDisabled()) setStatus('插件已关闭，总结条目已停用，不再注入聊天喵。');
    }).catch(error => {
        if (!stillDisabled()) return;
        console.error('[喵喵大总结] 停用条目失败：', error);
        setStatus(`插件已关闭，但总结条目停用失败：${error.message}`);
        notify('error', `总结条目停用失败：${error.message}`);
    });
    return chatSyncChain;
}

function summaryWasCancelled() {
    return Boolean(activeRun && (activeRun.cancelled
        || activeRun.manualVisibilityRevision !== manualVisibilityRevision
        || !settings.enabled || activeRun.enabledRevision !== enabledRevision));
}

function assertSummaryActive() {
    if (summaryWasCancelled()) throw new Error('本次总结已取消。');
}

function onFinalPromptData(data, dryRun) {
    if (!dryRun && summaryRequest?.native) {
        if (summaryWasCancelled() || !isSameArchive(getContext(), summaryRequest.archiveInfo, summaryRequest.characterId)) {
            summaryRequest.cancelled = true;
            getContext()?.stopGeneration?.();
            return;
        }
        if (!Array.isArray(data.prompt)) {
            if (summaryRequest.sourceOnly) {
                if (typeof data.prompt === 'string') data.prompt = summaryRequest.prompt;
                else if (typeof data.input === 'string') data.input = summaryRequest.prompt;
            } else if (summaryRequest.position === 'tail') {
                if (typeof data.prompt === 'string') data.prompt = buildSummaryTextPrompt(data.prompt, summaryRequest.prompt);
                else if (typeof data.input === 'string') data.input = buildSummaryTextPrompt(data.input, summaryRequest.prompt);
            }
            summaryRequest.expectedBody = JSON.stringify(data);
            summaryRequest.sent = true;
        }
    }
    if (!promptProbe || !dryRun) return;
    promptProbe.data = structuredClone(data);
}

function onMainApiRequest(data) {
    if (summaryRequest?.sending && data.type === 'quiet' && Array.isArray(data.messages)) {
        if (summaryWasCancelled() || !isSameArchive(getContext(), summaryRequest.archiveInfo, summaryRequest.characterId)) {
            summaryRequest.cancelled = true;
            getContext()?.stopGeneration?.();
            return;
        }
        if (summaryRequest.sourceOnly) data.messages = [{ role: 'user', content: summaryRequest.prompt }];
        // Keep the host's assembled facts, but do not execute its roleplay preset
        // as system instructions while asking for a historical summary.
        else if (summaryRequest.position === 'tail') data.messages = buildSummaryMessages(data.messages, summaryRequest.prompt);
        // Quiet requests use the current connection, model and preset; tools
        // cannot replace the requested textual summary with a tool invocation.
        delete data.tools;
        delete data.tool_choice;
        delete data.assistant_prefill;
        if (summaryRequest.secondary) {
            // Set the destination in the owned request object as well as the
            // fetch adapter. A later hook cannot silently fall back to the
            // main provider merely by changing the serialized request body.
            const secondaryData = buildSecondaryRequest(getContext(), data, summaryRequest.secondary);
            for (const key of Object.keys(data)) delete data[key];
            Object.assign(data, secondaryData);
        }
        summaryRequest.sent = true;
        summaryRequest.expectedBody = JSON.stringify(data);
    }
}

function onTemplatePreviewContext(environment) {
    if (!requestPreview) return;
    environment.isDryRun = true;
    // Counting must not execute variable updates or slash commands a second
    // time. Conditions still read the current MVU/EJS values.
    for (const name of Object.keys(environment)) {
        if (/^(setvar|incvar|decvar|delvar|insvar|(?:set|inc|dec|del|insert)(?:Local|Global|Message)Var|patchVariables|execute)$/.test(name)) {
            environment[name] = () => undefined;
        }
    }
    for (const name of ['getvar', 'getLocalVar', 'getGlobalVar', 'getMessageVar']) {
        const read = environment[name];
        if (typeof read === 'function') environment[name] = (...args) => {
            const value = read(...args);
            return value && typeof value === 'object' ? structuredClone(value) : value;
        };
    }
}

async function prepareChatPreview(context, messages) {
    // EJS intentionally skips GENERATE_AFTER_DATA for a dry run and processes
    // chat completion messages at SETTINGS_READY instead. Run that request
    // preparation event without making an API request.
    const { createGenerationParameters, getChatCompletionModel } = await chatCompletionApi();
    const apiSettings = context.chatCompletionSettings;
    const model = getChatCompletionModel();
    // Older stable builds prepare these inside sendOpenAIRequest and do not
    // export createGenerationParameters. Their settings event still supports
    // the same message preparation without making a model request.
    const { generate_data } = typeof createGenerationParameters === 'function'
        ? await createGenerationParameters(apiSettings, model, 'normal', messages)
        : { generate_data: {
            type: 'normal', messages, model,
            temperature: Number(apiSettings.temp_openai),
            frequency_penalty: Number(apiSettings.freq_pen_openai),
            presence_penalty: Number(apiSettings.pres_pen_openai),
            top_p: Number(apiSettings.top_p_openai), max_tokens: apiSettings.openai_max_tokens,
            stream: Boolean(apiSettings.stream_openai), chat_completion_source: apiSettings.chat_completion_source,
            custom_prompt_post_processing: apiSettings.custom_prompt_post_processing,
            user_name: context.name1, char_name: context.name2,
        } };
    const previousPreview = requestPreview;
    requestPreview = true;
    try {
        context.eventSource.makeLast?.('prompt_template_prepare', onTemplatePreviewContext);
        await context.eventSource.emit(context.eventTypes.CHAT_COMPLETION_SETTINGS_READY, generate_data);
        if (!Array.isArray(generate_data.messages)) throw new Error('主 API 提示词预览未返回消息列表。');
        return generate_data;
    } finally {
        requestPreview = previousPreview;
    }
}

function refreshFinalHooks() {
    if (!settings?.enabled) return;
    const context = getContext();
    if (!context?.eventSource?.makeLast) return;
    context.eventSource.makeLast(context.eventTypes.GENERATE_AFTER_DATA, onFinalPromptData);
    context.eventSource.makeLast(context.eventTypes.CHAT_COMPLETION_SETTINGS_READY, onMainApiRequest);
}

async function assemblePrompt(context) {
    if (typeof context.generate !== 'function') throw new Error('当前酒馆缺少提示词组装接口，请更新稳定版。');
    if (promptProbe) throw new Error('正在组装另一份提示词，请稍后再试。');
    const probe = { data: null };
    promptProbe = probe;
    const previousPreview = requestPreview;
    requestPreview = true;
    try {
        refreshFinalHooks();
        context.eventSource.makeLast?.('prompt_template_prepare', onTemplatePreviewContext);
        // Dry run assembles the preset, history and conditional world info,
        // without consuming the input box or sending a model request.
        await context.generate('normal', {}, true);
        if (!probe.data) throw new Error('酒馆未返回完整提示词，尚未调用主 API。');
        return probe.data;
    } finally {
        promptProbe = null;
        requestPreview = previousPreview;
    }
}

async function processedPreview(context, data) {
    if (Array.isArray(data.prompt)) {
        const prepared = await prepareChatPreview(context, data.prompt);
        let messages = prepared.messages;
        const processing = prepared.custom_prompt_post_processing;
        if (prepared.chat_completion_source === 'custom' && processing && processing !== 'none') {
            // Use the same backend post-processing as the custom API, including
            // strict role alternation, before counting the actual message list.
            let processed;
            try {
                processed = await fetchJson('/api/backends/chat-completions/process', {
                    method: 'POST', headers: context.getRequestHeaders(),
                    body: JSON.stringify({ messages, type: processing, user_name: prepared.user_name, char_name: prepared.char_name, group_names: prepared.group_names }),
                }, { signal: activeRun?.controller?.signal, label: '提示词后处理失败' });
            } catch (error) {
                if (activeRun?.controller?.signal.aborted) throw activeRun.controller.signal.reason ?? new Error('本次总结已取消。');
                if (globalThis.__TAURITAVERN_HOST__ && (error.code === 'HTML_RESPONSE' || [404, 501].includes(error.status))) {
                    processed = { messages: tauriPromptPreview(messages, processing, prepared) };
                } else if (error.code === 'HTML_RESPONSE') {
                    throw new Error(`${error.message} 当前酒馆未提供有效的提示词后处理预览，请检查该接口的路由。`);
                } else throw error;
            }
            if (!Array.isArray(processed?.messages)) throw new Error('提示词后处理未返回消息列表。');
            messages = processed.messages;
        }
        return messages;
    }
    return data.prompt ?? data.input;
}

async function countAssembledPrompt(context, data) {
    const prompt = await processedPreview(context, data);
    if (Array.isArray(prompt)) {
        const tokenizer = await tokenizerApi();
        const countTokens = tokenizer.countTokensOpenAIAsync ?? tokenizer.countTokensOpenAI;
        if (typeof countTokens !== 'function') throw new Error('当前酒馆缺少聊天补全 token 计数接口。');
        return await countTokens(prompt, true);
    }
    if (typeof prompt !== 'string' || typeof context.getTokenCountAsync !== 'function') {
        throw new Error('当前 API 没有可计数的完整提示词。');
    }
    return await context.getTokenCountAsync(prompt, 0);
}

async function verifySummaryInjection(context, entry) {
    updateTaskStage('verifying');
    const event = context.eventTypes?.WORLDINFO_SCAN_DONE;
    const bookName = settings.worldBookName;
    const archiveId = entryMetadata(entry)?.archiveId;
    const { getRegexedString, regex_placement } = await regexApi();
    const matchesEntry = candidate => candidate.world === bookName
        && String(candidate.uid) === String(entry.uid) && entryMetadata(candidate)?.archiveId === archiveId;
    if (!event) {
        return await verifyLegacyInjection(context, {
            matchesEntry, assertActive: assertSummaryActive,
            marker: `MEWO_VERIFY_${randomId()}`,
            preview: async () => await processedPreview(context, await assemblePrompt(context)),
            expectedText: async candidate => getRegexedString(
                context.substituteParamsExtended ? await context.substituteParamsExtended(candidate.content) : candidate.content,
                regex_placement.WORLD_INFO,
                { depth: candidate.position === 4 ? (candidate.depth ?? 4) : null, isMarkdown: false, isPrompt: true }),
        });
    }
    if (!context.eventSource?.removeListener) throw new Error('酒馆缺少世界书扫描确认接口；总结已保留，未隐藏消息。');
    let activated = null;
    const observe = scan => {
        const entries = scan?.activated?.entries;
        activated = entries?.values ? [...entries.values()].find(matchesEntry) : null;
    };
    context.eventSource.on(event, observe);
    context.eventSource.makeLast?.(event, observe);
    try {
        const data = await assemblePrompt(context);
        assertSummaryActive();
        if (!activated) throw new Error('总结已保存，但没有通过世界书激活或预算检查；未隐藏消息。请调整世界书预算或预设后重试隐藏。');
        // Match the host's at-depth fallback for older entries without depth.
        const expected = getRegexedString(activated.content, regex_placement.WORLD_INFO,
            { depth: activated.position === 4 ? (activated.depth ?? 4) : null, isMarkdown: false, isPrompt: true });
        const prompt = await processedPreview(context, data);
        assertSummaryActive();
        if (!promptContainsText(prompt, expected)) throw new Error('总结已保存，但无法在最终提示词中确认正文；未隐藏消息。请检查预设、正则或模板处理后重试隐藏。');
    } finally {
        context.eventSource.removeListener(event, observe);
    }
}

function extractSummaryText(response) {
    const content = response?.choices?.[0]?.message?.content ?? response?.choices?.[0]?.text
        ?? response?.results?.[0]?.text ?? response?.content ?? response?.output ?? response?.response
        ?? response?.text ?? response?.message?.content ?? response?.[0]?.content;
    if (typeof response === 'string' || response instanceof String) return String(response).trim();
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) return content.filter(part => part?.type === 'text' || part?.type === 'output_text')
        .map(part => part.text ?? '').join('\n').trim();
    return '';
}

function stripReasoning(text, template = getContext()?.powerUserSettings?.reasoning) {
    let content = String(text ?? '');
    const prefix = template?.prefix;
    const suffix = template?.suffix;
    if (!prefix || !suffix) return content.trim();
    // Literal delimiters match ST's selected template, including custom tags.
    // Remove every wrapped block; keep all non-reasoning text verbatim.
    let offset = 0;
    while (true) {
        const start = content.indexOf(prefix, offset);
        if (start < 0) break;
        const end = content.indexOf(suffix, start + prefix.length);
        if (end < 0) {
            // Never save the tail of an unfinished reasoning block.
            content = content.slice(0, start);
            break;
        }
        content = content.slice(0, start) + content.slice(end + suffix.length);
        offset = start;
    }
    return content.trim();
}

function getSecondaryConfig(source = settings, requireModel = true) {
    let url;
    try { url = new URL(String(source.secondaryUrl ?? '').trim()); }
    catch { throw new Error('喵，请填好副 API 的 http / https 地址。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('喵，副 API 地址只填基础 URL，Key 请放在下面的密钥框里。');
    }
    url.pathname = url.pathname.replace(/\/(?:chat\/completions|completions|models)\/?$/i, '').replace(/\/+$/, '') || '/v1';
    const key = String(source.secondaryKey ?? '').trim().replace(/^Bearer\s+/i, '');
    if (/[\r\n]/.test(key)) throw new Error('喵，副 API 的 Key 不能换行。');
    const model = String(source.secondaryModel ?? '').trim();
    if (requireModel && !model) throw new Error('喵，先拉取并选择副 API 模型，也可以手填模型名。');
    return { url: url.toString().replace(/\/$/, ''), key, model };
}

function secondaryHeaders(config) {
    // ST's custom endpoint merges these after its saved API key. Explicitly
    // override Authorization even for a keyless endpoint; never borrow a key.
    return JSON.stringify({ Authorization: config.key ? `Bearer ${config.key}` : '' });
}

function buildSecondaryRequest(context, original, config) {
    const messages = Array.isArray(original.messages) ? original.messages
        : Array.isArray(original.prompt) ? original.prompt
            : [{ role: 'user', content: original.prompt ?? original.input }];
    if (!messages.length || messages.some(message => typeof message?.content !== 'string' && !Array.isArray(message?.content))) {
        throw new Error('喵，酒馆没有组装出可发送给副 API 的提示词。');
    }
    const payload = {
        type: 'quiet', chat_completion_source: 'custom', model: config.model,
        messages: structuredClone(messages), stream: false, n: 1,
        custom_url: config.url, custom_include_headers: secondaryHeaders(config),
        custom_prompt_post_processing: original.custom_prompt_post_processing ?? 'none',
        // Only the assembled prompt and host-side message formatting are shared.
        // Omit optional sampling fields so the secondary provider uses its own
        // defaults, including models that reject temperature or penalty fields.
        max_tokens: SECONDARY_MAX_TOKENS,
        user_name: original.user_name ?? context.name1, char_name: original.char_name ?? context.name2,
    };
    return payload;
}

async function fetchSecondaryModels({ silent = false } = {}) {
    if (silent && !settings?.enabled) return;
    if (sendLockDepth) return;
    let config;
    const label = ui.querySelector('.als-model-status');
    try { config = getSecondaryConfig(settingsDraft, false); }
    catch (error) {
        if (!silent) notify('warning', error.message);
        label.textContent = error.message;
        return;
    }
    const revision = ++modelFetchRevision;
    modelFetchController?.abort();
    const controller = new AbortController();
    modelFetchController = controller;
    const button = ui.querySelector('.als-model-fetch');
    button.disabled = true;
    label.textContent = '喵喵正在找可用模型…';
    const unchanged = () => revision === modelFetchRevision
        && settingsDraft.secondaryUrl === sourceUrl && settingsDraft.secondaryKey === sourceKey;
    const sourceUrl = settingsDraft.secondaryUrl;
    const sourceKey = settingsDraft.secondaryKey;
    try {
        const data = await fetchJson('/api/backends/chat-completions/status', {
            method: 'POST', headers: getContext().getRequestHeaders(),
            body: JSON.stringify({ chat_completion_source: 'custom', custom_url: config.url,
                custom_include_headers: secondaryHeaders(config) }),
            signal: controller.signal,
        }, { label: '模型没拉到，请检查 URL 和 Key' });
        if (data?.error || !Array.isArray(data?.data)) throw new Error('喵，副 API 没有返回 OpenAI 格式的模型列表；也可以手填模型名。');
        const models = [...new Set(data.data.map(model => typeof model === 'string' ? model : model?.id)
            .filter(model => typeof model === 'string' && model.trim()).map(model => model.trim()))].sort();
        if (!unchanged()) return;
        settingsDraft.secondaryModels = models;
        renderModelOptions();
        syncSettingsState();
        label.textContent = models.length ? `找到 ${models.length} 个模型喵，选好后记得保存设置。` : '喵，列表是空的，可以直接填写模型名。';
    } catch (error) {
        if (!unchanged()) return;
        label.textContent = error.name === 'TimeoutError' ? '拉取模型超时了喵，可以重试或手填模型名。'
            : error.name === 'AbortError' ? '本次模型拉取已取消喵。' : error.message;
        if (!silent) notify('warning', label.textContent);
    } finally {
        if (revision === modelFetchRevision) {
            modelFetchController = null;
            button.disabled = Boolean(sendLockDepth);
        }
    }
}

function renderModelOptions() {
    const list = ui?.querySelector('.als-model-select');
    if (!list) return;
    const models = settingsDraft.secondaryModels ?? [];
    const placeholder = createElement('option', '', models.length ? '请选择模型' : '先拉取模型，或选择手动填写');
    placeholder.value = '';
    const manual = createElement('option', '', '手动填写模型名…');
    manual.value = 'manual';
    list.replaceChildren(placeholder, ...models.map((model, index) => {
        const option = createElement('option', '', model);
        option.value = String(index);
        return option;
    }), manual);
    const selected = models.indexOf(settingsDraft.secondaryModel);
    list.value = selected >= 0 ? String(selected) : settingsDraft.secondaryModel ? 'manual' : '';
    ui.querySelector('.als-model-manual-field').hidden = list.value !== 'manual';
}

function selectSecondaryModel(value) {
    if (sendLockDepth) return;
    const manual = value === 'manual';
    if (!manual) {
        settingsDraft.secondaryModel = settingsDraft.secondaryModels?.[Number(value)] ?? '';
        if (value === '') settingsDraft.secondaryModel = '';
        ui.querySelector('.als-secondary-model').value = settingsDraft.secondaryModel;
    }
    ui.querySelector('.als-model-manual-field').hidden = !manual;
    syncSettingsState();
}

function scheduleModelFetch() {
    if (modelFetchTimer) clearTimeout(modelFetchTimer);
    modelFetchTimer = setTimeout(() => {
        modelFetchTimer = null;
        if (settings.enabled && settingsDraft.apiMode === 'secondary' && settingsDraft.secondaryUrl.trim()) void fetchSecondaryModels({ silent: true });
    }, 400);
}

function createSummaryCoverage(context) { return createCoveragePlan(context.chat); }

async function requestMainApiSummary(context, prompt, { sourceOnly = false } = {}) {
    if (typeof context.generate !== 'function') throw new Error('当前酒馆缺少后台生成接口。');
    const secondary = settings.apiMode === 'secondary' ? getSecondaryConfig() : null;
    const archiveInfo = await ensureArchive(context);
    assertSummaryActive();
    const request = {
        prompt, position: settings.instructionPosition, archiveInfo, characterId: context.characterId,
        native: true, afterCommands: true, sending: true, sent: false,
        expectedBody: null, rawText: null, cancelled: false,
        secondary, sourceOnly, coverage: sourceOnly ? null : createSummaryCoverage(context),
    };
    summaryRequest = request;
    const capturePrompt = async (data, dryRun) => {
        if (summaryRequest !== request || !request.coverage || dryRun || data?.dryRun) return;
        const assembled = data?.chat ?? data?.prompt ?? data?.input;
        if (assembled == null) return;
        // Prefer CHAT_COMPLETION_PROMPT_READY, before EJS/settings hooks rewrite
        // content. Text-completion hosts use GENERATE_AFTER_DATA instead.
        if (!request.coverage.observed) {
            request.coverage.prompt = structuredClone(assembled);
            request.coverage.observed = true;
            const missing = missingCoverage(request.coverage.sources, assembled);
            if (missing?.length && context.substituteParamsExtended) {
                for (const source of request.coverage.sources) {
                    if (source.text && missing.includes(source.index)) source.text = String(await context.substituteParamsExtended(source.text));
                }
            }
        }
    };
    const coverageEvents = [context.eventTypes?.CHAT_COMPLETION_PROMPT_READY, context.eventTypes?.GENERATE_AFTER_DATA].filter(Boolean);
    for (const event of coverageEvents) {
        context.eventSource.on(event, capturePrompt);
        context.eventSource.makeFirst?.(event, capturePrompt);
    }
    const reasoningTemplate = { ...context.powerUserSettings?.reasoning };
    const task = activeRun;
    let progressUpdatedAt = 0;
    const progress = snapshot => {
        request.rawText = snapshot.text;
        if (activeRun !== task || !task) return;
        const text = stripReasoning(snapshot.text, reasoningTemplate);
        rememberIncompleteDraft(archiveInfo.archive.archiveId, text, '生成曾中断或页面关闭；以下是最近收到的正文，尚未确认保存到世界书。', { immediate: false });
        task.stream = { ...task.stream, text, chars: text.length, thinking: snapshot.thinking,
            lastReceivedAt: snapshot.lastReceivedAt };
        if (Date.now() - progressUpdatedAt >= 200) {
            progressUpdatedAt = Date.now();
            syncTaskState();
        }
    };
    const originalFetch = globalThis.fetch;
    let observing = true;
    // Keep native quiet prompt assembly and response handling. Only the owned
    // request streams on the wire; collect it into one quiet response for ST.
    const observeSummaryResponse = async function(input, init) {
        const url = typeof input === 'string' ? input : input?.url ?? String(input);
        const matches = observing && request.expectedBody && init?.body === request.expectedBody
            && /\/api\/(?:backends\/[^/]+\/generate|novelai\/generate|horde\/generate)(?:[?#]|$)/.test(url);
        if (observing && secondary && request.expectedBody && !matches && typeof init?.body === 'string'
            && /\/api\/(?:backends\/[^/]+\/generate|novelai\/generate|horde\/generate)(?:[?#]|$)/.test(url)
            && init.body.includes(JSON.stringify(request.prompt).slice(1, -1))) {
            throw new Error('喵，其他扩展改写了这次模型请求，已取消副 API 总结，请重试。');
        }
        let response;
        if (matches && request.coverage) {
            const missing = missingCoverage(request.coverage.sources, request.coverage.prompt);
            if (!request.coverage.observed || missing === null || missing.length) {
                const detail = missing?.length ? `第 ${missing.slice(0, 5).join('、')} 层${missing.length > 5 ? '等' : ''}未在组装结果中确认` : '缺少宿主的原文覆盖信息';
                request.error = new Error(`总结输入不完整：${detail}。尚未调用模型，也未隐藏消息；请检查上下文、聊天历史开关或模板，或从原文重建。`);
                if (activeRun === task && task) task.coverageBlocked = true;
                throw request.error;
            }
            request.coverage.verified = true;
        }
        if (matches && (secondary || /\/api\/backends\/chat-completions\/generate(?:[?#]|$)/.test(url))) {
            const requestSignals = combineRequestSignals([init.signal, task?.controller?.signal]);
            try {
                assertSummaryActive();
                const original = JSON.parse(init.body);
                const payload = secondary ? buildSecondaryRequest(context, original, secondary) : { ...original };
                const streaming = settings.streamSummary && supportsSummaryStream(payload);
                payload.stream = Boolean(streaming);
                payload.n = 1;
                const signal = requestSignals.signal;
                if (task) task.stream = { enabled: streaming, text: '', chars: 0, thinking: false, startedAt: Date.now() };
                syncTaskState();
                response = await originalFetch.call(globalThis, secondary ? '/api/backends/chat-completions/generate' : input, {
                    ...init, ...(secondary ? { method: 'POST', headers: context.getRequestHeaders() } : {}),
                    body: JSON.stringify(payload), signal,
                });
                if (!response.ok) throw summaryResponseError(response.status, await response.text());
                let raw;
                if (streaming || response.headers?.get('content-type')?.includes('text/event-stream')) {
                    if (task) task.stream.enabled = true;
                    const result = await readSummaryStream(response, { signal, onProgress: progress, allowJson: true });
                    request.rawText = result.text;
                    request.failure = result.failure;
                    raw = result.json;
                } else {
                    // Some compatible services ignore stream:true and send JSON.
                    // Accept that same response; never issue a second paid call.
                    const body = await response.text();
                    try { raw = JSON.parse(body); }
                    catch { throw summaryResponseError(response.status, body); }
                    if (raw?.error) throw summaryResponseError(raw.error?.code, body);
                }
                if (raw !== undefined) {
                    const text = typeof context.extractMessageFromData === 'function' && !secondary
                        ? context.extractMessageFromData(raw) : extractSummaryText(raw);
                    request.rawText = typeof text === 'string' ? text : extractSummaryText(raw);
                    request.failure = completionFailure(raw);
                }
                assertSummaryActive();
                const text = request.rawText;
                return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text }, text }],
                    results: [{ text }], output: text, text, content: [{ type: 'text', text }] }),
                { status: 200, headers: { 'Content-Type': 'application/json' } });
            } catch (error) {
                request.error = error;
                throw error;
            } finally {
                requestSignals.dispose();
            }
        }
        response = await originalFetch.call(globalThis, input, init);
        if (matches && response.ok) {
            try {
                const raw = await response.clone().json();
                request.failure = completionFailure(raw);
                const extracted = typeof context.extractMessageFromData === 'function'
                    ? context.extractMessageFromData(raw) : null;
                request.rawText = typeof extracted === 'string' || extracted instanceof String
                    ? String(extracted) : extractSummaryText(raw);
            } catch {
                // Let ST handle response errors; never save a speculative result.
            }
        }
        return response;
    };
    const originalInjection = context.extensionPrompts?.[SUMMARY_INJECTION_ID];
    let injected = null;
    try {
        if (!sourceOnly && request.position !== 'tail') {
            if (typeof context.setExtensionPrompt !== 'function') throw new Error('酒馆缺少提示词层级注入接口。');
            context.setExtensionPrompt(SUMMARY_INJECTION_ID, prompt, INSTRUCTION_POSITIONS[request.position],
                settings.instructionDepth, false, settings.instructionRole,
                () => summaryRequest === request && !request.cancelled);
            injected = context.extensionPrompts?.[SUMMARY_INJECTION_ID];
        }
        globalThis.fetch = observeSummaryResponse;
        refreshFinalHooks();
        // Use the actual quiet generation flow: regex, world info, extension
        // interceptors, EJS conditions, presets and current main API all run.
        const response = await context.generate('quiet', { quiet_prompt: SUMMARY_TASK_INSTRUCTION, quietToLoud: false }, false);
        if (request.error) throw request.error;
        assertSummaryActive();
        if (request.cancelled || !isSameArchive(getContext(), archiveInfo, context.characterId)) {
            throw new Error('生成期间聊天存档已切换，本次总结已取消。');
        }
        if (!request.sent) throw new Error(secondary
            ? '喵，副 API 总结还没进入酒馆发送流程，请先保持酒馆当前主连接可用，再试一次。'
            : '酒馆没有发出大总结请求，请确认主 API 已连接。');
        request.rawText ??= extractSummaryText(response);
        if (request.coverage && !request.coverage.verified) throw new Error('无法确认本次总结请求的原文覆盖范围，未保存或隐藏消息。请检查其他扩展是否改写了请求。');
        const text = stripReasoning(request.rawText, reasoningTemplate);
        request.failure ??= summaryOutputFailure(text);
        if (request.failure) {
            throw new Error(`${request.failure}；未覆盖总结，也未隐藏消息。${text ? '可在概览查看和导出未完成结果。' : ''}`);
        }
        if (!text) throw new Error(`${secondary ? '副' : '主'} API 没有返回可保存的总结正文喵（可能只有推理内容）。旧楼层未隐藏。`);
        rememberIncompleteDraft(archiveInfo.archive.archiveId, text, '正文已生成，尚未确认写入世界书。');
        return text;
    } catch (error) {
        const text = stripReasoning(request.rawText ?? '', reasoningTemplate);
        if (text) rememberIncompleteDraft(archiveInfo.archive.archiveId, text, summaryWasCancelled()
            ? '任务已取消；以下为取消前收到的正文。' : request.failure ?? request.error?.message ?? error?.message ?? '生成中断。');
        throw error;
    } finally {
        for (const event of coverageEvents) context.eventSource.removeListener?.(event, capturePrompt);
        observing = false;
        request.expectedBody = null;
        request.rawText = null;
        if (globalThis.fetch === observeSummaryResponse) globalThis.fetch = originalFetch;
        if (injected && context.extensionPrompts?.[SUMMARY_INJECTION_ID] === injected) {
            if (originalInjection) context.extensionPrompts[SUMMARY_INJECTION_ID] = originalInjection;
            else delete context.extensionPrompts[SUMMARY_INJECTION_ID];
        }
        summaryRequest = null;
    }
}

function getContext() {
    return window.SillyTavern?.getContext?.();
}

function getSettings() {
    const context = getContext();
    if (!context) return null;
    context.extensionSettings[MODULE_NAME] ??= {};
    settings = context.extensionSettings[MODULE_NAME];
    const previousPrompt = settings.prompt;
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) {
            settings[key] = structuredClone(value);
        }
    }
    settings.pendingRetries ??= [];
    if (typeof settings.autoEnabled !== 'boolean') settings.autoEnabled = true;
    if (typeof settings.streamSummary !== 'boolean') settings.streamSummary = true;
    if (!['main', 'secondary'].includes(settings.apiMode)) settings.apiMode = 'main';
    for (const key of ['secondaryUrl', 'secondaryKey', 'secondaryModel']) {
        if (typeof settings[key] !== 'string') settings[key] = '';
    }
    if (!Array.isArray(settings.secondaryModels)) settings.secondaryModels = [];
    if (!Object.hasOwn(MODE_LABELS, settings.mode)) settings.mode = 'incremental';
    if (!Object.hasOwn(PROMPT_STYLE_LABELS, settings.promptStyle)) settings.promptStyle = 'traditional';
    if (!Object.hasOwn(INSTRUCTION_POSITIONS, settings.instructionPosition)) settings.instructionPosition = 'tail';
    settings.instructionDepth = Math.min(10000, Math.max(0, Math.floor(Number(settings.instructionDepth) || 0)));
    if (![0, 1, 2].includes(settings.instructionRole)) settings.instructionRole = 0;
    let migrated = false;
    if (!settings.prompts || typeof settings.prompts !== 'object' || Array.isArray(settings.prompts)) {
        settings.prompts = {
            incremental: typeof previousPrompt === 'string' && previousPrompt && previousPrompt !== LEGACY_DEFAULT_PROMPT ? previousPrompt : DEFAULT_PROMPT,
            merged: DEFAULT_MERGED_PROMPT,
        };
        migrated = true;
    }
    if (typeof settings.prompts.incremental !== 'string') settings.prompts.incremental = DEFAULT_PROMPT;
    if (typeof settings.prompts.merged !== 'string') settings.prompts.merged = DEFAULT_MERGED_PROMPT;
    // Upgrade the previously shipped defaults without rewriting custom text.
    for (const mode of ['incremental', 'merged']) {
        const template = migrateDefaultPrompt(settings.prompts[mode], mode);
        if (template !== settings.prompts[mode]) {
            settings.prompts[mode] = template;
            migrated = true;
        }
    }
    if (!settings.memoryPrompts || typeof settings.memoryPrompts !== 'object' || Array.isArray(settings.memoryPrompts)) {
        settings.memoryPrompts = {};
    }
    for (const mode of ['incremental', 'merged']) {
        if (typeof settings.memoryPrompts[mode] !== 'string') {
            settings.memoryPrompts[mode] = defaultPrompt('memory', mode);
            migrated = true;
        }
    }
    settings.prompt = promptTemplates(settings)[settings.mode];
    if (migrated) context.saveSettingsDebounced?.();
    return settings;
}

function saveSettings() {
    getContext()?.saveSettingsDebounced?.();
}

async function persistSettingsNow() {
    saveSettings();
    enabledSaveChain = enabledSaveChain.catch(() => {}).then(async () => {
        const native = await nativeScript();
        if (typeof native.saveSettings !== 'function') throw new Error('喵，酒馆没有提供立即保存设置的接口，请升级稳定版。');
        const context = getContext();
        const event = context?.eventTypes?.SETTINGS_UPDATED;
        if (!event || typeof context.eventSource?.removeListener !== 'function') {
            throw new Error('喵，酒馆缺少保存确认接口，请升级稳定版后重试。');
        }
        let confirmed = false;
        const onSaved = () => { confirmed = true; };
        context.eventSource.on(event, onSaved);
        try {
            await native.saveSettings();
            if (!confirmed) throw new Error('喵，酒馆没有确认设置已写入，请检查连接后再保存一次。');
        } finally {
            context.eventSource.removeListener(event, onSaved);
        }
    });
    return await enabledSaveChain;
}

function randomId() {
    return globalThis.crypto?.randomUUID?.()
        ?? `als-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function getCharacterAndChat(context = getContext()) {
    if (!context || context.groupId) return null;
    const rawCharacterId = context.characterId;
    if (rawCharacterId === undefined || rawCharacterId === null
        || !['number', 'string'].includes(typeof rawCharacterId)
        || String(rawCharacterId).trim() === '') return null;
    const characterIndex = Number(rawCharacterId);
    if (!Number.isInteger(characterIndex) || characterIndex < 0) return null;
    const character = context.characters?.[characterIndex];
    if (!character) return null;
    const avatar = String(character.avatar ?? character.name ?? context.characterId);
    const chatId = String(context.chatId || context.getCurrentChatId?.() || character.chat || '');
    if (!chatId || !Array.isArray(context.chat)) return null;
    return {
        character,
        cardKey: avatar,
        characterName: String(character.name ?? '未命名角色'),
        chatId,
        chatName: chatId.replace(/\.jsonl$/i, ''),
    };
}

async function ensureArchive(context = getContext()) {
    const current = getCharacterAndChat(context);
    if (!current) return null;
    const metadata = context.chatMetadata ?? (context.chatMetadata = {});
    if (!metadata[MODULE_NAME] || typeof metadata[MODULE_NAME] !== 'object') {
        metadata[MODULE_NAME] = {};
    }
    const archive = metadata[MODULE_NAME];
    let changed = false;
    const integrity = typeof metadata.integrity === 'string' ? metadata.integrity : '';
    const transition = archiveTransition(archive, current, integrity);
    if (transition !== 'same') {
        const previousId = archive.archiveId;
        const parentChatId = archive.chatId;
        archive.archiveId = randomId();
        if (archive.archiveId === previousId) archive.archiveId += `-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        delete archive.branch;
        if (transition === 'branch') archive.branch = {
            parentArchiveId: previousId, parentChatId, point: context.chat.length - 1, pending: true, needsRebuild: false,
        };
        archive.lastSummarizedThrough = -1;
        archive.sourceEnd = null;
        delete archive.sourceDigest;
        delete archive.sourceChanged;
        delete archive.sourceChangeAcknowledgement;
        delete archive.coverageBlocked;
        archive.round = 0;
        archive.autoTriggerArmed = true;
        archive.summaryStillOverThreshold = false;
        delete archive.pendingSummarySave;
        changed = true;
    }
    if (archive.chatIntegrity !== integrity || archive.chatId !== current.chatId) changed = true;
    archive.chatIntegrity = integrity;
    if (archive.worldBookName && archive.worldBookName !== settings.worldBookName) {
        archive.lastSummarizedThrough = -1;
        archive.round = 0;
        archive.autoTriggerArmed = true;
        archive.summaryStillOverThreshold = false;
        delete archive.sourceDigest;
        delete archive.sourceChanged;
        delete archive.sourceChangeAcknowledgement;
        delete archive.coverageBlocked;
        changed = true;
    }
    if (!Number.isInteger(archive.lastSummarizedThrough)) {
        archive.lastSummarizedThrough = -1;
        changed = true;
    }
    if (!Number.isInteger(archive.round)) {
        archive.round = 0;
        changed = true;
    }
    if (typeof archive.autoTriggerArmed !== 'boolean') {
        archive.autoTriggerArmed = true;
        changed = true;
    }
    archive.worldBookName = settings.worldBookName;
    archive.cardKey = current.cardKey;
    archive.characterName = current.characterName;
    archive.chatId = current.chatId;
    archive.chatName = current.chatName;
    if (changed) {
        await context.saveMetadata?.();
    }
    return { ...current, archive };
}

function isOwnedEntry(entry) {
    return entry?.extensions?.[ENTRY_MARKER]?.owner === MODULE_NAME;
}

function listOwnedEntries(data) {
    if (!data?.entries) return [];
    return Object.values(data.entries).filter(isOwnedEntry);
}

function entryMetadata(entry) {
    return entry?.extensions?.[ENTRY_MARKER] ?? null;
}

function archiveRecords(entry) {
    const meta = entryMetadata(entry);
    if (Array.isArray(meta?.records)) return meta.records;
    return [{
        round: meta?.round ?? 1, mode: meta?.mode ?? 'incremental',
        content: String(entry.content ?? ''), createdAt: meta?.createdAt,
        coveredFrom: meta?.coveredFrom ?? 0, coveredTo: meta?.coveredTo ?? -1,
    }];
}

function consolidateArchive(data, archiveId) {
    const entries = listOwnedEntries(data)
        .filter(entry => entryMetadata(entry)?.archiveId === archiveId)
        .sort((a, b) => (entryMetadata(a)?.round ?? 0) - (entryMetadata(b)?.round ?? 0));
    if (!entries.length) return { entry: null, changed: false };
    const entry = entries[0];
    if (entries.length === 1 && entryMetadata(entry)?.storageVersion >= 2) return { entry, changed: false };
    const records = entries.flatMap(archiveRecords).sort((a, b) => a.round - b.round);
    const first = entryMetadata(entry);
    const last = entryMetadata(entries.at(-1));
    entry.content = combineRecords(records);
    entry.extensions[ENTRY_MARKER] = {
        ...first, ...last, storageVersion: 2, records,
        coveredFrom: records[0]?.coveredFrom ?? 0,
        createdAt: first.createdAt, updatedAt: last.updatedAt ?? last.createdAt,
        mode: records.at(-1)?.mode ?? 'incremental',
    };
    entry.comment = `喵喵大总结 · ${last.characterName} · ${last.chatName}`.slice(0, 100);
    // All earlier AI replies remain in records, within the original entry.
    for (const old of entries.slice(1)) delete data.entries[old.uid];
    return { entry, changed: true };
}

function queueArchiveRetry(archiveId) {
    if (!archiveId) return;
    settings.pendingRetries ??= [];
    if (!settings.pendingRetries.includes(archiveId)) {
        settings.pendingRetries.push(archiveId);
        saveSettings();
    }
}

function isSameArchive(context, archiveInfo, characterId) {
    const current = getCharacterAndChat(context);
    return Boolean(current
        && current.chatId === archiveInfo.chatId
        && context.characterId === characterId
        && context.chatMetadata?.[MODULE_NAME]?.archiveId === archiveInfo.archive.archiveId);
}

async function ensureWorldBook(context = getContext()) {
    const name = String(settings.worldBookName ?? '').trim();
    if (!name) throw new Error('请先填写大总结世界书名称。');
    if (/[\\/:*?"<>|\x00-\x1f]/.test(name) || /[. ]$/.test(name)) {
        throw new Error('世界书名称包含不支持的文件名字符，请修改后重试。');
    }

    if (typeof context?.updateWorldInfoList !== 'function') {
        throw new Error('当前 SillyTavern 没有提供世界书列表接口，请更新到稳定版后重试。');
    }

    if (worldBookPreparations.has(name)) return await worldBookPreparations.get(name);
    const preparation = prepareWorldBook(context, name);
    worldBookPreparations.set(name, preparation);
    try {
        return await preparation;
    } finally {
        if (worldBookPreparations.get(name) === preparation) worldBookPreparations.delete(name);
    }
}

async function prepareWorldBook(context, name, { create = true, readOnly = false } = {}) {
    if (!settings.enabled && !readOnly) return null;
    if (readOnly) create = false;
    const revision = enabledRevision;
    await context.updateWorldInfoList();
    if ((!settings.enabled && !readOnly) || revision !== enabledRevision) return null;
    // /worldinfo/get returns an empty dummy book even when no file exists.
    // Only the refreshed file list can establish whether creation is needed.
    if (!(await worldInfoNames(context)).includes(name)) {
        if (!create) return null;
        await context.saveWorldInfo(name, { entries: {} }, true);
        if (!settings.enabled || revision !== enabledRevision) return null;
        await context.updateWorldInfoList();
        if (!settings.enabled || revision !== enabledRevision) return null;
        if (!(await worldInfoNames(context)).includes(name)) {
            throw new Error(`酒馆没有确认创建世界书“${name}”。请查看控制台或服务器日志后重试。`);
        }
    }

    return await readWorldBookData(context, name);
}

async function readWorldBookData(context, name) {
    return await readWorldBook(context, name, { signal: activeRun?.controller?.signal });
}

async function initializeBranchArchive(context, archiveInfo, data) {
    const branch = archiveInfo?.archive.branch;
    if (!branch?.pending || !data || !isSameArchive(getContext(), archiveInfo, context.characterId)) return;
    const parent = listOwnedEntries(data).find(entry => entryMetadata(entry)?.archiveId === branch.parentArchiveId
        && entryMetadata(entry)?.cardKey === archiveInfo.cardKey);
    const existingChild = listOwnedEntries(data).find(entry => entryMetadata(entry)?.archiveId === archiveInfo.archive.archiveId);
    const records = existingChild ? archiveRecords(existingChild) : parent ? branchRecords(archiveRecords(parent), context.chat) : [];
    const last = activeRecords(records).at(-1);
    const content = combineRecords(records);
    if (content && !existingChild) {
        let uid = 0;
        while (Object.hasOwn(data.entries, uid)) uid += 1;
        const metadata = { ...structuredClone(entryMetadata(parent)), archiveId: archiveInfo.archive.archiveId,
            chatId: archiveInfo.chatId, chatName: archiveInfo.chatName, chatIntegrity: archiveInfo.archive.chatIntegrity,
            storageVersion: 3, parentArchiveId: branch.parentArchiveId, branchPoint: branch.point,
            records, round: last.round, coveredTo: last.coveredTo, sourceEnd: last.sourceEnd, sourceDigest: last.sourceDigest };
        delete metadata.lastOperation;
        data.entries[uid] = { ...structuredClone(parent), uid, content, constant: false, disable: true,
            comment: `喵喵大总结 · ${archiveInfo.characterName} · ${archiveInfo.chatName}`.slice(0, 100),
            extensions: { ...parent.extensions, [ENTRY_MARKER]: metadata } };
        await saveVerifiedBook(context, settings.worldBookName, data, saved =>
            saved.entries[uid]?.content === content && entryMetadata(saved.entries[uid])?.archiveId === metadata.archiveId,
            { signal: activeRun?.controller?.signal });
    }
    if (!isSameArchive(getContext(), archiveInfo, context.characterId)) return;
    // Legacy records lack sourceEnd; coveredTo was only a hide boundary and is
    // never evidence that a summary is safe to inherit before a branch point.
    const parentLast = parent && activeRecords(archiveRecords(parent)).at(-1);
    branch.needsRebuild = Boolean(parentLast && parentLast.round !== last?.round);
    branch.pending = false;
    archiveInfo.archive.lastSummarizedThrough = last?.coveredTo ?? -1;
    archiveInfo.archive.sourceEnd = last?.sourceEnd ?? null;
    archiveInfo.archive.round = last?.round ?? 0;
    try { await context.saveMetadata?.(); }
    catch (error) { branch.pending = true; throw error; }
}

async function updateWorldBookStatus() {
    const context = getContext();
    if (!context || !ui) return;
    const label = ui.querySelector('.als-book-status');
    if (!settings.enabled) {
        if (label) label.textContent = '插件已关闭喵';
        return;
    }
    const revision = enabledRevision;
    try {
        await context.updateWorldInfoList();
        if (!settings.enabled || revision !== enabledRevision) return;
        const exists = (await worldInfoNames(context)).includes(settings.worldBookName);
        const mounted = [...document.querySelectorAll('#world_info option')]
            .some(option => option.textContent?.trim() === settings.worldBookName && option.selected);
        label.textContent = !exists ? '还没建好喵 · 首次总结会自动创建并全局启用'
            : mounted ? '世界书建好并全局启用啦喵' : '世界书建好啦喵 · 下次总结会自动全局启用';
    } catch (error) {
        if (!settings.enabled || revision !== enabledRevision) return;
        label.textContent = meowText(`无法读取世界书状态：${error.message}`);
    }
}

async function activateWorldBook(context = getContext()) {
    if (!settings.enabled) return;
    const revision = enabledRevision;
    const name = settings.worldBookName;
    const findOption = () => [...document.querySelectorAll('#world_info option')]
        .find(item => item.textContent?.trim() === name);

    await context.updateWorldInfoList?.();
    if (!settings.enabled || revision !== enabledRevision) return;
    let option = findOption();
    if (!option) throw new Error(`世界书“${name}”已保存，但未出现在全局世界书列表中。请刷新酒馆后重试。`);
    if (!option.selected) {
        // Use the same change event as a manual global-book selection. This also
        // updates Select2, ST's selected_world_info and its persisted settings.
        option.selected = true;
        option.parentElement.dispatchEvent(new Event('change', { bubbles: true }));
        await context.updateWorldInfoList?.();
        option = findOption();
    }
    if (!option?.selected) {
        throw new Error(`世界书“${name}”已创建，但没有成功挂载到全局世界书。请在酒馆顶部的全局世界书列表中手动启用一次。`);
    }
}

async function setArchiveActivation(archiveId, { reconcileCursor = false, bookData } = {}) {
    const context = getContext();
    if (!settings.enabled || !context || !settings.worldBookName) return;
    const revision = enabledRevision;
    const data = bookData ?? await ensureWorldBook(context);
    const identity = getCharacterAndChat(context);
    const stillCurrent = () => {
        if (!settings.enabled || revision !== enabledRevision) return false;
        const live = getCharacterAndChat();
        return identity ? live?.cardKey === identity.cardKey && live?.chatId === identity.chatId
            && (getContext()?.chatMetadata?.[MODULE_NAME]?.archiveId ?? null) === (archiveId ?? null)
            : live === null;
    };
    if (!stillCurrent()) return false;
    let changed = false;
    const template = context.powerUserSettings?.reasoning;
    if (template?.prefix && template?.suffix) {
        for (const entry of listOwnedEntries(data)) {
            for (const target of [entry, ...(entryMetadata(entry)?.records ?? [])]) {
                if (typeof target.content !== 'string' || !target.content.includes(template.prefix)
                    || !target.content.includes(template.suffix)) continue;
                const clean = stripReasoning(target.content, template);
                // Preserve an old record when it has no recoverable正文.
                if (clean && clean !== target.content) { target.content = clean; changed = true; }
            }
        }
    }
    const archiveIds = new Set(listOwnedEntries(data).map(entry => entryMetadata(entry)?.archiveId));
    for (const id of archiveIds) changed = consolidateArchive(data, id).changed || changed;
    const owned = listOwnedEntries(data);
    const latest = owned.find(entry => entryMetadata(entry)?.archiveId === archiveId
        && (!identity || entryMetadata(entry)?.cardKey === identity.cardKey));
    if (latest && identity) {
        const meta = entryMetadata(latest);
        for (const key of ['chatId', 'chatName', 'characterName']) {
            if (meta[key] !== identity[key]) { meta[key] = identity[key]; changed = true; }
        }
        const title = `喵喵大总结 · ${identity.characterName} · ${identity.chatName}`.slice(0, 100);
        if (latest.comment !== title) { latest.comment = title; changed = true; }
    }
    for (const entry of owned) {
        const shouldBeActive = Boolean(latest?.content?.trim() && entry.uid === latest.uid);
        if (entry.constant !== shouldBeActive || entry.disable !== !shouldBeActive || entry.preventRecursion !== true) {
            entry.constant = shouldBeActive;
            entry.disable = !shouldBeActive;
            entry.preventRecursion = true;
            changed = true;
        }
    }

    if (!stillCurrent()) return false;
    if (changed) {
        await context.saveWorldInfo(settings.worldBookName, data, true);
        const persisted = await readWorldBookData(context, settings.worldBookName);
        if (!persisted || listOwnedEntries(persisted).length !== owned.length || owned.some(entry => {
            const saved = persisted.entries[entry.uid];
            return !saved || saved.content !== entry.content || saved.preventRecursion !== true
                || saved.constant !== entry.constant || saved.disable !== entry.disable
                || JSON.stringify(entryMetadata(saved)) !== JSON.stringify(entryMetadata(entry));
        })) throw new Error('世界书条目更新后未能读回确认，已停止总结。');
    }
    if (!stillCurrent()) return false;
    await activateWorldBook(context);
    if (!stillCurrent()) return false;
    context.reloadWorldInfoEditor?.(settings.worldBookName);
    void updateWorldBookStatus();
    currentSummaryEntry = latest ?? null;
    syncActionState();

    if (reconcileCursor && archiveId) {
        const current = getCharacterAndChat(context);
        const archive = context.chatMetadata?.[MODULE_NAME];
        if (current && archive?.archiveId === archiveId) {
            if (reconcileArchiveMetadata(archive, latest)) await context.saveMetadata?.();
        }
    }
    return true;
}

function reconcileArchiveMetadata(archive, entry) {
    const before = JSON.stringify(archive);
    delete archive.pendingSummarySave;
    const meta = entryMetadata(entry);
    Object.assign(archive, { lastSummarizedThrough: meta?.coveredTo ?? -1,
        round: meta?.round ?? 0, sourceEnd: meta?.sourceEnd ?? null, sourceDigest: meta?.sourceDigest ?? null });
    updateSourceReview(archive, getContext()?.chat ?? []);
    const operation = meta?.lastOperation;
    if (operation?.phase === 'undone') {
        archive.undoAtLength = operation.undoAtLength;
        archive.autoTriggerArmed = false;
        if (archive.branch) archive.branch.needsRebuild = operation.previous.branchNeedsRebuild;
    } else if (operation) {
        delete archive.undoAtLength;
        if (operation.operation === 'rebuild' && archive.branch) archive.branch.needsRebuild = false;
    }
    return JSON.stringify(archive) !== before;
}

function canSummarize(context = getContext(), automatic = false) {
    const meta = entryMetadata(currentSummaryEntry);
    const pendingHide = meta?.archiveId === context?.chatMetadata?.[MODULE_NAME]?.archiveId
        && (meta?.lastOperation?.phase === 'saved' || meta?.lastOperation?.combinedRestorePending) && !meta.lastOperation.messagesRestored;
    return Boolean(settings?.enabled && (!automatic || settings.autoEnabled !== false)
        && getCharacterAndChat(context) && settings.prompt?.trim()
        && (!automatic || (!pendingHide && !context.chatMetadata?.[MODULE_NAME]?.branch?.needsRebuild
            && !context.chatMetadata?.[MODULE_NAME]?.sourceChanged
            && !context.chatMetadata?.[MODULE_NAME]?.coverageBlocked
            && !context.chatMetadata?.[MODULE_NAME]?.pendingSummarySave
            && !(context.chat.length <= context.chatMetadata?.[MODULE_NAME]?.undoAtLength))));
}

function sourceTaskPrompt(task, template, source) {
    return `任务：${task}。下面的资料是本次唯一事实来源；模板中的“上文”“全部剧情”均仅指这些资料。\n`
        + `保留重要事实、人物关系和未解决事项，去除重复描述。只输出整理后的总结正文。\n\n格式要求：\n${template}`
        + `\n\n【资料开始】\n${source}\n【资料结束】\n\n请完成“${task}”，不引用资料以外的聊天剧情。`;
}

async function retainCurrentMemory() {
    if (!settings?.enabled || runInProgress || thresholdCheckInProgress || sendLockDepth || archiveEditInProgress || disabledCleanupPending) return false;
    refreshSourceValidity();
    const context = getContext();
    const archive = context?.chatMetadata?.[MODULE_NAME];
    const meta = entryMetadata(currentSummaryEntry);
    const journal = meta?.lastOperation;
    if (!archive?.sourceChanged || !currentSummaryEntry?.content?.trim() || meta?.archiveId !== archive.archiveId) return false;
    if (archive.pendingSummarySave || journal?.phase === 'saved' || (journal?.combinedRestorePending && !journal.messagesRestored)) {
        notify('warning', '请先确认上次写入或完成恢复，再选择保留当前总结。');
        return false;
    }
    if (!window.confirm('保留现有总结继续使用？它可能仍包含已删除或修改的剧情。此次不调用模型、不改总结或隐藏楼层，并解除本次原文变更对后续总结的暂停；以后再次修改原文仍会提醒。')) return false;
    const previous = structuredClone(archive.sourceChangeAcknowledgement ?? null);
    const end = Math.min(archive.sourceEnd, context.chat.length - 1);
    archiveEditInProgress = true;
    lockSending();
    try {
        if (typeof context.saveMetadata !== 'function') throw new Error('酒馆缺少聊天状态保存接口。');
        archive.sourceChangeAcknowledgement = {
            archiveId: archive.archiveId, summaryRound: archive.round,
            summarySourceEnd: archive.sourceEnd, summarySourceDigest: archive.sourceDigest,
            end, digest: historyDigest(context.chat, end),
        };
        updateSourceReview(archive, context.chat);
        await context.saveMetadata();
        if (getContext()?.chatMetadata?.[MODULE_NAME] !== archive || !sourceChangeAccepted(context.chat, archive)) return false;
        setStatus('已选择保留现有总结继续使用，本次未调用模型、未修改消息可见状态。');
        notify('success', '已保留现有总结；本次原文变更不再强制要求更新记忆。');
        return true;
    } catch (error) {
        if (previous) archive.sourceChangeAcknowledgement = previous;
        else delete archive.sourceChangeAcknowledgement;
        updateSourceReview(archive, context.chat);
        notify('error', `保留选择未能保存：${error.message}`);
        return false;
    } finally {
        archiveEditInProgress = false;
        refreshSourceValidity();
        unlockSending();
        syncActionState();
    }
}

function updateTaskStage(stage) {
    setTaskStage(activeRun, stage);
    syncTaskState();
}

function syncTaskState() {
    const label = ui?.querySelector('.als-task-state');
    if (label) label.textContent = taskLabel(activeRun);
    const cancel = ui?.querySelector('.als-cancel');
    if (cancel) {
        cancel.hidden = !activeRun;
        cancel.disabled = Boolean(activeRun?.cancelled);
    }
    const live = ui?.querySelector('.als-live-result');
    const preview = ui?.querySelector('.als-live-text');
    const text = activeRun?.stage === 'generating' ? activeRun.stream?.text ?? '' : '';
    if (live) live.hidden = !text;
    if (preview && preview.value !== text) {
        const follow = preview.scrollHeight - preview.scrollTop - preview.clientHeight < 32;
        preview.value = text;
        if (follow) preview.scrollTop = preview.scrollHeight;
    }
    syncActionState();
}

function cancelCurrentTask() {
    if (!activeRun) return;
    activeRun.cancelled = true;
    activeRun.controller?.abort();
    if (summaryRequest?.sending) {
        summaryRequest.cancelled = true;
        getContext()?.stopGeneration?.();
    }
    setStatus(activeRun.committed ? '已请求取消，已保存的总结保留；后续可恢复或重试隐藏。' : '已请求取消本次任务，正在释放生成流程。');
    syncTaskState();
}

async function updateSavedOperation(context, archiveInfo, operationId, mutate) {
    assertSummaryActive();
    if (!isSameArchive(getContext(), archiveInfo, context.characterId)) throw new Error('聊天已切换，停止后续操作。');
    const bookName = archiveInfo.archive.worldBookName;
    const data = await readWorldBookData(context, bookName);
    const entry = listOwnedEntries(data).find(item => entryMetadata(item)?.archiveId === archiveInfo.archive.archiveId);
    const journal = entryMetadata(entry)?.lastOperation;
    if (!journal || journal.id !== operationId || textDigest(String(entry.content ?? '')) !== journal.resultDigest) {
        throw new Error('总结已被后续操作或手动编辑修改，未覆盖当前记录。');
    }
    assertSummaryActive();
    if (!isSameArchive(getContext(), archiveInfo, context.characterId)) throw new Error('聊天已切换，停止后续操作。');
    mutate(entry);
    const expected = JSON.stringify(entry);
    await saveVerifiedBook(context, bookName, data, saved => JSON.stringify(saved.entries[entry.uid]) === expected,
        { signal: activeRun?.controller?.signal });
    currentSummaryEntry = entry;
    context.reloadWorldInfoEditor?.(bookName);
    return entry;
}

async function recoverLatestSummary(action) {
    if (!['retry', 'restore', 'undo', 'undo-restore'].includes(action) || !settings.enabled || sendLockDepth || archiveEditInProgress) return;
    const combined = action === 'undo-restore';
    const context = getContext();
    const archiveInfo = await ensureArchive(context);
    if (!archiveInfo || !isSameArchive(getContext(), archiveInfo, context.characterId) || sendLockDepth) return;
    archiveEditInProgress = true;
    lockSending();
    activeRun = { chatId: archiveInfo.chatId, characterId: context.characterId, archiveId: archiveInfo.archive.archiveId,
        automatic: false, committed: true, cancelled: false, enabledRevision, manualVisibilityRevision, controller: new AbortController() };
    updateTaskStage('restoring');
    taskTimer = setInterval(syncTaskState, 1000);
    let undoCommitted = false;
    let undoAttempted = false;
    try {
        if (!await waitForCurrentGeneration(context, archiveInfo.chatId)) throw new Error('当前生成尚未结束，请稍后再试。');
        const data = await readWorldBookData(context, settings.worldBookName);
        const entry = listOwnedEntries(data).find(item => entryMetadata(item)?.archiveId === archiveInfo.archive.archiveId);
        const journal = entryMetadata(entry)?.lastOperation;
        if (!journal) throw new Error('这条旧记录没有恢复信息；新版本生成的总结支持恢复。');
        if (textDigest(String(entry.content ?? '')) !== journal.resultDigest) throw new Error('总结正文已被手动编辑，未覆盖当前记录。');
        const check = () => {
            assertSummaryActive();
            if (!isSameArchive(getContext(), archiveInfo, context.characterId)
                || !recoveryMatches(context.chat, journal, archiveInfo.archive.visibilityEpoch)) {
                throw new Error('聊天内容或手动隐藏状态已变化，请手动调整楼层；本次未覆盖你的操作。');
            }
        };
        if (combined) {
            if (journal.phase === 'undone' && !journal.combinedRestorePending) throw new Error('本次整理已经撤销，可按需单独恢复原文。');
            if (journal.changes.length && !journal.messagesRestored) check();
            if (journal.phase !== 'undone' && !window.confirm('撤销本次整理并恢复本轮隐藏的原文？此前隐藏的消息保持原样，本次总结正文仍保留在历史记录中。')) return;
        }
        if (action === 'undo' || (combined && journal.phase !== 'undone')) {
            if (journal.phase === 'undone') throw new Error('最近一次总结已经撤销。');
            if (!combined && !window.confirm('撤销最近一次总结，恢复之前的注入正文？消息隐藏状态保持原样，可另点“恢复本轮隐藏的消息”。')) return;
            undoAttempted = true;
            const saved = await updateSavedOperation(context, archiveInfo, journal.id, target => {
                if (combined && journal.changes.length && !journal.messagesRestored) check();
                const meta = entryMetadata(target);
                const record = meta.records.find(item => item.id === journal.id);
                if (!record) throw new Error('本次记录不存在，无法撤销。');
                record.undone = true;
                target.content = journal.previous.content;
                Object.assign(meta, { round: journal.previous.round, coveredTo: journal.previous.coveredTo,
                    sourceEnd: journal.previous.sourceEnd, sourceDigest: journal.previous.sourceDigest, mode: journal.previous.mode });
                meta.lastOperation.phase = 'undone';
                meta.lastOperation.undoAtLength = context.chat.length;
                meta.lastOperation.resultDigest = textDigest(target.content);
                if (combined) meta.lastOperation.combinedRestorePending = Boolean(journal.changes.length && !journal.messagesRestored);
                target.constant = Boolean(target.content.trim());
                target.disable = !target.constant;
            });
            undoCommitted = true;
            assertSummaryActive();
            if (!isSameArchive(getContext(), archiveInfo, context.characterId)) return;
            Object.assign(archiveInfo.archive, { lastSummarizedThrough: journal.previous.coveredTo,
                sourceEnd: journal.previous.sourceEnd, sourceDigest: journal.previous.sourceDigest, round: journal.previous.round, autoTriggerArmed: false,
                summaryStillOverThreshold: false, undoAtLength: context.chat.length });
            if (archiveInfo.archive.branch) archiveInfo.archive.branch.needsRebuild = journal.previous.branchNeedsRebuild;
            await context.saveMetadata?.();
            currentSummaryEntry = saved;
            refreshSourceValidity();
            setStatus('已撤销最近一次总结，历史正文保留。需要原文时可恢复本轮隐藏的消息。');
        }
        if (action === 'retry' || action === 'restore' || (combined && journal.changes.length && !journal.messagesRestored)) {
            if (combined) undoCommitted = true;
            if (action === 'retry' && (journal.phase !== 'saved' || journal.hideEnd < 0)) throw new Error('没有待重试的隐藏操作。');
            if (action === 'restore' && journal.messagesRestored) throw new Error('本轮隐藏的消息已恢复。');
            check();
            const hidden = action === 'retry';
            if (hidden) { await verifySummaryInjection(context, entry); check(); updateTaskStage('restoring'); }
            const indices = journal.changes.filter(item => messageFingerprint(context.chat[item.index]) === item.fingerprint
                && Boolean(context.chat[item.index]?.is_system) !== hidden).map(item => item.index);
            for (const [start, end] of consecutiveRanges(indices)) {
                check();
                summaryHideInProgress = true;
                try {
                    const result = await context.executeSlashCommandsWithOptions(`/${hidden ? 'hide' : 'unhide'} ${start}-${end}`);
                    if (result?.isError || context.chat.slice(start, end + 1).some(message => Boolean(message.is_system) !== hidden)) {
                        throw new Error('楼层状态未全部更新，可稍后重试。');
                    }
                } finally { summaryHideInProgress = false; }
            }
            check();
            if (hidden) {
                reconcileArchiveMetadata(archiveInfo.archive, entry);
                archiveInfo.archive.autoTriggerArmed = false;
                await context.saveMetadata?.();
                check();
            }
            await updateSavedOperation(context, archiveInfo, journal.id, target => {
                const operation = entryMetadata(target).lastOperation;
                if (hidden) {
                    operation.phase = 'complete';
                    operation.result = { newHidden: journal.changes.length, keptVisible: context.chat.filter(message => !message.is_system).length };
                    delete operation.messagesRestored;
                }
                else { operation.messagesRestored = true; delete operation.combinedRestorePending; }
            });
            setStatus(hidden ? '已完成隐藏，没有重新调用模型。' : '已恢复本轮实际隐藏的消息；原先隐藏的消息保持原样。');
        }
        if (combined) setStatus('本次整理已撤销，需恢复的原文已恢复；此前隐藏的消息与本次总结历史均保留。');
        updateTaskStage('complete');
        notify('success', combined ? '本次整理已撤销，原文已恢复。' : action === 'undo' ? '最近一次总结已撤销。' : action === 'retry' ? '旧消息隐藏完成。' : '本轮隐藏的消息已恢复。');
        void renderDirectory();
        scheduleVisibilityRefresh(context);
    } catch (error) {
        updateTaskStage(summaryWasCancelled() ? 'cancelled' : 'failed');
        if (combined && undoAttempted && !undoCommitted && isSameArchive(getContext(), archiveInfo, context.characterId)) {
            archiveInfo.archive.pendingSummarySave = true;
            context.saveMetadataDebounced?.();
        }
        const message = combined && undoCommitted ? `总结已撤销，原文恢复未完成：${error.message}。可继续恢复本次原文。`
            : combined && undoAttempted ? `撤销结果尚未确认，未继续恢复原文：${error.message}。请刷新世界书状态后重试。` : error.message;
        notify('warning', message);
        setStatus(message);
    } finally {
        clearInterval(taskTimer);
        taskTimer = null;
        activeRun = null;
        archiveEditInProgress = false;
        unlockSending();
        syncTaskState();
        syncActionState();
    }
}

function eligibleUncoveredRange(context, archiveInfo, manual) {
    return summaryScope(context.chat, settings.keepRecent, archiveInfo.archive.lastSummarizedThrough ?? -1).range;
}

function captureMessageRange(chat, endIndex) {
    return chat.slice(0, endIndex + 1).map(message => ({
        mes: String(message?.mes ?? ''),
        is_user: Boolean(message?.is_user),
        is_system: Boolean(message?.is_system),
        name: String(message?.name ?? ''),
        fingerprint: messageFingerprint(message),
    }));
}

function messageRangeMatches(chat, snapshot) {
    if (chat.length < snapshot.length) return false;
    return snapshot.every((saved, index) => {
        const current = chat[index];
        return String(current?.mes ?? '') === saved.mes
            && Boolean(current?.is_user) === saved.is_user
            && Boolean(current?.is_system) === saved.is_system
            && String(current?.name ?? '') === saved.name
            && messageFingerprint(current) === saved.fingerprint;
    });
}

async function waitForCurrentGeneration(context, expectedChatId) {
    const native = await nativeScript();
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        const current = getContext();
        if (!current || current.chatId !== expectedChatId || current.characterId !== context.characterId) return false;
        const streaming = current.streamingProcessor && !current.streamingProcessor.isFinished;
        if (!streaming && !native.is_send_press && !native.isGenerating?.()
            && document.body.dataset.generating !== 'true') return true;
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    return false;
}

async function runLargeSummary({ manual = false, operation = 'summary', modeOverride = null } = {}) {
    if (!['summary', 'compact', 'rebuild'].includes(operation)) return false;
    if (modeOverride !== null && (!Object.hasOwn(MODE_LABELS, modeOverride) || operation !== 'summary')) return false;
    if (operation !== 'summary') manual = true;
    if (!settings?.enabled) return false;
    if (!manual && settings.autoEnabled === false) return false;
    if (runInProgress || archiveEditInProgress || (manual && (thresholdCheckInProgress || sendLockDepth))) return false;
    const context = getContext();
    const current = getCharacterAndChat(context);
    if (!context || !current) {
        if (manual) notify('warning', '请先打开一个角色卡的聊天存档。');
        return;
    }
    if (!canSummarize(context, !manual)) {
        if (manual) notify('warning', '请填写总结提示词。');
        return;
    }

    runInProgress = true;
    lockSending();
    setStatus('正在后台生成大总结，暂时暂停发送…');
    activeRun = {
        chatId: current.chatId, characterId: context.characterId, archiveId: null, committed: false,
        automatic: !manual, operation, cancelled: false, enabledRevision, manualVisibilityRevision,
        controller: new AbortController(),
    };
    updateTaskStage('preparing');
    taskTimer = setInterval(syncTaskState, 1000);
    let toast = null;
    if (manual) ui?.querySelector('.als-task-row')?.scrollIntoView?.({ block: 'nearest' });
    const showProgress = message => {
        if (toast) window.toastr?.clear?.(toast, { force: true });
        toast = null;
        // The visible task row already provides live progress. A persistent
        // toast would cover its controls on narrow screens.
        if (ui?.getClientRects?.().length) return;
        toast = notify('info', message, '喵喵大总结', {
            timeOut: 4000, extendedTimeOut: 1000, closeButton: true, tapToDismiss: false,
        });
    };
    let summaryCommitted = false;
    try {
        if (!await waitForCurrentGeneration(context, current.chatId)) {
            setStatus('当前生成尚未结束或聊天已切换，本次总结已取消。');
            if (manual) notify('warning', '当前生成尚未结束或聊天存档已切换，请稍后再试。');
            if (!manual) {
                const live = getContext();
                if (live?.chatId === current.chatId && live?.characterId === context.characterId) {
                    const archive = live.chatMetadata?.[MODULE_NAME];
                    if (archive) {
                        archive.autoTriggerArmed = true;
                        await live.saveMetadata?.();
                    }
                } else {
                    queueArchiveRetry(context.chatMetadata?.[MODULE_NAME]?.archiveId);
                }
            }
            return;
        }
        assertSummaryActive();
        if (operation === 'rebuild' && !context.chat.some(message => String(message?.mes ?? '').trim())) {
            throw new Error('当前存档没有可用于重建的原文，旧总结和历史记录保持不变。');
        }
        const archiveInfo = await ensureArchive(context);
        if (!archiveInfo) return;
        activeRun.archiveId = archiveInfo.archive.archiveId;
        const initialBook = await ensureWorldBook(context);
        const initializingBranch = Boolean(archiveInfo.archive.branch?.pending);
        await initializeBranchArchive(context, archiveInfo, initialBook);
        const activationBook = initializingBranch ? await readWorldBookData(context, settings.worldBookName) : initialBook;
        await setArchiveActivation(archiveInfo.archive.archiveId, { reconcileCursor: true, bookData: activationBook });
        assertSummaryActive();
        if (!isSameArchive(getContext(), archiveInfo, context.characterId)) {
            queueArchiveRetry(archiveInfo.archive.archiveId);
            return;
        }
        const beforeBook = activationBook;
        assertSummaryActive();
        const beforeEntry = listOwnedEntries(beforeBook).find(entry => entryMetadata(entry)?.archiveId === archiveInfo.archive.archiveId);
        const beforeRevision = entryRevision(beforeEntry, ENTRY_MARKER);
        if (summarySourceChanged(context.chat, entryMetadata(beforeEntry)) && !sourceChangeAccepted(context.chat,
            { ...entryMetadata(beforeEntry), sourceChangeAcknowledgement: archiveInfo.archive.sourceChangeAcknowledgement })) {
            archiveInfo.archive.sourceChanged = true;
            context.saveMetadataDebounced?.();
        }
        if (operation !== 'rebuild' && archiveInfo.archive.sourceChanged) {
            throw new Error('已有总结对应的原文已改变，请先选择更新记忆或保留现有总结；旧总结与原文保持不变。');
        }
        if (operation === 'summary' && archiveInfo.archive.branch?.needsRebuild) {
            throw new Error('本分支需要先更新记忆，确认可复用的有效旧总结，避免继承分叉后的剧情。');
        }
        if (operation === 'compact' && !beforeEntry?.content?.trim()) {
            setStatus('当前存档还没有可合并的总结。');
            if (manual) notify('info', '当前存档还没有可合并的总结。');
            return false;
        }
        const keepRecent = Math.max(1, Math.floor(Number(settings.keepRecent) || 1));
        const checkpoint = operation === 'rebuild' ? memoryUpdateCheckpoint(archiveRecords(beforeEntry ?? {}), context.chat) : null;
        if (operation === 'rebuild' && !checkpoint) {
            const message = '没有可复用的有效旧总结，本次未调用模型，也不会全量重跑历史。可在世界书中手动修正总结，或选择保留现有总结继续使用。';
            setStatus(message);
            notify('warning', message);
            return false;
        }
        const range = operation === 'compact'
            ? { coveredFrom: entryMetadata(beforeEntry)?.coveredFrom ?? 0, coveredTo: entryMetadata(beforeEntry)?.coveredTo ?? -1, keepRecent }
            : operation === 'rebuild'
                ? { coveredFrom: 0, coveredTo: Math.max(-1, context.chat.length - keepRecent - 1), keepRecent }
                : eligibleUncoveredRange(context, archiveInfo, manual);
        if (!range) {
            setStatus('没有可总结的旧楼层，可以继续对话。');
            if (!manual) {
                archiveInfo.archive.autoTriggerArmed = true;
                await context.saveMetadata?.();
            }
            if (manual) notify('info', '没有可总结的旧楼层。');
            return;
        }
        const sourceSnapshot = captureMessageRange(context.chat, context.chat.length - 1);
        const sourceEnd = context.chat.length - 1;
        const sourceDigest = historyDigest(context.chat, sourceEnd);
        const mode = operation === 'summary' ? modeOverride ?? settings.mode : 'merged';
        const promptStyle = settings.promptStyle;
        const template = operation === 'summary' && modeOverride === null ? settings.prompt : promptTemplates(settings)[mode];
        let prompt = context.substituteParamsExtended
            ? await context.substituteParamsExtended(template)
            : template;
        if (operation === 'compact') prompt = sourceTaskPrompt('仅合并已有总结，不加入新剧情', prompt, beforeEntry.content);
        if (operation === 'rebuild') prompt = sourceTaskPrompt('沿用有效旧总结并更新后续记忆', prompt,
            `【已验证有效的旧总结，覆盖至第 ${checkpoint.sourceEnd} 层】\n${checkpoint.content}\n\n`
            + `【后续原文，从第 ${checkpoint.sourceEnd + 1} 层开始；包含这一区间内的隐藏消息】\n`
            + context.chat.slice(checkpoint.sourceEnd + 1).map((message, offset) =>
                `[第 ${checkpoint.sourceEnd + 1 + offset} 层 · ${message.name ?? (message.is_user ? '用户' : '角色')}]\n${message.mes ?? ''}`).join('\n\n'));
        if (!String(prompt ?? '').trim()) throw new Error('总结提示词为空。');
        assertSummaryActive();

        updateTaskStage('generating');
        showProgress(operation === 'compact' ? '正在合并已有总结，不改变消息可见状态…' : '正在大总结中，请等待…');
        const summary = checkpoint?.sourceEnd === sourceEnd ? checkpoint.content
            : await requestMainApiSummary(context, String(prompt), { sourceOnly: operation !== 'summary' });
        assertSummaryActive();
        const latestContext = getContext();
        const latestIdentity = getCharacterAndChat(latestContext);
        if (!summary || !String(summary).trim()) throw new Error('总结 API 没有返回正文喵。');
        if (!latestContext || latestIdentity?.chatId !== archiveInfo.chatId
            || latestContext.characterId !== context.characterId
            || latestContext.chatMetadata?.[MODULE_NAME]?.archiveId !== archiveInfo.archive.archiveId) {
            console.warn('[自动大总结] 生成期间聊天存档已切换，已丢弃这次结果。');
            queueArchiveRetry(archiveInfo.archive.archiveId);
            return;
        }
        if (!messageRangeMatches(latestContext.chat, sourceSnapshot)) {
            const currentArchive = latestContext.chatMetadata?.[MODULE_NAME];
            if (currentArchive) {
                currentArchive.autoTriggerArmed = true;
                await latestContext.saveMetadata?.();
            }
            notify('warning', '生成期间旧楼层发生变化，这次结果未保存也未隐藏楼层。', '喵喵大总结');
            return;
        }

        updateTaskStage('saving');
        showProgress('大总结已返回，正在保存世界书…');
        const data = await ensureWorldBook(latestContext);
        assertSummaryActive();
        if (!isSameArchive(getContext(), archiveInfo, context.characterId)
            || !messageRangeMatches(getContext().chat, sourceSnapshot)) {
            notify('warning', '保存前聊天发生变化，这次结果未保存也未隐藏楼层。', '喵喵大总结');
            return;
        }
        const all = listOwnedEntries(data);
        const existingEntry = all.find(entry => entryMetadata(entry)?.archiveId === archiveInfo.archive.archiveId);
        if (entryRevision(existingEntry, ENTRY_MARKER) !== beforeRevision) {
            throw new Error('生成期间总结记录被其他操作修改，本次结果未覆盖旧记录，请重试。');
        }
        const previousRecords = existingEntry ? archiveRecords(existingEntry) : [];
        const previousRound = Math.max(
            archiveInfo.archive.round ?? 0,
            ...all.filter(entry => entryMetadata(entry)?.archiveId === archiveInfo.archive.archiveId)
                .flatMap(entry => [entryMetadata(entry)?.round ?? 0, ...archiveRecords(entry).map(record => record.round)]),
        );
        const round = previousRound + 1;
        let uid = existingEntry?.uid ?? 0;
        if (!existingEntry) while (Object.hasOwn(data.entries, uid)) uid += 1;
        const now = new Date();
        const operationId = `${randomId()}-${++operationSequence}`;
        const recordSourceEnd = operation === 'compact' ? entryMetadata(existingEntry)?.sourceEnd ?? null : sourceEnd;
        const recordSourceDigest = operation === 'compact' ? entryMetadata(existingEntry)?.sourceDigest ?? null : sourceDigest;
        const previousMeta = entryMetadata(existingEntry);
        const journal = {
            id: operationId, operation, phase: operation === 'compact' ? 'complete' : 'saved',
            sourceEnd, sourceDigest, hideEnd: operation === 'compact' ? -1 : range.coveredTo,
            manualEpoch: archiveInfo.archive.visibilityEpoch ?? '',
            changes: operation === 'compact' ? [] : visibilityChanges(latestContext.chat, range.coveredTo),
            previous: { content: existingEntry?.content ?? '', round: previousMeta?.round ?? 0,
                coveredTo: previousMeta?.coveredTo ?? -1, sourceEnd: previousMeta?.sourceEnd ?? null,
                sourceDigest: previousMeta?.sourceDigest ?? null, mode: previousMeta?.mode ?? 'incremental',
                branchNeedsRebuild: archiveInfo.archive.branch?.needsRebuild ?? false },
        };
        const meta = {
            owner: MODULE_NAME,
            version: 1,
            storageVersion: 3,
            archiveId: archiveInfo.archive.archiveId,
            cardKey: archiveInfo.cardKey,
            characterName: archiveInfo.characterName,
            chatId: archiveInfo.chatId,
            chatName: archiveInfo.chatName,
            chatIntegrity: archiveInfo.archive.chatIntegrity,
            round,
            coveredFrom: previousRecords[0]?.coveredFrom ?? range.coveredFrom,
            coveredTo: range.coveredTo,
            createdAt: entryMetadata(existingEntry)?.createdAt ?? now.toISOString(),
            updatedAt: now.toISOString(),
            mode,
            sourceEnd: recordSourceEnd, sourceDigest: recordSourceDigest,
            lastOperation: journal,
            records: [...previousRecords, {
                round, mode, promptStyle, content: String(summary).trim(), createdAt: now.toISOString(),
                coveredFrom: range.coveredFrom, coveredTo: range.coveredTo,
                id: operationId, operation, sourceEnd: recordSourceEnd, sourceDigest: recordSourceDigest,
            }],
        };
        const title = `喵喵大总结 · ${meta.characterName} · ${meta.chatName}`.slice(0, 100);
        const expectedContent = mode === 'incremental' && existingEntry?.content?.trim()
            ? `${existingEntry.content.trim()}\n\n${String(summary).trim()}` : String(summary).trim();
        journal.resultDigest = textDigest(expectedContent);
        data.entries[uid] = {
            ...existingEntry,
            uid,
            key: [],
            keysecondary: [],
            comment: title,
            content: expectedContent,
            constant: true,
            vectorized: false,
            selective: true,
            selectiveLogic: 0,
            addMemo: false,
            order: 100,
            position: 4,
            disable: false,
            ignoreBudget: false,
            excludeRecursion: false,
            preventRecursion: true,
            matchPersonaDescription: false,
            matchCharacterDescription: false,
            matchCharacterPersonality: false,
            matchCharacterDepthPrompt: false,
            matchScenario: false,
            matchCreatorNotes: false,
            delayUntilRecursion: 0,
            probability: 100,
            useProbability: true,
            depth: Math.max(0, Math.floor(Number(settings.depth) || 0)),
            outletName: '',
            group: '',
            groupOverride: false,
            groupWeight: 100,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
            role: 0,
            sticky: null,
            cooldown: null,
            delay: null,
            triggers: [],
            extensions: { ...existingEntry?.extensions, [ENTRY_MARKER]: meta },
        };
        for (const entry of all) {
            if (entry.uid === uid) continue;
            entry.constant = false;
            entry.disable = true;
            entry.preventRecursion = true;
        }
        activeRun.saveAttempted = true;
        await latestContext.saveWorldInfo(settings.worldBookName, data, true);
        const persistedBook = await readWorldBookData(latestContext, settings.worldBookName);
        const persistedEntry = persistedBook?.entries?.[uid];
        if (persistedEntry?.content !== expectedContent || persistedEntry?.preventRecursion !== true
            || entryMetadata(persistedEntry)?.archiveId !== meta.archiveId
            || entryMetadata(persistedEntry)?.records?.at(-1)?.content !== String(summary).trim()) {
            throw new Error('大总结未能从世界书读回确认，楼层尚未隐藏。');
        }
        summaryCommitted = true;
        activeRun.committed = true;
        currentSummaryEntry = persistedEntry;
        if (incompleteResults.has(archiveInfo.archive.archiveId)) removeIncompleteDraft(archiveInfo.archive.archiveId);
        showProgress('大总结保存成功，正在处理旧楼层…');
        assertSummaryActive();
        latestContext.reloadWorldInfoEditor?.(settings.worldBookName);

        if (!isSameArchive(getContext(), archiveInfo, context.characterId)) {
            console.warn('[自动大总结] 世界书已保存，但聊天存档已经切换；没有修改楼层可见状态。');
            notify('info', '大总结保存成功；聊天已切换，没有隐藏楼层。', '喵喵大总结');
            return;
        }
        const currentArchive = latestContext.chatMetadata[MODULE_NAME];
        currentArchive.lastSummarizedThrough = range.coveredTo;
        currentArchive.round = round;
        currentArchive.sourceEnd = recordSourceEnd;
        currentArchive.sourceDigest = recordSourceDigest;
        delete currentArchive.sourceChanged;
        delete currentArchive.sourceChangeAcknowledgement;
        delete currentArchive.coverageBlocked;
        delete currentArchive.undoAtLength;
        if (operation === 'rebuild' && currentArchive.branch) currentArchive.branch.needsRebuild = false;
        currentArchive.worldBookName = settings.worldBookName;
        await latestContext.saveMetadata?.();
        if (settings.pendingRetries.includes(archiveInfo.archive.archiveId)) {
            settings.pendingRetries = settings.pendingRetries.filter(id => id !== archiveInfo.archive.archiveId);
            saveSettings();
        }

        const liveContext = getContext();
        assertSummaryActive();
        if (!isSameArchive(liveContext, archiveInfo, context.characterId)
            || !messageRangeMatches(liveContext.chat, sourceSnapshot)) {
            console.warn('[自动大总结] 保存过程中聊天发生变化；保留总结记录，没有隐藏楼层。');
            notify('info', '大总结保存成功；聊天已变化，没有隐藏楼层。', '喵喵大总结');
            return;
        }
        const hideStart = 0;
        const hideEnd = operation === 'compact' ? -1 : Math.min(range.coveredTo, liveContext.chat.length - range.keepRecent - 1);
        if (hideEnd >= hideStart) {
            await verifySummaryInjection(liveContext, persistedEntry);
            assertSummaryActive();
            if (!isSameArchive(getContext(), archiveInfo, context.characterId)
                || !messageRangeMatches(liveContext.chat, sourceSnapshot)) throw new Error('注入检查期间聊天发生变化，未隐藏消息。');
            updateTaskStage('hiding');
            setStatus('大总结已保存，正在隐藏旧楼层…');
            if (typeof liveContext.executeSlashCommandsWithOptions !== 'function') throw new Error('总结已保存，但酒馆缺少隐藏楼层接口。');
            // Exactly one native /hide after this newly saved summary.
            // Outside this transaction, manual visibility stays untouched.
            let result;
            summaryHideInProgress = true;
            try {
                result = await liveContext.executeSlashCommandsWithOptions(`/hide ${hideStart}-${hideEnd}`);
            } finally {
                summaryHideInProgress = false;
            }
            assertSummaryActive();
            if (result?.isError || liveContext.chat.slice(hideStart, hideEnd + 1).some(message => !message.is_system)) {
                throw new Error('总结已保存，但旧楼层未全部隐藏，请检查 /hide 命令。');
            }
        }
        if (operation !== 'compact') await updateSavedOperation(liveContext, archiveInfo, operationId, entry => {
            const savedOperation = entryMetadata(entry).lastOperation;
            savedOperation.phase = 'complete';
            savedOperation.result = { newHidden: journal.changes.length, keptVisible: liveContext.chat.filter(message => !message.is_system).length };
        });
        currentArchive.autoTriggerArmed = false;
        await liveContext.saveMetadata?.();
        updateTaskStage('complete');
        const completion = summaryResultText(entryMetadata(currentSummaryEntry)?.lastOperation);
        setStatus(completion);
        notify('success', completion, '喵喵大总结');
        if (manual) scheduleVisibilityRefresh(liveContext, { afterSummary: true });
        void renderDirectory();
        return true;
    } catch (error) {
        updateTaskStage(summaryWasCancelled() ? 'cancelled' : 'failed');
        if (activeRun?.coverageBlocked && !summaryWasCancelled()) {
            const live = getContext();
            if (live?.chatId === activeRun.chatId && live?.characterId === activeRun.characterId
                && live.chatMetadata?.[MODULE_NAME]?.archiveId === activeRun.archiveId) {
                live.chatMetadata[MODULE_NAME].coverageBlocked = true;
                live.saveMetadataDebounced?.();
            }
        }
        const recovery = ui?.querySelector('.als-recovery');
        if (summaryCommitted && recovery) recovery.open = true;
        if (summaryWasCancelled()) {
            setStatus(summaryCommitted ? '总结记录已保存；本次自动隐藏已取消。'
                : incompleteResults.has(activeRun?.archiveId) ? '本次总结已取消；已收到的正文可在概览查看和复制。' : '本次总结已取消。');
            notify('info', summaryCommitted ? '大总结保存成功；本次自动隐藏已取消。' : '本次大总结已取消，旧楼层未隐藏。', '喵喵大总结');
        } else {
            console.error('[喵喵大总结] 总结失败：', error);
            const failure = `${summaryCommitted ? (entryMetadata(currentSummaryEntry)?.lastOperation?.phase === 'saved' ? '总结已保存，隐藏未完成' : '大总结已保存，但后续处理失败') : '大总结失败'}：${error?.message ?? error}`;
            notify('error', failure, '喵喵大总结');
            setStatus(`${failure.replace(/[。.!?！？]+$/, '')}。已解除发送锁。`);
        }
        if (!summaryCommitted && activeRun?.saveAttempted) {
            const live = getContext();
            if (live?.chatId === activeRun.chatId && live?.characterId === activeRun.characterId
                && live.chatMetadata?.[MODULE_NAME]?.archiveId === activeRun.archiveId) {
                live.chatMetadata[MODULE_NAME].pendingSummarySave = true;
            }
            setStatus('保存请求已发出，但读回确认尚未完成；未自动隐藏消息。请点击世界书刷新按钮或重新打开当前聊天确认记录。');
        }
        if (!summaryCommitted && !activeRun?.saveAttempted && settings.enabled) {
            const live = getContext();
            const currentArchive = live?.chatMetadata?.[MODULE_NAME];
            if (currentArchive && live?.chatId === activeRun?.chatId
                && live?.characterId === activeRun?.characterId
                && (!activeRun?.archiveId || currentArchive.archiveId === activeRun.archiveId)) {
                currentArchive.autoTriggerArmed = true;
                live.saveMetadataDebounced?.();
            }
        }
    } finally {
        clearInterval(taskTimer);
        taskTimer = null;
        if (toast) window.toastr?.clear?.(toast, { force: true });
        runInProgress = false;
        activeRun = null;
        // A message edit during an awaited save can precede metadata updates.
        // Recheck the committed provenance before presenting the final state.
        refreshSourceValidity();
        unlockSending();
        syncTaskState();
        syncActionState();
    }
}

function onGenerationAfterCommands(type, _options, dryRun) {
    if (!settings?.enabled) return;
    refreshFinalHooks();
    if (dryRun) return;
    if (summaryRequest?.afterCommands && type === 'quiet') {
        summaryRequest.afterCommands = false;
        summaryRequest.interceptorPending = true;
        return;
    }
    // Event listeners must return promptly: a slash script may itself call
    // Generate, and waiting here can hold ST's command/busy state indefinitely.
    if (sendLockDepth) return;
    const context = getContext();
    const current = getCharacterAndChat(context);
    pendingGeneration = canSummarize(context, true) && ['normal', 'continue'].includes(type) ? {
        token: ++generationToken, chatId: current.chatId, characterId: context.characterId,
        manualVisibilityRevision,
        received: false, ended: false, locked: false,
    } : null;
}

globalThis.meowLargeSummaryGenerationInterceptor = (_chat, _contextSize, abort, type) => {
    if (!settings?.enabled) {
        if (disabledCleanupPending) {
            abort(true);
            notify('info', '正在停用旧总结条目，完成后就能发送喵。', '', { preventDuplicates: true });
        }
        return;
    }
    if (type === 'quiet' && summaryRequest?.interceptorPending && !summaryWasCancelled()) {
        summaryRequest.interceptorPending = false;
        captureCoverageSources(summaryRequest.coverage, _chat);
        return;
    }
    if (!sendLockDepth) return;
    // The supported ST interceptor aborts a model generation after slash
    // parsing. Local commands never reach it, and no waiter holds their script.
    abort(true);
    notify('info', '正在检查上下文或进行大总结，请处理完成后再生成。', '喵喵大总结', { preventDuplicates: true });
};

async function checkAfterReply(pending) {
    thresholdCheckInProgress = true;
    const startEnabledRevision = enabledRevision;
    const startVisibilityRevision = pending.manualVisibilityRevision ?? manualVisibilityRevision;
    const stillEnabled = () => settings.enabled && settings.autoEnabled !== false && enabledRevision === startEnabledRevision
        && manualVisibilityRevision === startVisibilityRevision
        && getContext()?.chatId === pending.chatId && getContext()?.characterId === pending.characterId;
    try {
        const context = getContext();
        if (context?.chatId !== pending.chatId || context?.characterId !== pending.characterId
            || !canSummarize(context, true)) return;
        if (!stillEnabled() || !await waitForCurrentGeneration(context, pending.chatId) || !stillEnabled()) return;
        const archiveInfo = await ensureArchive(context);
        if (!archiveInfo || !stillEnabled()) return;
        await refreshBudgetWarning();
        if (!stillEnabled()) return;
        const snapshot = captureMessageRange(context.chat, context.chat.length - 1);
        const comparisonConfiguration = tokenComparisonConfiguration(context);
        const countedDigest = textDigest(JSON.stringify(snapshot.map(message => message.fingerprint)));
        const data = await assemblePrompt(context);
        if (!stillEnabled()) return;
        const count = await countAssembledPrompt(context, data);
        if (!Number.isFinite(count)) throw new Error('酒馆返回了无效的 token 数。');
        if (!stillEnabled() || !isSameArchive(getContext(), archiveInfo, context.characterId)
            || !messageRangeMatches(getContext().chat, snapshot)) return;
        const threshold = Math.max(1, Number(settings.threshold) || DEFAULT_SETTINGS.threshold);
        archiveInfo.archive.lastPromptTokens = count;
        await renderNativeTokenCounter(context);
        if (!stillEnabled()) return;
        setStatus(`${pending.onOpen ? '当前存档' : '本轮回复后'}上下文：${count.toLocaleString()} / ${threshold.toLocaleString()} token`);
        if (count < threshold) {
            archiveInfo.archive.autoTriggerArmed = true;
            archiveInfo.archive.summaryStillOverThreshold = false;
            await context.saveMetadata?.();
            return;
        }
        if (archiveInfo.archive.summaryStillOverThreshold) {
            setStatus(`喵，本档总结后仍超阈值，已暂停连续自动总结。当前 ${count.toLocaleString()} / ${threshold.toLocaleString()} token，请先调整设置或手动处理。`);
            return;
        }
        if ((archiveInfo.archive.autoTriggerArmed === false && !pending.onOpen)
            || !eligibleUncoveredRange(context, archiveInfo, false)) return;
        archiveInfo.archive.autoTriggerArmed = false;
        await context.saveMetadata?.();
        if (!stillEnabled()) return;
        const completed = await runLargeSummary();
        if (completed && stillEnabled() && isSameArchive(getContext(), archiveInfo, context.characterId)) {
            const operation = entryMetadata(currentSummaryEntry)?.lastOperation;
            const afterSnapshot = captureMessageRange(getContext().chat, getContext().chat.length - 1);
            const afterConfiguration = tokenComparisonConfiguration(getContext());
            const after = await countAssembledPrompt(getContext(), await assemblePrompt(getContext()));
            if (!Number.isFinite(after)) throw new Error('喵，酒馆返回了无效的总结后 token 数。');
            if (!stillEnabled() || !isSameArchive(getContext(), archiveInfo, context.characterId)) return;
            if (getContext().chat.length !== afterSnapshot.length || !messageRangeMatches(getContext().chat, afterSnapshot)
                || operation?.id !== entryMetadata(currentSummaryEntry)?.lastOperation?.id
                || afterConfiguration !== tokenComparisonConfiguration(getContext())) return;
            archiveInfo.archive.lastPromptTokens = after;
            await renderNativeTokenCounter(getContext());
            if (!stillEnabled()) return;
            const comparable = comparisonConfiguration !== null && comparisonConfiguration === tokenComparisonConfiguration(getContext())
                && operation?.id === entryMetadata(currentSummaryEntry)?.lastOperation?.id
                && operation?.sourceEnd === snapshot.length - 1 && operation?.sourceDigest === countedDigest
                && getContext().chat.length === snapshot.length && messageRangeMatches(getContext().chat, afterSnapshot);
            reportSummaryTokenCount(archiveInfo.archive, after, comparable ? count : undefined);
            await getContext().saveMetadata?.();
        }
    } catch (error) {
        if (!stillEnabled()) return;
        console.error('[喵喵大总结] 回复后阈值检查失败：', error);
        setStatus(`阈值检查失败：${error.message}。已解除发送锁。`);
        notify('error', `大总结阈值检查失败：${error.message}`);
    } finally {
        thresholdCheckInProgress = false;
        if (pending.locked) {
            pending.locked = false;
            unlockSending();
        }
    }
}

function tokenComparisonConfiguration(context) {
    try {
        return textDigest(JSON.stringify([context.mainApi, context.chatCompletionSettings, context.textCompletionSettings,
            context.powerUserSettings, context.extensionPrompts, context.name1, context.name2, settings.worldBookName]));
    } catch { return null; }
}

function reportSummaryTokenCount(archive, count, before) {
    const journal = entryMetadata(currentSummaryEntry)?.lastOperation;
    if (entryMetadata(currentSummaryEntry)?.archiveId === archive.archiveId && journal?.phase === 'complete'
        && !journal.messagesRestored) {
        archive.lastSummaryTokens = { operationId: journal.id, after: count };
        if (Number.isFinite(before)) archive.lastSummaryTokens.before = before;
    }
    const threshold = Math.max(1, Number(settings.threshold) || DEFAULT_SETTINGS.threshold);
    const over = count >= threshold;
    archive.autoTriggerArmed = !over;
    archive.summaryStillOverThreshold = over;
    if (over) {
        const message = `总结已保存喵，但当前仍有 ${count.toLocaleString()} / ${threshold.toLocaleString()} token。已停止连续自动总结，请减少保留楼层、精简预设或世界书，或手动切换合并模式处理；原总结记录已保留。`;
        setStatus(message);
        notify('warning', message, '喵喵大总结', { timeOut: 12000, closeButton: true });
    } else setStatus(summaryResultText(entryMetadata(currentSummaryEntry)?.lastOperation, count)
        || `大总结完成，当前上下文：${count.toLocaleString()} token，可以继续对话喵。`);
}

function maybeSchedulePending() {
    if (!settings.enabled || settings.autoEnabled === false) { cancelPendingAutoSummary(); return; }
    if (!pendingGeneration?.received || !pendingGeneration?.ended || summaryTimer) return;
    const pending = pendingGeneration;
    if (!pending.locked) {
        pending.locked = true;
        lockSending();
        setStatus('回复已结束，正在检查实际上下文 token…');
    }
    summaryTimer = setTimeout(() => {
        summaryTimer = null;
        if (pendingGeneration?.token !== pending.token) return;
        pendingGeneration = null;
        void checkAfterReply(pending);
    }, 0);
}

function onMessageReceived(_messageId, type) {
    syncActionState();
    if (!pendingGeneration || runInProgress || thresholdCheckInProgress) return;
    if (type && !['normal', 'continue', 'appendFinal'].includes(type)) return;
    const context = getContext();
    if (context?.streamingProcessor?.isStopped) return;
    if (context?.chatId !== pendingGeneration.chatId || context?.characterId !== pendingGeneration.characterId) return;
    pendingGeneration.received = true;
    maybeSchedulePending();
}

function onGenerationEnded() {
    if (!pendingGeneration || runInProgress || thresholdCheckInProgress) return;
    pendingGeneration.ended = true;
    maybeSchedulePending();
}

async function syncCurrentArchive() {
    getSettings();
    if (!settings.enabled) return;
    currentSummaryEntry = null;
    const revision = enabledRevision;
    const stillEnabled = () => settings.enabled && revision === enabledRevision;
    installVisibilityCommandHooks();
    const context = getContext();
    let archiveInfo = await ensureArchive(context);
    if (!stillEnabled()) return;
    if (archiveInfo && settings.pendingRetries.includes(archiveInfo.archive.archiveId)) {
        archiveInfo.archive.autoTriggerArmed = true;
        settings.pendingRetries = settings.pendingRetries.filter(id => id !== archiveInfo.archive.archiveId);
        await context.saveMetadata?.();
        saveSettings();
    }
    let existing = await prepareWorldBook(context, settings.worldBookName, { create: false });
    if (!stillEnabled()) return;
    if (existing && archiveInfo) {
        const initializingBranch = Boolean(archiveInfo.archive.branch?.pending);
        await initializeBranchArchive(context, archiveInfo, existing);
        if (initializingBranch) existing = await readWorldBookData(context, settings.worldBookName);
    }
    if (!stillEnabled()) return;
    const matchingEntry = existing && archiveInfo && listOwnedEntries(existing)
        .find(entry => entryMetadata(entry)?.archiveId === archiveInfo.archive.archiveId);
    if (matchingEntry && entryMetadata(matchingEntry)?.cardKey !== archiveInfo.cardKey
        && isSameArchive(getContext(), archiveInfo, context.characterId)) {
        // Also repair IDs inherited before card identity was checked.
        delete archiveInfo.archive.archiveId;
        archiveInfo = await ensureArchive(context);
    }
    if (existing && stillEnabled()) await setArchiveActivation(archiveInfo?.archive.archiveId ?? null, { reconcileCursor: true, bookData: existing });
    if (!stillEnabled()) return;
    syncActionState();
    void updateWorldBookStatus();
    if (currentTab === 'directory') void renderDirectory();
}

function scheduleChatSync({ checkThreshold = true } = {}) {
    if (!settings?.enabled) return Promise.resolve();
    const revision = ++chatSyncRevision;
    const startEnabledRevision = enabledRevision;
    const stillEnabled = () => settings.enabled && startEnabledRevision === enabledRevision && revision === chatSyncRevision;
    const startVisibilityRevision = manualVisibilityRevision;
    lockSending();
    setStatus('正在切换总结条目并检查当前存档…');
    const operation = chatSyncChain.catch(() => {}).then(async () => {
        if (!stillEnabled()) return;
        // An earlier archive may still be finishing a cancelled request. Its
        // final write must finish before the new archive becomes active.
        while (runInProgress || thresholdCheckInProgress || promptProbe || archiveEditInProgress) {
            await new Promise(resolve => setTimeout(resolve, 80));
            if (!stillEnabled()) return;
        }
        await syncCurrentArchive();
        if (!stillEnabled()) return;
        const context = getContext();
        const current = getCharacterAndChat(context);
        if (checkThreshold && manualVisibilityRevision === startVisibilityRevision && current && canSummarize(context, true)) {
            await checkAfterReply({ chatId: current.chatId, characterId: context.characterId, onOpen: true, locked: false });
        } else {
            setStatus(context.chatMetadata?.[MODULE_NAME]?.branch?.needsRebuild
                ? '本分支的旧总结跨过分叉点或缺少来源信息，请从分支原文重建。'
                : current ? (settings.autoEnabled ? '总结条目已同步。' : '自动总结已暂停，可手动总结；已有总结继续注入。') : '请选择角色卡的聊天存档。');
        }
    });
    chatSyncChain = operation.catch(error => {
        if (stillEnabled()) {
            console.error('[喵喵大总结] 存档同步失败：', error);
            setStatus(`存档同步失败：${error.message}`);
            notify('error', `大总结存档同步失败：${error.message}`);
        }
    }).finally(unlockSending);
    return chatSyncChain;
}

function createElement(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function summaryRows(data) {
    return listOwnedEntries(data)
        .map(entry => ({ entry, meta: entryMetadata(entry) }))
        .filter(row => row.meta)
        .sort((a, b) => String(a.meta.characterName).localeCompare(String(b.meta.characterName), 'zh-CN')
            || String(a.meta.chatName).localeCompare(String(b.meta.chatName), 'zh-CN')
            || (a.meta.round ?? 0) - (b.meta.round ?? 0));
}

function showSummary(entry, { refresh = false } = {}) {
    const meta = entryMetadata(entry);
    selectedSummary = { archiveId: meta.archiveId, uid: entry.uid, bookName: settings.worldBookName };
    if (!refresh) summaryReturnFocus = document.activeElement?.matches?.('.als-archive-row') ? document.activeElement : null;
    ui.querySelector('.als-preview-title').textContent = `${meta.characterName} / ${meta.chatName}`;
    const select = ui.querySelector('.als-history-select');
    const previousSelection = refresh ? select.value : 'all';
    select.replaceChildren(createElement('option', '', '全部：当前注入内容'));
    select.firstElementChild.value = 'all';
    const records = archiveRecords(entry);
    for (let index = records.length - 1; index >= 0; index--) {
        const record = records[index];
        const styleLabel = PROMPT_STYLE_LABELS[record.promptStyle];
        const option = createElement('option', '', `第 ${record.round} 次 · ${record.operation === 'compact' ? '仅合并' : MODE_LABELS[record.mode] ?? '多次大总结'}${styleLabel ? ` · ${styleLabel}` : ''}${record.undone ? ' · 已撤销' : ''}`);
        option.value = String(index);
        select.append(option);
    }
    select.value = previousSelection !== 'all' && records[Number(previousSelection)] ? previousSelection : 'all';
    const record = select.value === 'all' ? activeRecords(records).at(-1) : records[Number(select.value)];
    ui.querySelector('.als-preview').value = select.value === 'all' ? entry.content ?? '' : record?.content ?? '';
    if (!refresh) ui.querySelector('.als-preview').scrollTop = 0;
    ui.querySelector('.als-delete-round').disabled = !settings.enabled || select.value === 'all' || Boolean(sendLockDepth);
    ui.querySelector('.als-preview-box').hidden = false;
    const list = ui.querySelector('.als-directory-list');
    if (list) list.hidden = true;
    const manage = ui.querySelector('.als-manage');
    if (manage && !refresh) manage.open = false;
    const detail = ui.querySelector('.als-record-detail');
    if (detail) detail.textContent = sourceDescription(record);
    updateSummaryDisplay();
    if (!refresh) ui.querySelector('.als-preview-close')?.focus();
}

function updateSummaryDisplay(view) {
    const source = ui?.querySelector('.als-preview');
    const reading = ui?.querySelector('.als-reading');
    if (!source || !reading) return;
    const selectedView = view ?? ui.querySelector('.als-reader-mode[aria-pressed="true"]')?.dataset.view ?? 'reading';
    source.hidden = selectedView !== 'source';
    reading.hidden = selectedView === 'source';
    for (const button of ui.querySelectorAll('.als-reader-mode')) button.setAttribute('aria-pressed', String(button.dataset.view === selectedView));
    renderSummaryReader(reading, source.value, window.SillyTavern?.libs);
}

function closeSummaryPreview({ focus = true } = {}) {
    const uid = selectedSummary?.uid;
    const box = ui?.querySelector('.als-preview-box');
    if (box) box.hidden = true;
    const list = ui?.querySelector('.als-directory-list');
    if (list) list.hidden = false;
    if (focus) {
        const target = summaryReturnFocus?.isConnected ? summaryReturnFocus
            : [...ui.querySelectorAll('.als-archive-row')].find(row => row.dataset.entryUid === String(uid));
        target?.focus();
    }
    selectedSummary = null;
    summaryReturnFocus = null;
}

async function deleteSummarySelection({ roundOnly = false } = {}) {
    if (!settings.enabled || sendLockDepth || !selectedSummary || selectedSummary.bookName !== settings.worldBookName) return;
    const selection = { ...selectedSummary };
    const selectedRound = ui.querySelector('.als-history-select').value;
    archiveEditInProgress = true;
    lockSending();
    try {
        const context = getContext();
        const data = await prepareWorldBook(context, selection.bookName, { create: false });
        if (!settings.enabled) return;
        const entry = data?.entries?.[selection.uid];
        if (!entry || entryMetadata(entry)?.archiveId !== selection.archiveId) return;
        const meta = entryMetadata(entry);
        const records = archiveRecords(entry);
        const index = selectedRound === 'all' ? NaN : Number(selectedRound);
        if (roundOnly && (!Number.isInteger(index) || !records[index])) return;
        const message = roundOnly
            ? `删除第 ${records[index].round} 次总结记录？将按剩余历史重建注入内容，已隐藏楼层不会自动恢复。`
            : `删除“${meta.characterName} / ${meta.chatName}”的全部总结？已隐藏楼层不会自动恢复。`;
        if (!window.confirm(message)) return;
        let remaining = [];
        if (roundOnly) remaining = records.filter((_record, position) => position !== index);
        const lastActive = activeRecords(remaining).at(-1);
        if (remaining.length) {
            entry.content = combineRecords(remaining);
            Object.assign(meta, {
                records: remaining, round: lastActive?.round ?? 0, mode: lastActive?.mode ?? 'incremental',
                coveredTo: lastActive?.coveredTo ?? -1, sourceEnd: lastActive?.sourceEnd ?? null,
                sourceDigest: lastActive?.sourceDigest ?? null, updatedAt: new Date().toISOString(),
            });
            delete meta.lastOperation;
            entry.preventRecursion = true;
        } else {
            for (const owned of listOwnedEntries(data)) {
                if (entryMetadata(owned)?.archiveId === selection.archiveId) delete data.entries[owned.uid];
            }
        }
        await context.saveWorldInfo(selection.bookName, data, true);
        const persisted = await prepareWorldBook(context, selection.bookName, { create: false });
        const saved = persisted?.entries?.[selection.uid];
        if (remaining.length ? saved?.content !== entry.content || entryMetadata(saved)?.records?.length !== remaining.length : Boolean(saved)) {
            throw new Error('总结删除后未能从世界书读回确认。');
        }
        const live = getContext();
        if (live?.chatMetadata?.[MODULE_NAME]?.archiveId === selection.archiveId) {
            Object.assign(live.chatMetadata[MODULE_NAME], {
                lastSummarizedThrough: lastActive?.coveredTo ?? -1, sourceEnd: lastActive?.sourceEnd ?? null,
                round: lastActive?.round ?? 0, autoTriggerArmed: true, summaryStillOverThreshold: false,
            });
            await live.saveMetadata?.();
        }
        live.reloadWorldInfoEditor?.(selection.bookName);
        if (selection.bookName !== settings.worldBookName) return;
        closeSummaryPreview({ focus: false });
        await syncCurrentArchive();
        await renderDirectory();
        if (remaining.length) showSummary(persisted.entries[selection.uid]);
        notify('success', roundOnly ? '本轮总结已删除。' : '聊天档的总结条目已删除。');
    } finally {
        archiveEditInProgress = false;
        unlockSending();
    }
}

async function renderDirectory({ reload = true } = {}) {
    if (!ui || !settings) return;
    const request = ++directoryRequest;
    const bookName = settings.worldBookName;
    const tree = ui.querySelector('.als-tree');
    if (reload || !directoryData || directoryBookName !== bookName) {
        tree.setAttribute('aria-busy', 'true');
        if (!directoryData) tree.replaceChildren(createElement('p', 'als-empty', '正在读取记忆存档…'));
        try {
            const data = await prepareWorldBook(getContext(), bookName, { create: false, readOnly: true });
            if (request !== directoryRequest || bookName !== settings.worldBookName) return;
            directoryData = data ?? { entries: {} };
            directoryBookName = bookName;
        } catch (error) {
            if (request !== directoryRequest) return;
            tree.replaceChildren(createElement('p', 'als-muted', error.message));
            return;
        } finally {
            if (request === directoryRequest) tree.removeAttribute('aria-busy');
        }
    }
    tree.replaceChildren();
    const rows = summaryRows(directoryData);
    const grouped = new Map();
    for (const row of rows) {
        const key = row.meta.cardKey ?? row.meta.characterName;
        if (!grouped.has(key)) grouped.set(key, { key, name: row.meta.characterName, rows: [] });
        grouped.get(key).rows.push(row);
    }
    const filter = ui.querySelector('.als-card-filter');
    const selectedCard = filter.value;
    filter.replaceChildren(createElement('option', '', '所有角色'));
    filter.firstElementChild.value = '';
    for (const card of grouped.values()) {
        const option = createElement('option', '', card.name);
        option.value = card.key;
        filter.append(option);
    }
    filter.value = grouped.has(selectedCard) ? selectedCard : '';
    const query = ui.querySelector('.als-directory-search').value.trim().toLocaleLowerCase();
    const cards = [...grouped.values()].filter(card => !filter.value || card.key === filter.value)
        .map(card => ({ ...card, rows: card.rows.filter(row => !query
            || `${card.name} ${row.meta.chatName}`.toLocaleLowerCase().includes(query)) }))
        .filter(card => card.rows.length);
    const current = getCharacterAndChat();
    cards.sort((a, b) => Number(b.key === current?.cardKey) - Number(a.key === current?.cardKey));
    const totalPages = Math.max(1, Math.ceil(cards.length / DIRECTORY_PAGE_SIZE));
    directoryPage = Math.min(Math.max(0, directoryPage), totalPages - 1);
    ui.querySelector('.als-directory-count').textContent = `${cards.length} 个角色 · ${cards.reduce((sum, card) => sum + card.rows.length, 0)} 个存档`;
    ui.querySelector('.als-page-label').textContent = `${directoryPage + 1} / ${totalPages}`;
    ui.querySelector('.als-page-prev').disabled = directoryPage === 0;
    ui.querySelector('.als-page-next').disabled = directoryPage >= totalPages - 1;
    const pagination = ui.querySelector('.als-pagination');
    if (pagination) pagination.hidden = totalPages <= 1;
    if (!cards.length) {
        const empty = createElement('div', 'als-empty');
        if (!rows.length) {
            const mascot = createElement('span', 'als-mascot als-empty-mascot');
            mascot.setAttribute('aria-hidden', 'true');
            empty.append(mascot);
        }
        empty.append(createElement('strong', '', rows.length ? '没有匹配的记录' : '第一份记忆，从这里开始'),
            createElement('p', '', rows.length ? '试试其他关键词，或清除角色筛选。' : '在概览中运行第一次总结，正文与每次历史会保存在这里。'));
        tree.append(empty);
        return;
    }
    for (const card of cards.slice(directoryPage * DIRECTORY_PAGE_SIZE, (directoryPage + 1) * DIRECTORY_PAGE_SIZE)) {
        const details = createElement('details', 'als-card');
        details.open = card.key === current?.cardKey || Boolean(query) || Boolean(filter.value);
        details.append(createElement('summary', '', `${card.name} · ${card.rows.length} 个存档`));
        for (const row of card.rows) {
            const line = createElement('button', 'als-archive-row');
            line.type = 'button';
            line.dataset.entryUid = String(row.entry.uid);
            line.setAttribute('aria-current', String(selectedSummary?.uid === row.entry.uid));
            const copy = createElement('span', 'als-archive-copy');
            const name = createElement('span', 'als-archive-name', row.meta.chatName);
            const metadata = createElement('span', 'als-archive-meta');
            metadata.append(createElement('span', '', `${archiveRecords(row.entry).length} 次记录`));
            if (row.meta.archiveId === getContext()?.chatMetadata?.[MODULE_NAME]?.archiveId) metadata.append(createElement('span', 'als-archive-current', '当前存档'));
            const date = new Date(row.meta.updatedAt ?? row.meta.createdAt);
            if (Number.isFinite(date.getTime())) metadata.append(createElement('span', '', date.toLocaleDateString('zh-CN')));
            copy.append(name, metadata);
            const arrow = createElement('span', 'als-archive-arrow');
            arrow.innerHTML = uiIcon('arrow');
            line.append(copy, arrow);
            line.addEventListener('click', () => showSummary(row.entry));
            details.append(line);
        }
        tree.append(details);
    }
    if (selectedSummary && selectedSummary.bookName === bookName) {
        const selected = directoryData.entries[selectedSummary.uid];
        if (!selected) {
            closeSummaryPreview({ focus: false });
        } else showSummary(selected, { refresh: true });
    }
}

function showTab(name) {
    currentTab = name;
    for (const button of ui.querySelectorAll('.als-tab')) {
        const selected = button.dataset.tab === name;
        button.classList.toggle('als-tab-active', selected);
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
    }
    for (const panel of ui.querySelectorAll('.als-panel')) panel.hidden = panel.dataset.panel !== name;
    if (name === 'directory') return renderDirectory();
}

function promptDraftKey() { return `${promptEditorStyle}:${promptEditorMode}`; }

function savedEditorPrompt() { return promptTemplates(settings, promptEditorStyle)[promptEditorMode]; }

function syncPromptEditor() {
    ui.querySelector('.als-settings-mode').value = settingsDraft.mode;
    ui.querySelector('.als-settings-style').value = settingsDraft.promptStyle;
    ui.querySelector('.als-prompt-mode').value = promptEditorMode;
    ui.querySelector('.als-prompt-style').value = promptEditorStyle;
    const draft = promptDrafts[promptDraftKey()] ?? savedEditorPrompt();
    ui.querySelector('.als-prompt').value = draft;
    ui.querySelector('.als-mode-description').textContent = settingsDraft.mode === 'incremental'
        ? '每轮只记新增剧情喵，接着写进这个聊天档的原条目。'
        : '把旧总结和新剧情整理到一起喵，用新全文替换原条目，历史记录仍会留着。';
    setUiText('.als-style-description', settingsDraft.promptStyle === 'memory'
        ? '按因果、关系、约定、知情范围和接续状态分类，方便查找仍有效的记忆。'
        : '沿用时间、事件、细节、对话、行为、情感变化和角色表，保留剧情发展脉络。');
    ui.querySelector('.als-prompt-state').textContent = draft === savedEditorPrompt() ? '提示词已经记住喵' : '还没保存喵';
    setUiText('.als-prompt-context', `当前运行：${PROMPT_STYLE_LABELS[settings.promptStyle]} · ${MODE_LABELS[settings.mode]}。正在编辑：${PROMPT_STYLE_LABELS[promptEditorStyle]} · ${MODE_LABELS[promptEditorMode]}。`);
    setUiText('.als-running-template-name', `${PROMPT_STYLE_LABELS[settings.promptStyle]} · ${MODE_LABELS[settings.mode]}`);
    setUiText('.als-prompt-length', `${draft.length.toLocaleString()} 字符`);
    syncEditorActions();
}

function setUiText(selector, text) {
    const node = ui?.querySelector(selector);
    if (node) node.textContent = text;
}

function exportSummaryText(content, label) {
    if (!String(content ?? '').trim()) { notify('info', '当前没有可下载的正文。'); return; }
    try { downloadText(content, label); }
    catch { notify('warning', '下载未成功，请使用复制正文。'); }
}

function settingsAreDirty() {
    return Boolean(settingsDraft && SETTING_FIELDS.some(key => key === 'secondaryModels'
        ? JSON.stringify(settingsDraft[key]) !== JSON.stringify(settings[key]) : settingsDraft[key] !== settings[key]));
}

function syncEditorActions() {
    if (!ui || !settings) return;
    const dirty = settingsAreDirty();
    const promptDirty = (promptDrafts[promptDraftKey()] ?? savedEditorPrompt()) !== savedEditorPrompt();
    const canUsePrompt = promptDirty || promptEditorStyle !== settings.promptStyle || promptEditorMode !== settings.mode;
    setUiText('.als-prompt-usage', promptEditorStyle === settings.promptStyle && promptEditorMode === settings.mode
        ? promptDirty ? '正在使用此模板的已保存版本；当前修改尚未生效。' : '正在使用此模板'
        : '正在编辑其他模板；仅保存不会切换当前运行模板。');
    for (const [selector, changed] of [['.als-settings-save', dirty], ['.als-settings-discard', dirty], ['.als-prompt-save', promptDirty], ['.als-prompt-use', canUsePrompt], ['.als-prompt-discard', promptDirty]]) {
        const button = ui.querySelector(selector);
        if (button) button.disabled = Boolean(sendLockDepth) || !changed;
    }
    ui.querySelector('.als-settings-state')?.closest?.('.als-savebar')?.setAttribute('data-dirty', String(dirty));
    ui.querySelector('.als-prompt-state')?.closest?.('.als-savebar')?.setAttribute('data-dirty', String(promptDirty));
}

function editRunningTemplate() {
    if (sendLockDepth) return;
    promptDrafts[promptDraftKey()] = ui.querySelector('.als-prompt').value;
    promptEditorMode = settings.mode;
    promptEditorStyle = settings.promptStyle;
    syncPromptEditor();
    ui.querySelector('.als-prompt').focus?.();
}

function discardSettingsDraft() {
    if (sendLockDepth) return;
    modelFetchRevision += 1;
    if (modelFetchTimer) clearTimeout(modelFetchTimer);
    modelFetchTimer = null;
    modelFetchController?.abort();
    modelFetchController = null;
    const modelButton = ui.querySelector('.als-model-fetch');
    if (modelButton) modelButton.disabled = false;
    settingsDraft = Object.fromEntries(SETTING_FIELDS.map(key => [key, structuredClone(settings[key])]));
    populateSettingsDraft();
}

function changeMode(mode) {
    if (sendLockDepth || !Object.hasOwn(MODE_LABELS, mode)) return;
    promptEditorMode = mode;
    syncPromptEditor();
}

function changePromptStyle(style) {
    if (sendLockDepth || !Object.hasOwn(PROMPT_STYLE_LABELS, style)) return;
    promptEditorStyle = style;
    syncPromptEditor();
}

async function savePromptDraft({ use = false } = {}) {
    if (sendLockDepth) return;
    const draft = ui.querySelector('.als-prompt').value;
    if (!draft.trim()) {
        notify('warning', '提示词不能为空。');
        return;
    }
    const mode = promptEditorMode;
    const style = promptEditorStyle;
    const templates = promptTemplates(settings, style);
    const previous = templates[mode];
    const previousRuntime = { mode: settings.mode, promptStyle: settings.promptStyle };
    promptDrafts[promptDraftKey()] = draft;
    templates[mode] = draft;
    if (use) Object.assign(settings, { mode, promptStyle: style });
    settings.prompt = promptTemplates(settings)[settings.mode];
    lockSending();
    try {
        await persistSettingsNow();
        // Follow the new runtime only for fields without a separate settings
        // draft. Never commit or discard unrelated settings or template drafts.
        if (use) {
            for (const key of ['mode', 'promptStyle']) {
                if (settingsDraft[key] === previousRuntime[key]) settingsDraft[key] = settings[key];
            }
        }
        syncPromptEditor();
        syncSettingsState();
        const active = style === settings.promptStyle && mode === settings.mode;
        notify('success', `${PROMPT_STYLE_LABELS[style]} · ${MODE_LABELS[mode]}提示词已保存${active ? '并生效' : `；当前仍使用 ${PROMPT_STYLE_LABELS[settings.promptStyle]} · ${MODE_LABELS[settings.mode]}`}，刷新或重启也会记得喵。`);
    } catch (error) {
        templates[mode] = previous;
        Object.assign(settings, previousRuntime);
        settings.prompt = promptTemplates(settings)[settings.mode];
        ui.querySelector('.als-prompt-state').textContent = '保存没有成功喵，请重试。';
        notify('error', `提示词保存失败：${error.message}`);
    } finally {
        unlockSending();
    }
}

function bindInput(selector, key, transform = value => value) {
    const input = ui.querySelector(selector);
    const handler = () => {
        settingsDraft[key] = transform(input.type === 'checkbox' ? input.checked : input.value);
        if (key === 'mode' || key === 'promptStyle') syncPromptEditor();
        syncSettingsState();
    };
    input.addEventListener('input', handler);
    input.addEventListener('change', handler);
}

function syncSettingsState() {
    syncBudgetWarning();
    ui.querySelector('.als-settings-state').textContent = settingsAreDirty() ? '有未保存的修改' : '所有设置已保存';
    setUiText('.als-keep-help', `${settingsDraft.keepRecent} 条消息通常约为 ${settingsDraft.keepRecent / 2} 轮问答；保留数量只决定隐藏边界。`);
    const atDepth = settingsDraft.instructionPosition === 'depth';
    ui.querySelector('.als-instruction-depth-field').hidden = !atDepth;
    ui.querySelector('.als-instruction-role-field').hidden = settingsDraft.instructionPosition === 'tail';
    const secondary = ui.querySelector('.als-secondary-settings');
    if (secondary) secondary.hidden = settingsDraft.apiMode !== 'secondary';
    syncOperationalControls();
}

function syncOperationalControls() {
    if (!ui || !settings) return;
    for (const selector of ['.als-run', '.als-book-check', '.als-delete-round', '.als-delete-archive']) {
        for (const control of ui.querySelectorAll(selector)) {
            // Preserve pagination/selection restrictions when enabled.
            if (!settings.enabled) control.disabled = true;
            else if (!sendLockDepth && !['.als-delete-round', '.als-page-prev', '.als-page-next'].includes(selector)) {
                const archive = getContext()?.chatMetadata?.[MODULE_NAME];
                control.disabled = selector === '.als-run' && Boolean(archive?.sourceChanged || archive?.branch?.needsRebuild);
            }
        }
    }
    if (!settings.enabled) {
        const label = ui.querySelector('.als-book-status');
        if (label) label.textContent = '插件已关闭喵';
    }
    syncActionState();
}

function updateSourceReview(archive, chat) {
    const before = JSON.stringify([archive.sourceChanged, archive.sourceChangeAcknowledgement]);
    const changed = summarySourceChanged(chat, archive);
    const accepted = sourceChangeAccepted(chat, archive);
    if (changed && !accepted) archive.sourceChanged = true;
    else delete archive.sourceChanged;
    if (!changed || !accepted) delete archive.sourceChangeAcknowledgement;
    return before !== JSON.stringify([archive.sourceChanged, archive.sourceChangeAcknowledgement]);
}

function refreshSourceValidity() {
    const context = getContext();
    const archive = context?.chatMetadata?.[MODULE_NAME];
    if (!settings?.enabled || !archive) return;
    if (updateSourceReview(archive, context.chat)) context.saveMetadataDebounced?.();
}

function onChatContentChanged() {
    refreshSourceValidity();
    syncActionState();
}

function syncBudgetWarning() {
    budgetWarning = settings?.autoEnabled ? thresholdBudgetWarning(settings.threshold, currentInputBudget) : '';
    const draftWarning = settingsDraft.autoEnabled ? thresholdBudgetWarning(settingsDraft.threshold, currentInputBudget) : '';
    setUiText('.als-budget-warning', draftWarning);
    const notice = ui?.querySelector('.als-budget-warning');
    if (notice) notice.hidden = !draftWarning;
}

async function refreshBudgetWarning() {
    const revision = ++budgetCheckRevision;
    if (!settings?.enabled) return;
    try {
        const budget = await inputTokenBudget(getContext());
        if (revision !== budgetCheckRevision || !settings.enabled) return;
        currentInputBudget = budget;
        syncBudgetWarning();
        syncActionState();
    } catch { /* Unknown host budget must not block a summary or change settings. */ }
}

function syncActionState() {
    publishIntegrationState();
    if (!ui || !settings) return;
    const context = getContext();
    const archive = context?.chatMetadata?.[MODULE_NAME];
    const entry = entryMetadata(currentSummaryEntry)?.archiveId === archive?.archiveId ? currentSummaryEntry : null;
    const journal = entryMetadata(entry)?.lastOperation;
    const scope = summaryScope(context?.chat ?? [], settings.keepRecent, archive?.lastSummarizedThrough ?? -1,
        journal?.phase === 'saved' ? journal.hideEnd : -1);
    const needsRebuild = Boolean(archive?.branch?.needsRebuild || archive?.sourceChanged);
    const draftArchiveId = archive?.chatId === context?.chatId && archive?.cardKey === getCharacterAndChat(context)?.cardKey ? archive?.archiveId : null;
    loadIncompleteDraft(draftArchiveId);
    const incomplete = incompleteResults.get(draftArchiveId);
    const incompletePanel = ui.querySelector('.als-incomplete-result');
    if (incompletePanel) incompletePanel.hidden = !incomplete || (activeRun?.archiveId === archive?.archiveId && activeRun?.stage === 'generating');
    const incompleteText = ui.querySelector('.als-incomplete-text');
    if (incompleteText) incompleteText.value = incomplete?.content ?? '';
    setUiText('.als-incomplete-reason', incomplete?.reason ?? '');
    setUiText('.als-draft-state', incomplete?.storageError ? '浏览器存储操作失败。已有正文仍可复制或下载；刷新前请先导出。'
        : incomplete?.persisted ? '已保存在当前浏览器，刷新后可继续查看。未完成正文不会自动注入或隐藏消息。'
        : '正文正在本页暂存，尚未确认写入本地；请按需导出。');
    for (const selector of ['.als-incomplete-copy', '.als-incomplete-download']) {
        const button = ui.querySelector(selector);
        if (button) button.disabled = !incomplete?.content;
    }
    const deleteDraft = ui.querySelector('.als-incomplete-delete');
    if (deleteDraft) deleteDraft.disabled = Boolean(sendLockDepth);
    const retryDraft = ui.querySelector('.als-incomplete-retry');
    if (retryDraft) { retryDraft.hidden = !incomplete?.storageError; retryDraft.disabled = Boolean(sendLockDepth); }
    const busy = !settings.enabled || Boolean(sendLockDepth) || !getCharacterAndChat(context);
    const controls = {
        '.als-run': busy || needsRebuild || !scope.range,
        '.als-compact': busy || !entry?.content?.trim() || needsRebuild,
        '.als-rebuild': busy || !(needsRebuild || archive?.coverageBlocked || sourceChangeAccepted(context?.chat ?? [], archive)),
        '.als-retain-memory': busy || !archive?.sourceChanged || !entry?.content?.trim()
            || Boolean(archive.pendingSummarySave || journal?.phase === 'saved' || (journal?.combinedRestorePending && !journal.messagesRestored)),
        '.als-retry-hide': busy || needsRebuild || journal?.phase !== 'saved' || journal.hideEnd < 0,
        '.als-restore': busy || !journal?.changes?.length || Boolean(journal?.messagesRestored),
        '.als-undo': busy || !journal || journal.phase === 'undone',
        '.als-undo-restore': busy || !journal || (journal.phase === 'undone' && !journal.combinedRestorePending),
        '.als-view-current': !entry,
        '.als-refresh-context': busy,
    };
    for (const [selector, disabled] of Object.entries(controls)) {
        const button = ui.querySelector(selector);
        if (button) button.disabled = disabled;
    }
    setUiText('.als-undo-restore', journal?.combinedRestorePending ? '继续恢复本次原文' : '撤销本次整理并恢复原文');
    const rebuild = ui.querySelector('.als-rebuild');
    if (rebuild) {
        rebuild.hidden = !(needsRebuild || archive?.coverageBlocked || sourceChangeAccepted(context?.chat ?? [], archive));
        rebuild.textContent = '更新记忆（从有效总结接续）';
    }
    const sourceWarning = ui.querySelector('.als-source-warning');
    const retained = sourceChangeAccepted(context?.chat ?? [], archive);
    if (sourceWarning) {
        sourceWarning.hidden = !archive?.sourceChanged && !retained;
        sourceWarning.textContent = retained ? '已选择保留现有总结，它可能包含已删除或修改的剧情；再次修改已确认的原文时会重新提醒。'
            : '原文已改变：可以更新记忆，或保留现有总结继续使用。没有有效旧总结时不会全量重跑历史，可到世界书中手动处理。';
    }
    const retain = ui.querySelector('.als-retain-memory');
    if (retain) retain.hidden = !archive?.sourceChanged || !entry?.content?.trim();
    const current = getCharacterAndChat(context);
    const total = context?.chat?.length ?? 0;
    const autoState = automaticStatus(settings, archive, journal, { hasChat: Boolean(current), busy: Boolean(sendLockDepth), hasWork: Boolean(scope.range), chatLength: total });
    setUiText('.als-chat-title', current?.chatName ?? '请选择一个聊天存档');
    setUiText('.als-chat-detail', current ? `${current.characterName} · ${total} 条消息 · ${entry ? archiveRecords(entry).length : 0} 次总结记录` : '打开单人聊天后即可整理与保存记忆。');
    setUiText('.als-state-badge', autoState.label);
    setUiText('.als-auto-status', autoState.reason);
    setUiText('.als-token-count', Number.isFinite(archive?.lastPromptTokens) ? archive.lastPromptTokens.toLocaleString() : '—');
    setUiText('.als-token-threshold', budgetWarning || (settings.autoEnabled ? `自动触发阈值 ${Number(settings.threshold).toLocaleString()} token` : '手动模式下，可按需刷新计数。'));
    setUiText('.als-hidden-count', `${scope.hiddenCount} 条`);
    setUiText('.als-hide-count', `${scope.pendingCount} 条`);
    setUiText('.als-keep-count', `${scope.keptCount} 条`);
    setUiText('.als-hide-range', scope.pendingCount ? `第 0–${scope.hideEnd} 层内` : '无待隐藏消息');
    setUiText('.als-keep-range', scope.recentCount ? `最近 ${scope.recentCount} 条不新增隐藏` : '等待聊天内容');
    for (const [selector, count] of [['.als-range-hidden', scope.hiddenCount], ['.als-range-old', scope.pendingCount], ['.als-range-recent', scope.keptCount]]) {
        const segment = ui.querySelector(selector);
        if (segment) { segment.style.flexGrow = String(count); segment.hidden = !count; }
    }
    setUiText('.als-runtime-mode', MODE_LABELS[settings.mode]);
    setUiText('.als-runtime-style', PROMPT_STYLE_LABELS[settings.promptStyle]);
    setUiText('.als-runtime-api', settings.apiMode === 'secondary' ? '副 API' : '主 API');
    setUiText('.als-action-context', !settings.enabled ? '启用插件后可整理；记录页仍可查看历史。'
        : archive?.pendingSummarySave ? '上次写入结果尚未确认，请先刷新世界书状态。'
        : journal?.combinedRestorePending && !journal.messagesRestored ? '总结已撤销，原文尚未全部恢复。继续恢复不会再次撤销或重新生成。'
        : archive?.sourceChanged ? '原文已改变，请选择更新记忆或保留现有总结。确认前暂停自动总结，仍可继续聊天。'
        : archive?.coverageBlocked ? '上次输入覆盖检查未通过，自动总结已暂停。可调整上下文后手动重试，或从有效旧总结更新记忆。'
        : archive?.branch?.needsRebuild ? '部分旧总结无法确认属于当前分支。可从有效旧总结更新记忆，或到世界书中手动处理。'
        : journal?.phase === 'saved' ? '总结已保存，隐藏未完成。请在“恢复与撤销”中只重试隐藏，无需再次总结。'
        : scope.range ? '保存确认后才隐藏旧消息，最近原文也会参与本次总结。'
        : total <= scope.recentCount ? '当前消息均在保留范围内，没有可处理的旧消息。可继续聊天或仅合并已有总结。'
        : '没有可处理的旧消息：旧消息已总结、已隐藏或正文为空。可继续聊天或仅合并已有总结。');
    setUiText('.als-summary-result', summaryResultText(journal));
    setUiText('.als-token-comparison', tokenComparisonText(archive?.lastSummaryTokens, journal));
    const suggested = archive?.pendingSummarySave ? ['.als-book-check', '确认上次操作结果']
        : journal?.combinedRestorePending && !journal.messagesRestored ? ['.als-undo-restore', '继续恢复本次原文']
        : needsRebuild || archive?.coverageBlocked ? ['.als-rebuild', '更新记忆（从有效总结接续）']
        : journal?.phase === 'saved' && !journal.messagesRestored && journal.hideEnd >= 0 ? ['.als-retry-hide', '只重试隐藏（不重新生成）']
        : !scope.range && entry?.content?.trim() ? ['.als-view-current', '查看当前总结'] : null;
    const nextAction = ui.querySelector('.als-next-action');
    if (nextAction) {
        nextAction.hidden = !suggested;
        nextAction.textContent = suggested?.[1] ?? '';
        nextAction.dataset.target = suggested?.[0] ?? '';
        nextAction.disabled = busy || Boolean(ui.querySelector(suggested?.[0] ?? '.als-run')?.disabled);
    }
    const runButton = ui.querySelector('.als-run');
    if (runButton) {
        // A failed coverage check can be retried after fixing the host context;
        // source-only rebuilding is an alternative, not a required conversion.
        runButton.hidden = Boolean(suggested) && !(suggested[0] === '.als-rebuild' && archive?.coverageBlocked && !needsRebuild);
        runButton.classList?.toggle('als-primary', !suggested);
    }
    if (rebuild && nextAction && suggested?.[0] === '.als-rebuild') rebuild.hidden = true;
    const detail = ui.querySelector('.als-last-operation');
    if (detail) detail.textContent = entry ? `${sourceDescription(activeRecords(archiveRecords(entry)).at(-1))}。`
        + (journal?.phase === 'undone' ? '最近一次总结已撤销。' : '')
        : '当前存档暂无总结。';
    floatingPanel?.update({ busy: Boolean(activeRun || sendLockDepth), enabled: settings.enabled, autoEnabled: settings.autoEnabled, tokens: archive?.lastPromptTokens });
    syncEditorActions();
}

function populateSettingsDraft() {
    const controls = {
        enabled: '.als-enabled', autoEnabled: '.als-auto-enabled', streamSummary: '.als-stream-summary', threshold: '.als-threshold', keepRecent: '.als-keep',
        worldBookName: '.als-book', depth: '.als-depth', mode: '.als-settings-mode', promptStyle: '.als-settings-style',
        instructionPosition: '.als-instruction-position', instructionDepth: '.als-instruction-depth',
        instructionRole: '.als-instruction-role',
        apiMode: '.als-api-mode', secondaryUrl: '.als-secondary-url',
        secondaryKey: '.als-secondary-key', secondaryModel: '.als-secondary-model',
    };
    for (const [key, selector] of Object.entries(controls)) {
        const input = ui.querySelector(selector);
        if (input.type === 'checkbox') input.checked = Boolean(settingsDraft[key]);
        else input.value = settingsDraft[key];
    }
    syncPromptEditor();
    renderModelOptions();
    syncSettingsState();
}

async function saveSettingsDraft() {
    if (sendLockDepth) return;
    const name = String(settingsDraft.worldBookName).trim();
    if (!name || /[\\/:*?"<>|\x00-\x1f]/.test(name) || /[. ]$/.test(name)) {
        notify('warning', '请填写有效的世界书名称。');
        return;
    }
    if (settingsDraft.apiMode === 'secondary') {
        try {
            const config = getSecondaryConfig(settingsDraft);
            settingsDraft.secondaryUrl = config.url;
            settingsDraft.secondaryKey = config.key;
            settingsDraft.secondaryModel = config.model;
        } catch (error) {
            notify('warning', error.message);
            return;
        }
    }
    archiveEditInProgress = true;
    lockSending();
    const previousSettings = Object.fromEntries(SETTING_FIELDS.map(key => [key, structuredClone(settings[key])]));
    const saveEnabledRevision = enabledRevision;
    let oldBookDeactivated = false;
    try {
        const context = getContext();
        if (settings.enabled && settingsDraft.enabled && name !== settings.worldBookName) {
            const previous = await prepareWorldBook(context, settings.worldBookName, { create: false });
            if (!settings.enabled || enabledRevision !== saveEnabledRevision) return;
            const owned = listOwnedEntries(previous);
            if (owned.some(entry => !entry.disable)) {
                for (const entry of owned) { entry.disable = true; entry.constant = false; }
                oldBookDeactivated = true;
                await context.saveWorldInfo(settings.worldBookName, previous, true);
                const verified = await prepareWorldBook(context, settings.worldBookName, { create: false });
                if (owned.some(entry => !verified?.entries?.[entry.uid]?.disable)) throw new Error('旧世界书条目未成功关闭，设置尚未保存。');
                context.reloadWorldInfoEditor?.(settings.worldBookName);
            }
        }
        settingsDraft.worldBookName = name;
        const enabledChanged = settings.enabled !== settingsDraft.enabled;
        Object.assign(settings, settingsDraft);
        if (previousSettings.autoEnabled && !settings.autoEnabled) cancelPendingAutoSummary();
        if (!previousSettings.autoEnabled && settings.autoEnabled) {
            const archive = context.chatMetadata?.[MODULE_NAME];
            if (archive) { delete archive.undoAtLength; archive.autoTriggerArmed = true; }
        }
        if (enabledChanged) {
            enabledRevision += 1;
            if (!settings.enabled) {
                stopPluginWork();
                void scheduleDisabledCleanup({ bookName: previousSettings.worldBookName });
            }
        }
        settings.prompt = promptTemplates(settings)[settings.mode];
        await persistSettingsNow();
        directoryData = null;
        closeSummaryPreview({ focus: false });
        populateSettingsDraft();
        void refreshBudgetWarning();
        notify('success', '设置已保存喵。');
    } catch (error) {
        const liveEnabled = settings.enabled;
        Object.assign(settings, previousSettings);
        if (enabledRevision !== saveEnabledRevision) settings.enabled = liveEnabled;
        settings.prompt = promptTemplates(settings)[settings.mode];
        syncSettingsState();
        notify('error', error.message);
        if (oldBookDeactivated && settings.enabled && enabledRevision === saveEnabledRevision) {
            try {
                const archiveInfo = await ensureArchive(getContext());
                await setArchiveActivation(archiveInfo?.archive.archiveId ?? null, { reconcileCursor: true });
            } catch (restoreError) {
                notify('error', `设置未保存，旧总结激活状态尚未恢复：${restoreError.message}。请连接恢复后重新打开当前聊天。`);
            }
        }
        return;
    } finally {
        archiveEditInProgress = false;
        unlockSending();
    }
    if (settings.enabled) void scheduleChatSync();
    else if (name !== previousSettings.worldBookName) {
        void scheduleDisabledCleanup({ bookName: previousSettings.worldBookName });
        void scheduleDisabledCleanup();
    }
}

async function getInstalledExtension() {
    const match = new URL(import.meta.url).pathname.match(/\/third-party\/([^/]+)\//);
    if (!match) throw new Error('无法确认插件安装目录，请使用酒馆扩展管理页面更新。');
    const folder = decodeURIComponent(match[1]);
    const response = await fetch('/api/extensions/discover', { cache: 'no-store' });
    if (!response.ok) throw new Error(`无法读取扩展列表（HTTP ${response.status}）。`);
    const extensions = await response.json();
    const extension = extensions.find(item => item.name?.replaceAll('\\', '/').split('/').at(-1) === folder);
    if (!extension || !['global', 'local'].includes(extension.type)) throw new Error('没有找到此插件的 Git 安装目录。');
    return { extensionName: folder, global: extension.type === 'global' };
}

async function extensionApi(action, installation) {
    const response = await fetch(`/api/extensions/${action}`, {
        method: 'POST', headers: getContext().getRequestHeaders(),
        body: JSON.stringify(installation),
    });
    if (!response.ok) throw new Error(`插件${action === 'update' ? '更新' : '检查'}失败（HTTP ${response.status}），请查看酒馆服务器日志。`);
    return await response.json();
}

function renderUpdateNotice() {
    if (!ui) return;
    const visible = Boolean(availableUpdate && dismissedUpdate !== availableUpdate.key);
    ui.querySelector('.als-update-badge').hidden = !visible;
    ui.querySelector('.als-update-notice').hidden = !visible;
    if (visible) ui.querySelector('.als-update-title').textContent = `喵！发现新版本：${availableUpdate.version}`;
}

async function checkForUpdate({ silent = false } = {}) {
    if (silent && !settings?.enabled) return;
    if (updateCheckInProgress || updateInProgress) return;
    const revision = enabledRevision;
    const cancelled = () => silent && (!settings.enabled || revision !== enabledRevision);
    updateCheckInProgress = true;
    const label = ui.querySelector('.als-update-status');
    const button = ui.querySelector('.als-update-check');
    button.disabled = true;
    label.textContent = '喵喵正在看看有没有更新…';
    try {
        const installation = await getInstalledExtension();
        if (cancelled()) return;
        const version = await extensionApi('version', installation);
        if (cancelled()) return;
        if (typeof version.isUpToDate !== 'boolean') throw new Error('酒馆未返回有效的更新状态。');
        availableUpdate = null;
        if (!version.isUpToDate) {
            let remoteVersion = 'Git 新提交';
            const remote = String(version.remoteUrl ?? '').match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i);
            if (remote && version.currentBranchName) {
                try {
                    const branch = version.currentBranchName.split('/').map(encodeURIComponent).join('/');
                    const url = `https://raw.githubusercontent.com/${encodeURIComponent(remote[1])}/${encodeURIComponent(remote[2])}/${branch}/manifest.json`;
                    const manifest = await fetchJson(url, { cache: 'no-store' }, { timeoutMs: 10000 });
                    if (typeof manifest?.version === 'string') remoteVersion = manifest.version;
                } catch { /* The ST Git check remains authoritative if version labels cannot be read. */ }
            }
            if (cancelled()) return;
            availableUpdate = { installation, version: remoteVersion, key: `${remoteVersion}:${version.currentCommitHash}` };
            label.textContent = `新版本到啦喵：${remoteVersion}`;
        } else label.textContent = '已经是最新版本喵';
        renderUpdateNotice();
    } catch (error) {
        if (cancelled()) return;
        label.textContent = error.message;
        if (!silent) notify('warning', error.message);
    } finally {
        updateCheckInProgress = false;
        button.disabled = false;
        if (cancelled()) label.textContent = '插件已关闭喵，可手动检查更新。';
    }
}

const UPDATE_DRAFT_KEY = `meow-summary-update-draft:${location.pathname}`;

export async function onExtensionUpdate() {
    notify('info', '喵喵大总结已更新，当前处理完成后自动刷新酒馆。');
    const native = await nativeScript();
    while (sendLockDepth || runInProgress || thresholdCheckInProgress || archiveEditInProgress || disabledCleanupPending
        || native.is_send_press || native.isGenerating?.() || document.body.dataset.generating === 'true'
        || (getContext()?.streamingProcessor && !getContext().streamingProcessor.isFinished)) {
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    lockSending();
    try {
        const draft = document.querySelector('#send_textarea')?.value;
        if (draft) sessionStorage.setItem(UPDATE_DRAFT_KEY, JSON.stringify({ text: draft, time: Date.now() }));
        // Flush the debounced ST settings save before unloading this page.
        await persistSettingsNow();
        await enabledSaveChain;
        location.reload();
    } catch (error) {
        notify('error', `插件已更新，但自动刷新失败：${error.message}。请手动刷新酒馆。`);
    } finally {
        unlockSending();
    }
}

async function updateExtensionNow() {
    if (updateInProgress || sendLockDepth) return;
    updateInProgress = true;
    const button = ui.querySelector('.als-update-apply');
    button.disabled = true;
    button.textContent = '正在更新喵…';
    try {
        const installation = availableUpdate?.installation ?? await getInstalledExtension();
        await extensionApi('update', installation);
        await onExtensionUpdate();
    } catch (error) {
        notify('error', error.message);
        ui.querySelector('.als-update-status').textContent = error.message;
    } finally {
        updateInProgress = false;
        button.disabled = false;
        button.textContent = '更新';
    }
}

function restoreUpdateDraft() {
    try {
        const saved = JSON.parse(sessionStorage.getItem(UPDATE_DRAFT_KEY) ?? 'null');
        sessionStorage.removeItem(UPDATE_DRAFT_KEY);
        const input = document.querySelector('#send_textarea');
        if (saved?.text && Date.now() - saved.time < 300000 && input && !input.value) {
            input.value = saved.text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    } catch { /* Draft restoration must not prevent plugin initialization. */ }
}

async function renderSettings() {
    if (ui?.isConnected) return;
    ui = document.createElement('section');
    ui.id = 'auto_large_summary_settings';
    ui.className = 'als-settings';
    ui.innerHTML = settingsMarkup(EXTENSION_VERSION);
    const settingsRoot = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
    if (!settingsRoot) return;
    settingsRoot.append(ui);
    settingsDraft = Object.fromEntries(SETTING_FIELDS.map(key => [key, settings[key]]));
    promptEditorMode = settings.mode;
    promptEditorStyle = settings.promptStyle;
    promptDrafts = {};
    populateSettingsDraft();
    ui.querySelector('.als-enabled').addEventListener('change', event => applyEnabledState(event.target.checked));
    bindInput('.als-auto-enabled', 'autoEnabled', Boolean);
    bindInput('.als-stream-summary', 'streamSummary', Boolean);
    bindInput('.als-threshold', 'threshold', value => Math.max(1, Math.floor(Number(value) || DEFAULT_SETTINGS.threshold)));
    bindInput('.als-keep', 'keepRecent', value => Math.max(1, Math.floor(Number(value) || DEFAULT_SETTINGS.keepRecent)));
    bindInput('.als-book', 'worldBookName', value => String(value).trim());
    bindInput('.als-depth', 'depth', value => Math.max(0, Math.floor(Number(value) || 0)));
    bindInput('.als-settings-mode', 'mode', String);
    bindInput('.als-settings-style', 'promptStyle', String);
    bindInput('.als-api-mode', 'apiMode', String);
    bindInput('.als-secondary-url', 'secondaryUrl', value => String(value).trim());
    bindInput('.als-secondary-key', 'secondaryKey', String);
    bindInput('.als-secondary-model', 'secondaryModel', value => String(value).trim());
    ui.querySelector('.als-model-select').addEventListener('change', event => selectSecondaryModel(event.target.value));
    ui.querySelector('.als-model-fetch').addEventListener('click', () => void fetchSecondaryModels());
    ui.querySelector('.als-api-mode').addEventListener('change', () => {
        if (settingsDraft.apiMode === 'secondary' && !settingsDraft.secondaryModels.length) scheduleModelFetch();
    });
    for (const selector of ['.als-secondary-url', '.als-secondary-key']) {
        ui.querySelector(selector).addEventListener('input', () => {
            modelFetchRevision += 1;
            modelFetchController?.abort();
            modelFetchController = null;
            settingsDraft.secondaryModels = [];
            renderModelOptions();
            ui.querySelector('.als-model-fetch').disabled = Boolean(sendLockDepth);
            ui.querySelector('.als-model-status').textContent = '连接信息改好后，喵喵会重新找模型。';
            syncSettingsState();
        });
        ui.querySelector(selector).addEventListener('change', scheduleModelFetch);
    }
    bindInput('.als-instruction-position', 'instructionPosition', String);
    bindInput('.als-instruction-depth', 'instructionDepth', value => Math.min(10000, Math.max(0, Math.floor(Number(value) || 0))));
    bindInput('.als-instruction-role', 'instructionRole', Number);
    ui.querySelector('.als-prompt-mode').addEventListener('change', event => changeMode(event.target.value));
    ui.querySelector('.als-prompt-style').addEventListener('change', event => changePromptStyle(event.target.value));
    ui.querySelector('.als-settings-save').addEventListener('click', () => void saveSettingsDraft());
    ui.querySelector('.als-settings-discard').addEventListener('click', discardSettingsDraft);
    ui.querySelector('.als-settings-reset').addEventListener('click', () => {
        if (sendLockDepth) return;
        modelFetchRevision += 1;
        modelFetchController?.abort();
        modelFetchController = null;
        ui.querySelector('.als-model-fetch').disabled = false;
        ui.querySelector('.als-model-status').textContent = '填好 URL 和 Key 后，喵喵会帮你拉取模型。';
        settingsDraft = Object.fromEntries(SETTING_FIELDS.map(key => [key, structuredClone(DEFAULT_SETTINGS[key])]));
        settingsDraft.enabled = settings.enabled;
        populateSettingsDraft();
    });
    ui.querySelector('.als-update-check').addEventListener('click', () => void checkForUpdate());
    ui.querySelector('.als-update-apply').addEventListener('click', () => void updateExtensionNow());
    ui.querySelector('.als-update-dismiss').addEventListener('click', () => {
        dismissedUpdate = availableUpdate?.key ?? '';
        renderUpdateNotice();
    });
    const tabs = [...ui.querySelectorAll('.als-tab')];
    for (const [index, button] of tabs.entries()) {
        button.addEventListener('click', () => showTab(button.dataset.tab));
        button.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1)
                : tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
            showTab(next.dataset.tab);
            next.focus();
        });
    }
    ui.querySelector('.als-prompt').addEventListener('input', event => {
        promptDrafts[promptDraftKey()] = event.target.value;
        ui.querySelector('.als-prompt-state').textContent = event.target.value === savedEditorPrompt() ? '提示词已经记住喵' : '还没保存喵';
        setUiText('.als-prompt-length', `${event.target.value.length.toLocaleString()} 字符`);
        syncEditorActions();
    });
    ui.querySelector('.als-prompt-save').addEventListener('click', () => void savePromptDraft());
    ui.querySelector('.als-prompt-use').addEventListener('click', () => void savePromptDraft({ use: true }));
    ui.querySelector('.als-edit-running').addEventListener('click', editRunningTemplate);
    ui.querySelector('.als-next-action').addEventListener('click', event => {
        if (sendLockDepth) return;
        const target = event.currentTarget.dataset.target;
        if (['.als-book-check', '.als-rebuild', '.als-retry-hide', '.als-view-current', '.als-undo-restore'].includes(target)) ui.querySelector(target)?.click();
    });
    ui.querySelector('.als-prompt-discard').addEventListener('click', () => {
        if (sendLockDepth) return;
        promptDrafts[promptDraftKey()] = savedEditorPrompt();
        syncPromptEditor();
    });
    ui.querySelector('.als-prompt-reset').addEventListener('click', () => {
        if (sendLockDepth) return;
        promptDrafts[promptDraftKey()] = defaultPrompt(promptEditorStyle, promptEditorMode);
        syncPromptEditor();
    });
    ui.querySelector('.als-run').addEventListener('click', () => runLargeSummary({ manual: true }));
    ui.querySelector('.als-compact').addEventListener('click', () => runLargeSummary({ operation: 'compact' }));
    ui.querySelector('.als-rebuild').addEventListener('click', () => {
        if (window.confirm('检查仍有效的旧总结，只整理它之后的原文来更新记忆？没有有效旧总结时会停止，不会全量重跑历史。成功后替换当前记忆，历史保留，并按设置隐藏一次旧消息。')) {
            void runLargeSummary({ operation: 'rebuild' });
        }
    });
    ui.querySelector('.als-retain-memory').addEventListener('click', () => void retainCurrentMemory());
    ui.querySelector('.als-cancel').addEventListener('click', cancelCurrentTask);
    ui.querySelector('.als-incomplete-copy').addEventListener('click', async () => {
        const result = incompleteResults.get(getContext()?.chatMetadata?.[MODULE_NAME]?.archiveId);
        if (!result) return;
        try { await navigator.clipboard.writeText(result.content); notify('success', '未完成结果已复制。'); }
        catch { notify('warning', '无法访问剪贴板，请在文本框中手动复制。'); }
    });
    ui.querySelector('.als-incomplete-download').addEventListener('click', () => {
        const result = incompleteResults.get(getContext()?.chatMetadata?.[MODULE_NAME]?.archiveId);
        if (result) exportSummaryText(result.content, `${getCharacterAndChat()?.chatName ?? '当前存档'}-未完成`);
    });
    ui.querySelector('.als-incomplete-delete').addEventListener('click', () => {
        if (sendLockDepth) return;
        const id = getContext()?.chatMetadata?.[MODULE_NAME]?.archiveId;
        if (id && window.confirm('删除当前存档的未完成草稿？已保存的总结不受影响。')) {
            removeIncompleteDraft(id);
            syncActionState();
        }
    });
    ui.querySelector('.als-incomplete-retry').addEventListener('click', () => {
        if (sendLockDepth) return;
        const id = getContext()?.chatMetadata?.[MODULE_NAME]?.archiveId;
        if (!id) return;
        if (incompleteResults.get(id)?.content) flushIncompleteDraft(id);
        else { incompleteResults.delete(id); loadedIncompleteDrafts.delete(id); loadIncompleteDraft(id); }
        syncActionState();
    });
    ui.querySelector('.als-go-settings').addEventListener('click', () => {
        showTab('settings');
        ui.querySelector('.als-keep').focus();
    });
    ui.querySelector('.als-view-current').addEventListener('click', async () => {
        await showTab('directory');
        const id = getContext()?.chatMetadata?.[MODULE_NAME]?.archiveId;
        const entry = listOwnedEntries(directoryData).find(item => entryMetadata(item)?.archiveId === id);
        if (entry) showSummary(entry);
    });
    ui.querySelector('.als-refresh-context').addEventListener('click', () => {
        if (!settings.enabled || sendLockDepth) return;
        setStatus('正在重新计算当前上下文 token…');
        scheduleVisibilityRefresh();
    });
    for (const [selector, action] of [['.als-retry-hide', 'retry'], ['.als-restore', 'restore'], ['.als-undo', 'undo'], ['.als-undo-restore', 'undo-restore']]) {
        ui.querySelector(selector).addEventListener('click', () => void recoverLatestSummary(action));
    }
    ui.querySelector('.als-book-check').addEventListener('click', () => {
        if (getContext()?.chatMetadata?.[MODULE_NAME]?.pendingSummarySave) void scheduleChatSync({ checkThreshold: false });
        else void updateWorldBookStatus();
    });
    for (const selector of ['.als-directory-search', '.als-card-filter']) {
        ui.querySelector(selector).addEventListener(selector.includes('search') ? 'input' : 'change', () => {
            directoryPage = 0;
            void renderDirectory({ reload: false });
        });
    }
    ui.querySelector('.als-directory-refresh').addEventListener('click', () => void renderDirectory());
    for (const [selector, delta] of [['.als-page-prev', -1], ['.als-page-next', 1]]) {
        ui.querySelector(selector).addEventListener('click', () => {
            directoryPage += delta;
            void renderDirectory({ reload: false });
        });
    }
    ui.querySelector('.als-history-select').addEventListener('change', event => {
        const entry = directoryData?.entries?.[selectedSummary?.uid];
        if (!entry) return;
        const record = archiveRecords(entry)[Number(event.target.value)];
        ui.querySelector('.als-preview').value = event.target.value === 'all' ? entry.content ?? '' : record?.content ?? '';
        ui.querySelector('.als-preview').scrollTop = 0;
        ui.querySelector('.als-record-detail').textContent = sourceDescription(event.target.value === 'all' ? activeRecords(archiveRecords(entry)).at(-1) : record);
        ui.querySelector('.als-delete-round').disabled = !settings.enabled || event.target.value === 'all' || Boolean(sendLockDepth);
        updateSummaryDisplay();
    });
    ui.querySelector('.als-preview-close').addEventListener('click', () => closeSummaryPreview());
    for (const button of ui.querySelectorAll('.als-reader-mode')) button.addEventListener('click', () => updateSummaryDisplay(button.dataset.view));
    ui.querySelector('.als-copy-summary').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(ui.querySelector('.als-preview').value);
            notify('success', '总结原文已复制。');
        } catch { notify('warning', '复制未成功，可切换到原文后手动复制。'); }
    });
    ui.querySelector('.als-download-summary').addEventListener('click', () => {
        const label = ui.querySelector('.als-history-select').selectedOptions[0]?.textContent ?? '当前总结';
        exportSummaryText(ui.querySelector('.als-preview').value, `${ui.querySelector('.als-preview-title').textContent}-${label}`);
    });
    ui.querySelector('.als-delete-round').addEventListener('click', () => void deleteSummarySelection({ roundOnly: true }).catch(error => notify('error', error.message)));
    ui.querySelector('.als-preview-box .als-delete-archive').addEventListener('click', () => void deleteSummarySelection().catch(error => notify('error', error.message)));
    floatingPanel = mountFloatingPanel(ui, { onOpen: () => { showTab('overview'); syncActionState(); } });
    integrationReady = true;
    syncActionState();
    void updateWorldBookStatus();
    if (settings.enabled) void checkForUpdate({ silent: true });
    else setStatus('插件已关闭，不再检查上下文或切换总结条目喵。');
}

function initialize() {
    const context = getContext();
    if (!context || initialized) return;
    initialized = true;
    window.addEventListener?.('pagehide', flushPendingIncompleteDrafts);
    getSettings();
    installVisibilityCommandHooks();
    void renderSettings();
    restoreUpdateDraft();
    document.addEventListener('click', blockSendInput, true);
    document.addEventListener('keydown', blockSendInput, true);
    document.addEventListener('submit', blockSendInput, true);
    context.eventSource.on(context.eventTypes.GENERATION_STARTED, refreshFinalHooks);
    context.eventSource.on(context.eventTypes.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);
    context.eventSource.on(context.eventTypes.GENERATE_AFTER_DATA, onFinalPromptData);
    context.eventSource.on(context.eventTypes.CHAT_COMPLETION_SETTINGS_READY, onMainApiRequest);
    context.eventSource.on('prompt_template_prepare', onTemplatePreviewContext);
    context.eventSource.on(context.eventTypes.MESSAGE_RECEIVED, onMessageReceived);
    // Keep the overview current in manual mode, without assembling a prompt or calling a model.
    for (const name of ['MESSAGE_SENT', 'MESSAGE_DELETED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED']) {
        if (context.eventTypes[name]) context.eventSource.on(context.eventTypes[name], onChatContentChanged);
    }
    for (const name of ['CHATCOMPLETION_MODEL_CHANGED', 'CHATCOMPLETION_SOURCE_CHANGED', 'PRESET_CHANGED', 'SETTINGS_UPDATED']) {
        if (context.eventTypes[name]) context.eventSource.on(context.eventTypes[name], refreshBudgetWarning);
    }
    void refreshBudgetWarning();
    context.eventSource.on(context.eventTypes.GENERATION_ENDED, onGenerationEnded);
    context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => {
        currentSummaryEntry = null;
        closeSummaryPreview({ focus: false });
        syncActionState();
        if (!settings.enabled) return;
        if (activeRun && !activeRun.committed) queueArchiveRetry(activeRun.archiveId);
        if (activeRun) { activeRun.cancelled = true; activeRun.controller?.abort(); }
        if (summaryRequest?.sending) getContext()?.stopGeneration?.();
        if (pendingGeneration?.locked) unlockSending();
        pendingGeneration = null;
        if (summaryTimer) clearTimeout(summaryTimer);
        summaryTimer = null;
        directoryPage = 0;
        void scheduleChatSync();
    });
    context.eventSource.on(context.eventTypes.CHAT_CREATED, () => {
        void scheduleChatSync();
    });
    if (settings.enabled) void scheduleChatSync();
    else void scheduleDisabledCleanup();
}

const initialContext = getContext();
if (initialContext?.eventSource && initialContext?.eventTypes) {
    initialContext.eventSource.on(initialContext.eventTypes.APP_READY, initialize);
} else {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
}
