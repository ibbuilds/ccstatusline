import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'optimizer-runtime-v2');

interface FixtureSetting {
    model: string | null;
    effort: string | null;
}

interface FixtureStep {
    id: string;
    at: string;
    requested: FixtureSetting;
    observed: { model: string | null; at: string | null };
    state: string;
}

interface FixtureSnapshot {
    claudeCode: FixtureSetting;
    authorized: FixtureSetting | null;
    step: FixtureStep | null;
}

interface FixtureAgent extends FixtureSnapshot {
    id: string;
    label: string;
    status: string;
    [key: string]: unknown;
}

// The fields the tests change; the rest of the file passes through untouched
export interface RuntimeFixture {
    version: number;
    session: string;
    updatedAt: string;
    endedAt: string | null;
    workflow: { name: string; source: string; execution: string; [key: string]: unknown };
    lead: FixtureSnapshot & Record<string, unknown>;
    agents: FixtureAgent[];
    view: { agentId: string | null; at: string } | null;
    activity: { stage: string; since: string; detail: string | null };
    composition: { methodology: string | null; strategies: { name: string; support: string; state: string }[]; alias: string | null } | null;
    native: { advisor: { state: string }; teams: { state: string } };
    [key: string]: unknown;
}

// Representative runtime files written by CC Optimizer (contract version 2)
export function loadRuntimeFixture(name: string): RuntimeFixture {
    return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8')) as RuntimeFixture;
}

export function must<T>(value: T | null | undefined): T {
    if (value === null || value === undefined) {
        throw new Error('expected a value');
    }
    return value;
}

export function agentAt(fixture: RuntimeFixture, index: number): FixtureAgent {
    return must(fixture.agents[index]);
}

export function stepOf(snapshot: FixtureSnapshot): FixtureStep {
    return must(snapshot.step);
}
