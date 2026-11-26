import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it
} from 'vitest';

import {
    STALE_PENDING_MS,
    formatModelName,
    getActiveAgents,
    getOptimizerRuntimePath,
    getOptimizerStateDir,
    isSameModel,
    parseOptimizerRuntime,
    readOptimizerRuntime,
    resolveContext
} from '../optimizer-runtime';

import {
    agentAt,
    loadRuntimeFixture,
    must,
    stepOf
} from './optimizer-runtime-fixtures';

function parseFixture(name: string) {
    const raw = loadRuntimeFixture(name);
    return must(parseOptimizerRuntime(raw, raw.session));
}

describe('optimizer runtime reader', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-runtime-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function write(session: string, content: unknown): void {
        fs.writeFileSync(path.join(dir, `${session}.runtime.json`), typeof content === 'string' ? content : JSON.stringify(content));
    }

    const env = () => ({ CC_OPTIMIZER_STATE_DIR: dir });

    it('resolves the state dir from the environment, else the temp dir', () => {
        expect(getOptimizerStateDir({ CC_OPTIMIZER_STATE_DIR: '/x/state' })).toBe('/x/state');
        expect(getOptimizerStateDir({})).toBe(path.join(os.tmpdir(), 'cc-optimizer'));
    });

    it('keys the file by the session id without characters outside [A-Za-z0-9_-], first 80', () => {
        expect(path.basename(getOptimizerRuntimePath('a/b..c d_e-f', {}) ?? '')).toBe('abcd_e-f.runtime.json');
        expect(path.basename(getOptimizerRuntimePath('x'.repeat(100), {}) ?? '')).toBe(`${'x'.repeat(80)}.runtime.json`);
        expect(getOptimizerRuntimePath('///', {})).toBeNull();
    });

    it('returns null when the file is missing or there is no session id', () => {
        expect(readOptimizerRuntime('nope', { env: env() })).toBeNull();
        expect(readOptimizerRuntime(undefined, { env: env() })).toBeNull();
        expect(readOptimizerRuntime('', { env: env() })).toBeNull();
    });

    it('returns null for malformed or truncated JSON and for non-runtime shapes', () => {
        write('s1', '{"version":2,"session":"s1"');
        write('s2', '[]');
        write('s3', { hello: 'world' });
        expect(readOptimizerRuntime('s1', { env: env() })).toBeNull();
        expect(readOptimizerRuntime('s2', { env: env() })).toBeNull();
        expect(readOptimizerRuntime('s3', { env: env() })).toBeNull();
    });

    it('returns null when the file belongs to another session', () => {
        write('mine', { ...loadRuntimeFixture('native-opus-medium'), session: 'someone-else' });
        expect(readOptimizerRuntime('mine', { env: env() })).toBeNull();
    });

    it('returns null once the session has ended', () => {
        write('native-session', { ...loadRuntimeFixture('native-opus-medium'), endedAt: '2026-11-24T11:00:00.000Z' });
        expect(readOptimizerRuntime('native-session', { env: env() })).toBeNull();
    });

    it('reads a version 2 file', () => {
        write('orchestrator-session', loadRuntimeFixture('orchestrator-workers'));
        const runtime = readOptimizerRuntime('orchestrator-session', { env: env() });

        expect(runtime?.version).toBe(2);
        expect(runtime?.workflow).toMatchObject({ name: 'orchestrator', execution: 'optimizer' });
        expect(runtime?.activity?.stage).toBe('waiting-for-workers');
        expect(runtime?.agents.map(agent => agent.label)).toEqual(['Implementer 1', 'Implementer 2']);
    });

    it('reads version 1 through its v1 fields only', () => {
        const v1 = {
            version: 1,
            session: 'v1-session',
            updatedAt: '2026-11-24T10:00:00.000Z',
            endedAt: null,
            workflow: { name: 'orchestrator', source: 'config', why: 'configured', execution: 'optimizer', pick: null },
            lead: {
                configured: { model: 'claude-sonnet-5-5', effort: 'medium' },
                requested: { model: 'claude-opus-5-5', effort: 'high' },
                observed: { model: 'claude-opus-5-5', at: '2026-11-24T10:00:00.000Z' },
                // v2 fields in a v1 file are ignored
                view: { agentId: 'w1' },
                step: { state: 'pending', requested: { model: 'ignored', effort: null } }
            },
            view: { agentId: 'w1' },
            activity: { stage: 'working' },
            agents: [{
                id: 'w1',
                role: 'worker',
                status: 'aborted',
                configured: { model: 'claude-sonnet-5-5', effort: 'medium' },
                requested: { model: null, effort: null },
                observed: { model: 'claude-sonnet-5-5', at: null }
            }],
            composition: { methodology: 'orchestrator', strategies: [{ name: 'parallel', support: 'guided' }], alias: null }
        };
        const runtime = parseOptimizerRuntime(v1, 'v1-session');

        expect(runtime?.version).toBe(1);
        expect(runtime?.view).toBeNull();
        expect(runtime?.activity).toBeNull();
        expect(runtime?.agents[0]).toMatchObject({ label: 'worker', kind: 'optimizer', status: 'canceled' });
        expect(runtime?.composition?.strategies).toEqual([{ name: 'parallel', state: 'authorized' }]);

        const lead = resolveContext(must(runtime));
        expect(lead).toMatchObject({ kind: 'main', model: 'claude-opus-5-5', effort: 'high', pending: false });
    });

    it('reads the known fields of a future version and ignores the rest', () => {
        const future = { ...loadRuntimeFixture('viewed-agent'), version: 7, brandNew: { anything: true } };
        const runtime = parseOptimizerRuntime(future, 'orchestrator-session');

        expect(runtime?.version).toBe(2);
        expect(resolveContext(must(runtime))).toMatchObject({ kind: 'agent', label: 'Implementer 1' });
    });

    it('rejects version 0 and a non-numeric version', () => {
        expect(parseOptimizerRuntime({ ...loadRuntimeFixture('native-opus-medium'), version: 0 }, 'native-session')).toBeNull();
        expect(parseOptimizerRuntime({ ...loadRuntimeFixture('native-opus-medium'), version: '2' }, 'native-session')).toBeNull();
    });

    it('drops malformed agents and tolerates malformed optional fields', () => {
        const raw = {
            ...loadRuntimeFixture('orchestrator-workers'),
            agents: [{ nope: true }, 'text', ...loadRuntimeFixture('orchestrator-workers').agents],
            composition: 'bad',
            activity: 12
        };
        const runtime = parseOptimizerRuntime(raw, 'orchestrator-session');

        expect(runtime?.agents).toHaveLength(2);
        expect(runtime?.composition).toBeNull();
        expect(runtime?.activity).toBeNull();
    });
});

describe('model names', () => {
    it('prettifies ids and aliases', () => {
        expect(formatModelName('claude-opus-5-5')).toBe('Opus 5.5');
        expect(formatModelName('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
        expect(formatModelName('claude-opus-4-6[1m]')).toBe('Opus 4.6');
        expect(formatModelName('claude-opus-5')).toBe('Opus 5');
        expect(formatModelName('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5');
        expect(formatModelName('opus')).toBe('Opus');
        expect(formatModelName('sonnet')).toBe('Sonnet');
        expect(formatModelName('haiku')).toBe('Haiku');
        expect(formatModelName('some-other-model[1m]')).toBe('some-other-model');
    });

    it('treats an alias as the same model as any model of its family', () => {
        expect(isSameModel('opus', 'claude-opus-5-5')).toBe(true);
        expect(isSameModel('claude-sonnet-5-5', 'claude-sonnet-5-5-20260101')).toBe(true);
        expect(isSameModel('opus', 'claude-sonnet-5-5')).toBe(false);
        expect(isSameModel('claude-opus-5-5', 'claude-opus-4-6')).toBe(false);
    });
});

describe('resolveContext', () => {
    const NOW = Date.parse('2026-11-24T10:00:30.000Z');

    it('uses the main conversation when no view was observed', () => {
        const runtime = parseFixture('orchestrator-workers');

        expect(runtime.view).toBeNull();
        expect(resolveContext(runtime, { now: NOW })).toMatchObject({
            kind: 'main',
            nativeMain: false,
            model: 'claude-opus-5-5',
            effort: 'medium',
            answered: true,
            pending: false,
            substitution: false
        });
    });

    it('uses the viewed agent, with its own model, effort and step', () => {
        const runtime = parseFixture('viewed-agent');
        const resolved = resolveContext(runtime, { now: NOW });

        expect(resolved).toMatchObject({
            kind: 'agent',
            label: 'Implementer 1',
            model: 'claude-sonnet-5-5',
            effort: 'medium',
            pending: true
        });
    });

    it('returns to the main conversation when the view is cleared or names no agent', () => {
        const raw = loadRuntimeFixture('viewed-agent');
        const cleared = must(parseOptimizerRuntime({ ...raw, view: { agentId: null, at: must(raw.view).at } }, 'orchestrator-session'));
        const unknown = must(parseOptimizerRuntime({ ...raw, view: { agentId: 'gone', at: must(raw.view).at } }, 'orchestrator-session'));

        expect(resolveContext(cleared, { now: NOW })).toMatchObject({ kind: 'main', model: 'claude-opus-5-5' });
        expect(resolveContext(unknown, { now: NOW })).toMatchObject({ kind: 'main', model: 'claude-opus-5-5' });
    });

    it('never picks an agent by activity: the view alone decides', () => {
        const runtime = parseFixture('orchestrator-workers');
        const newest = [...runtime.agents].sort((a, b) => b.id.localeCompare(a.id))[0];

        expect(newest?.status).toBe('running');
        expect(resolveContext(runtime, { now: NOW }).kind).toBe('main');
    });

    it('shows the requested model of a pending request, marked pending', () => {
        const runtime = parseFixture('orchestrator-planning');

        expect(resolveContext(runtime, { now: Date.parse('2026-11-24T10:00:05.000Z') })).toMatchObject({
            kind: 'main',
            model: 'opus',
            effort: 'high',
            pending: true,
            stale: false
        });
    });

    it('marks a pending request stale after ten minutes without an update, and keeps the agents', () => {
        const runtime = parseFixture('orchestrator-workers');
        const updated = Date.parse(must(runtime.updatedAt));
        const w1 = must(runtime.agents[0]);

        expect(resolveContext({ ...runtime, view: { agentId: w1.id } }, { now: updated + STALE_PENDING_MS - 1 }).stale).toBe(false);
        expect(resolveContext({ ...runtime, view: { agentId: w1.id } }, { now: updated + STALE_PENDING_MS + 1 })).toMatchObject({ pending: true, stale: true });
        expect(getActiveAgents(runtime)).toHaveLength(2);
    });

    it('reports a substitution when the provider served another model than requested', () => {
        const runtime = parseFixture('substitution');

        expect(resolveContext(runtime, { now: NOW })).toMatchObject({
            model: 'claude-sonnet-5-5',
            requestedModel: 'claude-opus-5-5',
            answered: true,
            substitution: true,
            effort: 'high'
        });
    });

    it('does not report a substitution for an alias that matches the served model', () => {
        const raw = loadRuntimeFixture('substitution');
        stepOf(raw.lead).requested.model = 'sonnet';
        const runtime = must(parseOptimizerRuntime(raw, 'substitution-session'));

        expect(resolveContext(runtime, { now: NOW }).substitution).toBe(false);
    });

    it('falls back to the authorized, then Claude Code, model and marks it configured when there is no step', () => {
        const raw = loadRuntimeFixture('orchestrator-planning');
        raw.lead.step = null;
        const withAuthorized = must(parseOptimizerRuntime(raw, 'orchestrator-session'));
        raw.lead.authorized = null;
        const withoutAuthorized = must(parseOptimizerRuntime(raw, 'orchestrator-session'));

        expect(resolveContext(withAuthorized, { now: NOW })).toMatchObject({ model: 'opus', effort: 'high', configured: true, pending: false });
        expect(resolveContext(withoutAuthorized, { now: NOW })).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium', configured: true });
    });

    it('keeps concurrent agents on their own model and effort', () => {
        const raw = loadRuntimeFixture('orchestrator-workers');
        stepOf(agentAt(raw, 1)).requested = { model: 'claude-haiku-5', effort: 'low' };
        agentAt(raw, 1).authorized = { model: 'claude-haiku-5', effort: 'low' };
        const runtime = must(parseOptimizerRuntime(raw, 'orchestrator-session'));
        const view = (agentId: string) => resolveContext({ ...runtime, view: { agentId } }, { now: NOW });

        expect(view('w1')).toMatchObject({ label: 'Implementer 1', model: 'claude-sonnet-5-5', effort: 'medium' });
        expect(view('w2')).toMatchObject({ label: 'Implementer 2', model: 'claude-haiku-5', effort: 'low' });
        expect(resolveContext(runtime, { now: NOW })).toMatchObject({ kind: 'main', model: 'claude-opus-5-5', effort: 'medium' });
    });

    it('marks the main conversation native unless the optimizer runs the workflow', () => {
        expect(resolveContext(parseFixture('native-opus-medium'), { now: NOW }).nativeMain).toBe(true);
        expect(resolveContext(parseFixture('critic-reviewing'), { now: NOW }).nativeMain).toBe(false);
    });

    it('counts only running and waiting agents as active', () => {
        const runtime = parseFixture('critic-reviewing');

        expect(runtime.agents.map(agent => agent.status)).toEqual(['completed', 'running']);
        expect(getActiveAgents(runtime).map(agent => agent.label)).toEqual(['Critic']);
    });

    it('includes native agents', () => {
        const runtime = parseFixture('native-opus-medium');

        expect(getActiveAgents(runtime).map(agent => agent.kind)).toContain('native');
    });

    it('reports a recent lead model change with its source, for a minute', () => {
        const runtime = parseFixture('direct-plan-switch');
        const at = Date.parse('2026-11-24T10:00:03.000Z');

        expect(resolveContext(runtime, { now: at + 5_000 }).change).toEqual({ from: 'claude-opus-5-5', source: 'CC Optimizer' });
        expect(resolveContext(runtime, { now: at + 61_000 }).change).toBeNull();
    });

    it('keeps a model change on its own loop: an agent change never marks the lead, and the reverse', () => {
        const raw = loadRuntimeFixture('viewed-agent');
        const change = { at: '2026-11-24T10:00:09.000Z', agent: 'w1', role: 'implementer', from: 'claude-opus-5-5', to: 'claude-sonnet-5-5', source: 'policy', reason: 'r' };
        const runtime = must(parseOptimizerRuntime({ ...raw, modelChanges: [change] }, raw.session));

        expect(resolveContext(runtime, { now: NOW }).change).toEqual({ from: 'claude-opus-5-5', source: 'CC Optimizer' });
        const main = must(parseOptimizerRuntime({ ...raw, view: null, modelChanges: [change] }, raw.session));
        expect(resolveContext(main, { now: NOW }).change).toBeNull();
    });

    it('ignores a change whose target is not the model shown, and malformed change entries', () => {
        const raw = loadRuntimeFixture('direct-plan-switch');
        const runtime = must(parseOptimizerRuntime({
            ...raw,
            modelChanges: [{ agent: 'lead' }, 'x', { at: '2026-11-24T10:00:03.000Z', agent: 'lead', from: 'claude-sonnet-5-5', to: 'claude-opus-5-5', source: 'you' }]
        }, raw.session));

        expect(runtime.modelChanges).toHaveLength(1);
        expect(resolveContext(runtime, { now: Date.parse('2026-11-24T10:00:05.000Z') }).change).toBeNull();
    });
});
