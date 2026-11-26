import type { OptimizerRuntime } from '../types/OptimizerRuntime';
import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type {
    CustomKeybind,
    Widget,
    WidgetEditorDisplay,
    WidgetItem
} from '../types/Widget';
import {
    getActivityLabel,
    getStrategyLabel
} from '../utils/optimizer-runtime';

import { makeModifierText } from './shared/editor-display';
import { removeMetadataKeys } from './shared/metadata';
import {
    CATEGORY_OPTIMIZER,
    RUNTIME_KEYBIND,
    TOGGLE_RUNTIME_ACTION,
    getRuntimeModifier,
    isRuntimeAware,
    toggleRuntimeAware
} from './shared/optimizer-display';
import { formatRawOrLabeledValue } from './shared/raw-or-labeled';

const LABEL = 'Activity: ';
const STRATEGIES_KEY = 'strategies';
const CYCLE_STRATEGIES_ACTION = 'cycle-strategies';
const STRATEGY_MODES = ['off', 'active', 'all'] as const;
type StrategyMode = typeof STRATEGY_MODES[number];

function getStrategyMode(item: WidgetItem): StrategyMode {
    const value = item.metadata?.[STRATEGIES_KEY];
    return (STRATEGY_MODES as readonly string[]).includes(value ?? '') ? (value as StrategyMode) : 'off';
}

function describeActivity(runtime: OptimizerRuntime, mode: StrategyMode): string | null {
    const label = runtime.activity ? getActivityLabel(runtime.activity.stage) : null;
    if (!label) {
        return null;
    }

    const strategies = runtime.composition?.strategies ?? [];
    const parts = mode === 'off'
        ? []
        : [
            ...strategies.filter(strategy => strategy.state === 'active').map(strategy => getStrategyLabel(strategy.name)),
            ...(mode === 'all'
                ? strategies.filter(strategy => strategy.state !== 'active').map(strategy => `(${getStrategyLabel(strategy.name)})`)
                : [])
        ];

    return parts.length > 0 ? `${label} · ${parts.join(', ')}` : label;
}

export class OptimizerActivityWidget implements Widget {
    getDefaultColor(): string { return 'yellow'; }
    getDescription(): string { return 'Displays the stage CC Optimizer is in (Planning, Working, Reviewing, Verifying, ...), optionally with the active strategies and the allowed ones in parentheses.\nHidden under native execution and without it in this session.'; }
    getDisplayName(): string { return 'Optimizer Activity'; }
    getCategory(): string { return CATEGORY_OPTIMIZER; }
    getLabelPrefix(): string { return LABEL; }
    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        const modifiers: string[] = [];
        const mode = getStrategyMode(item);
        if (mode !== 'off') {
            modifiers.push(mode === 'active' ? 'active strategies' : 'all strategies');
        }
        const runtimeModifier = getRuntimeModifier(item);
        if (runtimeModifier) {
            modifiers.push(runtimeModifier);
        }

        return { displayText: this.getDisplayName(), modifierText: makeModifierText(modifiers) };
    }

    getCustomKeybinds(): CustomKeybind[] {
        return [
            { key: 's', label: '(s)trategies', action: CYCLE_STRATEGIES_ACTION },
            RUNTIME_KEYBIND
        ];
    }

    handleEditorAction(action: string, item: WidgetItem): WidgetItem | null {
        if (action === CYCLE_STRATEGIES_ACTION) {
            const next = STRATEGY_MODES[(STRATEGY_MODES.indexOf(getStrategyMode(item)) + 1) % STRATEGY_MODES.length] ?? 'off';
            return next === 'off'
                ? removeMetadataKeys(item, [STRATEGIES_KEY])
                : { ...item, metadata: { ...item.metadata, [STRATEGIES_KEY]: next } };
        }

        return action === TOGGLE_RUNTIME_ACTION ? toggleRuntimeAware(item) : null;
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        const mode = getStrategyMode(item);
        if (context.isPreview) {
            return formatRawOrLabeledValue(item, LABEL, mode === 'off' ? 'Working' : 'Working · Parallel');
        }

        if (!isRuntimeAware(item) || !context.optimizerRuntime) {
            return null;
        }

        const text = describeActivity(context.optimizerRuntime, mode);
        return text ? formatRawOrLabeledValue(item, LABEL, text) : null;
    }

    supportsRawValue(): boolean { return true; }
    supportsColors(item: WidgetItem): boolean { return true; }
}
