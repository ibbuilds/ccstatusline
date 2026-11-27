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
    getMethodLabel,
    isAutomaticWorkflow
} from '../utils/optimizer-runtime';

import { makeModifierText } from './shared/editor-display';
import { isMetadataFlagEnabled } from './shared/metadata';
import {
    CATEGORY_OPTIMIZER,
    RUNTIME_KEYBIND,
    TOGGLE_RUNTIME_ACTION,
    getRuntimeModifier,
    isRuntimeAware,
    toggleRuntimeAware
} from './shared/optimizer-display';
import { formatRawOrLabeledValue } from './shared/raw-or-labeled';

const LABEL = 'Workflow: ';
const HIDE_AUTO_KEY = 'hideAuto';
const TOGGLE_AUTO_ACTION = 'toggle-auto';

// Advisor and Agent Teams run on Claude Code's own features, which only work
// once Claude Code has loaded them: configured is not the same as in use.
function nativeFeatureSuffix(runtime: OptimizerRuntime, methodology: string | null): string {
    const state = methodology === 'advisor'
        ? runtime.native.advisor
        : methodology === 'agent-teams'
            ? runtime.native.teams
            : null;

    switch (state) {
        case 'requested': return ' (pending reload)';
        case 'off': return ' (inactive)';
        default: return '';
    }
}

function describeWorkflow(runtime: OptimizerRuntime, showAuto: boolean): string | null {
    const workflow = runtime.workflow;
    if (!workflow) {
        return null;
    }

    if (workflow.execution !== 'optimizer') {
        return 'Native';
    }

    const methodLabel = getMethodLabel(workflow.name);
    const methodology = methodLabel ? workflow.name.toLowerCase() : (runtime.composition?.methodology ?? null);
    const text = `${methodLabel ?? workflow.name}${nativeFeatureSuffix(runtime, methodology)}`;

    return showAuto && isAutomaticWorkflow(workflow) ? `${text} (auto)` : text;
}

export class OptimizerWorkflowWidget implements Widget {
    getDefaultColor(): string { return 'brightMagenta'; }
    getDescription(): string { return 'CC Optimizer workflow in use: Native, a methodology (Direct, Advisor, Orchestrator, Critic, Best-of-N, Agent Teams) or a custom workflow name, with (auto) when automatic selection chose it.\nHidden without CC Optimizer in this session.'; }
    getDisplayName(): string { return 'Workflow'; }
    getCategory(): string { return CATEGORY_OPTIMIZER; }
    getLabelPrefix(): string { return LABEL; }
    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        const modifiers: string[] = [];
        if (isMetadataFlagEnabled(item, HIDE_AUTO_KEY)) {
            modifiers.push('no auto marker');
        }
        const runtimeModifier = getRuntimeModifier(item);
        if (runtimeModifier) {
            modifiers.push(runtimeModifier);
        }

        return { displayText: this.getDisplayName(), modifierText: makeModifierText(modifiers) };
    }

    getCustomKeybinds(): CustomKeybind[] {
        return [
            { key: 't', label: '(t)oggle auto marker', action: TOGGLE_AUTO_ACTION },
            RUNTIME_KEYBIND
        ];
    }

    handleEditorAction(action: string, item: WidgetItem): WidgetItem | null {
        if (action === TOGGLE_AUTO_ACTION) {
            const { [HIDE_AUTO_KEY]: removed, ...rest } = item.metadata ?? {};
            const metadata = isMetadataFlagEnabled(item, HIDE_AUTO_KEY)
                ? rest
                : { ...rest, [HIDE_AUTO_KEY]: 'true' };

            return { ...item, metadata: Object.keys(metadata).length > 0 ? metadata : undefined };
        }

        return action === TOGGLE_RUNTIME_ACTION ? toggleRuntimeAware(item) : null;
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        if (context.isPreview) {
            return formatRawOrLabeledValue(item, LABEL, 'Orchestrator');
        }

        if (!isRuntimeAware(item) || !context.optimizerRuntime) {
            return null;
        }

        const text = describeWorkflow(context.optimizerRuntime, !isMetadataFlagEnabled(item, HIDE_AUTO_KEY));
        return text ? formatRawOrLabeledValue(item, LABEL, text) : null;
    }

    supportsRawValue(): boolean { return true; }
    supportsColors(item: WidgetItem): boolean { return true; }
}
