// Source-contract checks only; these do not launch a real ST/Tauri host.
// Fetch the pinned public sources with scripts/fetch-compat-hosts.mjs first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('../output/hosts/', import.meta.url);
for (const version of ['1.14.0', '1.15.0', '1.16.0', '1.17.0', '1.18.0', 'tauri-canary', 'tauri-2.3.0']) {
    const tauri = version.startsWith('tauri-');
    const folder = new URL(`${tauri ? version : `st-${version}`}/`, root);
    const frontend = tauri ? 'src' : 'public';
    let available = true;
    try { await access(new URL(`${frontend}/script.js`, folder)); } catch { available = false; }
    test(`${version}: verified host surface for summary generation and persistence`, { skip: !available }, async () => {
        const read = file => readFile(new URL(file, folder), 'utf8');
        const [context, events, script, openai, tokenizer, world, regex, extensions] = await Promise.all([
            'scripts/st-context.js', 'scripts/events.js', 'script.js', 'scripts/openai.js',
            'scripts/tokenizers.js', 'scripts/world-info.js', 'scripts/extensions/regex/engine.js', 'scripts/extensions.js',
        ].map(file => read(`${frontend}/${file}`)));
        for (const field of ['chatMetadata', 'extensionSettings', 'eventSource', 'eventTypes', 'generate',
            'saveMetadata', 'saveSettingsDebounced', 'getRequestHeaders', 'updateWorldInfoList', 'saveWorldInfo',
            'getTokenCountAsync', 'setExtensionPrompt', 'executeSlashCommandsWithOptions', 'extractMessageFromData']) {
            assert.match(context, new RegExp(`\\b${field}\\b`), `context.${field}`);
        }
        for (const event of ['APP_READY', 'SETTINGS_UPDATED', 'GENERATE_AFTER_DATA', 'CHAT_COMPLETION_SETTINGS_READY',
            'GENERATION_AFTER_COMMANDS', 'GENERATION_ENDED', 'CHAT_CHANGED', 'MESSAGE_RECEIVED']) {
            assert.match(events, new RegExp(`\\b${event}:`), event);
        }
        assert.match(script, /export async function saveSettings\(/);
        assert.match(script, /eventSource.emit\(event_types.SETTINGS_UPDATED/);
        assert.match(script, /eventSource.emit\(event_types.GENERATE_AFTER_DATA, generate_data, dryRun\)/);
        assert.match(openai, /export function getChatCompletionModel\(/);
        assert.match(openai, /eventSource.emit\(event_types.CHAT_COMPLETION_SETTINGS_READY, generate_data\)/);
        assert.match(events, /CHAT_COMPLETION_PROMPT_READY:/);
        assert.match(openai, /eventSource.emit\(event_types.CHAT_COMPLETION_PROMPT_READY, eventData\)/);
        assert.match(openai, /const eventData = \{ chat, dryRun \}/);
        assert.match(script, /\.\.\.chatItem,\s*mes: regexedMessage,\s*index,/);
        assert.match(script, /runGenerationInterceptors\(coreChat, this_max_context, type\)/);
        assert.match(script, /(?:export function getMaxPromptTokens|export function getMaxContextSize)/);
        assert.match(tokenizer, /export async function countTokensOpenAIAsync\(/);
        assert.match(regex, /export function getRegexedString\(/);
        assert.match(world, /export (?:let|var) world_names/);
        assert.match(extensions, /generate_interceptor/);
        if (['1.14.0', '1.15.0', '1.16.0', '1.17.0'].includes(version)) {
            assert.doesNotMatch(context, /getWorldInfoNames:/);
        } else assert.match(context, /getWorldInfoNames:/);
        if (version === '1.14.0') {
            assert.doesNotMatch(events, /WORLDINFO_SCAN_DONE:/);
            assert.match(world, /eventSource.emit\(event_types.WORLDINFO_ENTRIES_LOADED, \{ globalLore, characterLore, chatLore, personaLore \}\)/);
            assert.match(world, /export async function getSortedEntries\(/);
            assert.doesNotMatch(openai, /export async function createGenerationParameters\(/);
        } else {
            assert.match(events, /WORLDINFO_SCAN_DONE:/);
            assert.match(world, /entries: allActivatedEntries/);
            assert.match(world, /eventSource.emit\(event_types.WORLDINFO_SCAN_DONE, args\)/);
            assert.match(openai, /export async function createGenerationParameters\(/);
        }
        if (tauri) {
            if (version === 'tauri-2.3.0') {
                const init = await read('src/init.js');
                const bootstrap = await read('src/tauri/main/bootstrap.js');
                assert.match(init, /window\.__TAURI_RUNNING__ = true/);
                assert.match(bootstrap, /window\.__TAURITAVERN__ = \{/);
                assert.match(bootstrap, /const HOST_ABI_VERSION = 1/);
                assert.doesNotMatch(init + bootstrap, /__TAURITAVERN_HOST__/);
            }
            const processing = (await read('src-tauri/crates/tt-application/src/services/chat_completion_service/payload/prompt_post_processing.rs')).replace(/\r\n/g, '\n');
            const bytes = Buffer.from(processing);
            assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
                '53edbf77bf9d1a3ef2d836b4267711cd36df4c3b', 'TT local preview must be reviewed against any changed backend implementation');
            const routes = await read('src/tauri/main/routes/ai-routes.js');
            assert.doesNotMatch(routes, /\/api\/backends\/chat-completions\/process/);
            assert.match(routes, /\/api\/backends\/chat-completions\/generate/);
            assert.match(routes, /\/api\/backends\/chat-completions\/status/);
            assert.match(routes, /createChatCompletionStreamResponse\(context, payload, init\?\.signal/);
            assert.match(await read('src/scripts/util/safe-generate.js'), /await waitForIdle\(\)/);
        } else {
            const backend = await read('src/endpoints/backends/chat-completions.js');
            assert.match(backend, /router.post\('\/process'/);
            assert.match(backend, /custom_include_headers/);
        }
    });
}
