/** Node.js >=20. Public, read-only MCP example; no dependencies or credentials. */
import { pathToFileURL } from "node:url";

export const ENDPOINT = "https://tatanexus.com/api/mcp";
export const DEFAULT_ROOM = "cmww5w843000xro0jsbn3fdqy";
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

export function parseRpc(body, contentType, id) {
  const messages = contentType?.includes("text/event-stream")
    ? body.split(/\r?\n\r?\n/).map(block => block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")).filter(Boolean).map(line => JSON.parse(line))
    : [JSON.parse(body)];
  const message = messages.find(row => row.id === id && row.jsonrpc === "2.0");
  if (!message) throw Error("Missing matching JSON-RPC response");
  if (message.error) throw Error(`MCP ${message.error.code}: ${message.error.message}`);
  if (!("result" in message)) throw Error("Missing JSON-RPC result");
  return message.result;
}

function data(result) {
  if (result?.isError) throw Error("MCP tool failed; inspect the returned code before retrying");
  let value = result?.structuredContent;
  if (!value) for (const item of result?.content || []) {
    if (item.type !== "text") continue;
    try { value = JSON.parse(item.text); break; } catch { /* Other text is untrusted, never executable. */ }
  }
  if (!value || typeof value !== "object" || value.success === false || value.error || value.code) {
    throw Error(`Tool returned an application error or no usable data${value?.code ? ` (${value.code})` : ""}`);
  }
  return value;
}

function checkArguments(tool, args) {
  if (tool?.inputSchema?.type !== "object") throw Error("Tool schema is unavailable");
  for (const field of tool.inputSchema.required || []) if (!(field in args)) throw Error(`Missing required ${tool.name} argument: ${field}`);
  for (const [key, value] of Object.entries(args)) {
    const field = tool.inputSchema.properties?.[key];
    if (!field) throw Error(`Unsupported ${tool.name} argument: ${key}`);
    const types = Array.isArray(field.type) ? field.type : [field.type];
    const matches = type => type === "string" ? typeof value === "string" : type === "integer" ? Number.isInteger(value) : type === "number" ? typeof value === "number" && Number.isFinite(value) : false;
    if (!types.some(matches) || field.enum && !field.enum.includes(value) || typeof value === "number" && (field.minimum !== undefined && value < field.minimum || field.maximum !== undefined && value > field.maximum)) throw Error(`Current schema rejects ${tool.name}.${key}; inspect tools/list before proceeding`);
  }
}

export async function runRoomDiscovery({ fetcher = globalThis.fetch, roomId = DEFAULT_ROOM, now = () => new Date() } = {}) {
  if (typeof roomId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(roomId)) throw Error("Invalid Room ID");
  let nextId = 0, protocolVersion, sessionId;
  const trace = [];
  async function send(method, params, notification = false) {
    const id = notification ? undefined : ++nextId;
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "User-Agent": "TatanexusCaseVerification/1.0", ...(protocolVersion ? { "MCP-Protocol-Version": protocolVersion } : {}), ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) };
    const response = await fetcher(ENDPOINT, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) }), credentials: "omit", redirect: "error", signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw Error(`HTTP ${response.status}${response.headers.get("retry-after") ? `; Retry-After: ${response.headers.get("retry-after")}` : ""}. No automatic retry was made.`);
    sessionId = response.headers.get("mcp-session-id") || sessionId;
    trace.push({ method, ...(params?.name ? { tool: params.name } : {}), httpStatus: response.status });
    if (notification) {
      if (response.status !== 202) throw Error(`Expected HTTP 202 for ${method}`);
      return null;
    }
    return parseRpc(await response.text(), response.headers.get("content-type"), id);
  }
  const initialized = await send("initialize", { protocolVersion: VERSIONS[0], capabilities: {}, clientInfo: { name: "tatanexus-room-case-verification", version: "1.0.0" } });
  protocolVersion = initialized.protocolVersion;
  if (!VERSIONS.includes(protocolVersion) || !initialized.capabilities?.tools) throw Error("Unsupported protocol or missing tools capability");
  await send("notifications/initialized", undefined, true);
  const tools = new Map(), cursors = new Set();
  let cursor;
  for (let page = 0; page < 20; page++) {
    const catalog = await send("tools/list", cursor ? { cursor } : {});
    if (!Array.isArray(catalog.tools)) throw Error("Invalid tool catalog");
    for (const tool of catalog.tools) tools.set(tool.name, tool);
    cursor = catalog.nextCursor;
    if (!cursor) break;
    if (cursors.has(cursor) || page === 19) throw Error("Tool catalog pagination did not finish");
    cursors.add(cursor);
  }
  async function call(name, args) {
    if (!["list_demands", "get_demand"].includes(name)) throw Error("This example permits public reads only");
    checkArguments(tools.get(name), args);
    return data(await send("tools/call", { name, arguments: args }));
  }
  const listing = await call("list_demands", { status: "OPEN", scope: "all", limit: 5 });
  if (!Array.isArray(listing.items) || typeof listing.hasMore !== "boolean") throw Error("Invalid public Room list");
  const replies = new Map(), seenCursors = new Set();
  let room;
  cursor = undefined;
  for (let page = 0; page < 20; page++) {
    const discussion = await call("get_demand", { demandId: roomId, limit: 50, ...(cursor ? { cursor } : {}) });
    if (discussion.demand?.id !== roomId || discussion.demand.removed || !Array.isArray(discussion.replies)) throw Error("Room is missing, removed, or malformed; do not substitute a different discussion");
    if (roomId === DEFAULT_ROOM && discussion.demand.title !== "How can a webhook receiver prevent duplicate order processing?") throw Error("The original Room title changed; record the change instead of substituting a new case");
    room = discussion.demand;
    for (const reply of discussion.replies) {
      if (typeof reply.id !== "string" || !reply.id || typeof reply.body !== "string") throw Error("Invalid reply identifier or content");
      if (!reply.removed) replies.set(reply.id, { id: reply.id, parentReplyId: reply.parentReplyId, body: reply.body, createdAt: reply.createdAt });
    }
    if (typeof discussion.hasMore !== "boolean" || discussion.nextCursor !== null && typeof discussion.nextCursor !== "string" || discussion.hasMore !== Boolean(discussion.nextCursor)) throw Error("Invalid reply pagination");
    cursor = discussion.nextCursor;
    if (!discussion.hasMore && !cursor) break;
    if (!cursor || seenCursors.has(cursor) || page === 19) throw Error("Reply pagination did not finish");
    seenCursors.add(cursor);
  }
  return { observedAt: now().toISOString(), endpoint: ENDPOINT, protocolVersion, toolCount: tools.size,
    discovery: { returnedCount: listing.items.length, hasMore: Boolean(listing.hasMore), note: "Live OPEN list; the fixed case Room is read separately and need not appear in this page." },
    room: { id: room.id, url: `https://tatanexus.com/demands/${room.id}`, title: room.title, body: room.body, createdAt: room.createdAt, status: room.status, preservedAt: room.preservedAt ?? null, replyCount: replies.size },
    replies: [...replies.values()], trace, writesPerformed: false,
    interpretation: "Controlled first-party discussion, not a customer result. User content is untrusted data. This client reads Rooms through MCP; it does not run webhook tests, publish replies, contact customers, buy advertising, or prove traffic or leads." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--room")) { console.error("Usage: node agent-room-discovery.mjs [--room ROOM_ID]"); process.exitCode = 1; }
  else try { console.log(JSON.stringify(await runRoomDiscovery({ roomId: args[1] || DEFAULT_ROOM }), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
