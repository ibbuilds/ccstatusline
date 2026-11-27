import type { OptimizerRuntime } from '../types/OptimizerRuntime';
import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type {
    CustomKeybind,
    HideableState,
    Widget,
    WidgetEditorDisplay,
    WidgetItem
} from '../types/Widget';
import {
    getActiveAgents,
    resolveAgent
} from '../utils/optimizer-runtime';

import { makeModifierText } from './shared/editor-display';
import { isHidden } from './shared/hideable';
import { removeMetadataKeys } from './shared/metadata';
import {
    CATEGORY_OPTIMIZER,
    RUNTIME_KEYBIND,
    TOGGLE_RUNTIME_ACTION,
    formatContextModel,
    getRuntimeModifier,
    isRuntimeAware,
    toggleRuntimeAware
} from './shared/optimizer-display';
import { formatRawOrLabeledValue } from './shared/raw-or-labeled';

const DETAILED_LABEL = 'Agents: ';
const FORMAT_KEY = 'format';
const MAX_ITEMS_KEY = 'maxItems';
const CYCLE_FORMAT_ACTION = 'cycle-format';
const CYCLE_MAX_ITEMS_ACTION = 'cycle-max-items';
const MAX_ITEMS_CHOICES = [1, 2, 3, 4, 5, 8] as const;
const DEFAULT_MAX_ITEMS = 3;
const NONE_HIDEABLE_STATE: HideableState = { key: 'none', label: 'when no agents are active', defaultEnabled: true };

function isDetailed(item: WidgetItem): boolean {
    return item.metadata?.[FORMAT_KEY] === 'detailed';
}

function getMaxItems(item: WidgetItem): number {
    const value = Number(item.metadata?.[MAX_ITEMS_KEY]);
    return (MAX_ITEMS_CHOICES as readonly number[]).includes(value) ? value : DEFAULT_MAX_ITEMS;
}

function describeAgents(runtime: OptimizerRuntime, item: WidgetItem): string | null {
    const active = getActiveAgents(runtime);
    if (active.length === 0 && isHidden(item, NONE_HIDEABLE_STATE.key, NONE_HIDEABLE_STATE.defaultEnabled)) {
        return null;
    }

    if (!isDetailed(item)) {
        return item.rawValue ? `${active.length}` : `${active.length} ${active.length === 1 ? 'agent' : 'agents'}`;
    }

    if (active.length === 0) {
        return 'none';
    }

    const groups: { label: string; base: string; detail: string; count: number }[] = [];
    for (const agent of active) {
        const resolved = resolveAgent(runtime, agent);
        const model = formatContextModel(resolved, 'substitution');
        const detail = [model, resolved.effort].filter((part): part is string => Boolean(part)).join(' ');
        const base = agent.label.replace(/\s+\d+$/, '');
        const same = groups.find(group => group.base === base && group.detail === detail);
        if (same) {
            same.count += 1;
        } else {
            groups.push({ label: agent.label, base, detail, count: 1 });
        }
    }

    const shown = groups.slice(0, getMaxItems(item));
    const entries = shown.map((group) => {
        const name = group.count > 1 ? `${group.base} ×${group.count}` : group.label;
        return group.detail ? `${name} (${group.detail})` : name;
    });
    const hidden = groups.slice(shown.length).reduce((sum, group) => sum + group.count, 0);

    return `${entries.join(', ')}${hidden > 0 ? ` +${hidden}` : ''}`;
}

export class OptimizerAgentsWidget implements Widget {
    getDefaultColor(): string { return 'brightCyan'; }
    getDescription(): string { return 'CC Optimizer agents running or waiting, as a count or as a list with each agent\'s model and effort: Implementer ×2 (Sonnet 5.5 medium).\nHidden without CC Optimizer in this session.'; }
    getDisplayName(): string { return 'Agents'; }
    getCategory(): string { return CATEGORY_OPTIMIZER; }
    getLabelPrefix(item?: WidgetItem): string | undefined {
        return item && isDetailed(item) ? DETAILED_LABEL : undefined;
    }

    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        const modifiers: string[] = [];
        if (isDetailed(item)) {
            modifiers.push(`detailed, max ${getMaxItems(item)}`);
        }
        const runtimeModifier = getRuntimeModifier(item);
        if (runtimeModifier) {
            modifiers.push(runtimeModifier);
        }

        return { displayText: this.getDisplayName(), modifierText: makeModifierText(modifiers) };
    }

    getHideableStates(): HideableState[] {
        return [NONE_HIDEABLE_STATE];
    }

    getCustomKeybinds(item?: WidgetItem): CustomKeybind[] {
        const keybinds: CustomKeybind[] = [{ key: 'f', label: '(f)ormat', action: CYCLE_FORMAT_ACTION }];
        if (item === undefined || isDetailed(item)) {
            keybinds.push({ key: 'n', label: '(n)umber of agents', action: CYCLE_MAX_ITEMS_ACTION });
        }
        keybinds.push(RUNTIME_KEYBIND);

        return keybinds;
    }

    handleEditorAction(action: string, item: WidgetItem): WidgetItem | null {
        if (action === CYCLE_FORMAT_ACTION) {
            return isDetailed(item)
                ? removeMetadataKeys(item, [FORMAT_KEY])
                : { ...item, metadata: { ...item.metadata, [FORMAT_KEY]: 'detailed' } };
        }

        if (action === CYCLE_MAX_ITEMS_ACTION) {
            const index = MAX_ITEMS_CHOICES.indexOf(getMaxItems(item) as typeof MAX_ITEMS_CHOICES[number]);
            const next = MAX_ITEMS_CHOICES[(index + 1) % MAX_ITEMS_CHOICES.length] ?? DEFAULT_MAX_ITEMS;
            return next === DEFAULT_MAX_ITEMS
                ? removeMetadataKeys(item, [MAX_ITEMS_KEY])
                : { ...item, metadata: { ...item.metadata, [MAX_ITEMS_KEY]: String(next) } };
        }

        return action === TOGGLE_RUNTIME_ACTION ? toggleRuntimeAware(item) : null;
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        if (context.isPreview) {
            return isDetailed(item)
                ? formatRawOrLabeledValue(item, DETAILED_LABEL, 'Implementer ×2 (Sonnet 5.5 medium), Analyst (Opus 5.5 high)')
                : (item.rawValue ? '2' : '2 agents');
        }

        if (!isRuntimeAware(item) || !context.optimizerRuntime) {
            return null;
        }

        const text = describeAgents(context.optimizerRuntime, item);
        if (text === null) {
            return null;
        }

        return isDetailed(item) ? formatRawOrLabeledValue(item, DETAILED_LABEL, text) : text;
    }

    supportsRawValue(): boolean { return true; }
    supportsColors(item: WidgetItem): boolean { return true; }
}
