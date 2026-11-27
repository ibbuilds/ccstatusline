import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    getClaudeConfigDir,
    getClaudeJsonPath
} from './claude-settings';
import {
    getScopeStatusPath,
    readScopeStatus
} from './mcp-scope-status';

export {
    getScopeStatusPath,
    readScopeStatus,
    type McpScopeStatus
} from './mcp-scope-status';

/**
 * MCP server status for the MCP Status widget.
 *
 * Claude Code passes nothing about MCP servers to the status line, so this
 * combines two read-only sources:
 *
 * - The session transcript. Claude Code records the tools it hands the model in
 *   `deferred_tools_delta` attachments and the servers that sent instructions in
 *   `mcp_instructions_delta` attachments. A server whose tools appear there is
 *   connected in *this* session; one that only offers `authenticate` tools needs
 *   authentication. The transcript is already scanned once per render, so this
 *   costs no extra I/O.
 * - Claude Code's configuration files, for servers the session never reported:
 *   configured, disabled for the project, awaiting `.mcp.json` approval, or
 *   blocked by policy. Only server names are read; definitions (commands, URLs,
 *   headers, env) are never copied out.
 * - CC Optimizer's MCP scope, when it is installed and set to `project`: it
 *   writes the servers it held back from this session to
 *   `<state dir>/<session_id>.mcp.json`. Those never started, so they are
 *   `held` (inactive, not a problem) instead of `not-connected`. Without the
 *   file nothing changes.
 *
 * Neither source distinguishes "failed to connect" from "connection error" or
 * "still connecting": a configured server whose tools never reached an
 * observed session is reported as `not-connected`.
 */

export type McpServerState
    = | 'connected'
        | 'needs-auth'
        | 'not-connected'
        | 'pending-approval'
        | 'disabled'
        | 'blocked'
        | 'held'
        | 'configured';

export type McpConfigScope = 'local' | 'project' | 'user';
export type McpServerScope = McpConfigScope | 'session';

export interface McpConfigServer {
    name: string;
    scope: McpConfigScope;
    /** Set only when configuration alone decides the state. */
    state?: 'disabled' | 'pending-approval' | 'blocked';
}

export interface McpServerStatus {
    name: string;
    state: McpServerState;
    scope: McpServerScope;
}

export interface McpStatusData {
    servers: McpServerStatus[];
    /** True once the transcript listed the session's tools, so absent servers are known to be missing. */
    sessionObserved: boolean;
}

export interface McpSessionState {
    toolsObserved: boolean;
    /** Tool names with the `mcp__` prefix removed: `<server>__<tool>`. */
    tools: Set<string>;
    /** Normalized server name -> name as Claude Code announced it. */
    instructionServers: Map<string, string>;
}

export interface McpConfigOptions {
    /** Directory Claude Code keys project state by (the session's project or working directory). */
    projectDir?: string;
    claudeJsonPath: string;
    /** User-level settings files, e.g. `<config>/settings.json`. Project layers are derived from projectDir. */
    userSettingsPaths: string[];
    managedSettingsPaths: string[];
    /** CC Optimizer's per-session MCP scope file, if any. */
    scopeStatusPath?: string;
}

const MCP_TOOL_PREFIX = 'mcp__';
const AUTH_TOOLS = new Set(['authenticate', 'complete_authentication']);
const CLAUDE_AI_PREFIX = 'claude_ai_';

/** Claude Code's tool-name form of a server name. */
export function normalizeMcpServerName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function createMcpSessionState(): McpSessionState {
    return { toolsObserved: false, tools: new Set(), instructionServers: new Map() };
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function accumulateMcpSessionRecord(state: McpSessionState, record: unknown): void {
    if (!isRecord(record) || record.type !== 'attachment' || record.isSidechain === true) {
        return;
    }
    const attachment = record.attachment;
    if (!isRecord(attachment)) {
        return;
    }

    if (attachment.type === 'deferred_tools_delta') {
        if (!Array.isArray(attachment.addedNames) && !Array.isArray(attachment.removedNames)) {
            return;
        }
        state.toolsObserved = true;
        for (const name of stringArray(attachment.addedNames)) {
            if (name.startsWith(MCP_TOOL_PREFIX)) {
                state.tools.add(name.slice(MCP_TOOL_PREFIX.length));
            }
        }
        for (const name of stringArray(attachment.removedNames)) {
            if (name.startsWith(MCP_TOOL_PREFIX)) {
                state.tools.delete(name.slice(MCP_TOOL_PREFIX.length));
            }
        }
    } else if (attachment.type === 'mcp_instructions_delta') {
        for (const name of stringArray(attachment.addedNames)) {
            state.instructionServers.set(normalizeMcpServerName(name), name);
        }
        for (const name of stringArray(attachment.removedNames)) {
            state.instructionServers.delete(normalizeMcpServerName(name));
        }
    }
}

// Splits `<server>__<tool>`, preferring a known server name so names that
// themselves contain `__` resolve correctly
function splitTool(remainder: string, knownNames: string[]): { server: string; tool: string } | null {
    for (const name of knownNames) {
        if (remainder.startsWith(`${name}__`) && remainder.length > name.length + 2) {
            return { server: name, tool: remainder.slice(name.length + 2) };
        }
    }
    const separator = remainder.indexOf('__');
    if (separator <= 0 || separator + 2 >= remainder.length) {
        return null;
    }
    return { server: remainder.slice(0, separator), tool: remainder.slice(separator + 2) };
}

// claude.ai connectors are announced as "claude.ai <Name>"; their tool prefix
// is the only trace when they sent no instructions
function displayNameFromKey(key: string): string {
    if (key.startsWith(CLAUDE_AI_PREFIX) && key.length > CLAUDE_AI_PREFIX.length) {
        return `claude.ai ${key.slice(CLAUDE_AI_PREFIX.length).replace(/_/g, ' ')}`;
    }
    return key;
}

export function resolveMcpStatus(config: McpConfigServer[], session: McpSessionState | null): McpStatusData {
    const configByKey = new Map<string, McpConfigServer>();
    for (const server of config) {
        const key = normalizeMcpServerName(server.name);
        if (!configByKey.has(key)) {
            configByKey.set(key, server);
        }
    }

    const sessionStates = new Map<string, 'connected' | 'needs-auth'>();
    if (session) {
        const knownNames = Array.from(new Set([...configByKey.keys(), ...session.instructionServers.keys()]))
            .sort((a, b) => b.length - a.length);
        const toolsByServer = new Map<string, Set<string>>();
        for (const remainder of session.tools) {
            const parsed = splitTool(remainder, knownNames);
            if (!parsed) {
                continue;
            }
            const tools = toolsByServer.get(parsed.server) ?? new Set<string>();
            tools.add(parsed.tool);
            toolsByServer.set(parsed.server, tools);
        }
        for (const [key, tools] of toolsByServer) {
            const authOnly = Array.from(tools).every(tool => AUTH_TOOLS.has(tool));
            sessionStates.set(key, authOnly ? 'needs-auth' : 'connected');
        }
        for (const key of session.instructionServers.keys()) {
            if (!sessionStates.has(key)) {
                sessionStates.set(key, 'connected');
            }
        }
    }

    const toolsObserved = session?.toolsObserved ?? false;
    const servers: McpServerStatus[] = [];
    for (const [key, server] of configByKey) {
        const sessionState = sessionStates.get(key);
        const state: McpServerState = sessionState
            ?? server.state
            ?? (toolsObserved ? 'not-connected' : 'configured');
        servers.push({ name: server.name, state, scope: server.scope });
    }
    for (const [key, state] of sessionStates) {
        if (configByKey.has(key)) {
            continue;
        }
        const name = session?.instructionServers.get(key) ?? displayNameFromKey(key);
        servers.push({ name, state, scope: 'session' });
    }

    servers.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
    return { servers, sessionObserved: toolsObserved };
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function serverNames(value: unknown): string[] {
    return isRecord(value) ? Object.keys(value) : [];
}

function normalizePathKey(input: string): string {
    const resolved = path.resolve(input).replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function findProjectEntry(claudeJson: Record<string, unknown> | null, projectDir: string | undefined): Record<string, unknown> | null {
    if (!claudeJson || !projectDir || !isRecord(claudeJson.projects)) {
        return null;
    }
    const wanted = normalizePathKey(projectDir);
    for (const [key, value] of Object.entries(claudeJson.projects)) {
        if (isRecord(value) && normalizePathKey(key) === wanted) {
            return value;
        }
    }
    return null;
}

// Closest .mcp.json first, walking from the project directory to the root
function readProjectServerNames(projectDir: string | undefined): string[] {
    if (!projectDir) {
        return [];
    }
    const names: string[] = [];
    let dir = path.resolve(projectDir);
    for (;;) {
        const file = readJsonObject(path.join(dir, '.mcp.json'));
        names.push(...serverNames(file?.mcpServers));
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return names;
}

function policyNames(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map(entry => (isRecord(entry) && typeof entry.serverName === 'string' ? entry.serverName : null))
        .filter((name): name is string => name !== null);
}

export function readMcpConfig(options: McpConfigOptions): McpConfigServer[] {
    const claudeJson = readJsonObject(options.claudeJsonPath);
    const project = findProjectEntry(claudeJson, options.projectDir);
    const projectSettingsPaths = options.projectDir
        ? [
            path.join(options.projectDir, '.claude', 'settings.local.json'),
            path.join(options.projectDir, '.claude', 'settings.json')
        ]
        : [];
    const layers = [...options.managedSettingsPaths, ...projectSettingsPaths, ...options.userSettingsPaths]
        .map(readJsonObject)
        .filter((layer): layer is Record<string, unknown> => layer !== null);
    const approvalSources = [project, ...layers].filter((source): source is Record<string, unknown> => source !== null);

    const enableAll = approvalSources.some(source => source.enableAllProjectMcpServers === true);
    const approved = new Set(approvalSources.flatMap(source => stringArray(source.enabledMcpjsonServers)));
    const rejected = new Set(approvalSources.flatMap(source => stringArray(source.disabledMcpjsonServers)));
    const disabled = new Set(stringArray(project?.disabledMcpServers));
    const denied = new Set(layers.flatMap(layer => policyNames(layer.deniedMcpServers)));
    const allowLists = layers.filter(layer => Array.isArray(layer.allowedMcpServers));
    const allowed = allowLists.length > 0 ? new Set(allowLists.flatMap(layer => policyNames(layer.allowedMcpServers))) : null;

    // Precedence local > project > user; the first scope to name a server wins
    const candidates: { name: string; scope: McpConfigScope }[] = [
        ...serverNames(project?.mcpServers).map(name => ({ name, scope: 'local' as const })),
        ...readProjectServerNames(options.projectDir).map(name => ({ name, scope: 'project' as const })),
        ...serverNames(claudeJson?.mcpServers).map(name => ({ name, scope: 'user' as const }))
    ];

    const seen = new Set<string>();
    const servers: McpConfigServer[] = [];
    for (const { name, scope } of candidates) {
        if (seen.has(name)) {
            continue;
        }
        seen.add(name);

        let state: McpConfigServer['state'];
        if (denied.has(name) || (allowed !== null && !allowed.has(name))) {
            state = 'blocked';
        } else if (disabled.has(name) || (scope === 'project' && rejected.has(name))) {
            state = 'disabled';
        } else if (scope === 'project' && !enableAll && !approved.has(name)) {
            state = 'pending-approval';
        }
        servers.push(state ? { name, scope, state } : { name, scope });
    }
    return servers;
}

function getManagedSettingsPaths(): string[] {
    if (process.platform === 'win32') {
        return [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json')];
    }
    if (process.platform === 'darwin') {
        return ['/Library/Application Support/ClaudeCode/managed-settings.json'];
    }
    return ['/etc/claude-code/managed-settings.json'];
}

/** Server names CC Optimizer held back from the session; empty when the file is absent or not version 1. */
export function readScopeHeld(filePath: string | undefined): string[] {
    return readScopeStatus(filePath)?.held ?? [];
}

/** Marks held servers; a server the session reported as connected keeps that state. */
export function applyScopeHeld(data: McpStatusData, held: string[]): McpStatusData {
    if (held.length === 0) {
        return data;
    }
    const heldKeys = new Map(held.map(name => [normalizeMcpServerName(name), name]));
    const servers = data.servers.map((server) => {
        const key = normalizeMcpServerName(server.name);
        if (!heldKeys.has(key)) {
            return server;
        }
        heldKeys.delete(key);
        return server.state === 'connected' || server.state === 'needs-auth' ? server : { ...server, state: 'held' as const };
    });
    for (const name of heldKeys.values()) {
        servers.push({ name, state: 'held', scope: 'session' });
    }
    servers.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
    return { ...data, servers };
}

/** Options for the active Claude profile, honoring CLAUDE_CONFIG_DIR. */
export function getDefaultMcpConfigOptions(projectDir: string | undefined, sessionId?: string): McpConfigOptions {
    const configDir = getClaudeConfigDir();
    const scopeStatusPath = getScopeStatusPath(sessionId);
    return {
        ...(scopeStatusPath ? { scopeStatusPath } : {}),
        projectDir,
        claudeJsonPath: getClaudeJsonPath(),
        userSettingsPaths: [path.join(configDir, 'settings.local.json'), path.join(configDir, 'settings.json')],
        managedSettingsPaths: getManagedSettingsPaths()
    };
}

export function getMcpStatus(session: McpSessionState | null, options: McpConfigOptions): McpStatusData {
    return applyScopeHeld(resolveMcpStatus(readMcpConfig(options), session), readScopeHeld(options.scopeStatusPath));
}
