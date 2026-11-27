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
    getScopeStatusPath,
    readScopeStatus,
    type McpScopeStatus
} from '../utils/mcp-scope-status';

import { makeModifierText } from './shared/editor-display';
import { isHidden } from './shared/hideable';
import {
    CATEGORY_OPTIMIZER,
    RUNTIME_KEYBIND,
    TOGGLE_RUNTIME_ACTION,
    getRuntimeModifier,
    isRuntimeAware,
    toggleRuntimeAware
} from './shared/optimizer-display';
import { formatRawOrLabeledValue } from './shared/raw-or-labeled';

const LABEL = 'MCP scope: ';
const GLOBAL_HIDEABLE_STATE: HideableState = { key: 'global', label: 'when every configured server may load (global)', defaultEnabled: true };

function describeScope(status: McpScopeStatus): string {
    return status.held.length > 0 ? `${status.scope} (${status.held.length} held)` : status.scope;
}

export class McpScopeWidget implements Widget {
    getDefaultColor(): string { return 'cyan'; }
    getDescription(): string { return 'CC Optimizer MCP scope for this session: project (3 held) when servers from your global setup are held back, or global.\nHidden without CC Optimizer\'s MCP scope in this session.'; }
    getDisplayName(): string { return 'MCP Scope'; }
    getCategory(): string { return CATEGORY_OPTIMIZER; }
    getLabelPrefix(): string { return LABEL; }
    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        const modifiers: string[] = [];
        const runtimeModifier = getRuntimeModifier(item);
        if (runtimeModifier) {
            modifiers.push(runtimeModifier);
        }

        return { displayText: this.getDisplayName(), modifierText: makeModifierText(modifiers) };
    }

    getHideableStates(): HideableState[] {
        return [GLOBAL_HIDEABLE_STATE];
    }

    getCustomKeybinds(item?: WidgetItem): CustomKeybind[] {
        return [RUNTIME_KEYBIND];
    }

    handleEditorAction(action: string, item: WidgetItem): WidgetItem | null {
        return action === TOGGLE_RUNTIME_ACTION ? toggleRuntimeAware(item) : null;
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        if (context.isPreview) {
            return formatRawOrLabeledValue(item, LABEL, 'project (3 held)');
        }

        if (!isRuntimeAware(item)) {
            return null;
        }

        const status = readScopeStatus(getScopeStatusPath(context.data?.session_id));
        if (!status || (status.scope !== 'project' && isHidden(item, GLOBAL_HIDEABLE_STATE.key, GLOBAL_HIDEABLE_STATE.defaultEnabled))) {
            return null;
        }

        return formatRawOrLabeledValue(item, LABEL, describeScope(status));
    }

    supportsRawValue(): boolean { return true; }
    supportsColors(item: WidgetItem): boolean { return true; }
}
