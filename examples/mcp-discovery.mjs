/** Public discovery example. Requires Node.js with built-in fetch; no packages or credentials. */
import { pathToFileURL } from "node:url";

export const ENDPOINT = "https://tatanexus.com/api/mcp";
export const DEFAULT_TASK = "crypto wallet";
const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26"];

export function parseRpcResponse(body, contentType, expectedId) {
  const messages = contentType?.includes("text/event-stream")
    ? body.split(/\r?\n\r?\n/).map(block => block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")).filter(Boolean).map(line => JSON.parse(line))
    : [JSON.parse(body)];
  const message = messages.find(row => row.id === expectedId);
  if (!message) throw Error("The server did not return a matching response ID");
  if (message.error) throw Error(`MCP ${message.error.code}: ${message.error.message}`);
  return message;
}
function toolData(result) {
  if (result?.isError) throw Error(result.content?.filter(c => c.type === "text").map(c => c.text).join("\n") || "MCP tool failed");
  if (result?.structuredContent) return result.structuredContent;
  for (const content of result?.content || []) {
    if (content.type !== "text") continue;
    try { return JSON.parse(content.text); } catch { /* Try another text block. */ }
  }
  throw Error("The tool returned no structured JSON data");
}

export async function runDiscovery({ fetcher = globalThis.fetch, task = DEFAULT_TASK } = {}) {
  if (typeof task !== "string" || !task.trim() || task.length > 200) throw Error("task must be a non-empty string of at most 200 characters");
  let nextId = 0, protocolVersion, sessionId;
  async function send(method, params, notification = false) {
    const id = notification ? undefined : ++nextId;
    const payload = { jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) };
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(protocolVersion ? { "MCP-Protocol-Version": protocolVersion } : {}), ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) };
    const response = await fetcher(ENDPOINT, { method: "POST", headers, body: JSON.stringify(payload), credentials: "omit", redirect: "error", signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw Error(`HTTP ${response.status}. Check the endpoint, authorization requirements, and Retry-After before retrying.`);
    sessionId = response.headers.get("mcp-session-id") || sessionId;
    if (notification) {
      if (response.status !== 202) throw Error(`Expected HTTP 202 for ${method}, received ${response.status}`);
      return null;
    }
    return parseRpcResponse(await response.text(), response.headers.get("content-type"), id).result;
  }
  const initialized = await send("initialize", { protocolVersion: SUPPORTED[0], capabilities: {}, clientInfo: { name: "tatanexus-public-discovery-guide", version: "1.0.0" } });
  protocolVersion = initialized.protocolVersion;
  if (!SUPPORTED.includes(protocolVersion) || !initialized.capabilities?.tools) throw Error("Unsupported negotiated MCP version or missing tools capability");
  await send("notifications/initialized", undefined, true);
  const tools = new Map(), seenCursors = new Set(); let cursor;
  for (let page = 0; page < 20; page++) {
    const catalog = await send("tools/list", cursor ? { cursor } : {});
    if (!Array.isArray(catalog.tools)) throw Error("Invalid tool catalog");
    for (const tool of catalog.tools) tools.set(tool.name, tool);
    cursor = catalog.nextCursor;
    if (!cursor) break;
    if (seenCursors.has(cursor) || page === 19) throw Error("Tool catalog pagination did not finish");
    seenCursors.add(cursor);
  }
  if (!tools.has("search_products") || !tools.has("get_product_details")) throw Error("The public discovery tools are not in this catalog");
  const search = toolData(await send("tools/call", { name: "search_products", arguments: { task } }));
  if (!Array.isArray(search.results)) throw Error("Invalid search response");
  const first = search.results[0]; let firstReturnedProduct = null;
  if (first) {
    if (typeof first.slug !== "string" || !first.slug) throw Error("The returned candidate has no usable slug");
    firstReturnedProduct = toolData(await send("tools/call", { name: "get_product_details", arguments: { slug: first.slug } }));
  }
  return { endpoint: ENDPOINT, protocolVersion, serverInfo: initialized.serverInfo, toolCount: tools.size,
    search: { task, dataStatus: search.dataStatus, returnedCount: search.results.length, firstCandidates: search.results.slice(0, 3) },
    firstReturnedProduct,
    note: "The first returned candidate is shown to demonstrate get_product_details. Order and sponsorship are not a recommendation; verify capability and applicableTasks." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const taskIndex = args.indexOf("--task");
  if (args.length && (taskIndex !== 0 || args.length !== 2)) { console.error('Usage: node mcp-discovery.mjs [--task "your task"]'); process.exitCode = 1; }
  else try { console.log(JSON.stringify(await runDiscovery({ task: taskIndex < 0 ? DEFAULT_TASK : args[1] }), null, 2)); }
  catch (failure) { console.error(failure.message); process.exitCode = 1; }
}
