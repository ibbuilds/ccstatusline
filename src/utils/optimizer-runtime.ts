import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

import type {
    OptimizerRuntime,
    RuntimeAgent,
    RuntimeAgentStatus,
    RuntimeNativeState,
    RuntimeSetting,
    RuntimeSnapshot,
    RuntimeStep,
    RuntimeStrategy
} from '../types/OptimizerRuntime';

// Optional integration: CC Optimizer writes <state>/<key>.runtime.json for the
// session; the status line only reads it. Every field is tolerated missing or
// malformed so a newer or older writer never breaks rendering.

const STATE_DIR_ENV = 'CC_OPTIMIZER_STATE_DIR';
const STATE_DIR_NAME = 'cc-optimizer';
const KEY_PATTERN = /[^A-Za-z0-9_-]/g;
const KEY_MAX_LENGTH = 80;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const STALE_PENDING_MS = 10 * 60 * 1000;

const nullableString = z.string().nullable().optional().catch(null).transform(value => value ?? null);

const SettingSchema = z.looseObject({
    model: nullableString,
    effort: nullableString
});
const nullableSetting = SettingSchema.nullable().optional().catch(null).transform(value => value ?? null);

const ObservedSchema = z.looseObject({ model: nullableString });

const StepSchema = z.looseObject({
    state: nullableString,
    requested: nullableSetting,
    observed: ObservedSchema.nullable().optional().catch(null)
});

const AgentSchema = z.looseObject({
    id: z.string().min(1),
    label: nullableString,
    role: nullableString,
    kind: nullableString,
    parentId: nullableString,
    status: nullableString,
    claudeCode: nullableSetting,
    authorized: nullableSetting,
    step: StepSchema.nullable().optional().catch(null),
    configured: nullableSetting,
    requested: nullableSetting,
    observed: ObservedSchema.nullable().optional().catch(null)
});

const LeadSchema = z.looseObject({
    claudeCode: nullableSetting,
    authorized: nullableSetting,
    step: StepSchema.nullable().optional().catch(null),
    configured: nullableSetting,
    requested: nullableSetting,
    observed: ObservedSchema.nullable().optional().catch(null)
});

const NativeStateSchema = z.looseObject({ state: nullableString });

const StrategySchema = z.looseObject({
    name: z.string().min(1),
    state: nullableString
});

const RuntimeSchema = z.looseObject({
    version: z.number(),
    session: z.string(),
    updatedAt: nullableString,
    endedAt: nullableString,
    workflow: z.looseObject({
        name: nullableString,
        source: nullableString,
        execution: nullableString,
        pick: nullableString
    }).nullable().optional().catch(null),
    native: z.looseObject({
        advisor: NativeStateSchema.nullable().optional().catch(null),
        teams: NativeStateSchema.nullable().optional().catch(null)
    }).nullable().optional().catch(null),
    activity: z.looseObject({
        stage: nullableString,
        since: nullableString,
        detail: nullableString
    }).nullable().optional().catch(null),
    composition: z.looseObject({
        methodology: nullableString,
        strategies: z.array(z.unknown()).optional().catch([])
    }).nullable().optional().catch(null),
    lead: LeadSchema.nullable().optional().catch(null),
    agents: z.array(z.unknown()).optional().catch([]),
    view: z.looseObject({ agentId: nullableString }).nullable().optional().catch(null)
});

type ParsedSetting = z.infer<typeof SettingSchema> | null;
type ParsedStep = z.infer<typeof StepSchema> | null | undefined;
type ParsedObserved = z.infer<typeof ObservedSchema> | null | undefined;

export function sanitizeSessionKey(sessionId: string): string {
    return sessionId.replace(KEY_PATTERN, '').slice(0, KEY_MAX_LENGTH);
}

export function getOptimizerStateDir(env: Record<string, string | undefined> = process.env): string {
    const configured = env[STATE_DIR_ENV];
    if (configured) {
        return configured;
    }

    return path.join(os.tmpdir(), STATE_DIR_NAME);
}

export function getOptimizerRuntimePath(sessionId: string, env: Record<string, string | undefined> = process.env): string | null {
    const key = sanitizeSessionKey(sessionId);
    return key ? path.join(getOptimizerStateDir(env), `${key}.runtime.json`) : null;
}

function toSetting(value: ParsedSetting | undefined): RuntimeSetting {
    return { model: value?.model ?? null, effort: value?.effort ?? null };
}

function toStep(step: ParsedStep): RuntimeStep | null {
    if (!step) {
        return null;
    }

    const state = step.state === 'pending' ? 'pending' : step.state === 'failed' ? 'failed' : 'answered';
    return {
        state,
        requested: toSetting(step.requested),
        observedModel: step.observed?.model ?? null
    };
}

// Version 1 has no per-request step: its configured / requested / observed
// triple is mapped onto the same shape so one resolver serves both versions.
function fromVersion1(configured: ParsedSetting | undefined, requested: ParsedSetting | undefined, observed: ParsedObserved): RuntimeSnapshot {
    const base = toSetting(configured);
    const asked = toSetting(requested);
    const differs = asked.model !== null || asked.effort !== null;
    const authorized = differs
        ? { model: asked.model ?? base.model, effort: asked.effort ?? base.effort }
        : null;
    const served = observed?.model ?? null;
    const step: RuntimeStep | null = served
        ? {
            state: 'answered',
            requested: { model: asked.model ?? base.model, effort: asked.effort ?? base.effort },
            observedModel: served
        }
        : null;

    return { claudeCode: base, authorized, step };
}

function toSnapshot(
    version: number,
    value: {
        claudeCode?: ParsedSetting;
        authorized?: ParsedSetting;
        step?: ParsedStep;
        configured?: ParsedSetting;
        requested?: ParsedSetting;
        observed?: ParsedObserved;
    } | null | undefined
): RuntimeSnapshot {
    if (!value) {
        return { claudeCode: { model: null, effort: null }, authorized: null, step: null };
    }

    if (version < 2) {
        return fromVersion1(value.configured, value.requested, value.observed);
    }

    return {
        claudeCode: toSetting(value.claudeCode ?? value.configured),
        authorized: value.authorized ? toSetting(value.authorized) : null,
        step: toStep(value.step)
    };
}

function toAgentStatus(value: string | null): RuntimeAgentStatus {
    switch (value) {
        case 'running':
        case 'waiting':
        case 'completed':
        case 'failed':
        case 'canceled':
            return value;
        case 'aborted':
            return 'canceled';
        default:
            return 'unknown';
    }
}

function toNativeState(value: string | null | undefined): RuntimeNativeState {
    return value === 'requested' || value === 'observed' ? value : 'off';
}

function toAgents(version: number, items: unknown[]): RuntimeAgent[] {
    const agents: RuntimeAgent[] = [];
    for (const item of items) {
        const parsed = AgentSchema.safeParse(item);
        if (!parsed.success) {
            continue;
        }

        const agent = parsed.data;
        const v2 = version >= 2;
        agents.push({
            ...toSnapshot(version, agent),
            id: agent.id,
            label: (v2 ? agent.label : null) ?? agent.role ?? agent.id,
            role: agent.role ?? '',
            kind: v2 && agent.kind === 'native' ? 'native' : 'optimizer',
            parentId: v2 ? agent.parentId : null,
            status: toAgentStatus(agent.status)
        });
    }
    return agents;
}

function toStrategies(items: unknown[]): RuntimeStrategy[] {
    const strategies: RuntimeStrategy[] = [];
    for (const item of items) {
        const parsed = StrategySchema.safeParse(item);
        if (parsed.success) {
            strategies.push({ name: parsed.data.name, state: parsed.data.state === 'active' ? 'active' : 'authorized' });
        }
    }
    return strategies;
}

/**
 * Validates a parsed runtime document against the session. Returns null when it
 * is not usable (wrong shape, other session, ended session), so callers behave
 * exactly as without CC Optimizer.
 */
export function parseOptimizerRuntime(raw: unknown, sessionId: string | undefined): OptimizerRuntime | null {
    const key = sessionId ? sanitizeSessionKey(sessionId) : '';
    if (!key) {
        return null;
    }

    const parsed = RuntimeSchema.safeParse(raw);
    if (!parsed.success) {
        return null;
    }

    const data = parsed.data;
    if (data.version < 1 || sanitizeSessionKey(data.session) !== key || data.endedAt) {
        return null;
    }

    // Written versions above 2 are read through the fields version 2 defines
    const version = data.version >= 2 ? 2 : 1;
    const execution = data.workflow?.execution === 'optimizer' ? 'optimizer' : 'native';
    const activityStage = data.activity?.stage ?? null;
    const view = version >= 2 && data.view ? { agentId: data.view.agentId } : null;
    const composition = data.composition
        ? {
            methodology: data.composition.methodology,
            strategies: toStrategies(data.composition.strategies ?? [])
        }
        : null;

    return {
        version,
        session: data.session,
        updatedAt: data.updatedAt,
        workflow: data.workflow?.name
            ? { name: data.workflow.name, source: data.workflow.source, execution, pick: data.workflow.pick }
            : null,
        native: {
            advisor: toNativeState(data.native?.advisor?.state),
            teams: toNativeState(data.native?.teams?.state)
        },
        activity: version >= 2 && data.activity && activityStage
            ? { stage: activityStage, since: data.activity.since, detail: data.activity.detail }
            : null,
        composition,
        lead: toSnapshot(version, data.lead),
        agents: toAgents(version, data.agents ?? []),
        view
    };
}

export interface OptimizerRuntimeReadOptions {
    env?: Record<string, string | undefined>;
    readFile?: (filePath: string) => string | null;
}

function readTextFile(filePath: string): string | null {
    try {
        if (fs.statSync(filePath).size > MAX_FILE_BYTES) {
            return null;
        }
        return fs.readFileSync(filePath, 'utf8');
    } catch {
        return null;
    }
}

/**
 * Reads CC Optimizer's runtime file for the session. The writer rewrites the
 * file in place, so a read that fails to parse is "unavailable", never empty.
 */
export function readOptimizerRuntime(sessionId: string | undefined, options: OptimizerRuntimeReadOptions = {}): OptimizerRuntime | null {
    if (!sessionId) {
        return null;
    }

    const filePath = getOptimizerRuntimePath(sessionId, options.env);
    if (!filePath) {
        return null;
    }

    const text = (options.readFile ?? readTextFile)(filePath);
    if (!text) {
        return null;
    }

    try {
        return parseOptimizerRuntime(JSON.parse(text), sessionId);
    } catch {
        return null;
    }
}

export interface ResolvedContext {
    kind: 'main' | 'agent';
    agent: RuntimeAgent | null;
    label: string | null;
    // Main conversation under native execution: Claude Code's own payload is authoritative
    nativeMain: boolean;
    model: string | null;
    requestedModel: string | null;
    effort: string | null;
    pending: boolean;
    stale: boolean;
    answered: boolean;
    substitution: boolean;
    // No request seen yet: the model is what the configuration authorizes
    configured: boolean;
}

export interface ResolveOptions { now?: number }

const MODEL_ID_PATTERN = /^(?:claude-)?(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[[^\]]*\])?$/;
const LEGACY_MODEL_ID_PATTERN = /^claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)(?:-\d{8})?(?:\[[^\]]*\])?$/;
const ALIAS_PATTERN = /^(opus|sonnet|haiku|fable)(?:\[[^\]]*\])?$/;

function capitalize(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}

function joinVersion(major: string | undefined, minor: string | undefined): string {
    return minor ? `${major}.${minor}` : `${major}`;
}

/** claude-opus-5-5 becomes Opus 5.5 and the aliases opus / sonnet / haiku become Opus / Sonnet / Haiku; other ids stay as written minus a [1m] style suffix. */
export function formatModelName(id: string): string {
    const trimmed = id.trim();
    const lower = trimmed.toLowerCase();

    const alias = ALIAS_PATTERN.exec(lower)?.[1];
    if (alias) {
        return capitalize(alias);
    }

    const current = MODEL_ID_PATTERN.exec(lower);
    if (current?.[1]) {
        return `${capitalize(current[1])} ${joinVersion(current[2], current[3])}`;
    }

    const legacy = LEGACY_MODEL_ID_PATTERN.exec(lower);
    if (legacy?.[3]) {
        return `${capitalize(legacy[3])} ${joinVersion(legacy[1], legacy[2])}`;
    }

    return trimmed.replace(/\s*\[[^\]]*\]$/, '');
}

function modelFamily(id: string): string | null {
    const lower = id.trim().toLowerCase();
    return ALIAS_PATTERN.exec(lower)?.[1]
        ?? MODEL_ID_PATTERN.exec(lower)?.[1]
        ?? LEGACY_MODEL_ID_PATTERN.exec(lower)?.[3]
        ?? null;
}

/** True when two ids name the same model; an alias matches any model of its family. */
export function isSameModel(a: string, b: string): boolean {
    const nameA = formatModelName(a).toLowerCase();
    const nameB = formatModelName(b).toLowerCase();
    if (nameA === nameB) {
        return true;
    }

    const familyA = modelFamily(a);
    const eitherAlias = ALIAS_PATTERN.test(a.trim().toLowerCase()) || ALIAS_PATTERN.test(b.trim().toLowerCase());
    return eitherAlias && familyA !== null && familyA === modelFamily(b);
}

function isStale(runtime: OptimizerRuntime, now: number): boolean {
    if (!runtime.updatedAt) {
        return false;
    }

    const updated = Date.parse(runtime.updatedAt);
    return Number.isFinite(updated) && now - updated > STALE_PENDING_MS;
}

function resolveSnapshot(snapshot: RuntimeSnapshot, runtime: OptimizerRuntime, now: number): Pick<ResolvedContext, 'model' | 'requestedModel' | 'effort' | 'pending' | 'stale' | 'answered' | 'substitution' | 'configured'> {
    const { claudeCode, authorized, step } = snapshot;
    const fallbackModel = authorized?.model ?? claudeCode.model;
    const requestedModel = step?.requested.model ?? fallbackModel;
    const effort = step?.requested.effort ?? authorized?.effort ?? claudeCode.effort;
    const pending = step?.state === 'pending';
    const answered = step?.state === 'answered';
    const observed = step?.state === 'answered' ? step.observedModel : null;
    const model = pending ? requestedModel : (observed ?? requestedModel);
    const substitution = Boolean(observed && requestedModel && !isSameModel(observed, requestedModel));

    return {
        model,
        requestedModel,
        effort,
        pending,
        stale: pending && isStale(runtime, now),
        answered,
        substitution,
        configured: step === null
    };
}

export function resolveAgent(runtime: OptimizerRuntime, agent: RuntimeAgent, options: ResolveOptions = {}): ResolvedContext {
    return {
        kind: 'agent',
        agent,
        label: agent.label,
        nativeMain: false,
        ...resolveSnapshot(agent, runtime, options.now ?? Date.now())
    };
}

/** The context on screen: the agent named by view.agentId, else the main conversation. Never inferred from agent activity. */
export function resolveContext(runtime: OptimizerRuntime, options: ResolveOptions = {}): ResolvedContext {
    const viewed = runtime.view?.agentId;
    const agent = viewed ? runtime.agents.find(candidate => candidate.id === viewed) : undefined;
    if (agent) {
        return resolveAgent(runtime, agent, options);
    }

    return {
        kind: 'main',
        agent: null,
        label: null,
        nativeMain: runtime.workflow?.execution !== 'optimizer',
        ...resolveSnapshot(runtime.lead, runtime, options.now ?? Date.now())
    };
}

export function isAgentActive(agent: RuntimeAgent): boolean {
    return agent.status === 'running' || agent.status === 'waiting';
}

export function getActiveAgents(runtime: OptimizerRuntime): RuntimeAgent[] {
    return runtime.agents.filter(isAgentActive);
}

const METHOD_LABELS: Record<string, string> = {
    'direct': 'Direct',
    'orchestrator': 'Orchestrator',
    'advisor': 'Advisor',
    'critic': 'Critic',
    'best-of-n': 'Best-of-N',
    'agent-teams': 'Agent Teams'
};

export function getMethodLabel(name: string): string | null {
    return METHOD_LABELS[name.toLowerCase()] ?? null;
}

const ACTIVITY_LABELS: Record<string, string> = {
    'planning': 'Planning',
    'researching': 'Researching',
    'delegating': 'Delegating',
    'working': 'Working',
    'waiting-for-workers': 'Waiting for workers',
    'reviewing': 'Reviewing',
    'revising': 'Revising',
    'verifying': 'Verifying',
    'selecting': 'Selecting',
    'completed': 'Completed',
    'failed': 'Failed'
};

/** The stage label, or null for idle and unknown stages. */
export function getActivityLabel(stage: string): string | null {
    return ACTIVITY_LABELS[stage] ?? null;
}

const STRATEGY_LABELS: Record<string, string> = {
    'plan-execute': 'Plan–Execute',
    'plan-switch': 'Plan–Switch',
    'research-first': 'Research-first',
    'tdd': 'TDD',
    'spec-driven': 'Spec-driven',
    'incremental': 'Incremental',
    'parallel': 'Parallel',
    'independent-review': 'Independent review',
    'iterative-refinement': 'Iterative refinement',
    'verification-gates': 'Verification gates',
    'retry-escalation': 'Retry and escalation',
    'context-isolation': 'Context isolation',
    'worktree-isolation': 'Worktree isolation',
    'context-management': 'Context management'
};

export function getStrategyLabel(name: string): string {
    return STRATEGY_LABELS[name]
        ?? capitalize(name.replace(/[-_]+/g, ' ').trim());
}

/** Workflow automatically picked rather than chosen by the user or the configuration. */
export function isAutomaticWorkflow(workflow: NonNullable<OptimizerRuntime['workflow']>): boolean {
    return /auto/i.test(workflow.source ?? '');
}
