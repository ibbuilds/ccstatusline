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
    accumulateMcpSessionRecord,
    createMcpSessionState,
    getMcpStatus,
    normalizeMcpServerName,
    readMcpConfig,
    resolveMcpStatus,
    type McpConfigServer,
    type McpSessionState
} from '../mcp-status';

function toolsDelta(added: string[], removed: string[] = [], extra: Record<string, unknown> = {}): unknown {
    return { type: 'attachment', attachment: { type: 'deferred_tools_delta', addedNames: added, removedNames: removed }, ...extra };
}

function instructionsDelta(added: string[], removed: string[] = []): unknown {
    return { type: 'attachment', attachment: { type: 'mcp_instructions_delta', addedNames: added, addedBlocks: [], removedNames: removed } };
}

function session(...records: unknown[]): McpSessionState {
    const state = createMcpSessionState();
    for (const record of records) {
        accumulateMcpSessionRecord(state, record);
    }
    return state;
}

function states(config: McpConfigServer[], sessionState: McpSessionState | null): Record<string, string> {
    return Object.fromEntries(resolveMcpStatus(config, sessionState).servers.map(server => [server.name, server.state]));
}

describe('normalizeMcpServerName', () => {
    it('replaces characters Claude Code does not allow in tool names', () => {
        expect(normalizeMcpServerName('claude.ai Google Drive')).toBe('claude_ai_Google_Drive');
        expect(normalizeMcpServerName('my-server_1')).toBe('my-server_1');
    });
});

describe('MCP session state from transcript records', () => {
    it('reports nothing observed for a transcript without MCP records', () => {
        const result = resolveMcpStatus([], session({ type: 'user', message: { content: 'hi' } }));
        expect(result.servers).toEqual([]);
        expect(result.sessionObserved).toBe(false);
    });

    it('marks a server connected when its tools reached the session', () => {
        expect(states([], session(toolsDelta(['Read', 'mcp__context7__query-docs'])))).toEqual({ context7: 'connected' });
    });

    it('marks several servers connected', () => {
        const result = states([], session(toolsDelta(['mcp__context7__a', 'mcp__deepwiki__b', 'mcp__deepwiki__c'])));
        expect(result).toEqual({ context7: 'connected', deepwiki: 'connected' });
    });

    it('marks a server whose only tools are authenticate tools as needing authentication', () => {
        const result = states([], session(toolsDelta([
            'mcp__claude_ai_Gmail__authenticate',
            'mcp__claude_ai_Gmail__complete_authentication'
        ])));
        expect(result).toEqual({ 'claude.ai Gmail': 'needs-auth' });
    });

    it('uses the raw name announced with server instructions for display', () => {
        const result = states([], session(
            instructionsDelta(['claude.ai Claude Docs']),
            toolsDelta(['mcp__claude_ai_Claude_Docs__read'])
        ));
        expect(result).toEqual({ 'claude.ai Claude Docs': 'connected' });
    });

    it('drops a server when all its tools are removed later in the session', () => {
        const config: McpConfigServer[] = [{ name: 'figma', scope: 'user' }];
        const result = states(config, session(
            toolsDelta(['mcp__figma__get', 'mcp__figma__put']),
            toolsDelta([], ['mcp__figma__get', 'mcp__figma__put'])
        ));
        expect(result).toEqual({ figma: 'not-connected' });
    });

    it('ignores sidechain records', () => {
        const result = resolveMcpStatus([], session(toolsDelta(['mcp__x__y'], [], { isSidechain: true })));
        expect(result.servers).toEqual([]);
        expect(result.sessionObserved).toBe(false);
    });

    it('ignores malformed records', () => {
        const state = session(
            null,
            42,
            'text',
            { type: 'attachment' },
            { type: 'attachment', attachment: { type: 'deferred_tools_delta', addedNames: 'mcp__a__b' } },
            { type: 'attachment', attachment: { type: 'deferred_tools_delta', addedNames: [7, null, 'mcp__', 'mcp____x'] } }
        );
        expect(resolveMcpStatus([], state).servers).toEqual([]);
    });

    it('matches a configured name containing a double underscore', () => {
        const config: McpConfigServer[] = [{ name: 'acme__corp', scope: 'user' }];
        expect(states(config, session(toolsDelta(['mcp__acme__corp__search'])))).toEqual({ acme__corp: 'connected' });
    });
});

describe('resolveMcpStatus with configuration', () => {
    it('reports configured servers as configured when the session has not reported tools yet', () => {
        const config: McpConfigServer[] = [{ name: 'github', scope: 'user' }];
        const result = resolveMcpStatus(config, null);
        expect(result.sessionObserved).toBe(false);
        expect(result.servers).toEqual([{ name: 'github', state: 'configured', scope: 'user' }]);
    });

    it('does not call a server disconnected from instructions alone', () => {
        const config: McpConfigServer[] = [{ name: 'github', scope: 'user' }, { name: 'context7', scope: 'user' }];
        expect(states(config, session(instructionsDelta(['context7'])))).toEqual({ context7: 'connected', github: 'configured' });
    });

    it('marks a configured server absent from an observed session as not connected', () => {
        const config: McpConfigServer[] = [{ name: 'github', scope: 'user' }, { name: 'context7', scope: 'user' }];
        expect(states(config, session(toolsDelta(['mcp__context7__q'])))).toEqual({ context7: 'connected', github: 'not-connected' });
    });

    it('keeps the configuration state of disabled, pending and blocked servers', () => {
        const config: McpConfigServer[] = [
            { name: 'off', scope: 'user', state: 'disabled' },
            { name: 'new', scope: 'project', state: 'pending-approval' },
            { name: 'bad', scope: 'user', state: 'blocked' }
        ];
        expect(states(config, session(toolsDelta(['mcp__other__x'])))).toEqual({
            bad: 'blocked',
            new: 'pending-approval',
            off: 'disabled',
            other: 'connected'
        });
    });

    it('trusts the session over configuration when a server is actually connected', () => {
        const config: McpConfigServer[] = [{ name: 'new', scope: 'project', state: 'pending-approval' }];
        expect(states(config, session(toolsDelta(['mcp__new__x'])))).toEqual({ new: 'connected' });
    });

    it('sorts servers by name', () => {
        const result = resolveMcpStatus([], session(toolsDelta(['mcp__zeta__a', 'mcp__Alpha__a', 'mcp__beta__a'])));
        expect(result.servers.map(server => server.name)).toEqual(['Alpha', 'beta', 'zeta']);
    });
});

describe('readMcpConfig', () => {
    let tempDir: string;
    let claudeJsonPath: string;
    let userSettingsPath: string;
    let projectDir: string;

    function writeJson(filePath: string, value: unknown): void {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(value));
    }

    function read(overrides: Partial<Parameters<typeof readMcpConfig>[0]> = {}): Record<string, string> {
        const servers = readMcpConfig({
            projectDir,
            claudeJsonPath,
            userSettingsPaths: [userSettingsPath],
            managedSettingsPaths: [],
            ...overrides
        });
        return Object.fromEntries(servers.map(server => [`${server.scope}:${server.name}`, server.state ?? 'enabled']));
    }

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccstatusline-mcp-'));
        claudeJsonPath = path.join(tempDir, 'home', '.claude.json');
        userSettingsPath = path.join(tempDir, 'home', '.claude', 'settings.json');
        projectDir = path.join(tempDir, 'Work Space', 'repo');
        fs.mkdirSync(projectDir, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('returns no servers when nothing is configured', () => {
        expect(read()).toEqual({});
    });

    it('reads user and local servers and the project entry keyed with forward slashes', () => {
        writeJson(claudeJsonPath, {
            mcpServers: { github: { command: 'secret-cmd', env: { TOKEN: 'abc' } } },
            projects: { [projectDir.replace(/\\/g, '/')]: { mcpServers: { local1: { url: 'https://user:pw@example.com' } } } }
        });
        expect(read()).toEqual({ 'user:github': 'enabled', 'local:local1': 'enabled' });
    });

    it('matches the project entry case-insensitively on Windows', () => {
        if (process.platform !== 'win32') {
            return;
        }
        writeJson(claudeJsonPath, { projects: { [projectDir.toUpperCase()]: { mcpServers: { local1: {} } } } });
        expect(read()).toEqual({ 'local:local1': 'enabled' });
    });

    it('does not apply another project\'s local servers', () => {
        writeJson(claudeJsonPath, { projects: { [path.join(tempDir, 'other').replace(/\\/g, '/')]: { mcpServers: { foreign: {} } } } });
        expect(read()).toEqual({});
    });

    it('marks unapproved .mcp.json servers pending and approved ones enabled', () => {
        writeJson(path.join(projectDir, '.mcp.json'), { mcpServers: { approved: {}, waiting: {}, rejected: {} } });
        writeJson(claudeJsonPath, {
            projects: {
                [projectDir]: {
                    enabledMcpjsonServers: ['approved'],
                    disabledMcpjsonServers: ['rejected']
                }
            }
        });
        expect(read()).toEqual({ 'project:approved': 'enabled', 'project:waiting': 'pending-approval', 'project:rejected': 'disabled' });
    });

    it('treats enableAllProjectMcpServers in settings as approval', () => {
        writeJson(path.join(projectDir, '.mcp.json'), { mcpServers: { waiting: {} } });
        writeJson(path.join(projectDir, '.claude', 'settings.local.json'), { enableAllProjectMcpServers: true });
        expect(read()).toEqual({ 'project:waiting': 'enabled' });
    });

    it('finds .mcp.json in a parent directory of the working directory', () => {
        writeJson(path.join(projectDir, '.mcp.json'), { mcpServers: { up: {} } });
        const nested = path.join(projectDir, 'src', 'deep');
        fs.mkdirSync(nested, { recursive: true });
        writeJson(claudeJsonPath, { projects: { [nested]: { enabledMcpjsonServers: ['up'] } } });
        expect(read({ projectDir: nested })).toEqual({ 'project:up': 'enabled' });
    });

    it('marks servers disabled for the project via /mcp', () => {
        writeJson(claudeJsonPath, {
            mcpServers: { github: {} },
            projects: { [projectDir]: { disabledMcpServers: ['github'] } }
        });
        expect(read()).toEqual({ 'user:github': 'disabled' });
    });

    it('marks servers denied by policy as blocked', () => {
        const managed = path.join(tempDir, 'managed-settings.json');
        writeJson(managed, { deniedMcpServers: [{ serverName: 'bad' }] });
        writeJson(claudeJsonPath, { mcpServers: { bad: {}, good: {} } });
        expect(read({ managedSettingsPaths: [managed] })).toEqual({ 'user:bad': 'blocked', 'user:good': 'enabled' });
    });

    it('marks servers missing from a policy allowlist as blocked', () => {
        const managed = path.join(tempDir, 'managed-settings.json');
        writeJson(managed, { allowedMcpServers: [{ serverName: 'good' }] });
        writeJson(claudeJsonPath, { mcpServers: { bad: {}, good: {} } });
        expect(read({ managedSettingsPaths: [managed] })).toEqual({ 'user:bad': 'blocked', 'user:good': 'enabled' });
    });

    it('survives malformed and unexpected files', () => {
        fs.mkdirSync(path.dirname(claudeJsonPath), { recursive: true });
        fs.writeFileSync(claudeJsonPath, '{not json');
        writeJson(path.join(projectDir, '.mcp.json'), { mcpServers: ['not', 'an', 'object'] });
        writeJson(userSettingsPath, { deniedMcpServers: 'nope' });
        expect(read()).toEqual({});
    });

    it('returns only names and states, never server definitions', () => {
        writeJson(claudeJsonPath, { mcpServers: { github: { command: 'x', env: { TOKEN: 'secret-token' } } } });
        const servers = readMcpConfig({ projectDir, claudeJsonPath, userSettingsPaths: [], managedSettingsPaths: [] });
        expect(JSON.stringify(servers)).not.toContain('secret-token');
        expect(Object.keys(servers[0] ?? {}).sort()).toEqual(['name', 'scope']);
    });

    it('keeps profiles apart: a different .claude.json yields different servers', () => {
        const otherProfile = path.join(tempDir, 'profile2', '.claude.json');
        writeJson(claudeJsonPath, { mcpServers: { a: {} } });
        writeJson(otherProfile, { mcpServers: { b: {} } });
        expect(read()).toEqual({ 'user:a': 'enabled' });
        expect(read({ claudeJsonPath: otherProfile })).toEqual({ 'user:b': 'enabled' });
    });
});

describe('getMcpStatus', () => {
    it('combines configuration with the session', () => {
        const status = getMcpStatus(session(toolsDelta(['mcp__a__x'])), {
            projectDir: os.tmpdir(),
            claudeJsonPath: path.join(os.tmpdir(), 'does-not-exist', '.claude.json'),
            userSettingsPaths: [],
            managedSettingsPaths: []
        });
        expect(status.servers).toEqual([{ name: 'a', state: 'connected', scope: 'session' }]);
    });
});
