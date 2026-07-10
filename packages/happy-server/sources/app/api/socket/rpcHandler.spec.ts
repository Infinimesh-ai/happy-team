/**
 * Server↔daemon RPC routing over a real in-process socket (C0.7 transport
 * layer). A socket.io client stands in for the member's daemon: it registers an
 * RPC method into its room and answers rpc-request acks. This exercises the real
 * routing that carries every live task RPC (prepare/spawn/deliver/intent),
 * previously only unit-tested at the crypto and gateway-mapping ends.
 */
import { createServer, type Server as HttpServer } from "http";
import type { AddressInfo } from "net";
import { Server } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callRegisteredRpcMethod, rpcHandler } from "./rpcHandler";

const USER_ID = "account-1";

let httpServer: HttpServer;
let io: Server;
let client: ClientSocket;
let port: number;

beforeEach(async () => {
    httpServer = createServer();
    io = new Server(httpServer);
    io.on("connection", (socket) => {
        // Every connected socket behaves as this user's daemon.
        rpcHandler(USER_ID, socket, io);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as AddressInfo).port;
});

afterEach(async () => {
    client?.disconnect();
    io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

async function connectDaemon(): Promise<ClientSocket> {
    const socket = ioClient(`http://localhost:${port}`, { transports: ["websocket"], forceNew: true });
    await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
    return socket;
}

describe("callRegisteredRpcMethod over a real socket", () => {
    it("routes a call to the registered daemon and returns its response", async () => {
        client = await connectDaemon();
        const method = "machine-1:task-check-artifacts";

        const registered = new Promise<void>((resolve) => client.on("rpc-registered", () => resolve()));
        client.emit("rpc-register", { method });
        // The daemon answers rpc-request acks (echoes the params back).
        client.on("rpc-request", (data: { method: string; params: string }, ack: (response: string) => void) => {
            ack(`echo:${data.params}`);
        });
        await registered;

        const result = await callRegisteredRpcMethod(io, USER_ID, method, "PAYLOAD");
        expect(result).toEqual({ ok: true, result: "echo:PAYLOAD" });
    });

    it("reports failure when no daemon has registered the method", async () => {
        client = await connectDaemon();
        // The lookup waits out the reconnect grace window before giving up.
        const result = await callRegisteredRpcMethod(io, USER_ID, "machine-1:task-deliver", "x");
        expect(result.ok).toBe(false);
    }, 20_000);

    it("stops routing after the method is unregistered", async () => {
        client = await connectDaemon();
        const method = "machine-1:task-deliver";
        await new Promise<void>((resolve) => {
            client.on("rpc-registered", () => resolve());
            client.emit("rpc-register", { method });
        });
        await new Promise<void>((resolve) => {
            client.on("rpc-unregistered", () => resolve());
            client.emit("rpc-unregister", { method });
        });
        const result = await callRegisteredRpcMethod(io, USER_ID, method, "x");
        expect(result.ok).toBe(false);
    }, 20_000);
});
