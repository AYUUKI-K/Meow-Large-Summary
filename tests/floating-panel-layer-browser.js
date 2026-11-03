// Run with Playwright CLI against tests/ui-smoke.mjs (see USAGE.md).
async page => {
    const results = [];
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
        const context = await page.context().browser().newContext({ viewport });
        const checkPage = await context.newPage();
        const errors = [];
        checkPage.on('pageerror', error => errors.push(error.message));
        const check = (condition, message) => { if (!condition) throw new Error(`${viewport.width}px: ${message}`); };
        const onTop = async selector => checkPage.locator(selector).evaluate(element => {
            const rect = element.getBoundingClientRect();
            return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        });
        try {
            await checkPage.addInitScript(() => localStorage.setItem('meow-large-summary-panel-v1', JSON.stringify({
                open: true, visible: true, autoCompact: true, dockSide: 'right', dockY: .45,
                frame: { x: 12, y: 90, width: 400, height: 560 },
            })));
            await checkPage.goto(new URL('/', page.url()).href);
            const panel = checkPage.getByRole('dialog', { name: '喵喵大总结悬浮面板' });
            await panel.waitFor();
            // ST drawers/top bar and extension menus use 3000/3005/29999.
            // Mount competitors later too, as drawers can be reopened after the panel.
            await checkPage.evaluate(() => {
                for (const [side, layer] of [['left', 3005], ['right', 29999]]) {
                    const drawer = document.createElement('aside');
                    drawer.className = 'fixture-layer-drawer';
                    drawer.textContent = `${side} sidebar`;
                    drawer.style.cssText = `position:fixed;${side}:0;top:0;width:50vw;height:100vh;background:#555;z-index:${layer}`;
                    document.body.append(drawer);
                }
            });
            for (const light of [false, true]) {
                await checkPage.evaluate(light => document.body.classList.toggle('light', light), light);
                check(await onTop('.als-floating-grip'), 'panel header is covered by a sidebar');
                check(await onTop('.als-floating-close'), 'panel close control is covered');
                await panel.getByRole('tab', { name: '设置', exact: true }).click();
                await panel.getByRole('tab', { name: '概览', exact: true }).click();
            }
            const grip = checkPage.locator('.als-floating-grip');
            const before = await panel.boundingBox();
            const handle = await grip.boundingBox();
            await checkPage.mouse.move(handle.x + 30, handle.y + 20);
            await checkPage.mouse.down();
            await checkPage.mouse.move(viewport.width - before.width + 18 + 30, handle.y + 40, { steps: 8 });
            await checkPage.mouse.up();
            const after = await panel.boundingBox();
            check(after.y > before.y, 'panel cannot be dragged over sidebars');
            check(await onTop('.als-floating-close'), 'moved panel is covered by the right sidebar');
            // Strong custom theme layers must not hide either presentation.
            await checkPage.evaluate(() => document.querySelectorAll('.fixture-layer-drawer').forEach(node => node.style.zIndex = '1000000'));
            check(await onTop('.als-floating-grip'), 'custom theme layer covers the panel');
            // Native modal dialogs must still receive input above the floating UI.
            await checkPage.evaluate(() => {
                const dialog = document.createElement('dialog');
                dialog.id = 'fixture-layer-modal';
                dialog.innerHTML = '<button type="button">确认测试</button>';
                document.body.append(dialog);
                dialog.showModal();
            });
            check(await onTop('#fixture-layer-modal button'), 'native confirmation dialog is covered');
            await checkPage.getByRole('button', { name: '确认测试', exact: true }).click();
            await checkPage.keyboard.press('Escape');
            check(await panel.isVisible(), 'modal Escape unexpectedly closed the floating panel');
            await checkPage.evaluate(() => {
                document.querySelector('#fixture-layer-modal').remove();
                // Keep the dock out of view so phone launcher avoidance does not apply.
                document.querySelector('main').style.display = 'none';
            });
            await panel.getByRole('button', { name: '收起悬浮窗口', exact: true }).click();
            const launcher = checkPage.locator('.als-float-launcher');
            await launcher.waitFor({ state: 'visible' });
            check(await onTop('.als-float-launcher'), 'right token label is covered');
            const right = await launcher.boundingBox();
            await checkPage.mouse.move(right.x + 20, right.y + 20);
            await checkPage.mouse.down();
            await checkPage.mouse.move(32, right.y + 20, { steps: 8 });
            await checkPage.mouse.up();
            check(await checkPage.locator('.als-floating-shell').getAttribute('data-dock') === 'left', 'launcher did not dock left');
            check(await onTop('.als-float-launcher'), 'left token label is covered');
            await launcher.click();
            await panel.waitFor();
            await grip.press('Escape');
            await launcher.waitFor({ state: 'visible' });
            await launcher.press('Home');
            check(await checkPage.locator('.als-floating-shell').getAttribute('data-dock') === '', 'Home did not restore cat launcher');
            check(await onTop('.als-float-launcher'), 'expanded cat launcher is covered');
            await launcher.click();
            await panel.waitFor();
            const embedded = await checkPage.evaluate(() => {
                const container = document.createElement('section');
                document.body.append(container);
                const api = window.MeowLargeSummary;
                const mounted = api.mount(container);
                const root = container.querySelector('.als-settings');
                const result = { mounted, floating: root?.classList.contains('als-floating'), zIndex: root && getComputedStyle(root).zIndex };
                api.unmount(container);
                container.remove();
                return result;
            });
            check(embedded.mounted && !embedded.floating && embedded.zIndex === 'auto', 'embedded panel retained floating layer');
            check(errors.length === 0, errors.join('\n'));
            results.push({ viewport, passed: true, checks: ['both sidebars', 'light/dark', 'drag', 'custom layers', 'modal', 'left/right docking', 'cat launcher', 'Escape', 'external mount'] });
        } finally {
            await context.close();
        }
    }
    return results;
}
