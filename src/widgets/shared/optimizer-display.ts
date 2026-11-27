import type { RenderContext } from '../../types/RenderContext';
import type { WidgetItem } from '../../types/Widget';
import {
    formatModelName,
    resolveContext,
    type ResolvedContext
} from '../../utils/optimizer-runtime';

import { removeMetadataKeys } from './metadata';

const RUNTIME_METADATA_KEY = 'runtime';

export const CATEGORY_OPTIMIZER = 'CC Optimizer';
export const TOGGLE_RUNTIME_ACTION = 'toggle-runtime';

export const RUNTIME_KEYBIND = { key: 'o', label: '(o)ptimizer runtime', action: TOGGLE_RUNTIME_ACTION };

/** Runtime awareness is on unless the item stores runtime=off. */
export function isRuntimeAware(item: WidgetItem): boolean {
    return item.metadata?.[RUNTIME_METADATA_KEY] !== 'off';
}

export function toggleRuntimeAware(item: WidgetItem): WidgetItem {
    if (!isRuntimeAware(item)) {
        return removeMetadataKeys(item, [RUNTIME_METADATA_KEY]);
    }

    return { ...item, metadata: { ...item.metadata, [RUNTIME_METADATA_KEY]: 'off' } };
}

export function getRuntimeModifier(item: WidgetItem): string | null {
    return isRuntimeAware(item) ? null : 'runtime off';
}

/** The context on screen according to CC Optimizer's runtime file, or null when there is no runtime or the item opted out. */
export function getResolvedRuntimeContext(item: WidgetItem, context: RenderContext): ResolvedContext | null {
    if (!isRuntimeAware(item) || !context.optimizerRuntime) {
        return null;
    }

    return resolveContext(context.optimizerRuntime);
}

export type ModelMarkers = 'all' | 'substitution';

/** Model of a resolved context as text: substitution shows both, pending and configured are marked. */
export function formatContextModel(ctx: ResolvedContext, markers: ModelMarkers = 'all'): string | null {
    if (!ctx.model) {
        return null;
    }

    const name = formatModelName(ctx.model);
    if (ctx.substitution && ctx.requestedModel) {
        return `${name} (asked ${formatModelName(ctx.requestedModel)})`;
    }

    if (markers === 'all') {
        if (ctx.pending) {
            return `${name} (${ctx.stale ? 'stale' : 'pending'})`;
        }
        if (ctx.configured) {
            return `${name} (configured)`;
        }
        if (ctx.change) {
            const by = ctx.change.source === 'you' || ctx.change.source === 'unknown' ? '' : ` by ${ctx.change.source}`;
            return `${name} (from ${formatModelName(ctx.change.from)}${by})`;
        }
    }

    return name;
}
