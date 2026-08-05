/**
 * MCP HTTP routes. Two auth domains, deliberately separate:
 *
 * - POST /v1/team/mcp/token — normal account auth (app.authenticate). A member
 *   mints a personal MCP token here and configures it in their external MCP
 *   client (e.g. SparkClaw). Issuance is audited.
 * - POST /v1/team/mcp — the MCP endpoint itself, authenticated ONLY by the
 *   personal MCP token (Bearer). Stateless JSON mode: one JSON-RPC message per
 *   POST, JSON response, no SSE stream — GET/DELETE answer 405 so spec-compliant
 *   clients fall back to plain POSTs.
 *
 * Registered from api.ts via {@link teamMcpRoutes}.
 */
import { z } from "zod";
import { type Fastify } from "@/app/api/types";
import { getActiveTeamUser } from "@/team/status";
import { writeTeamAudit } from "@/team/audit";
import { issueMcpToken, resolveMcpTeamUser } from "./mcpToken";
import { handleMcpRequest } from "./mcpServer";

export function teamMcpRoutes(app: Fastify) {
    app.post("/v1/team/mcp/token", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const teamUser = await getActiveTeamUser(request.userId);
        if (!teamUser) return reply.code(403).send({ error: "Team user required" });
        const token = issueMcpToken(teamUser);
        await writeTeamAudit({ actorId: teamUser.id, action: "team.mcp.token_issued" });
        return reply.send({ token, endpoint: "/v1/team/mcp" });
    });

    app.post("/v1/team/mcp", {
        schema: { body: z.unknown() },
    }, async (request, reply) => {
        const header = request.headers.authorization;
        const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
        const teamUser = bearer ? await resolveMcpTeamUser(bearer) : null;
        if (!teamUser) return reply.code(401).send({ error: "Invalid MCP token" });

        const result = await handleMcpRequest(teamUser, request.body);
        if (result.body === undefined) return reply.code(result.status).send();
        return reply.code(result.status).send(result.body);
    });

    // No server-initiated stream and no session state to delete in stateless mode.
    app.get("/v1/team/mcp", async (_request, reply) => reply.code(405).send({ error: "Method not allowed" }));
    app.delete("/v1/team/mcp", async (_request, reply) => reply.code(405).send({ error: "Method not allowed" }));
}
