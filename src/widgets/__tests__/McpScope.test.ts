import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it
} from 'vitest';

import type {
    RenderContext,
    WidgetItem
} from '../../types';
import { DEFAULT_SETTINGS } from '../../types/Settings';
import { McpScopeWidget } from '../McpScope';

const widget = new McpScopeWidget();
const SESSION = 'scope-session';

let dir = '';
let previous: string | undefined;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-scope-'));
    previous = process.env.CC_OPTIMIZER_STATE_DIR;
    process.env.CC_OPTIMIZER_STATE_DIR = dir;
});

afterEach(() => {
    if (previous === undefined) {
        delete process.env.CC_OPTIMIZER_STATE_DIR;
    } else {
        process.env.CC_OPTIMIZER_STATE_DIR = previous;
    }
    fs.rmSync(dir, { recursive: true, force: true });
});

function write(value: unknown): void {
    fs.writeFileSync(path.join(dir, `${SESSION}.mcp.json`), JSON.stringify(value));
}

function render(entry: WidgetItem, sessionId = SESSION): string | null {
    const context: RenderContext = { data: { session_id: sessionId } };
    return widget.render(entry, context, DEFAULT_SETTINGS);
}

const ITEM: WidgetItem = { id: 's', type: 'mcp-scope' };

describe('MCP Scope widget', () => {
    it('is hidden without CC Optimizer\'s scope file or a session', () => {
        expect(render(ITEM)).toBeNull();
        write({ version: 1, scope: 'project', held: ['u1'] });
        expect(render(ITEM, '')).toBeNull();
        write({ version: 2, scope: 'project', held: ['u1'] });
        expect(render(ITEM)).toBeNull();
    });

    it('shows the project scope with the number of held servers', () => {
        write({ version: 1, scope: 'project', held: ['u1', 'claude.ai Gmail', 3] });
        expect(render(ITEM)).toBe('MCP scope: project (2 held)');
        expect(render({ ...ITEM, rawValue: true })).toBe('project (2 held)');
        write({ version: 1, scope: 'project', held: [] });
        expect(render(ITEM)).toBe('MCP scope: project');
    });

    it('hides the global scope unless that hiding is turned off', () => {
        write({ version: 1, scope: 'global', held: ['u1'] });
        expect(render(ITEM)).toBeNull();
        expect(render({ ...ITEM, metadata: { hide: '' } })).toBe('MCP scope: global');
    });

    it('can opt out of the runtime and sits in the CC Optimizer category', () => {
        write({ version: 1, scope: 'project', held: ['u1'] });
        const off = widget.handleEditorAction('toggle-runtime', ITEM);
        expect(off?.metadata).toEqual({ runtime: 'off' });
        expect(render(off ?? ITEM)).toBeNull();
        expect(widget.getCategory()).toBe('CC Optimizer');
    });
});
