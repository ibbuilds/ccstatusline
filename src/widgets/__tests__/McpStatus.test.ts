import chalk from 'chalk';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it
} from 'vitest';

import type {
    RenderContext,
    WidgetItem
} from '../../types';
import { DEFAULT_SETTINGS } from '../../types/Settings';
import { updateColorMap } from '../../utils/colors';
import type {
    McpServerState,
    McpStatusData
} from '../../utils/mcp-status';
import { McpStatusWidget } from '../McpStatus';

const widget = new McpStatusWidget();

function status(entries: [string, McpServerState][], sessionObserved = true): McpStatusData {
    return { servers: entries.map(([name, state]) => ({ name, state, scope: 'user' })), sessionObserved };
}

function item(metadata?: Record<string, string>, extra: Partial<WidgetItem> = {}): WidgetItem {
    return { id: 'mcp', type: 'mcp-status', ...(metadata ? { metadata } : {}), ...extra };
}

function render(entry: WidgetItem, mcpStatus: McpStatusData | null | undefined, settings = DEFAULT_SETTINGS): string | null {
    const context: RenderContext = { mcpStatus };
    return widget.render(entry, context, settings);
}

const MIXED = status([
    ['GitHub', 'connected'],
    ['Figma', 'connected'],
    ['Gmail', 'needs-auth'],
    ['Broken', 'not-connected'],
    ['Off', 'disabled']
]);

describe('McpStatusWidget render', () => {
    it('shows connected over expected servers in compact mode by default', () => {
        expect(render(item(), MIXED)).toBe('MCP 2/4');
    });

    it('shows zero servers', () => {
        expect(render(item(), status([]))).toBe('MCP 0/0');
    });

    it('shows one connected server', () => {
        expect(render(item(), status([['a', 'connected']]))).toBe('MCP 1/1');
    });

    it('marks counts unconfirmed until the session reports its tools', () => {
        expect(render(item(), status([['a', 'configured'], ['b', 'configured']], false))).toBe('MCP 0/2?');
    });

    it('lists every non-zero state in detailed mode', () => {
        const all = status([
            ['a', 'connected'],
            ['b', 'needs-auth'],
            ['c', 'not-connected'],
            ['d', 'pending-approval'],
            ['e', 'blocked'],
            ['f', 'disabled'],
            ['g', 'configured']
        ]);
        expect(render(item({ mode: 'detailed' }), all))
            .toBe('MCP 1 connected | 1 needs auth | 1 not connected | 1 pending approval | 1 blocked | 1 disabled | 1 configured');
    });

    it('shows symbols per state in health mode', () => {
        expect(render(item({ mode: 'health' }), MIXED)).toBe('MCP ✓2 !1 ✗1');
    });

    it('counts enabled servers in count mode', () => {
        expect(render(item({ mode: 'count' }), MIXED)).toBe('MCP 4');
    });

    it('lists connected names with a default limit of three', () => {
        const many = status([['a', 'connected'], ['b', 'connected'], ['c', 'connected'], ['d', 'connected'], ['e', 'not-connected']]);
        expect(render(item({ mode: 'names' }), many)).toBe('MCP a, b, c +1');
    });

    it('honors a custom name limit and 0 for unlimited', () => {
        const many = status([['a', 'connected'], ['b', 'connected'], ['c', 'connected']]);
        expect(render(item({ mode: 'names', listLimit: '1' }), many)).toBe('MCP a +2');
        expect(render(item({ mode: 'names', listLimit: '0' }), many)).toBe('MCP a, b, c');
    });

    it('strips control characters from server names', () => {
        const evil = status([['bad\x1b[31mname\x07', 'connected']]);
        expect(render(item({ mode: 'names' }), evil)).toBe('MCP bad[31mname');
    });

    it('shows only problems in problems mode and hides when there are none', () => {
        expect(render(item({ mode: 'problems' }), MIXED)).toBe('MCP 1 needs auth | 1 not connected');
        expect(render(item({ mode: 'problems' }), status([['a', 'connected'], ['b', 'disabled']]))).toBeNull();
    });

    it('leaves servers held by an MCP scope out of the enabled count and the problems', () => {
        const scoped = status([['p1', 'connected'], ['u1', 'held'], ['claude.ai Gmail', 'held']]);
        expect(render(item(), scoped)).toBe('MCP 1/1');
        expect(render(item({ mode: 'detailed' }), scoped)).toBe('MCP 1 connected | 2 held by scope');
        expect(render(item({ mode: 'problems' }), scoped)).toBeNull();
    });

    it('does not count pending approval as connected', () => {
        expect(render(item(), status([['a', 'connected'], ['b', 'pending-approval']]))).toBe('MCP 1/2');
    });

    it('drops the label in raw value mode and honors a custom label', () => {
        expect(render(item(undefined, { rawValue: true }), MIXED)).toBe('2/4');
        expect(render(item({ label: 'Servers: ' }), MIXED)).toBe('Servers: 2/4');
    });

    it('hides when empty only if asked', () => {
        expect(render(item({ hide: 'empty' }), status([]))).toBeNull();
        expect(render(item({ hide: 'empty' }), MIXED)).toBe('MCP 2/4');
    });

    it('hides when all healthy only for a confirmed session', () => {
        const healthy = status([['a', 'connected'], ['b', 'disabled']]);
        expect(render(item({ hide: 'healthy' }), healthy)).toBeNull();
        expect(render(item({ hide: 'healthy' }), status([['a', 'configured']], false))).toBe('MCP 0/1?');
        expect(render(item({ hide: 'healthy' }), MIXED)).toBe('MCP 2/4');
    });

    it('shows n/a when status is unavailable', () => {
        expect(render(item(), null)).toBe('MCP n/a');
        expect(render(item(), undefined)).toBe('MCP n/a');
    });

    it('truncates to max width', () => {
        const output = render(item({ mode: 'detailed' }, { maxWidth: 12 }), MIXED);
        expect(output).toBe('MCP 2 con...');
    });

    it('renders a preview without live data', () => {
        const output = widget.render(item(), { isPreview: true }, DEFAULT_SETTINGS);
        expect(output).toBe('MCP 5/6');
    });
});

describe('McpStatusWidget state colors', () => {
    const previousLevel = chalk.level;
    beforeAll(() => {
        chalk.level = 1;
        updateColorMap();
    });
    afterAll(() => {
        chalk.level = previousLevel;
        updateColorMap();
    });

    const colored = { ...DEFAULT_SETTINGS, colorLevel: 1 as const };

    it('paints nothing itself when state colors are off', () => {
        expect(render(item(), MIXED, colored)).toBe('MCP 2/4');
        expect(widget.colorsOnlyItsRuns(item())).toBe(false);
    });

    it('paints a healthy value green and a failing one red by default', () => {
        const on = item({ stateColors: 'true' });
        expect(widget.colorsOnlyItsRuns(on)).toBe(true);
        expect(render(on, status([['a', 'connected']]), colored)).toBe('MCP \x1b[32m1/1\x1b[39m');
        expect(render(on, MIXED, colored)).toBe('MCP \x1b[31m2/4\x1b[39m');
    });

    it('paints pending and unconfirmed values yellow', () => {
        const on = item({ stateColors: 'true' });
        expect(render(on, status([['a', 'connected'], ['b', 'pending-approval']]), colored)).toBe('MCP \x1b[33m1/2\x1b[39m');
        expect(render(on, status([['a', 'configured']], false), colored)).toBe('MCP \x1b[33m0/1?\x1b[39m');
    });

    it('paints each health symbol by its own state', () => {
        const on = item({ mode: 'health', stateColors: 'true' });
        expect(render(on, MIXED, colored)).toBe('MCP \x1b[32m✓2\x1b[39m \x1b[33m!1\x1b[39m \x1b[31m✗1\x1b[39m');
    });

    it('uses color overrides from metadata', () => {
        const on = item({ 'stateColors': 'true', 'stateColor.healthy': 'cyan' });
        expect(render(on, status([['a', 'connected']]), colored)).toBe('MCP \x1b[36m1/1\x1b[39m');
    });

    it('paints nothing when the color level is off', () => {
        expect(render(item({ stateColors: 'true' }), MIXED, { ...DEFAULT_SETTINGS, colorLevel: 0 })).toBe('MCP 2/4');
    });
});

describe('McpStatusWidget editor', () => {
    it('cycles every display mode and back', () => {
        const modes: (string | undefined)[] = [];
        let current = item();
        for (let i = 0; i < 6; i++) {
            current = widget.handleEditorAction('cycle-mode', current) ?? current;
            modes.push(current.metadata?.mode);
        }
        expect(modes).toEqual(['detailed', 'health', 'count', 'names', 'problems', undefined]);
    });

    it('drops the name limit when leaving names mode', () => {
        const next = widget.handleEditorAction('cycle-mode', item({ mode: 'names', listLimit: '2' }));
        expect(next?.metadata).toEqual({ mode: 'problems' });
    });

    it('offers the limit keybind only in names mode and never binds reserved keys', () => {
        const keys = (entry: WidgetItem) => widget.getCustomKeybinds(entry).map(keybind => keybind.key);
        expect(keys(item())).toEqual(['v', 's', 'w']);
        expect(keys(item({ mode: 'names' }))).toEqual(['v', 'l', 's', 'w']);
    });

    it('describes its settings in the editor', () => {
        expect(widget.getEditorDisplay(item({ mode: 'names', listLimit: '2', stateColors: 'true' }, { maxWidth: 20 })))
            .toEqual({ displayText: 'MCP Status', modifierText: '(names, limit: 2, state colors, max:20)' });
        expect(widget.getEditorDisplay(item())).toEqual({ displayText: 'MCP Status', modifierText: '(compact)' });
    });

    it('declares hideable states, a label and raw value support', () => {
        expect(widget.getHideableStates().map(state => state.key)).toEqual(['empty', 'healthy']);
        expect(widget.getLabelPrefix()).toBe('MCP ');
        expect(widget.supportsRawValue()).toBe(true);
    });

    it('keeps an untouched item free of metadata after a round trip through JSON', () => {
        const roundTripped = JSON.parse(JSON.stringify(item())) as WidgetItem;
        expect(render(roundTripped, MIXED)).toBe('MCP 2/4');
        expect(roundTripped.metadata).toBeUndefined();
    });
});
