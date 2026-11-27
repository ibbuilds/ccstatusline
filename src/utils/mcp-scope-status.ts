import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** CC Optimizer's MCP scope for one session: `<state dir>/<session_id>.mcp.json`. */
export interface McpScopeStatus {
    scope: string;
    held: string[];
}

/** Where CC Optimizer writes a session's MCP scope status. */
export function getScopeStatusPath(sessionId: string | undefined): string | undefined {
    const id = (sessionId ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    if (!id) {
        return undefined;
    }
    const dir = process.env.CC_OPTIMIZER_STATE_DIR ?? path.join(os.tmpdir(), 'cc-optimizer');
    return path.join(dir, `${id}.mcp.json`);
}

/** The scope and the servers held back, or null when the file is absent, unreadable or not version 1. */
export function readScopeStatus(filePath: string | undefined): McpScopeStatus | null {
    if (!filePath) {
        return null;
    }
    let file: unknown;
    try {
        file = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        return null;
    }
    if (typeof file !== 'object' || file === null || Array.isArray(file)) {
        return null;
    }
    const { version, scope, held } = file as Record<string, unknown>;
    if (version !== 1 || typeof scope !== 'string') {
        return null;
    }
    const names = scope === 'project' && Array.isArray(held) ? held.filter((name): name is string => typeof name === 'string') : [];
    return { scope, held: names };
}
