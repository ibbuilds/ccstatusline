import { render } from 'ink';
import { PassThrough } from 'node:stream';
import stripAnsi from 'strip-ansi';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { waitFor } from '../../tui/__tests__/helpers/wait-for-ink';
import { DEFAULT_SETTINGS } from '../../types/Settings';
import type { WidgetItem } from '../../types/Widget';
import { McpStatusWidget } from '../McpStatus';

class MockTtyStream extends PassThrough {
    isTTY = true;
    columns = 120;
    rows = 40;

    setRawMode() {
        return this;
    }

    ref() {
        return this;
    }

    unref() {
        return this;
    }
}

function createStdout(): NodeJS.WriteStream & { getOutput: () => string } {
    const stream = new MockTtyStream();
    const chunks: string[] = [];
    stream.on('data', (chunk: Buffer | string) => {
        chunks.push(chunk.toString());
    });
    return Object.assign(stream as unknown as NodeJS.WriteStream, { getOutput: () => stripAnsi(chunks.join('')) });
}

function renderEditor(widget: WidgetItem, action: string) {
    const stdin = new MockTtyStream() as unknown as NodeJS.ReadStream;
    const stdout = createStdout();
    const stderr = createStdout();
    const onComplete = vi.fn();
    const onCancel = vi.fn();
    const element = new McpStatusWidget().renderEditor({ widget, onComplete, onCancel, action, settings: DEFAULT_SETTINGS });
    const instance = render(element, { stdin, stdout, stderr, debug: true, exitOnCtrlC: false, patchConsole: false });
    const cleanup = () => {
        instance.unmount();
        instance.cleanup();
        stdin.destroy();
        stdout.destroy();
        stderr.destroy();
    };
    return { stdin, stdout, onComplete, onCancel, cleanup };
}

describe('McpStatusWidget TUI editors', () => {
    it('turns state colors on and changes the healthy color', async () => {
        const editor = renderEditor({ id: 'mcp', type: 'mcp-status' }, 'edit-state-colors');
        try {
            await waitFor(() => {
                expect(editor.stdout.getOutput()).toContain('MCP Status: state colors');
            });
            editor.stdin.write(' ');
            await waitFor(() => {
                expect(editor.stdout.getOutput()).toContain('State colors: On');
            });
            editor.stdin.write('\x1b[C');
            await waitFor(() => {
                expect(editor.stdout.getOutput()).not.toMatch(/Healthy\s+Green\s*$/);
            });
            editor.stdin.write('\r');
            await waitFor(() => {
                expect(editor.onComplete).toHaveBeenCalledTimes(1);
            });
            const saved = editor.onComplete.mock.calls[0]?.[0] as WidgetItem;
            expect(saved.metadata?.stateColors).toBe('true');
            expect(saved.metadata?.['stateColor.healthy']).toBeDefined();
            expect(saved.metadata?.['stateColor.healthy']).not.toBe('green');
        } finally {
            editor.cleanup();
        }
    });

    it('cancels the state colors editor without saving', async () => {
        const editor = renderEditor({ id: 'mcp', type: 'mcp-status' }, 'edit-state-colors');
        try {
            await waitFor(() => {
                expect(editor.stdout.getOutput()).toContain('State colors: Off');
            });
            editor.stdin.write('\x1b');
            await waitFor(() => {
                expect(editor.onCancel).toHaveBeenCalledTimes(1);
            });
            expect(editor.onComplete).not.toHaveBeenCalled();
        } finally {
            editor.cleanup();
        }
    });

    it('saves a typed name limit', async () => {
        const editor = renderEditor({ id: 'mcp', type: 'mcp-status', metadata: { mode: 'names' } }, 'edit-list-limit');
        try {
            await waitFor(() => {
                expect(editor.stdout.getOutput()).toContain('Max server names to show');
            });
            editor.stdin.write('\x7f');
            await waitFor(() => {
                expect(editor.stdout.getOutput()).toMatch(/unlimited\):\s*\n/);
            });
            editor.stdin.write('5');
            await waitFor(() => {
                expect(editor.stdout.getOutput()).toContain('(0 for unlimited): 5');
            });
            editor.stdin.write('\r');
            await waitFor(() => {
                expect(editor.onComplete).toHaveBeenCalledTimes(1);
            });
            expect((editor.onComplete.mock.calls[0]?.[0] as WidgetItem).metadata).toEqual({ mode: 'names', listLimit: '5' });
        } finally {
            editor.cleanup();
        }
    });
});
