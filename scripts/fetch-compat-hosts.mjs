// Read-only upstream downloads; output/ is ignored by Git and is not packaged.
import { mkdir, writeFile } from 'node:fs/promises';
const root = new URL('../output/hosts/', import.meta.url);
const hosts = [
    ['st-1.14.0', 'SillyTavern/SillyTavern', '9c9be90821ffd6132b40b5f04982522a61d7ad30'],
    ['st-1.15.0', 'SillyTavern/SillyTavern', '1c0e7ea9556afcc3ae55c888287dff67a6aa42fc'],
    ['st-1.16.0', 'SillyTavern/SillyTavern', 'e3b866b5d2bcc7fbaa889bb926fbb567cd1ed25b'],
    ['st-1.17.0', 'SillyTavern/SillyTavern', 'e3f41666c69db032e17e079fcddcf40cf47e8593'],
    ['st-1.18.0', 'SillyTavern/SillyTavern', '51ad27fb86d39a3daca3adaa970375c9670c12df'],
    ['tauri-canary', 'Darkatse/TauriTavern', '21477e44e0ecddd16e5013d08184182d2dd02fc5'],
    ['tauri-2.3.0', 'Darkatse/TauriTavern', 'a1855be4a4f8b6ee7cd0374a84dbb3709c3e5375'],
];
const requested = process.argv.slice(2);
for (const name of requested) {
    if (!hosts.some(([host]) => host === name)) throw new Error(`Unknown host: ${name}`);
}
for (const [name, repo, commit] of hosts) {
    if (requested.length && !requested.includes(name)) continue;
    const tauri = name.startsWith('tauri-');
    const files = ['script.js', 'scripts/st-context.js', 'scripts/events.js', 'scripts/openai.js',
        'scripts/tokenizers.js', 'scripts/world-info.js', 'scripts/extensions/regex/engine.js', 'scripts/extensions.js']
        .map(file => `${tauri ? 'src' : 'public'}/${file}`);
    files.push(...(tauri ? ['src/tauri/main/routes/ai-routes.js', 'src/scripts/util/safe-generate.js',
        'src-tauri/crates/tt-application/src/services/chat_completion_service/payload/prompt_post_processing.rs']
        : ['src/endpoints/backends/chat-completions.js']));
    if (name === 'tauri-2.3.0') files.push('src/init.js', 'src/tauri/main/bootstrap.js');
    for (const file of files) {
        let response;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                response = await fetch(`https://raw.githubusercontent.com/${repo}/${commit}/${file}`, { signal: AbortSignal.timeout(30000) });
                if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
                break;
            } catch (error) { if (attempt === 2) throw error; }
        }
        const target = new URL(`${name}/${file}`, root);
        await mkdir(new URL('./', target), { recursive: true });
        await writeFile(target, await response.text());
    }
    await writeFile(new URL(`${name}/source.json`, root), JSON.stringify({ repo, commit }, null, 2));
    console.log(`${name}: ${commit}`);
}
