import { NANO_CONNECTOR, NANO_WORDMARK } from "./brand.mjs";
import { PROFILE_BODY_LIMIT } from "./custom-mcp.mjs";

export const bearer = req => /^Bearer ([a-z0-9_]+)$/i.exec(req.headers.authorization || "")?.[1] || "";

export async function manageCustomMcp({ custom, req, res, path, send, log }) {
  const respond = (code, data) => send(code, JSON.stringify(data));
  try {
    const secret = bearer(req);
    const profile = custom.management(secret);
    if (req.method === "GET" && path === "/profile") {
      if (secret && !profile) return respond(401, { error: "This recovery key did not open a saved profile." });
      return respond(200, { profile, available: custom.publicCatalog() });
    }
    if (req.method !== "POST") return respond(405, { error: "Method not allowed." });
    if (path !== "/profile" && !profile) return respond(401, { error: "Open your profile with the recovery key." });
    if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
      return respond(415, { error: "Send application/json." });
    }
    const tooLarge = () => {
      req.resume();
      res.setHeader("Connection", "close");
      return respond(413, { error: "Keep the combined profile submission under 512 KiB." });
    };
    if (Number(req.headers["content-length"]) > PROFILE_BODY_LIMIT) return tooLarge();
    const chunks = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > PROFILE_BODY_LIMIT) return tooLarge();
      chunks.push(chunk);
    }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { return respond(400, { error: "Enter valid JSON." }); }
    const saved = path === "/profile" ? await custom.update(secret, data)
      : path === "/delete" ? custom.remove(secret, data?.revision) : custom.connection(secret, data);
    return respond(200, { profile: saved, available: custom.publicCatalog() });
  } catch (e) {
    const status = e.status ?? (e.mcpCode === -32602 ? 400 : 503);
    if (status === 503) log("Custom MCP profile storage or validation is temporarily unavailable");
    return respond(status, { error: status === 503 ? "Custom MCP is temporarily unavailable. Try again." : e.message });
  }
}

export function customMcpPage(scriptUrl) {
  return `
    <header class="top"><a class="brand" href="/" aria-label="Nanoodle home">${NANO_CONNECTOR}${NANO_WORDMARK}</a>
      <nav aria-label="MCP navigation"><a href="/#connect">Standard install</a></nav></header>
    <section class="cm-intro" aria-labelledby="cm-title">
      <div class="cm-kicker">NANOODLE MCP</div>
      <h1 id="cm-title">Custom <span>MCP</span></h1>
      <p>Choose the tools your agent can use. Add Nanoodle workflows of your own and connect to a private endpoint.</p>
    </section>
    <noscript><p>Enable JavaScript to manage your Custom MCP profile.</p></noscript>
    <p id="cm-load" role="status">Loading your tools…</p>
    <div id="cm-main" hidden>
      <details id="cm-open" class="cm-card">
        <summary>Open a saved profile</summary>
        <form id="cm-open-form">
          <label for="cm-owner">Recovery key</label>
          <div class="cm-row"><input id="cm-owner" type="password" required autocomplete="off" spellcheck="false"><button>Open profile</button></div>
        </form>
      </details>
      <div id="cm-workspace">
        <form class="cm-card" id="cm-form">
          <h2>Built-in tools</h2>
          <div class="cm-row cm-select"><p>Choose the tools to show in your MCP client.</p><button type="button" id="cm-toggle">Select all</button></div>
          <fieldset id="cm-builtins"><legend class="cm-sr">Available tools</legend><div id="cm-builtin-list"></div></fieldset>
          <h2 id="cm-workflows-heading">Your workflows</h2>
          <p>Upload a JSON export from the <a href="https://nanoodle.com">Nanoodle editor</a>. Each workflow becomes a tool with the name you choose.</p>
          <div id="cm-workflows" aria-labelledby="cm-workflows-heading"></div>
          <button type="button" id="cm-add">Add a workflow</button>
          <p class="cm-small">Up to eight workflows, 200 KB each and 512 KiB per save. Supported graphs use built-in Nanoodle nodes and model inputs.</p>
          <div class="cm-actions"><button type="submit" class="cm-primary" id="cm-save">Save profile</button><span id="cm-save-state" role="status"></span></div>
        </form>
        <section class="cm-card" id="cm-connect" tabindex="-1">
          <h2>Connect your client</h2>
          <p id="cm-connect-empty">Save at least one tool to get your endpoint and client token.</p>
          <div id="cm-install" hidden>
            <label for="cm-url">MCP endpoint</label>
            <div class="cm-row"><input id="cm-url" readonly><button type="button" data-copy="cm-url">Copy URL</button></div>
            <p id="cm-token-state"></p>
            <div class="cm-actions"><button type="button" id="cm-issue">Generate client token</button><button type="button" id="cm-revoke" hidden>Revoke token</button></div>
            <div id="cm-token-wrap" hidden>
              <label for="cm-token">Client token</label>
              <div class="cm-row"><input id="cm-token" readonly spellcheck="false"><button type="button" data-copy="cm-token">Copy token</button></div>
              <p>Save this token in your client’s secret store. You can generate a replacement here any time.</p>
            </div>
            <details class="cm-guide"><summary>Client setup instructions</summary>
              <p>Use Streamable HTTP. Set the <code>Authorization</code> header to <code>Bearer YOUR_CLIENT_TOKEN</code> using your client’s secret settings.</p>
              <h3>Codex</h3>
              <p>Set <code id="cm-env-label">NANOODLE_MCP_TOKEN</code> in the environment that launches Codex. Then run this command.</p>
              <div class="cm-row"><pre id="cm-command"></pre><button type="button" data-copy="cm-command">Copy command</button></div>
              <p class="cm-small"><a href="https://developers.openai.com/codex/mcp">Codex MCP setup</a> · <a href="https://code.claude.com/docs/en/mcp">Claude Code MCP setup</a></p>
            </details>
          </div>
        </section>
      </div>
      <section class="cm-card" id="cm-session" hidden>
        <h2>Reopen this profile later</h2>
        <p>Save your recovery key in a password manager. This tab remembers it until you close the tab or close the profile.</p>
        <div class="cm-actions"><button type="button" id="cm-recovery">Show recovery key</button><button type="button" id="cm-logout">Close profile in this tab</button><button type="button" id="cm-delete" hidden>Delete this host’s profile</button></div>
        <div id="cm-key-wrap" hidden><label for="cm-key">Recovery key</label><div class="cm-row"><input id="cm-key" readonly spellcheck="false"><button type="button" data-copy="cm-key">Copy key</button></div></div>
      </section>
      <p id="cm-message" role="alert" hidden></p>
    </div>
    <script src="${scriptUrl}" defer></script>`;
}

export const CUSTOM_MCP_CSS = `
  main{max-width:65rem}
  .cm-intro{max-width:43rem;margin:3rem 0 2rem}
  .cm-intro h1,.cm-intro p{text-align:left;margin:.7rem 0}
  .cm-intro p,.cm-card p{color:var(--muted)}
  .cm-kicker{font:600 .72rem var(--nano-font-mono);letter-spacing:.12em;color:var(--accent-ink)}
  #cm-workspace{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:1rem;align-items:start}
  .cm-card{background:var(--card);border:1px solid var(--edge);border-radius:var(--nano-radius-card);padding:1.25rem;margin-bottom:1rem;min-width:0}
  .cm-card h2{font-size:1.25rem;margin:0 0 .5rem;letter-spacing:0}
  .cm-card p{margin:.45rem 0 .8rem;font-size:.88rem}
  .cm-card label{display:block;margin:.8rem 0 .3rem;font-size:.82rem;font-weight:650}
  .cm-card fieldset{border:0;padding:0;margin:0 0 1.25rem}
  .cm-card input:not([type=checkbox]){box-sizing:border-box;min-width:0;width:100%;min-height:44px;padding:.55rem;color:var(--fg);background:var(--bg);border:1px solid #5c6580;border-radius:6px;font:inherit;font-size:.84rem}
  .cm-card input[readonly],.cm-card pre{font-family:var(--nano-font-mono)}
  .cm-card button{min-height:44px;border-radius:6px;white-space:normal}
  .cm-card :focus-visible{outline:2px solid var(--accent-ink);outline-offset:3px}
  .cm-card button:disabled{opacity:.55;cursor:default}
  .cm-row,.cm-actions{display:flex;gap:.65rem;align-items:center}
  .cm-row button{flex:none}.cm-actions{flex-wrap:wrap;margin-top:.85rem}
  .cm-select{justify-content:space-between;margin-bottom:.6rem}
  #cm-builtin-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.45rem}
  #cm-builtin-list label{margin:0;min-height:44px;display:flex;gap:.55rem;align-items:center;padding:.43rem .6rem;border:1px solid var(--edge);border-radius:6px;overflow-wrap:anywhere;cursor:pointer}
  #cm-builtin-list label:has(:checked){border-color:var(--accent);background:var(--card2)}
  #cm-builtin-list input{flex:none;accent-color:var(--accent);width:1rem;height:1rem}
  .cm-workflow{margin:.75rem 0;padding:.75rem;background:var(--bg);border:1px solid var(--edge);border-radius:6px}
  .cm-workflow header{display:flex;align-items:center;justify-content:space-between;gap:.6rem;font-size:.86rem}
  .cm-workflow input[type=file]{white-space:normal;overflow:hidden}
  .cm-card .cm-small,#cm-save-state{font-size:.8rem;color:var(--muted)}
  .cm-card .cm-primary{background:var(--accent);color:#0b0d12;border:0;font-weight:750}
  .cm-guide{margin-top:1.15rem;padding-top:.85rem;border-top:1px solid var(--edge)}
  .cm-card summary{cursor:pointer;color:var(--accent-ink);font-weight:650}
  .cm-card pre{white-space:pre-wrap;overflow-wrap:anywhere;flex:1;min-width:0;margin:0;font-size:.76rem}
  #cm-message{position:fixed;z-index:1;bottom:.65rem;left:50%;transform:translateX(-50%);width:max-content;box-sizing:border-box;max-width:calc(100% - 1.4rem);margin:0;padding:.7rem 1rem;border:1px solid var(--accent);border-radius:8px;background:var(--bg);color:var(--fg);box-shadow:0 5px 24px #0009}
  .cm-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
  [hidden]{display:none!important}
  @media(max-width:750px){#cm-workspace{grid-template-columns:minmax(0,1fr);gap:0}.cm-intro{margin-top:1.9rem}}
  @media(max-width:390px){.cm-card{padding:.85rem}#cm-builtin-list{grid-template-columns:minmax(0,1fr)}}
`;
