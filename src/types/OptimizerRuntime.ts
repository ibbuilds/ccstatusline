export interface RuntimeSetting {
    model: string | null;
    effort: string | null;
}

export interface RuntimeStep {
    state: 'pending' | 'answered' | 'failed';
    requested: RuntimeSetting;
    observedModel: string | null;
}

// What one loop (the main conversation or one agent) runs on, as the status
// line needs it: Claude Code's own setting, what the configuration authorizes
// and the latest request.
export interface RuntimeSnapshot {
    claudeCode: RuntimeSetting;
    authorized: RuntimeSetting | null;
    step: RuntimeStep | null;
}

export type RuntimeAgentStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'canceled' | 'unknown';

export interface RuntimeAgent extends RuntimeSnapshot {
    id: string;
    label: string;
    role: string;
    kind: 'optimizer' | 'native';
    parentId: string | null;
    status: RuntimeAgentStatus;
}

export type RuntimeNativeState = 'off' | 'requested' | 'observed';

export interface RuntimeStrategy {
    name: string;
    state: 'authorized' | 'active';
}

export interface OptimizerRuntime {
    version: number;
    session: string;
    updatedAt: string | null;
    workflow: {
        name: string;
        source: string | null;
        execution: 'native' | 'optimizer';
        pick: string | null;
    } | null;
    native: { advisor: RuntimeNativeState; teams: RuntimeNativeState };
    activity: { stage: string; since: string | null; detail: string | null } | null;
    composition: { methodology: string | null; strategies: RuntimeStrategy[] } | null;
    lead: RuntimeSnapshot;
    agents: RuntimeAgent[];
    view: { agentId: string | null } | null;
}
