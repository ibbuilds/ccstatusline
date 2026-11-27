import {
    Box,
    Text,
    useInput
} from 'ink';
import React, { useState } from 'react';

import {
    getColorLevelString,
    type ColorLevelString
} from '../types/ColorLevel';
import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type {
    CustomKeybind,
    HideableState,
    Widget,
    WidgetEditorDisplay,
    WidgetEditorProps,
    WidgetItem
} from '../types/Widget';
import {
    applyColors,
    getAvailableColorsForUI,
    getColorAnsiCode,
    getColorDisplayName
} from '../utils/colors';
import {
    getPlainInput,
    shouldInsertInput
} from '../utils/input-guards';
import type {
    McpServerState,
    McpStatusData
} from '../utils/mcp-status';

import { BlinkingCursor } from './shared/BlinkingCursor';
import { makeModifierText } from './shared/editor-display';
import { isHidden } from './shared/hideable';
import {
    MAX_WIDTH_ACTION,
    applyMaxWidth,
    getMaxWidthKeybind,
    getMaxWidthModifier,
    renderMaxWidthEditor
} from './shared/max-width';
import { removeMetadataKeys } from './shared/metadata';
import { getLabel } from './shared/raw-or-labeled';

type Mode = 'compact' | 'detailed' | 'health' | 'count' | 'names' | 'problems';
const MODES: Mode[] = ['compact', 'detailed', 'health', 'count', 'names', 'problems'];

type Severity = 'healthy' | 'warning' | 'problem';
const SEVERITIES: Severity[] = ['healthy', 'warning', 'problem'];
const DEFAULT_STATE_COLORS: Record<Severity, string> = { healthy: 'green', warning: 'yellow', problem: 'red' };

const LABEL = 'MCP ';
const MODE_KEY = 'mode';
const LIST_LIMIT_KEY = 'listLimit';
const STATE_COLORS_KEY = 'stateColors';
const STATE_COLOR_PREFIX = 'stateColor.';
const DEFAULT_LIST_LIMIT = 3;

const CYCLE_MODE_ACTION = 'cycle-mode';
const EDIT_LIST_LIMIT_ACTION = 'edit-list-limit';
const EDIT_STATE_COLORS_ACTION = 'edit-state-colors';

const EMPTY_STATE: HideableState = { key: 'empty', label: 'when no MCP servers are configured or connected' };
const HEALTHY_STATE: HideableState = { key: 'healthy', label: 'when every enabled server is connected' };

// Display order, wording, health symbol and severity of each state. Disabled
// and held servers were turned off on purpose, so they carry no severity.
const STATES: { state: McpServerState; text: string; symbol: string | null; severity: Severity | null }[] = [
    { state: 'connected', text: 'connected', symbol: '✓', severity: 'healthy' },
    { state: 'needs-auth', text: 'needs auth', symbol: '!', severity: 'warning' },
    { state: 'not-connected', text: 'not connected', symbol: '✗', severity: 'problem' },
    { state: 'pending-approval', text: 'pending approval', symbol: '…', severity: 'warning' },
    { state: 'blocked', text: 'blocked', symbol: '⊘', severity: 'problem' },
    { state: 'disabled', text: 'disabled', symbol: null, severity: null },
    { state: 'held', text: 'held by scope', symbol: null, severity: null },
    { state: 'configured', text: 'configured', symbol: '○', severity: 'warning' }
];
const PROBLEM_STATES = new Set<McpServerState>(['needs-auth', 'not-connected', 'pending-approval', 'blocked']);
const INACTIVE_STATES = new Set<McpServerState>(['disabled', 'blocked', 'held']);

const PREVIEW_STATUS: McpStatusData = {
    servers: [
        { name: 'context7', state: 'connected', scope: 'user' },
        { name: 'deepwiki', state: 'connected', scope: 'user' },
        { name: 'github', state: 'connected', scope: 'user' },
        { name: 'figma', state: 'connected', scope: 'user' },
        { name: 'linear', state: 'connected', scope: 'user' },
        { name: 'claude.ai Gmail', state: 'needs-auth', scope: 'session' }
    ],
    sessionObserved: true
};

function getMode(item: WidgetItem): Mode {
    const mode = item.metadata?.[MODE_KEY];
    return MODES.includes(mode as Mode) ? mode as Mode : 'compact';
}

function getListLimit(item: WidgetItem): number {
    const parsed = Number.parseInt(item.metadata?.[LIST_LIMIT_KEY] ?? '', 10);
    return Number.isNaN(parsed) || parsed < 0 ? DEFAULT_LIST_LIMIT : parsed;
}

function isStateColorsEnabled(item: WidgetItem): boolean {
    return item.metadata?.[STATE_COLORS_KEY] === 'true';
}

function getStateColor(item: WidgetItem, severity: Severity): string {
    return item.metadata?.[`${STATE_COLOR_PREFIX}${severity}`] ?? DEFAULT_STATE_COLORS[severity];
}

function setMetadataValue(item: WidgetItem, key: string, value: string | null): WidgetItem {
    return value === null ? removeMetadataKeys(item, [key]) : { ...item, metadata: { ...item.metadata, [key]: value } };
}

// Names come from config files and transcripts; drop anything that could move
// the cursor or start an escape sequence
function sanitizeName(name: string): string {
    return name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

function countStates(data: McpStatusData): Map<McpServerState, number> {
    const counts = new Map<McpServerState, number>();
    for (const server of data.servers) {
        counts.set(server.state, (counts.get(server.state) ?? 0) + 1);
    }
    return counts;
}

function overallSeverity(counts: Map<McpServerState, number>): Severity | null {
    let worst = -1;
    for (const { state, severity } of STATES) {
        if (severity && (counts.get(state) ?? 0) > 0) {
            worst = Math.max(worst, SEVERITIES.indexOf(severity));
        }
    }
    return SEVERITIES[worst] ?? null;
}

interface Painter { paint: (text: string, severity: Severity | null) => string }

function createPainter(item: WidgetItem, settings: Settings): Painter {
    const colorLevel: ColorLevelString = getColorLevelString(settings.colorLevel);
    const enabled = isStateColorsEnabled(item) && settings.colorLevel !== 0;
    return {
        paint: (text, severity) => {
            if (!enabled || !severity || !text) {
                return text;
            }
            const code = getColorAnsiCode(getStateColor(item, severity), colorLevel);
            return code ? `${code}${text}\x1b[39m` : text;
        }
    };
}

function joinStates(counts: Map<McpServerState, number>, include: (state: McpServerState) => boolean): string {
    return STATES
        .filter(({ state }) => include(state) && (counts.get(state) ?? 0) > 0)
        .map(({ state, text }) => `${counts.get(state)} ${text}`)
        .join(' | ');
}

function formatValue(mode: Mode, data: McpStatusData, item: WidgetItem, painter: Painter): string | null {
    const counts = countStates(data);
    const enabled = data.servers.filter(server => !INACTIVE_STATES.has(server.state)).length;
    const connected = counts.get('connected') ?? 0;
    const severity = overallSeverity(counts);

    switch (mode) {
        case 'compact':
            return painter.paint(`${connected}/${enabled}${data.sessionObserved ? '' : '?'}`, severity);
        case 'detailed':
            return painter.paint(joinStates(counts, () => true) || 'none', severity);
        case 'health': {
            const parts = STATES
                .filter(({ state, symbol }) => symbol !== null && (counts.get(state) ?? 0) > 0)
                .map(({ state, symbol, severity: own }) => painter.paint(`${symbol}${counts.get(state)}`, own));
            return parts.length > 0 ? parts.join(' ') : 'none';
        }
        case 'count':
            return painter.paint(String(enabled), severity);
        case 'names': {
            const names = data.servers.filter(server => server.state === 'connected').map(server => sanitizeName(server.name));
            if (names.length === 0) {
                return painter.paint('none', severity);
            }
            const limit = getListLimit(item);
            const shown = limit > 0 ? names.slice(0, limit) : names;
            const overflow = names.length - shown.length;
            return painter.paint(`${shown.join(', ')}${overflow > 0 ? ` +${overflow}` : ''}`, severity);
        }
        case 'problems': {
            const text = joinStates(counts, state => PROBLEM_STATES.has(state));
            return text ? painter.paint(text, severity) : null;
        }
    }
}

export class McpStatusWidget implements Widget {
    getDefaultColor(): string { return 'white'; }
    getDescription(): string {
        return 'MCP servers of this session: connected, needing auth, not connected, pending approval, disabled or blocked.\n'
            + 'Connected and needs-auth come from the tools Claude Code gave this session (read from its transcript);\n'
            + 'the rest from Claude Code config for this project. "?" / "configured" means the session has not reported its tools yet.\n'
            + '"Not connected" covers failed, errored and still-connecting servers alike; Claude Code does not tell them apart here.';
    }

    getDisplayName(): string { return 'MCP Status'; }
    getCategory(): string { return 'CC Optimizer'; }
    getLabelPrefix(): string { return LABEL; }
    supportsRawValue(): boolean { return true; }
    supportsColors(): boolean { return true; }

    getHideableStates(): HideableState[] {
        return [EMPTY_STATE, HEALTHY_STATE];
    }

    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        const mode = getMode(item);
        const modifiers: string[] = [mode];
        if (mode === 'names' && item.metadata?.[LIST_LIMIT_KEY] !== undefined) {
            modifiers.push(`limit: ${getListLimit(item)}`);
        }
        if (isStateColorsEnabled(item)) {
            modifiers.push('state colors');
        }
        const maxWidth = getMaxWidthModifier(item);
        if (maxWidth) {
            modifiers.push(maxWidth);
        }
        return { displayText: this.getDisplayName(), modifierText: makeModifierText(modifiers) };
    }

    getCustomKeybinds(item?: WidgetItem): CustomKeybind[] {
        const keybinds: CustomKeybind[] = [{ key: 'v', label: '(v)iew mode', action: CYCLE_MODE_ACTION }];
        if (item && getMode(item) === 'names') {
            keybinds.push({ key: 'l', label: '(l)imit', action: EDIT_LIST_LIMIT_ACTION });
        }
        keybinds.push({ key: 's', label: '(s)tate colors', action: EDIT_STATE_COLORS_ACTION });
        keybinds.push(getMaxWidthKeybind());
        return keybinds;
    }

    handleEditorAction(action: string, item: WidgetItem): WidgetItem | null {
        if (action !== CYCLE_MODE_ACTION) {
            return null;
        }
        const next = MODES[(MODES.indexOf(getMode(item)) + 1) % MODES.length] ?? 'compact';
        const cleaned = next === 'names' ? item : removeMetadataKeys(item, [LIST_LIMIT_KEY]);
        return setMetadataValue(cleaned, MODE_KEY, next === 'compact' ? null : next);
    }

    renderEditor(props: WidgetEditorProps): React.ReactElement {
        if (props.action === MAX_WIDTH_ACTION) {
            return renderMaxWidthEditor(props);
        }
        if (props.action === EDIT_STATE_COLORS_ACTION) {
            return <McpStateColorsEditor {...props} />;
        }
        return <McpListLimitEditor {...props} />;
    }

    colorsOnlyItsRuns(item: WidgetItem): boolean {
        return isStateColorsEnabled(item);
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        const data = context.isPreview ? PREVIEW_STATUS : context.mcpStatus;
        const label = item.rawValue ? '' : getLabel(item, LABEL);

        if (!data) {
            return applyMaxWidth(`${label}n/a`, item.maxWidth);
        }
        if (data.servers.length === 0 && isHidden(item, EMPTY_STATE.key)) {
            return null;
        }
        const healthy = data.sessionObserved && !data.servers.some(server => PROBLEM_STATES.has(server.state));
        if (healthy && data.servers.length > 0 && isHidden(item, HEALTHY_STATE.key)) {
            return null;
        }

        const value = formatValue(getMode(item), data, item, createPainter(item, settings));
        return value === null ? null : applyMaxWidth(`${label}${value}`, item.maxWidth);
    }
}

const McpListLimitEditor: React.FC<WidgetEditorProps> = ({ widget, onComplete, onCancel }) => {
    const [input, setInput] = useState(() => getListLimit(widget).toString());

    useInput((text, key) => {
        if (key.return) {
            const parsed = Number.parseInt(input, 10);
            onComplete(Number.isNaN(parsed) || parsed < 0
                ? removeMetadataKeys(widget, [LIST_LIMIT_KEY])
                : setMetadataValue(widget, LIST_LIMIT_KEY, String(parsed)));
        } else if (key.escape) {
            onCancel();
        } else if (key.backspace || key.delete) {
            setInput(input.slice(0, -1));
        } else if (shouldInsertInput(text, key) && /\d/.test(text)) {
            setInput(input + text);
        }
    });

    return (
        <Box flexDirection='column'>
            <Box>
                <Text>Max server names to show (0 for unlimited): </Text>
                <Text>{input}</Text>
                <BlinkingCursor>{' '}</BlinkingCursor>
            </Box>
            <Text dimColor>Press Enter to save, ESC to cancel</Text>
        </Box>
    );
};

const NAMED_COLORS = getAvailableColorsForUI().map(color => color.value).filter(value => value !== '');

function cycleNamedColor(current: string, direction: 1 | -1): string {
    const index = NAMED_COLORS.indexOf(current);
    if (index === -1) {
        return NAMED_COLORS[direction === 1 ? 0 : NAMED_COLORS.length - 1] ?? current;
    }
    return NAMED_COLORS[(index + direction + NAMED_COLORS.length) % NAMED_COLORS.length] ?? current;
}

const SEVERITY_LABELS: Record<Severity, string> = { healthy: 'Healthy', warning: 'Attention', problem: 'Problem' };

const McpStateColorsEditor: React.FC<WidgetEditorProps> = ({ widget, onComplete, onCancel, settings }) => {
    const [draft, setDraft] = useState(widget);
    const [selected, setSelected] = useState(0);
    const enabled = isStateColorsEnabled(draft);
    const colorLevel = getColorLevelString(settings?.colorLevel);
    const severity = SEVERITIES[selected] ?? 'healthy';

    useInput((input, key) => {
        const shortcut = getPlainInput(input, key);
        if (key.return) {
            onComplete(draft);
        } else if (key.escape) {
            onCancel();
        } else if (key.upArrow || key.downArrow) {
            setSelected((selected + (key.downArrow ? 1 : -1) + SEVERITIES.length) % SEVERITIES.length);
        } else if (key.leftArrow || key.rightArrow) {
            const next = cycleNamedColor(getStateColor(draft, severity), key.rightArrow ? 1 : -1);
            setDraft(setMetadataValue(draft, `${STATE_COLOR_PREFIX}${severity}`, next === DEFAULT_STATE_COLORS[severity] ? null : next));
        } else if (shortcut === ' ') {
            setDraft(setMetadataValue(draft, STATE_COLORS_KEY, enabled ? null : 'true'));
        } else if (shortcut === 'd') {
            setDraft(removeMetadataKeys(draft, SEVERITIES.map(entry => `${STATE_COLOR_PREFIX}${entry}`)));
        }
    });

    const sampleSettings = { ...(settings ?? ({} as Settings)), colorLevel: settings?.colorLevel ?? 1 };
    const sample = applyColors(
        new McpStatusWidget().render({ ...draft, metadata: { ...draft.metadata, [MODE_KEY]: 'health' } }, {
            mcpStatus: {
                servers: [
                    { name: 'a', state: 'connected', scope: 'user' },
                    { name: 'b', state: 'needs-auth', scope: 'user' },
                    { name: 'c', state: 'not-connected', scope: 'user' }
                ],
                sessionObserved: true
            }
        }, sampleSettings) ?? '',
        draft.color ?? 'white',
        undefined,
        false,
        colorLevel,
        undefined,
        true
    );

    return (
        <Box flexDirection='column'>
            <Text bold>MCP Status: state colors</Text>
            <Text dimColor>↑↓ select, ←→ change color, Space on/off, (d)efaults, Enter save, ESC cancel</Text>
            <Box marginTop={1}>
                <Text>Sample: </Text>
                <Text>{sample}</Text>
            </Box>
            <Box marginTop={1}>
                <Text>State colors: </Text>
                <Text color={enabled ? 'green' : 'red'}>{enabled ? 'On' : 'Off'}</Text>
                {!enabled && <Text dimColor>  (Space to turn on; the widget uses its single color until then)</Text>}
            </Box>
            <Box marginTop={1} flexDirection='column'>
                {SEVERITIES.map((entry, index) => {
                    const isSelected = index === selected;
                    const color = getStateColor(draft, entry);
                    const code = settings?.colorLevel === 0 ? '' : getColorAnsiCode(color, colorLevel);
                    const name = getColorDisplayName(color);
                    return (
                        <Box key={entry} flexDirection='row' flexWrap='nowrap'>
                            <Box width={3}>
                                <Text color={isSelected ? 'green' : undefined}>{isSelected ? '▶ ' : '  '}</Text>
                            </Box>
                            <Box width={11}>
                                <Text color={isSelected ? 'green' : undefined} dimColor={!enabled && !isSelected}>{SEVERITY_LABELS[entry]}</Text>
                            </Box>
                            <Text dimColor={!enabled}>{code ? `${code}${name}\x1b[39m` : name}</Text>
                        </Box>
                    );
                })}
            </Box>
        </Box>
    );
};
