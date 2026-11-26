import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type {
    CustomKeybind,
    Widget,
    WidgetEditorDisplay,
    WidgetItem
} from '../types/Widget';
import {
    isSameModel,
    type ResolvedContext
} from '../utils/optimizer-runtime';

import { makeModifierText } from './shared/editor-display';
import {
    RUNTIME_KEYBIND,
    TOGGLE_RUNTIME_ACTION,
    formatContextModel,
    getResolvedRuntimeContext,
    getRuntimeModifier,
    toggleRuntimeAware
} from './shared/optimizer-display';
import { formatRawOrLabeledValue } from './shared/raw-or-labeled';

const LABEL = 'Model: ';

function getPayloadModel(context: RenderContext): { id: string | undefined; name: string } | null {
    const model = context.data?.model;
    const id = typeof model === 'string' ? model : model?.id;
    const displayName = typeof model === 'string'
        ? model
        : (model?.display_name ?? model?.id);

    return displayName ? { id, name: displayName.replace(/\s*\(.*\)$/, '') } : null;
}

// Claude Code's own payload names the main loop's model; CC Optimizer's runtime
// file is authoritative only where the payload cannot be: the model an
// optimizer-run lead or a viewed agent actually runs on.
function resolveRuntimeModel(resolved: ResolvedContext, payload: ReturnType<typeof getPayloadModel>): string | null {
    if (resolved.kind === 'agent') {
        const text = formatContextModel(resolved);
        return `${resolved.label ?? 'Agent'}: ${text ?? 'unknown'}`;
    }

    if (!resolved.nativeMain) {
        return formatContextModel(resolved) ?? payload?.name ?? null;
    }

    if (!payload) {
        return formatContextModel(resolved);
    }

    const differsFromPayload = resolved.model !== null && payload.id !== undefined && !isSameModel(resolved.model, payload.id);
    if (resolved.substitution || (resolved.pending && differsFromPayload)) {
        return formatContextModel(resolved);
    }

    return payload.name;
}

export class ModelWidget implements Widget {
    getDefaultColor(): string { return 'cyan'; }
    getDescription(): string { return 'Displays the Claude model name (e.g., Claude 3.5 Sonnet).\nWith CC Optimizer running, shows the model of the lead or the viewed agent, and a pending or substituted request.'; }
    getDisplayName(): string { return 'Model'; }
    getCategory(): string { return 'Core'; }
    getLabelPrefix(): string { return LABEL; }
    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        return { displayText: this.getDisplayName(), modifierText: makeModifierText([getRuntimeModifier(item)].filter((modifier): modifier is string => modifier !== null)) };
    }

    getCustomKeybinds(): CustomKeybind[] {
        return [RUNTIME_KEYBIND];
    }

    handleEditorAction(action: string, item: WidgetItem): WidgetItem | null {
        return action === TOGGLE_RUNTIME_ACTION ? toggleRuntimeAware(item) : null;
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        if (context.isPreview) {
            return formatRawOrLabeledValue(item, this.getLabelPrefix(), 'Claude');
        }

        const payload = getPayloadModel(context);
        const resolved = getResolvedRuntimeContext(item, context);
        if (resolved) {
            const runtimeModel = resolveRuntimeModel(resolved, payload);
            return runtimeModel ? formatRawOrLabeledValue(item, this.getLabelPrefix(), runtimeModel) : null;
        }

        if (payload) {
            return formatRawOrLabeledValue(item, this.getLabelPrefix(), payload.name);
        }
        return null;
    }

    supportsRawValue(): boolean { return true; }
    supportsColors(item: WidgetItem): boolean { return true; }
}
