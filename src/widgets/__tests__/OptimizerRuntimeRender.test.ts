import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type {
    RenderContext,
    StatusJSON,
    WidgetItem
} from '../../types';
import type { OptimizerRuntime } from '../../types/OptimizerRuntime';
import {
    DEFAULT_SETTINGS,
    type Settings
} from '../../types/Settings';
import {
    agentAt,
    loadRuntimeFixture,
    stepOf
} from '../../utils/__tests__/optimizer-runtime-fixtures';
import { parseOptimizerRuntime } from '../../utils/optimizer-runtime';
import {
    calculateMaxWidthsFromPreRendered,
    preRenderAllWidgets,
    renderStatusLine
} from '../../utils/renderer';
import { OptimizerActivityWidget } from '../OptimizerActivity';
import { OptimizerAgentsWidget } from '../OptimizerAgents';
import { OptimizerWorkflowWidget } from '../OptimizerWorkflow';

const SEPARATOR: WidgetItem = { id: 'sep', type: 'separator', character: '|' };

// Raw values keep the example lines short; labels are covered by the widget tests below
const LINE: WidgetItem[] = [
    { id: 'm', type: 'model', rawValue: true },
    SEPARATOR,
    { id: 'e', type: 'thinking-effort', rawValue: true },
    SEPARATOR,
    { id: 'w', type: 'optimizer-workflow', rawValue: true },
    SEPARATOR,
    { id: 'a', type: 'optimizer-activity', rawValue: true, metadata: { strategies: 'active' } },
    SEPARATOR,
    { id: 'g', type: 'optimizer-agents', rawValue: true, metadata: { format: 'detailed' } }
];

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, colorLevel: 0, defaultPadding: '' };

function payload(model: string, displayName: string, effort: string): StatusJSON {
    return { model: { id: model, display_name: displayName }, effort: { level: effort } };
}

function parse(raw: Record<string, unknown>): OptimizerRuntime {
    const runtime = parseOptimizerRuntime(raw, String(raw.session));
    if (!runtime) {
        throw new Error('fixture did not parse');
    }
    return runtime;
}

function fixture(name: string): OptimizerRuntime {
    return parse(loadRuntimeFixture(name));
}

function render(items: WidgetItem[], data: StatusJSON, optimizerRuntime?: OptimizerRuntime | null): string {
    const context: RenderContext = { isPreview: false, terminalWidth: 0, data, optimizerRuntime };
    const preRendered = preRenderAllWidgets([items], SETTINGS, context);
    const maxWidths = calculateMaxWidthsFromPreRendered(preRendered, SETTINGS);
    return renderStatusLine(items, SETTINGS, context, preRendered[0] ?? [], maxWidths).trim();
}

const OPUS = payload('claude-opus-5-5', 'Opus 5.5 (1M context)', 'medium');
const SONNET = payload('claude-sonnet-5-5', 'Sonnet 5.5', 'medium');

// Fixed time: a pending request goes stale ten minutes after the file's updatedAt
function setNow(iso: string): void {
    vi.useFakeTimers({ now: new Date(iso), toFake: ['Date'] });
}

beforeEach(() => {
    setNow('2026-11-24T10:00:30.000Z');
});

afterEach(() => {
    vi.useRealTimers();
});

describe('status line with CC Optimizer runtime', () => {
    function check(name: string, line: string, expected: string): void {
        if (process.env.CCSL_PRINT_EXAMPLES) {
            console.log(`EXAMPLE ${name} => ${line}`);
        }
        expect(line).toBe(expected);
    }

    it('native Opus medium: payload model and effort, workflow native, no activity, native agents counted', () => {
        check('native Opus medium', render(LINE, OPUS, fixture('native-opus-medium')),
            'Opus 5.5 | medium | Native | Find the config');
    });

    it('orchestrator planning on Opus: the lead runs Opus although Claude Code reports Sonnet', () => {
        check('orchestrator planning', render(LINE, SONNET, fixture('orchestrator-planning')),
            'Opus (pending) | high | Orchestrator | Planning (Plan-Execute)');
    });

    it('several Sonnet workers under an Opus orchestrator: Model shows Opus, Agents the workers', () => {
        check('orchestrator with workers', render(LINE, OPUS, fixture('orchestrator-workers')),
            'Opus 5.5 | medium | Orchestrator | Waiting for workers (Parallel) | Implementer ×2 (Sonnet 5.5 medium)');
    });

    it('main model transition: Direct plan-switch hands the lead to Sonnet and names who changed it, then shows the model alone', () => {
        setNow('2026-11-24T10:00:10.000Z');
        check('main model transition', render(LINE, OPUS, fixture('direct-plan-switch')),
            'Sonnet 5.5 (from Opus 5.5 by CC Optimizer) | medium | Direct | Working');

        setNow('2026-11-24T10:01:10.000Z');
        check('main model transition, a minute later', render(LINE, OPUS, fixture('direct-plan-switch')),
            'Sonnet 5.5 | medium | Direct | Working');
    });

    it('a change of effort alone, or by the provider, adds no transition marker', () => {
        setNow('2026-11-24T10:00:12.000Z');
        expect(render(LINE, OPUS, fixture('orchestrator-workers')).startsWith('Opus 5.5 | medium |')).toBe(true);
        expect(render(LINE, OPUS, fixture('substitution')).startsWith('Sonnet 5.5 (asked Opus 5.5) | high')).toBe(true);
    });

    it('a completed worker leaves the active agents; the running one stays', () => {
        check('worker completed', render(LINE, OPUS, fixture('worker-completed')),
            'Opus 5.5 | medium | Orchestrator | Waiting for workers | Implementer 1 (Sonnet 5.5 medium)');
    });

    it('Opus critic reviewing: the lead and the critic each show their own', () => {
        check('critic reviewing', render(LINE, OPUS, fixture('critic-reviewing')),
            'Opus 5.5 | medium | Critic | Reviewing (Review, Refine) | Critic (Opus 5.5 medium)');
    });

    it('viewed agent: Model and Thinking Effort show that agent, never the lead', () => {
        check('viewed agent', render(LINE, OPUS, fixture('viewed-agent')),
            'Implementer 1: Sonnet 5.5 (pending) | medium | Orchestrator | Waiting for workers (Parallel) | Implementer ×2 (Sonnet 5.5 medium)');
    });

    it('back to main after viewing an agent', () => {
        const raw = loadRuntimeFixture('viewed-agent');
        raw.view = { agentId: null, at: '2026-11-24T10:00:12.000Z' };
        check('back to main', render(LINE, OPUS, parse(raw)),
            'Opus 5.5 | medium | Orchestrator | Waiting for workers (Parallel) | Implementer ×2 (Sonnet 5.5 medium)');
    });

    it('substitution: the served model is shown with the requested one', () => {
        check('substitution', render(LINE, OPUS, fixture('substitution')),
            'Sonnet 5.5 (asked Opus 5.5) | high | Orchestrator | Working');
    });

    it('missing runtime renders the payload alone; a stale pending request is marked stale', () => {
        const without = render(LINE, OPUS, null);
        expect(without).toBe('Opus 5.5 | medium');
        expect(render(LINE, OPUS, undefined)).toBe(without);

        setNow('2026-11-24T10:20:00.000Z');
        check('stale pending', render(LINE, SONNET, fixture('orchestrator-planning')),
            'Opus (stale) | high | Orchestrator | Planning (Plan-Execute)');
    });

    it('runtime from another session, an ended session and a malformed file are all "no runtime"', () => {
        const raw = loadRuntimeFixture('orchestrator-workers');

        expect(parseOptimizerRuntime(raw, 'other-session')).toBeNull();
        expect(parseOptimizerRuntime({ ...raw, endedAt: '2026-11-24T10:05:00.000Z' }, 'orchestrator-session')).toBeNull();
        expect(render(LINE, OPUS, parseOptimizerRuntime('garbage', 'orchestrator-session'))).toBe('Opus 5.5 | medium');
    });
});

describe('independent widgets', () => {
    const only = (type: string): WidgetItem[] => [{ id: type, type, rawValue: true }];

    it('each CC Optimizer widget renders alone, and in any order', () => {
        const runtime = fixture('orchestrator-workers');

        expect(render(only('optimizer-workflow'), OPUS, runtime)).toBe('Orchestrator');
        expect(render(only('optimizer-activity'), OPUS, runtime)).toBe('Waiting for workers');
        expect(render([{ id: 'a', type: 'optimizer-activity', rawValue: true, metadata: { strategies: 'active' } }], OPUS, runtime)).toBe('Waiting for workers (Parallel)');
        expect(render(only('optimizer-agents'), OPUS, runtime)).toBe('2');
        expect(render([{ id: 'g', type: 'optimizer-agents', rawValue: true, metadata: { format: 'detailed' } }], OPUS, runtime)).toBe('Implementer ×2 (Sonnet 5.5 medium)');
        expect(render([...LINE].reverse(), OPUS, runtime)).toBe(
            'Implementer ×2 (Sonnet 5.5 medium) | Waiting for workers (Parallel) | Orchestrator | medium | Opus 5.5'
        );
    });

    it('a CC Optimizer widget without a runtime file draws nothing', () => {
        for (const type of ['optimizer-workflow', 'optimizer-activity', 'optimizer-agents']) {
            expect(render(only(type), OPUS, null)).toBe('');
        }
    });
});

describe('existing layouts', () => {
    const OLD_WIDGETS: WidgetItem[] = [
        { id: '1', type: 'custom-text', customText: 'hello' },
        SEPARATOR,
        { id: '2', type: 'version' },
        SEPARATOR,
        { id: '3', type: 'output-style' },
        SEPARATOR,
        { id: '4', type: 'model' },
        SEPARATOR,
        { id: '5', type: 'thinking-effort' }
    ];
    const DATA: StatusJSON = {
        ...OPUS,
        version: '2.3.0',
        output_style: { name: 'explanatory' }
    };

    it('renders byte-identically with and without a runtime file under native execution', () => {
        const without = render(OLD_WIDGETS, DATA);

        expect(without).toContain('Model: Opus 5.5');
        expect(render(OLD_WIDGETS, DATA, null)).toBe(without);
        expect(render(OLD_WIDGETS, DATA, fixture('native-opus-medium'))).toBe(without);
    });

    it('changes only Model and Thinking Effort under optimizer execution', () => {
        const without = render(OLD_WIDGETS, DATA).split(' | ');
        const withRuntime = render(OLD_WIDGETS, DATA, fixture('orchestrator-planning')).split(' | ');

        expect(withRuntime.slice(0, 3)).toEqual(without.slice(0, 3));
        expect(withRuntime.slice(3)).toEqual(['Model: Opus (pending)', 'Thinking: high']);
    });

    it('does not use the runtime when a widget turns runtime awareness off', () => {
        const off: WidgetItem[] = OLD_WIDGETS.map(item => (
            item.type === 'model' || item.type === 'thinking-effort' ? { ...item, metadata: { runtime: 'off' } } : item
        ));

        expect(render(off, DATA, fixture('orchestrator-planning'))).toBe(render(OLD_WIDGETS, DATA));
    });
});

describe('Model and Thinking Effort with the runtime', () => {
    const MODEL: WidgetItem = { id: 'm', type: 'model' };

    it('labels a viewed agent in the Model value', () => {
        expect(render([MODEL], OPUS, fixture('viewed-agent'))).toBe('Model: Implementer 1: Sonnet 5.5 (pending)');
    });

    it('shows no effort of the lead for an agent whose effort is unknown', () => {
        const raw = loadRuntimeFixture('viewed-agent');
        stepOf(agentAt(raw, 0)).requested.effort = null;
        agentAt(raw, 0).authorized = null;
        agentAt(raw, 0).claudeCode = { model: 'claude-sonnet-5-5', effort: null };
        const items: WidgetItem[] = [{ id: 'e', type: 'thinking-effort', rawValue: true }];

        expect(render(items, payload('claude-opus-5-5', 'Opus 5.5', 'max'), parse(raw))).toBe('default');
    });

    it('keeps the payload effort when the lead has none in the runtime', () => {
        const raw = loadRuntimeFixture('orchestrator-workers');
        stepOf(raw.lead).requested.effort = null;
        raw.lead.authorized = null;
        raw.lead.claudeCode = { model: 'claude-opus-5-5', effort: null };
        const items: WidgetItem[] = [{ id: 'e', type: 'thinking-effort', rawValue: true }];

        expect(render(items, payload('claude-opus-5-5', 'Opus 5.5', 'high'), parse(raw))).toBe('high');
    });

    it('keeps the payload model and adds only the pending request when it differs under native execution', () => {
        const raw = loadRuntimeFixture('native-opus-medium');
        raw.lead.step = {
            id: 'turn2:0',
            at: '2026-11-24T10:00:05.000Z',
            requested: { model: 'claude-opus-5-5', effort: 'medium' },
            observed: { model: null, at: null },
            state: 'pending'
        };

        expect(render([MODEL], OPUS, parse(raw))).toBe('Model: Opus 5.5');

        stepOf(raw.lead).requested.model = 'claude-sonnet-5-5';
        expect(render([MODEL], OPUS, parse(raw))).toBe('Model: Sonnet 5.5 (pending)');
    });

    it('marks a lead with no request yet as configured', () => {
        const raw = loadRuntimeFixture('orchestrator-planning');
        raw.lead.step = null;

        expect(render([MODEL], SONNET, parse(raw))).toBe('Model: Opus (configured)');
    });

    it('renders unchanged previews', () => {
        const context: RenderContext = { isPreview: true, optimizerRuntime: fixture('viewed-agent') };

        expect(preRenderAllWidgets([[MODEL]], SETTINGS, context)[0]?.[0]?.content).toBe('Model: Claude');
    });
});

describe('Optimizer widgets', () => {
    const context = (runtime: OptimizerRuntime | null | undefined): RenderContext => ({ isPreview: false, optimizerRuntime: runtime });

    describe('Optimizer Workflow', () => {
        const widget = new OptimizerWorkflowWidget();
        const item: WidgetItem = { id: 'w', type: 'optimizer-workflow' };

        it('is hidden without a runtime and shows native, a methodology or a custom name', () => {
            expect(widget.render(item, context(null), SETTINGS)).toBeNull();
            expect(widget.render(item, context(undefined), SETTINGS)).toBeNull();
            expect(widget.render(item, context(fixture('native-opus-medium')), SETTINGS)).toBe('Workflow: Native');
            expect(widget.render(item, context(fixture('critic-reviewing')), SETTINGS)).toBe('Workflow: Critic');

            const custom = loadRuntimeFixture('orchestrator-workers');
            custom.workflow.name = 'my-team-flow';
            expect(widget.render(item, context(parse(custom)), SETTINGS)).toBe('Workflow: my-team-flow');
        });

        it('marks an automatically picked workflow, unless the marker is turned off', () => {
            const raw = loadRuntimeFixture('orchestrator-workers');
            raw.workflow.source = 'request-auto';
            const runtime = parse(raw);

            expect(widget.render(item, context(runtime), SETTINGS)).toBe('Workflow: Orchestrator (auto)');
            const toggled = widget.handleEditorAction('toggle-auto', item);
            expect(toggled?.metadata).toEqual({ hideAuto: 'true' });
            expect(widget.render(toggled ?? item, context(runtime), SETTINGS)).toBe('Workflow: Orchestrator');
            expect(widget.handleEditorAction('toggle-auto', toggled ?? item)?.metadata).toBeUndefined();
        });

        it('shows Advisor and Agent Teams as operational only once Claude Code observed them', () => {
            const raw = loadRuntimeFixture('orchestrator-workers');
            raw.workflow.name = 'advisor';
            const texts = (state: string) => {
                raw.native.advisor.state = state;
                return widget.render({ ...item, rawValue: true }, context(parse(raw)), SETTINGS);
            };

            expect(texts('observed')).toBe('Advisor');
            expect(texts('requested')).toBe('Advisor (pending reload)');
            expect(texts('off')).toBe('Advisor (inactive)');

            raw.workflow.name = 'agent-teams';
            raw.native.teams.state = 'requested';
            expect(widget.render({ ...item, rawValue: true }, context(parse(raw)), SETTINGS)).toBe('Agent Teams (pending reload)');
        });
    });

    describe('Optimizer Activity', () => {
        const widget = new OptimizerActivityWidget();
        const item: WidgetItem = { id: 'a', type: 'optimizer-activity', rawValue: true };

        it('is hidden without a runtime, under native execution and when idle', () => {
            expect(widget.render(item, context(null), SETTINGS)).toBeNull();
            expect(widget.render(item, context(fixture('native-opus-medium')), SETTINGS)).toBeNull();

            const raw = loadRuntimeFixture('orchestrator-workers');
            raw.activity.stage = 'idle';
            expect(widget.render(item, context(parse(raw)), SETTINGS)).toBeNull();
        });

        it('labels every stage', () => {
            const raw = loadRuntimeFixture('orchestrator-workers');
            const labels = ['planning', 'researching', 'delegating', 'working', 'waiting-for-workers', 'reviewing', 'revising', 'verifying', 'selecting', 'completed', 'failed']
                .map((stage) => {
                    raw.activity.stage = stage;
                    return widget.render(item, context(parse(raw)), SETTINGS);
                });

            expect(labels).toEqual(['Planning', 'Researching', 'Delegating', 'Working', 'Waiting for workers', 'Reviewing', 'Revising', 'Verifying', 'Selecting', 'Completed', 'Failed']);
        });

        it('shows only the stage, only active strategies, or all with the authorized ones in parentheses', () => {
            const runtime = fixture('orchestrator-planning');
            const active = widget.handleEditorAction('cycle-strategies', item);
            const all = widget.handleEditorAction('cycle-strategies', active ?? item);

            expect(widget.render(item, context(runtime), SETTINGS)).toBe('Planning');
            expect(widget.render(active ?? item, context(runtime), SETTINGS)).toBe('Planning (Plan-Execute)');
            expect(widget.render(all ?? item, context(runtime), SETTINGS)).toBe('Planning (Plan-Execute; allowed Parallel, Review)');
            expect(widget.handleEditorAction('cycle-strategies', all ?? item)?.metadata).toBeUndefined();
        });
    });

    describe('Optimizer Agents', () => {
        const widget = new OptimizerAgentsWidget();
        const compact: WidgetItem = { id: 'g', type: 'optimizer-agents' };

        it('is hidden without a runtime and, by default, with no active agents', () => {
            expect(widget.render(compact, context(null), SETTINGS)).toBeNull();
            expect(widget.render(compact, context(fixture('substitution')), SETTINGS)).toBeNull();
            expect(widget.render({ ...compact, metadata: { hide: '' } }, context(fixture('substitution')), SETTINGS)).toBe('0 agents');
        });

        it('counts running and waiting agents, never completed ones', () => {
            expect(widget.render(compact, context(fixture('orchestrator-workers')), SETTINGS)).toBe('2 agents');
            expect(widget.render(compact, context(fixture('critic-reviewing')), SETTINGS)).toBe('1 agent');
            expect(widget.render({ ...compact, rawValue: true }, context(fixture('orchestrator-workers')), SETTINGS)).toBe('2');

            const raw = loadRuntimeFixture('orchestrator-workers');
            agentAt(raw, 0).status = 'waiting';
            agentAt(raw, 1).status = 'canceled';
            expect(widget.render(compact, context(parse(raw)), SETTINGS)).toBe('1 agent');
        });

        it('lists agents with model and effort, limited by the maximum with a +N overflow', () => {
            const raw = loadRuntimeFixture('orchestrator-workers');
            const second = agentAt(raw, 1);
            raw.agents.push({ ...second, id: 'w3', label: 'Analyst', step: { ...stepOf(second), requested: { model: 'opus', effort: 'high' } } });
            const runtime = parse(raw);
            const detailed: WidgetItem = { ...compact, metadata: { format: 'detailed' } };

            expect(widget.render(detailed, context(runtime), SETTINGS)).toBe('Agents: Implementer ×2 (Sonnet 5.5 medium), Analyst (Opus high)');
            expect(widget.render({ ...detailed, metadata: { format: 'detailed', maxItems: '1' } }, context(runtime), SETTINGS))
                .toBe('Agents: Implementer ×2 (Sonnet 5.5 medium) +1');
        });

        it('includes native agents', () => {
            expect(widget.render(compact, context(fixture('native-opus-medium')), SETTINGS)).toBe('1 agent');
            expect(widget.render({ ...compact, metadata: { format: 'detailed' } }, context(fixture('native-opus-medium')), SETTINGS)).toBe('Agents: Find the config');
        });

        it('cycles format and maximum through the editor', () => {
            const detailed = widget.handleEditorAction('cycle-format', compact);
            const four = widget.handleEditorAction('cycle-max-items', detailed ?? compact);

            expect(detailed?.metadata).toEqual({ format: 'detailed' });
            expect(four?.metadata).toEqual({ format: 'detailed', maxItems: '4' });
            expect(widget.handleEditorAction('cycle-format', four ?? compact)?.metadata).toEqual({ maxItems: '4' });
            expect(widget.getCustomKeybinds(compact).map(keybind => keybind.key)).toEqual(['f', 'o']);
            expect(widget.getCustomKeybinds(detailed ?? compact).map(keybind => keybind.key)).toEqual(['f', 'n', 'o']);
        });
    });
});
