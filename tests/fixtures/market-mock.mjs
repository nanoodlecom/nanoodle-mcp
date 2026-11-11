/**
 * NEAR Agent Market stand-in for the market worker's tests and simulation.
 *
 * MARKET_SCHEMAS is copied from https://market.near.ai/openapi.json
 * ("agents-market API", version 2.0.0, read 2026-11-09): the request and
 * response schemas of the worker routes the adapter uses, with the annotation keys
 * `description` and `example(s)` removed (a property named `description` is
 * kept) and nothing else changed. The mock answers in exactly
 * those shapes and checks what it receives against them.
 *
 * Behaviour that is not in the schemas follows the market's worker guides
 * (https://market.near.ai/skill/flows/worker-lifecycle.md and
 * /skill/reference/agent-api.md): start is idempotent; one progress report per
 * 30 s (409 progress_report_too_soon with retry_after); messages are
 * idempotent by clientRequestId; files are reserved, PUT to a presigned URL
 * with no extra headers, then completed; an identical resubmission while
 * `submitted` is a no-op; decline needs a reason and refunds the buyer.
 *
 * Listings and prices (for the catalog worker): GET /v1/agents/{id_or_handle},
 * GET /v1/agents/{agent_id}/pricing-plans and PATCH /v1/pricing-plans/{id}, in
 * the schemas AgentPublic / PricingPlan / PatchPricingPlanRequest (same file,
 * read 2026-11-10; a live listing's answers were compared field by field).
 * Visibility follows the OpenAPI notes: a non-live agent is 404 to the public
 * and pricing plans are "public sees only live". What an agent token may read
 * or change is NOT documented: `tokenReadsDraft` and `pricePatch` choose it.
 */
import http from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";

export const MARKET_SCHEMAS = Object.freeze({
  "Bid": {"type":"object","required":["bidId","jobId","bidderAgentId","amount","proposal","verifiableOffered","status","createdAt","updatedAt"],"properties":{"amount":{"type":"string","example":"25.000000000000"},"bidId":{"type":"string","format":"uuid"},"bidderAgentId":{"type":"string","format":"uuid"},"createdAt":{"type":"string","format":"date-time"},"jobId":{"type":"string","format":"uuid"},"proposal":{"type":"string"},"slaSeconds":{"type":["integer","null"],"format":"int32","description":"The delivery window this bid promises; `None` means the agent's default `sla_seconds`."},"status":{"$ref":"#/components/schemas/BidStatus"},"updatedAt":{"type":"string","format":"date-time"},"verifiableOffered":{"type":"boolean"}}},
  "BidStatus": {"type":"string","description":"`Pending -> Accepted | Rejected | Withdrawn`; a bid still pending when its job ends is rejected.","enum":["pending","accepted","rejected","withdrawn"]},
  "PlaceBidRequest": {"type":"object","description":"Request body for placing a bid.","required":["amount","proposal"],"properties":{"agentId":{"type":["string","null"],"format":"uuid","description":"The bidding agent, for account callers bidding through one of their agents. Optional\nfor `aat_` agent callers \u2014 the bidder is pinned from the token; a mismatched explicit\nvalue is a 400."},"amount":{"type":"string","example":"25.00"},"asSelf":{"type":"boolean","description":"Bid as the account itself (`docs/human-worker-plan.md`): the person's worker row is\ncreated on the first such bid. Session callers only; exclusive with `agentId`."},"handle":{"type":["string","null"],"description":"With `asSelf` on a first bid: the previewed handle the person approved\n(`GET /v1/me/worker`). A stale preview answers 409 `handle_taken`."},"proposal":{"type":"string"},"slaSeconds":{"type":["integer","null"],"format":"int32","description":"The delivery window this bid promises, in seconds (1 to 30 days), snapshotted onto the\nassignment at award. Omitted: the agent's default `sla_seconds`."},"verifiableOffered":{"type":"boolean"}}},
  "MyAssignmentsResponse": {"type":"object","required":["assignments"],"properties":{"assignments":{"type":"array","items":{"$ref":"#/components/schemas/MyAssignmentItem"}}}},
  "MyAssignmentItem": {"type":"object","required":["assignment","job"],"properties":{"assignment":{"$ref":"#/components/schemas/JobAssignment"},"autoAcceptAt":{"type":["string","null"],"format":"date-time"},"job":{"$ref":"#/components/schemas/WorkerJobBrief"},"latestMessage":{"oneOf":[{"type":"null"},{"$ref":"#/components/schemas/LatestMessageBrief"}]}}},
  "JobAssignment": {"type":"object","required":["assignmentId","jobId","workerAgentId","status","escrowAmount","escrowToken","slaSeconds","slaDeadlineAt","acceptanceWindowDays","createdAt","updatedAt"],"properties":{"acceptanceWindowDays":{"type":"integer","format":"int32"},"assignmentId":{"type":"string","format":"uuid"},"bidId":{"type":["string","null"],"format":"uuid"},"cancelDetail":{"type":["string","null"]},"cancelReason":{"type":["string","null"]},"createdAt":{"type":"string","format":"date-time"},"deliverableHash":{"type":["string","null"]},"deliverableUrl":{"type":["string","null"]},"escrowAmount":{"type":"string"},"escrowToken":{"type":"string"},"finalizedAt":{"type":["string","null"],"format":"date-time"},"jobId":{"type":"string","format":"uuid"},"slaDeadlineAt":{"type":"string","format":"date-time"},"slaSeconds":{"type":"integer","format":"int32"},"startedAt":{"type":["string","null"],"format":"date-time"},"status":{"$ref":"#/components/schemas/AssignmentStatus"},"submittedAt":{"type":["string","null"],"format":"date-time"},"updatedAt":{"type":"string","format":"date-time"},"workerAgentId":{"type":"string","format":"uuid"}}},
  "AssignmentStatus": {"type":"string","enum":["in_progress","submitted","accepted","disputed","dispute_resolved","cancelled"]},
  "WorkerJobBrief": {"type":"object","required":["jobId","title","description","tags","jobKind","status","attachments"],"properties":{"attachments":{"type":"array","items":{"$ref":"#/components/schemas/AttachmentBrief"}},"description":{"type":"string"},"entriesCloseAt":{"type":["string","null"],"format":"date-time"},"jobId":{"type":"string","format":"uuid"},"jobKind":{"$ref":"#/components/schemas/JobKind"},"status":{"$ref":"#/components/schemas/JobStatus"},"tags":{"type":"array","items":{"type":"string"}},"title":{"type":"string"}}},
  "JobKind": {"type":"string","enum":["standard","instant","competition"]},
  "JobStatus": {"type":"string","enum":["open","filling","in_progress","completed","closed"]},
  "AttachmentBrief": {"type":"object","required":["id","filename","contentType","byteSize","sha256","createdAt","downloadUrl"],"properties":{"byteSize":{"type":"integer","format":"int64"},"contentType":{"type":"string"},"createdAt":{"type":"string","format":"date-time"},"downloadUrl":{"type":"string"},"filename":{"type":"string"},"id":{"type":"string","format":"uuid"},"sha256":{"type":"string"}}},
  "LatestMessageBrief": {"type":"object","required":["senderSide","origin","body","truncated","attachments","createdAt"],"properties":{"attachments":{"type":"array","items":{"$ref":"#/components/schemas/AttachmentBrief"}},"body":{"type":"string"},"createdAt":{"type":"string","format":"date-time"},"origin":{"$ref":"#/components/schemas/MessageOrigin"},"senderSide":{"type":"string"},"truncated":{"type":"boolean"}}},
  "MessageOrigin": {"type":"string","enum":["direct","axi","mcp","platform"]},
  "StartAssignmentResponse": {"type":"object","required":["startedAt"],"properties":{"startedAt":{"type":"string","format":"date-time"}}},
  "DeclineAssignmentRequest": {"type":"object","properties":{"detail":{"type":["string","null"]},"reason":{"oneOf":[{"type":"null"},{"$ref":"#/components/schemas/WorkerCancelReason"}]}}},
  "WorkerCancelReason": {"type":"string","enum":["rejected","failed"]},
  "ReportProgressRequest": {"type":"object","required":["message"],"properties":{"message":{"type":"string"},"percent":{"type":["integer","null"],"format":"int32","maximum":100,"minimum":0}}},
  "WorkerProgressReport": {"type":"object","required":["assignmentId","message","reportedAt"],"properties":{"assignmentId":{"type":"string","format":"uuid"},"message":{"type":"string"},"percent":{"type":["integer","null"],"format":"int32"},"reportedAt":{"type":"string","format":"date-time"}}},
  "SendMessageRequest": {"type":"object","required":["body"],"properties":{"attachmentIds":{"type":"array","items":{"type":"string","format":"uuid"}},"body":{"type":"string"},"clientRequestId":{"type":["string","null"]}}},
  "AssignmentMessage": {"type":"object","required":["messageId","assignmentId","senderAccountId","origin","body","createdAt"],"properties":{"assignmentId":{"type":"string","format":"uuid"},"body":{"type":"string"},"createdAt":{"type":"string","format":"date-time"},"messageId":{"type":"string","format":"uuid"},"origin":{"$ref":"#/components/schemas/MessageOrigin"},"senderAccountId":{"type":"string","format":"uuid"},"senderAgentId":{"type":["string","null"],"format":"uuid"}}},
  "ReserveFileRequest": {"type":"object","required":["filename","byteSize"],"properties":{"byteSize":{"type":"integer","format":"int64"},"filename":{"type":"string"},"link":{"type":"boolean"}}},
  "ReserveFileResponse": {"type":"object","required":["fileId","uploadUrl","directUploadUrl","byteSize","expiresInSecs"],"properties":{"byteSize":{"type":"integer","format":"int64"},"directUploadUrl":{"type":"string"},"expiresInSecs":{"type":"integer","format":"int64","minimum":0},"fileId":{"type":"string","format":"uuid"},"fileUrl":{"type":["string","null"]},"uploadUrl":{"type":"string"}}},
  "CompleteFileResponse": {"type":"object","required":["fileId","filename","byteSize","sha256","contentType"],"properties":{"byteSize":{"type":"integer","format":"int64"},"contentType":{"type":"string"},"fileId":{"type":"string","format":"uuid"},"filename":{"type":"string"},"sha256":{"type":"string"}}},
  "SubmitRequest": {"type":"object","required":["deliverableMarkdown"],"properties":{"deliverableMarkdown":{"type":"string"},"files":{"type":"array","items":{"type":"string"}}}},
  "ThreadMessage": {"allOf":[{"$ref":"#/components/schemas/AssignmentMessage"},{"type":"object","required":["attachments"],"properties":{"attachments":{"type":"array","items":{"$ref":"#/components/schemas/AttachmentBrief"}}}}]},
  "AgentPublic": {"type":"object","required":["agent_id","owner_account_id","handle","name","category","tags","runtime","listing_status","delivered_jobs","sla_seconds","required_slots","funding_paused","availability","created_at","updated_at"],"properties":{"agent_id":{"type":"string","format":"uuid"},"availability":{"$ref":"#/components/schemas/AgentAvailability"},"available_now":{"type":["boolean","null"]},"avatar_url":{"type":["string","null"]},"bio_markdown":{"type":["string","null"]},"builder":{"oneOf":[{"type":"null"},{"$ref":"#/components/schemas/BuilderSummary"}]},"category":{"$ref":"#/components/schemas/Category"},"created_at":{"type":"string","format":"date-time"},"delivered_jobs":{"type":"integer","format":"int32"},"description":{"type":["string","null"]},"funding_paused":{"type":"boolean"},"handle":{"type":"string"},"input_schema":{},"listing_status":{"$ref":"#/components/schemas/ListingStatus"},"media":{"type":"array","items":{"$ref":"#/components/schemas/AgentMediaPublic"}},"name":{"type":"string"},"output_schema":{},"owner_account_id":{"type":"string","format":"uuid"},"payable_with":{"type":["array","null"],"items":{"type":"string"}},"required_slots":{"type":"array","items":{"$ref":"#/components/schemas/RequiredSlot"}},"response_time_seconds_median":{"type":["integer","null"],"format":"int32"},"runtime":{"$ref":"#/components/schemas/Runtime"},"sla_seconds":{"type":"integer","format":"int32"},"success_rate":{"type":["integer","null"],"format":"int32"},"tags":{"type":"array","items":{"type":"string"}},"updated_at":{"type":"string","format":"date-time"}}},
  "AgentAvailability": {"type":"string","enum":["available","paused","suspended","unavailable_funding"]},
  "BuilderSummary": {"type":"object","required":["account_id","display_name","verification"],"properties":{"account_id":{"type":"string","format":"uuid"},"display_name":{"type":"string"},"proven":{"oneOf":[{"type":"null"},{"$ref":"#/components/schemas/ProvenChip"}]},"verification":{"$ref":"#/components/schemas/BuilderVerification"}}},
  "ProvenChip": {"type":"object","required":["jobs","acceptance_pct","buyers","dispute_window_days"],"properties":{"acceptance_pct":{"type":"integer","format":"int64"},"buyers":{"type":"integer","format":"int64"},"dispute_window_days":{"type":"integer","format":"int64"},"jobs":{"type":"integer","format":"int64"}}},
  "BuilderVerification": {"type":"object","required":["level"],"properties":{"level":{"$ref":"#/components/schemas/VerificationLevel"},"since":{"type":["string","null"],"format":"date-time"}}},
  "VerificationLevel": {"type":"string","enum":["none","verified","identity_verified"]},
  "Category": {"type":"string","enum":["automation","creative","customer_support","data","dev_tools","events","finance","legal_compliance","marketing","operations","research","sales","travel","other"]},
  "ListingStatus": {"type":"string","enum":["draft","live","paused","archived"]},
  "AgentMediaPublic": {"type":"object","required":["media_id","kind","url"],"properties":{"caption":{"type":["string","null"]},"embed_url":{"type":["string","null"]},"height":{"type":["integer","null"],"format":"int32"},"kind":{"$ref":"#/components/schemas/AgentMediaKind"},"media_id":{"type":"string","format":"uuid"},"provider":{"oneOf":[{"type":"null"},{"$ref":"#/components/schemas/VideoProvider"}]},"thumbnail_url":{"type":["string","null"]},"url":{"type":"string"},"width":{"type":["integer","null"],"format":"int32"}}},
  "AgentMediaKind": {"type":"string","enum":["image","video"]},
  "VideoProvider": {"type":"string","enum":["youtube","vimeo","loom"]},
  "RequiredSlot": {"type":"object","required":["key","label"],"properties":{"access":{"oneOf":[{"type":"null"},{"$ref":"#/components/schemas/SlotAccess"}]},"capability":{"type":["string","null"]},"connector_slugs":{"type":"array","items":{"type":"string"}},"hint":{"type":["string","null"]},"key":{"type":"string"},"label":{"type":"string"},"optional":{"type":"boolean"}}},
  "SlotAccess": {"type":"string","enum":["read","full"]},
  "Runtime": {"type":"string","enum":["http","managed","human"]},
  "PricingPlan": {"type":"object","required":["pricing_plan_id","agent_id","model","price_amount","is_default","listing_status","created_at","updated_at"],"properties":{"agent_id":{"type":"string","format":"uuid"},"billing_period":{"type":["string","null"]},"config":{},"created_at":{"type":"string","format":"date-time"},"description":{"type":["string","null"]},"display_name":{"type":["string","null"]},"is_default":{"type":"boolean"},"listing_status":{"$ref":"#/components/schemas/ListingStatus"},"model":{"$ref":"#/components/schemas/PricingModel"},"price_amount":{"type":"string"},"pricing_plan_id":{"type":"string","format":"uuid"},"sla_seconds":{"type":["integer","null"],"format":"int32"},"task_unit":{"type":["string","null"]},"updated_at":{"type":"string","format":"date-time"}}},
  "PricingModel": {"type":"string","enum":["per_call","per_task","subscription"]},
  "PatchPricingPlanRequest": {"type":"object","properties":{"billing_period":{"type":["string","null"]},"config":{},"description":{"type":["string","null"]},"display_name":{"type":["string","null"]},"listing_status":{"oneOf":[{"type":"null"},{"$ref":"#/components/schemas/ListingStatus"}]},"price_amount":{"type":["string","null"]},"sla_seconds":{"type":["integer","null"],"format":"int32"},"task_unit":{"type":["string","null"]}}},
});

/* ------------------------------------------------------------------ */
/* A small validator for the schema subset above                      */
/* ------------------------------------------------------------------ */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);

/**
 * Check a value against a schema of MARKET_SCHEMAS. `strict` also flags
 * object keys the schema does not name (used for request bodies, so a typo in
 * a field name fails the test instead of being silently ignored).
 * @returns {string[]} problems, empty when the value conforms
 */
export function validate(schemaOrName, value, { strict = false } = {}) {
  const check = (s, v, p) => {
    if (s && s.$ref) s = MARKET_SCHEMAS[s.$ref.split("/").pop()];
    if (!s || typeof s !== "object") return [];
    if (s.allOf) return s.allOf.flatMap((x) => check(x, v, p));
    if (s.oneOf) return s.oneOf.some((x) => check(x, v, p).length === 0) ? [] : [`${p}: matches none of oneOf`];
    const errs = [];
    if (s.type) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      const t = typeOf(v);
      if (!types.includes(t) && !(t === "integer" && types.includes("number"))) return [`${p}: expected ${types.join("|")}, got ${t}`];
    }
    if (s.enum && !s.enum.includes(v)) errs.push(`${p}: ${JSON.stringify(v)} not in ${s.enum.join("|")}`);
    if (typeof v === "string" && s.format === "uuid" && !UUID.test(v)) errs.push(`${p}: not a uuid`);
    if (typeof v === "string" && s.format === "date-time" && Number.isNaN(Date.parse(v))) errs.push(`${p}: not a date-time`);
    if (typeof v === "number" && s.minimum != null && v < s.minimum) errs.push(`${p}: below ${s.minimum}`);
    if (typeof v === "number" && s.maximum != null && v > s.maximum) errs.push(`${p}: above ${s.maximum}`);
    if (typeOf(v) === "object") {
      for (const k of s.required || []) if (!(k in v)) errs.push(`${p}: missing required ${k}`);
      const props = s.properties || {};
      for (const [k, x] of Object.entries(v)) {
        if (props[k]) errs.push(...check(props[k], x, `${p}.${k}`));
        else if (strict && s.properties) errs.push(`${p}: unknown field ${k}`);
      }
    }
    if (Array.isArray(v) && s.items) v.forEach((x, i) => errs.push(...check(s.items, x, `${p}[${i}]`)));
    return errs;
  };
  return check(typeof schemaOrName === "string" ? { $ref: `#/components/schemas/${schemaOrName}` } : schemaOrName, value, "$");
}

/* ------------------------------------------------------------------ */
/* The market stand-in                                                 */
/* ------------------------------------------------------------------ */

export const MOCK_TOKEN = "aat_" + "0123456789abcdef".repeat(2);
const MAX_MARKDOWN = 256 * 1024;
const MAX_FILE = 100 * 1024 * 1024;

/**
 * In-process NEAR Agent Market stand-in over real HTTP (127.0.0.1, random port).
 * Worker-side routes follow the OpenAPI subset above; every request body is
 * checked against its request schema (strictly) and every JSON answer against
 * its response schema, and anything off is recorded in `violations`.
 *
 * Buyer-side helpers (hire, requestChanges, accept, cancel) change the state
 * directly, as the website would. `fault()` makes the next matching request
 * fail: `drop` handles it and then cuts the connection with no answer (the
 * request took effect, the caller cannot know), `status` answers an error
 * without handling it.
 *
 * Agents: the mock starts with one agent (`token`, `handle`, `priceAmount`,
 * `listingStatus`); `addAgent()` adds more, each with its own token. Every
 * worker route acts only on the calling token's agent. `hire({ agent })` picks
 * the agent by handle (default: the first).
 *
 * `tokenReadsDraft` (default true): an agent's own token reads its agent and
 * plans when they are not live. `pricePatch`: "forbidden" (default; 403 to an
 * agent token) or "allowed" (the token may change its own plans' price).
 */
export function createMarketMock({
  token = MOCK_TOKEN, handle = "nanoodle-test", priceAmount = "1.00", listingStatus = "live",
  tokenReadsDraft = true, pricePatch = "forbidden", now = () => Date.now(),
} = {}) {
  const ownerAccountId = randomUUID();
  const agents = new Map(); // agentId -> { agentId, handle, token, listingStatus, plans: [PricingPlan] }
  const iso0 = () => new Date(now()).toISOString();
  function addAgent({ handle: h, token: t, priceAmount: price = "1.00", listingStatus: st = "live" }) {
    const id = randomUUID();
    const plan = {
      pricing_plan_id: randomUUID(), agent_id: id, model: "per_call", display_name: "Default", description: null,
      price_amount: String(price), sla_seconds: null, billing_period: null, task_unit: null, config: null,
      is_default: true, listing_status: st, created_at: iso0(), updated_at: iso0(),
    };
    const ag = { agentId: id, handle: h, token: t, listingStatus: st, plans: [plan], createdAt: iso0() };
    agents.set(id, ag);
    return ag;
  }
  const agentByHandle = (h) => [...agents.values()].find((x) => x.handle === h) || null;
  const primary = addAgent({ handle, token, priceAmount, listingStatus });
  const agentId = primary.agentId;
  const opts = { tokenReadsDraft, pricePatch };
  const rows = new Map(); // assignmentId -> { assignment, job, latestMessage, messages, progress, versions, lastProgressAt }
  const files = new Map(); // fileId -> { fileId, filename, byteSize, token, link, bytes, completed, jobId }
  const requests = [];
  const violations = [];
  const faults = [];
  let url = null;
  let server = null;
  const iso = (ms = now()) => new Date(ms).toISOString();

  function hire({ title = "nanoodle workflow", description, priceUsd = "1.000000000000", escrowToken = "USD", slaSeconds = 3600, jobKind = "instant", agent = null }) {
    const t = now();
    const worker = agent ? agentByHandle(agent) : primary;
    if (!worker) throw new Error(`mock: no agent ${agent}`);
    const assignmentId = randomUUID();
    const jobId = randomUUID();
    rows.set(assignmentId, {
      assignment: {
        assignmentId, jobId, workerAgentId: worker.agentId, bidId: null, status: "in_progress",
        escrowAmount: priceUsd, escrowToken, slaSeconds, slaDeadlineAt: iso(t + slaSeconds * 1000),
        acceptanceWindowDays: 3, createdAt: iso(t), updatedAt: iso(t),
        startedAt: null, submittedAt: null, deliverableUrl: null, deliverableHash: null,
        cancelReason: null, cancelDetail: null, finalizedAt: null,
      },
      job: { jobId, title, description, tags: ["workflow"], jobKind, status: "in_progress", attachments: [], entriesCloseAt: null },
      latestMessage: null, autoAcceptAt: null,
      messages: [], progress: [], versions: [], lastProgressAt: 0, refunded: false, seq: rows.size,
    });
    return assignmentId;
  }

  const board = new Map(); // jobId -> { job (JobView), bids: [Bid] }
  /** Post a public job on the board. */
  function postJob({ title = "Run my workflow", description, budgetAmount = null, budgetToken = "USDC", minBuilderVerification = "none", jobKind = "standard" }) {
    const jobId = randomUUID();
    board.set(jobId, {
      job: {
        jobId, title, description, budgetAmount, budgetToken, minBuilderVerification, jobKind, status: "open", isPrivate: false, isTestRun: false,
        maxSlots: 1, currentMaxSlots: 1, tags: [], acceptanceWindowDays: 3, entriesCloseAt: null, createdAt: iso(), updatedAt: iso(),
      },
      bids: [],
    });
    return jobId;
  }
  /** Award a bid: the job leaves the board and becomes an assignment with the bid's amount in escrow. */
  function award(jobId, bidId) {
    const b = board.get(jobId);
    const bid = b && b.bids.find((x) => x.bidId === bidId);
    if (!bid || bid.status !== "pending") throw new Error("mock: no pending bid to award");
    bid.status = "accepted";
    b.job.status = "in_progress";
    const id = hire({ title: b.job.title, description: b.job.description, priceUsd: bid.amount, escrowToken: b.job.budgetToken, jobKind: "standard", agent: [...agents.values()].find((x) => x.agentId === bid.bidderAgentId).handle, slaSeconds: bid.slaSeconds || 3600 });
    const r = rows.get(id);
    r.assignment.bidId = bidId;
    r.assignment.jobId = jobId;
    r.job.jobId = jobId;
    return id;
  }

  const touch = (r) => { r.assignment.updatedAt = iso(); };
  const pushMessage = (r, side, body, extra = {}) => {
    const m = {
      messageId: randomUUID(), assignmentId: r.assignment.assignmentId,
      senderAccountId: side === "worker" ? ownerAccountId : randomUUID(), senderAgentId: side === "worker" ? r.assignment.workerAgentId : null,
      origin: "direct", body, createdAt: iso(), attachments: [], senderSide: side, ...extra,
    };
    r.messages.push(m);
    r.latestMessage = { senderSide: side, origin: "direct", body: body.slice(0, 4000), truncated: body.length > 4000, attachments: [], createdAt: m.createdAt };
    return m;
  };

  function requestChanges(id, body) {
    const r = rows.get(id);
    r.assignment.status = "in_progress";
    r.assignment.slaDeadlineAt = iso(now() + r.assignment.slaSeconds * 1000 + 1000 * (r.versions.length + 1));
    r.autoAcceptAt = null;
    touch(r);
    pushMessage(r, "buyer", body);
  }
  function accept(id) {
    const r = rows.get(id);
    r.assignment.status = "accepted";
    r.assignment.finalizedAt = iso();
    touch(r);
  }
  function cancel(id) {
    const r = rows.get(id);
    r.assignment.status = "cancelled";
    r.assignment.cancelReason = "buyer_cancelled";
    r.assignment.finalizedAt = iso();
    r.refunded = true;
    touch(r);
  }

  const publicAssignment = (r) => {
    const a = { ...r.assignment };
    if (a.deliverableUrl) a.deliverableUrl = `/v1/assignments/${a.assignmentId}/deliverable/raw`;
    return a;
  };
  const item = (r) => ({ assignment: publicAssignment(r), job: { ...r.job }, latestMessage: r.latestMessage, autoAcceptAt: r.autoAcceptAt });

  function resolveFileRef(ref) {
    const s = String(ref);
    for (const f of files.values()) {
      if (f.fileId === s || f.token === s || (f.link && s === `${url}/files/${f.token}/${f.filename}`)) return f;
    }
    return null;
  }

  function contentTypeOf(name) {
    const ext = (name.split(".").pop() || "").toLowerCase();
    return { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", mp4: "video/mp4", mp3: "audio/mpeg", wav: "audio/wav", glb: "model/gltf-binary", md: "text/markdown", txt: "text/plain" }[ext] || "application/octet-stream";
  }

  /** Route one request. Returns { status, json?, headers? }. */
  function route(method, path, query, body, headers) {
    const err = (status, code, message, extra = {}) => ({ status, json: { error: code, ...(message ? { message } : {}), ...extra } });
    const bodyCheck = (schema) => {
      const v = validate(schema, body, { strict: true });
      if (v.length) { violations.push(`${method} ${path} request: ${v.join("; ")}`); return err(400, "validation_error", v.join("; ")); }
      return null;
    };

    let m;
    const storage = /^\/_storage\/([0-9a-f-]{36})$/.exec(path);
    if (storage && method === "PUT") {
      const f = files.get(storage[1]);
      if (!f) return { status: 404, text: "NoSuchUpload" };
      if (headers.authorization) violations.push("PUT to the presigned upload URL carried an Authorization header");
      if (!Buffer.isBuffer(body) || body.length !== f.byteSize) return { status: 400, text: `expected exactly ${f.byteSize} bytes` };
      f.bytes = Buffer.from(body);
      return { status: 200, text: "" };
    }
    if (method === "GET" && (m = /^\/files\/([^/]+)\/(.+)$/.exec(path))) {
      const f = [...files.values()].find((x) => x.token === m[1] && x.completed && x.link);
      return f ? { status: 200, raw: f.bytes, headers: { "content-type": contentTypeOf(f.filename) } } : { status: 404, text: "not found" };
    }

    const caller = [...agents.values()].find((x) => headers.authorization === `Bearer ${x.token}`) || null;

    // Listings and prices: public reads (an agent's own token may also see its drafts).
    const publicAgent = (ag) => ({
      agent_id: ag.agentId, owner_account_id: ownerAccountId, handle: ag.handle, name: ag.handle, description: null, bio_markdown: null,
      avatar_url: null, category: "creative", tags: ["workflow"], runtime: "http", listing_status: ag.listingStatus,
      delivered_jobs: 0, success_rate: null, response_time_seconds_median: null, sla_seconds: 3600, required_slots: [],
      funding_paused: false, availability: "available", available_now: ag.listingStatus === "live", builder: null,
      payable_with: ["USD", "USDC"], media: [], created_at: ag.createdAt, updated_at: ag.createdAt,
    });
    const ownerView = (ag) => caller && caller.agentId === ag.agentId && opts.tokenReadsDraft;
    if (method === "GET" && (m = /^\/v1\/agents\/([^/]+)\/pricing-plans$/.exec(path))) {
      if (!UUID.test(m[1])) return err(400, "validation_error", "agent_id must be a uuid");
      const ag = agents.get(m[1]);
      if (!ag || (ag.listingStatus !== "live" && !ownerView(ag))) return err(404, "not_found", "not found");
      const plans = ownerView(ag) ? ag.plans : ag.plans.filter((p) => p.listing_status === "live");
      return { status: 200, json: plans.map((p) => ({ ...p })), schema: { type: "array", items: { $ref: "#/components/schemas/PricingPlan" } } };
    }
    if (method === "GET" && (m = /^\/v1\/agents\/([^/]+)$/.exec(path)) && m[1] !== "me") {
      const ag = agents.get(m[1]) || agentByHandle(m[1]);
      if (!ag || (ag.listingStatus !== "live" && !ownerView(ag))) return err(404, "not_found", "not found");
      return { status: 200, json: publicAgent(ag), schema: "AgentPublic" };
    }
    if (method === "PATCH" && (m = /^\/v1\/pricing-plans\/([^/]+)$/.exec(path))) {
      if (!caller) return err(401, "unauthorized");
      const ag = [...agents.values()].find((x) => x.plans.some((p) => p.pricing_plan_id === m[1]));
      if (!ag) return err(404, "not_found");
      if (opts.pricePatch !== "allowed" || ag.agentId !== caller.agentId) return err(403, "forbidden", "not a member of the owning account");
      const bad = bodyCheck("PatchPricingPlanRequest"); if (bad) return bad;
      const plan = ag.plans.find((p) => p.pricing_plan_id === m[1]);
      if (body.price_amount != null) {
        if (!/^\d+(\.\d{1,6})?$/.test(body.price_amount) || Number(body.price_amount) <= 0) return err(400, "validation_error", "unparseable price");
        plan.price_amount = Number(body.price_amount).toFixed(4);
      }
      plan.updated_at = iso();
      return { status: 200, json: { ...plan }, schema: "PricingPlan" };
    }

    if (!caller) return err(401, "unauthorized");
    const mine = (r) => r && r.assignment.workerAgentId === caller.agentId;

    if (method === "GET" && path === "/v1/jobs/board") {
      const q = (query.get("q") || "").toLowerCase();
      const kind = query.get("kind");
      const limit = query.has("limit") ? Number(query.get("limit")) : 50;
      if (!(Number.isInteger(limit) && limit >= 1 && limit <= 100)) return err(400, "validation_error", "limit 1..=100");
      const jobs = [...board.values()].map((b) => b.job)
        .filter((j) => (j.status === "open" || j.status === "filling") && (!kind || j.jobKind === kind) && (!q || `${j.title}\n${j.description}`.toLowerCase().includes(q)))
        .reverse().slice(0, limit).map((j) => ({ ...j }));
      return { status: 200, json: { jobs } };
    }
    if (method === "POST" && (m = /^\/v1\/jobs\/([^/]+)\/bids$/.exec(path))) {
      const b = board.get(m[1]);
      if (!b) return err(404, "not_found", "no such job");
      const bad = bodyCheck("PlaceBidRequest"); if (bad) return bad;
      if (b.job.status !== "open" && b.job.status !== "filling") return err(400, "invalid_state_transition", "the job takes no bids");
      if (b.job.minBuilderVerification !== "none") return err(400, "builder_verification_required", `this job asks for ${b.job.minBuilderVerification}; your owner holds none`);
      if (!/^\d+(\.\d{1,6})?$/.test(body.amount) || Number(body.amount) <= 0) return err(400, "validation_error", "amount must be greater than zero");
      if (b.bids.some((x) => x.bidderAgentId === caller.agentId)) return err(409, "duplicate_bid", "one bid per job");
      const bid = {
        bidId: randomUUID(), jobId: m[1], bidderAgentId: caller.agentId, amount: Number(body.amount).toFixed(12), proposal: body.proposal,
        slaSeconds: body.slaSeconds ?? null, verifiableOffered: false, status: "pending", createdAt: iso(), updatedAt: iso(),
      };
      b.bids.push(bid);
      return { status: 201, json: { ...bid }, schema: "Bid" };
    }

    if (method === "GET" && path === "/v1/agents/me/assignments") {
      const status = query.get("status") || "in_progress";
      const limit = query.has("limit") ? Number(query.get("limit")) : 50;
      const offset = query.has("offset") ? Number(query.get("offset")) : 0;
      if (!(Number.isInteger(limit) && limit >= 1 && limit <= 100) || !(Number.isInteger(offset) && offset >= 0)) return err(400, "validation_error", "limit 1..=100, offset >= 0");
      const statuses = MARKET_SCHEMAS.AssignmentStatus.enum;
      if (status !== "all" && !statuses.includes(status)) return err(400, "validation_error", "bad status filter");
      const list = [...rows.values()].filter((r) => mine(r) && (status === "all" || r.assignment.status === status)).sort((a, b) => b.seq - a.seq);
      return { status: 200, json: { assignments: list.slice(offset, offset + limit).map(item) }, schema: "MyAssignmentsResponse" };
    }

    if ((m = /^\/v1\/assignments\/([^/]+)\/(start|decline|progress|messages|submit)$/.exec(path)) && method === "POST") {
      const r = rows.get(m[1]);
      if (!r || !mine(r)) return err(404, "not_found");
      const a = r.assignment;
      switch (m[2]) {
        case "start": {
          if (a.status !== "in_progress" && !a.startedAt) return err(400, "invalid_state_transition", `cannot transition from '${a.status}' to 'started'`);
          if (!a.startedAt) { a.startedAt = iso(); touch(r); }
          return { status: 200, json: { startedAt: a.startedAt }, schema: "StartAssignmentResponse" };
        }
        case "decline": {
          const bad = bodyCheck("DeclineAssignmentRequest"); if (bad) return bad;
          if (!body.reason) return err(400, "validation_error", "an agent's decline needs a reason");
          if (r.job.jobKind === "competition") return err(400, "competition_entry");
          if (a.status !== "in_progress") return err(400, "invalid_state_transition", `cannot transition from '${a.status}' to 'cancelled'`);
          if (body.reason === "rejected" && a.deliverableUrl) return err(400, "validation_error", "rejected after a delivery");
          if (body.detail != null && body.detail.length > 1000) return err(400, "validation_error", "detail over 1000 characters");
          a.status = "cancelled"; a.cancelReason = body.reason; a.cancelDetail = body.detail ?? null; a.finalizedAt = iso();
          r.refunded = true; touch(r);
          return { status: 200, json: publicAssignment(r), schema: "JobAssignment" };
        }
        case "progress": {
          const bad = bodyCheck("ReportProgressRequest"); if (bad) return bad;
          const msg = body.message.trim();
          if (msg.length < 1 || msg.length > 280) return err(400, "validation_error", "message 1-280 characters");
          if (a.status !== "in_progress") return err(400, "invalid_state_transition");
          const since = now() - r.lastProgressAt;
          if (r.lastProgressAt && since < 30_000) {
            const ra = Math.ceil((30_000 - since) / 1000);
            return { status: 409, json: { error: "progress_report_too_soon", message: "one report per 30 seconds", retry_after: ra }, headers: { "retry-after": String(ra) } };
          }
          r.lastProgressAt = now();
          const rep = { assignmentId: a.assignmentId, message: msg, percent: body.percent ?? null, reportedAt: iso() };
          r.progress.push(rep);
          return { status: 200, json: rep, schema: "WorkerProgressReport" };
        }
        case "messages": {
          const bad = bodyCheck("SendMessageRequest"); if (bad) return bad;
          if (a.status === "cancelled" || a.status === "accepted") return err(400, "invalid_state_transition");
          if (body.clientRequestId) {
            const prev = r.messages.find((x) => x.clientRequestId === body.clientRequestId);
            if (prev && prev.body !== body.body) return err(400, "validation_error", "clientRequestId reused with other text");
            if (prev) { const { senderSide, clientRequestId, ...wire } = prev; return { status: 201, json: wire, schema: "ThreadMessage" }; }
          }
          const msg = pushMessage(r, "worker", body.body, { clientRequestId: body.clientRequestId || null });
          const { senderSide, clientRequestId, ...wire } = msg;
          return { status: 201, json: wire, schema: "ThreadMessage" };
        }
        case "submit": {
          const bad = bodyCheck("SubmitRequest"); if (bad) return bad;
          const md = body.deliverableMarkdown;
          const size = Buffer.byteLength(md);
          if (size < 1 || size > MAX_MARKDOWN) return err(400, "invalid_deliverable", "1 byte to 256 KiB");
          const listed = body.files || [];
          const resolved = [];
          for (const [i, ref] of listed.entries()) {
            const f = resolveFileRef(ref);
            if (!f || !f.completed) return err(400, "invalid_attachment", `files[${i}]: unknown or unconfirmed`);
            if (f.jobId && f.jobId !== a.jobId) return err(400, "invalid_attachment", `files[${i}]: it is part of another job`);
            resolved.push(f);
          }
          if (resolved.length > 5) return err(400, "invalid_attachment", "at most 5 files");
          if (resolved.reduce((n, f) => n + f.byteSize, 0) > MAX_FILE) return err(400, "invalid_attachment", "files over 100 MiB together");
          const hash = createHash("sha256").update(md).digest("hex");
          const fileSet = resolved.map((f) => f.fileId).sort().join(",");
          const last = r.versions[r.versions.length - 1];
          if (a.status === "submitted" && last && last.hash === hash && last.fileSet === fileSet) {
            return { status: 200, json: publicAssignment(r), schema: "JobAssignment" }; // identical resubmission: a no-op
          }
          if (a.status !== "in_progress" && a.status !== "submitted") return err(400, "invalid_state_transition", `cannot transition from '${a.status}' to 'submitted'`);
          for (const f of resolved) f.jobId = a.jobId;
          r.versions.push({ version: r.versions.length + 1, markdown: md, hash, fileSet, files: resolved.map((f) => f.fileId), at: iso() });
          a.status = "submitted"; a.submittedAt = iso(); a.deliverableHash = hash; a.deliverableUrl = `deliverables/${a.assignmentId}/v${r.versions.length}.md`;
          r.autoAcceptAt = iso(now() + 3 * 86_400_000);
          touch(r);
          return { status: 200, json: publicAssignment(r), schema: "JobAssignment" };
        }
      }
    }

    if (method === "POST" && path === "/v1/files") {
      const bad = bodyCheck("ReserveFileRequest"); if (bad) return bad;
      if (!(Number.isInteger(body.byteSize) && body.byteSize > 0)) return err(400, "invalid_byte_size");
      if (body.byteSize > MAX_FILE) return err(413, "payload_too_large");
      if (/\.(exe|msi|dmg|sh|bat)$/i.test(body.filename)) return err(400, "invalid_file_type");
      const fileId = randomUUID();
      const tok = randomBytes(12).toString("hex");
      files.set(fileId, { fileId, filename: body.filename, byteSize: body.byteSize, token: tok, link: !!body.link, bytes: null, completed: false, jobId: null });
      return {
        status: 201,
        json: {
          fileId, byteSize: body.byteSize, expiresInSecs: 1800,
          uploadUrl: `${url}/_sink/${fileId}`, directUploadUrl: `${url}/_storage/${fileId}`,
          fileUrl: body.link ? `${url}/files/${tok}/${body.filename}` : null,
        },
        schema: "ReserveFileResponse",
      };
    }
    if ((m = /^\/v1\/files\/([^/]+)\/complete$/.exec(path)) && method === "POST") {
      const f = files.get(m[1]);
      if (!f) return err(404, "not_found");
      if (f.completed) return err(409, "upload_not_pending");
      if (!f.bytes) return err(400, "upload_incomplete");
      f.completed = true;
      return {
        status: 200,
        json: { fileId: f.fileId, filename: f.filename, byteSize: f.byteSize, sha256: createHash("sha256").update(f.bytes).digest("hex"), contentType: contentTypeOf(f.filename) },
        schema: "CompleteFileResponse",
      };
    }
    if ((m = /^\/v1\/files\/([^/]+)$/.exec(path)) && method === "DELETE") {
      const f = files.get(m[1]);
      if (!f) return err(404, "not_found");
      if (f.jobId) return err(409, "file_bound");
      files.delete(m[1]);
      return { status: 204 };
    }
    return err(404, "not_found", `mock: no route for ${method} ${path}`);
  }

  async function onRequest(req, res) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const u = new URL(req.url, "http://x");
    let body;
    const isJson = /json/.test(req.headers["content-type"] || "");
    if (isJson) { try { body = JSON.parse(raw.toString("utf8")); } catch { body = undefined; } } else body = raw.length ? raw : undefined;
    const entry = { method: req.method, path: u.pathname, query: u.search, body: isJson ? body : (raw.length ? `<${raw.length} bytes>` : undefined), auth: !!req.headers.authorization, at: now() };
    requests.push(entry);

    const fi = faults.findIndex((f) => f.method === req.method && f.path.test(u.pathname));
    const fault = fi >= 0 ? faults[fi] : null;
    if (fault && --fault.times <= 0) faults.splice(fi, 1);
    if (fault && fault.mode === "status") {
      entry.fault = `status ${fault.status}`;
      res.writeHead(fault.status, { "content-type": "application/json" });
      res.end(JSON.stringify(fault.body || { error: "internal_error" }));
      return;
    }
    const out = route(req.method, u.pathname, u.searchParams, body, req.headers);
    entry.status = out.status;
    if (out.schema && out.status < 300) {
      const v = validate(out.schema, out.json);
      if (v.length) violations.push(`${req.method} ${u.pathname} response: ${v.join("; ")}`);
    }
    if (fault && fault.mode === "drop") {
      entry.fault = "response dropped";
      req.socket.destroy(); // the request took effect; the caller never hears back
      return;
    }
    if (out.raw) { res.writeHead(out.status, out.headers || {}); res.end(out.raw); return; }
    if (out.json !== undefined) {
      res.writeHead(out.status, { "content-type": "application/json", ...(out.headers || {}) });
      res.end(JSON.stringify(out.json));
      return;
    }
    res.writeHead(out.status, { "content-type": "text/plain" });
    res.end(out.text || "");
  }

  return {
    agentId,
    agents,
    /** Add a listing with its own token: { handle, token, priceAmount?, listingStatus? }. */
    addAgent,
    agent: agentByHandle,
    /** Change a listing's default price on the market (as its owner would on the website). */
    setPrice(h, amount) { const p = agentByHandle(h).plans.find((x) => x.is_default); p.price_amount = String(amount); p.updated_at = iso(); },
    /** Change a listing's status (the agent and its plans), e.g. "draft" → "live". */
    setListingStatus(h, st) { const ag = agentByHandle(h); ag.listingStatus = st; for (const p of ag.plans) p.listing_status = st; },
    /** "allowed" | "forbidden": may an agent token PATCH its own plan's price. */
    set pricePatch(v) { opts.pricePatch = v; },
    get pricePatch() { return opts.pricePatch; },
    set tokenReadsDraft(v) { opts.tokenReadsDraft = !!v; },
    rows,
    files,
    requests,
    violations,
    hire, requestChanges, accept, cancel, postJob, award, board,
    get url() { return url; },
    /** Make the next `times` requests matching method + path fail. mode "drop" (handled, no answer) or "status". */
    fault({ method, path, mode = "drop", status = 503, body = null, times = 1 }) {
      faults.push({ method, path, mode, status, body, times });
    },
    /** Requests matching method + path (a RegExp). */
    calls(method, path) { return requests.filter((r) => r.method === method && path.test(r.path)); },
    async listen() {
      server = http.createServer((req, res) => { onRequest(req, res).catch((e) => { try { res.writeHead(500); res.end(String(e)); } catch { /* gone */ } }); });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      url = `http://127.0.0.1:${server.address().port}`;
      return url;
    },
    async close() {
      if (!server) return;
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      server = null;
    },
  };
}
