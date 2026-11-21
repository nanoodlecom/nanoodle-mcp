(() => {
  "use strict";

  const byId = id => document.getElementById("cm-" + id);
  const endpoint = "/custom-mcp";
  const state = { profile: null, available: [], owner: "", pendingOwner: "", pendingClient: "", dirty: false, busy: false };
  const list = byId("builtin-list");
  const workflows = byId("workflows");
  const saved = byId("save-state");
  const toast = byId("message");
  const fieldLimit = 200_000;
  const recoveryDraft = "nanoodle-custom-setup";
  let toastTimer;

  function announce(message) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; }, 10_000);
  }

  async function request(path, data, token) {
    const headers = { ...(data && { "Content-Type": "application/json" }), ...(token && { Authorization: "Bearer " + token }) };
    const response = await fetch(endpoint + path, {
      method: data ? "POST" : "GET",
      headers,
      ...(data && { body: JSON.stringify(data) }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(result.error?.message || result.error || "Custom MCP is temporarily unavailable."),
        { status: response.status });
    }
    return result;
  }

  function token(prefix) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return prefix + Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function rememberOwner(value) {
    try {
      if (value) sessionStorage.setItem(recoveryDraft, value);
      else sessionStorage.removeItem(recoveryDraft);
    } catch { /* The current page can still retry a save. */ }
  }

  function element(tag, props = {}) {
    return Object.assign(document.createElement(tag), props);
  }

  function addField(parent, name, input) {
    parent.append(element("label", { htmlFor: input.id, textContent: name }), input);
  }

  const selected = () => Array.from(list.querySelectorAll("input:checked"), input => input.value);
  const allChecks = () => Array.from(list.querySelectorAll("input:not([data-stale])"));
  let rowCount = 0;
  function addRow(record = null) {
    const row = element("div", { className: "cm-workflow" });
    row.previousName = record?.name;
    const id = "cm-workflow-" + ++rowCount;
    const heading = element("header");
    const title = element("strong", { textContent: record?.name || "New workflow" });
    const remove = element("button", { type: "button", textContent: "Remove" });
    remove.setAttribute("aria-label", record ? "Remove " + record.name : "Remove new workflow");
    remove.addEventListener("click", () => {
      row.remove();
      changed();
      byId("add").focus();
    });
    heading.append(title, remove);
    row.append(heading);
    const name = element("input", { id: id + "-name", value: record?.name || "", required: true,
      pattern: "[A-Za-z][A-Za-z0-9_\\-]{0,63}", title: "Start with a letter. Use letters, digits, hyphens or underscores.", maxLength: 64 });
    name.autocomplete = "off";
    name.placeholder = "example_workflow";
    const description = element("input", { id: id + "-description", value: record?.description || "", maxLength: 300 });
    const file = element("input", { id: id + "-file", type: "file", accept: ".json,application/json", required: !record });
    addField(row, "Tool name", name);
    addField(row, "Description (optional)", description);
    addField(row, record ? "Replace workflow JSON (optional)" : "Workflow JSON", file);
    row.read = async () => {
      const entry = { name: name.value.trim(), description: description.value, previousName: row.previousName };
      if (!file.files.length) return entry;
      const selectedFile = file.files[0];
      if (selectedFile.size > fieldLimit) throw new Error("Keep each workflow file under 200 KB.");
      try { entry.graph = JSON.parse(await selectedFile.text()); }
      catch { throw new Error("The workflow file is invalid JSON."); }
      return entry;
    };
    workflows.append(row);
    return name;
  }

  function renderSelection() {
    const tools = new Map(state.available.map(tool => [tool.name, tool]));
    const chosen = new Set(state.profile?.builtins ?? []);
    list.replaceChildren();
    for (const name of chosen) if (!tools.has(name)) tools.set(name, null);
    for (const [name, tool] of tools) {
      const input = element("input", { type: "checkbox", value: name, checked: chosen.has(name) });
      if (!tool) input.dataset.stale = "";
      const label = element("label");
      label.append(input, element("span", { textContent: name + (tool ? "" : " (unavailable)") }));
      if (tool?.description) label.title = tool.description;
      list.append(label);
    }
    workflows.replaceChildren();
    for (const record of state.profile?.workflows ?? []) addRow(record);
    state.dirty = false;
    updateActions();
  }

  function renderInstall() {
    const profile = state.profile;
    const install = !!profile?.revision && !!(profile.builtins.length || profile.workflows.length || profile.connected);
    byId("install").hidden = !install;
    byId("connect-empty").hidden = install;
    byId("session").hidden = !profile;
    byId("delete").hidden = !profile?.revision;
    if (!install) return;
    const url = new URL(profile.endpoint, location.origin);
    byId("url").value = url.href;
    byId("token-state").textContent = profile.connected ? "A client token is active." : "Generate a token to allow your client to connect.";
    byId("issue").textContent = profile.connected ? "Replace client token" : "Generate client token";
    byId("revoke").hidden = !profile.connected;
    const host = url.hostname.split(".")[0];
    const near = host === "near";
    const env = near ? "NANOODLE_NEAR_MCP_TOKEN" : "NANOODLE_MCP_TOKEN";
    byId("command").textContent = "codex mcp add nanoodle-custom-" + (near ? "near" : "nano") + " --url " + url.href + " --bearer-token-env-var " + env;
    const envLabel = byId("env-label");
    if (envLabel) envLabel.textContent = env;
  }

  function updateActions() {
    const checks = allChecks();
    byId("toggle").textContent = checks.length && checks.every(input => input.checked) ? "Clear all" : "Select all";
    byId("toggle").disabled = !checks.length;
    byId("add").disabled = workflows.childElementCount >= 8;
    byId("save").disabled = state.busy || !state.dirty;
    saved.textContent = state.dirty ? "Unsaved changes" : state.profile?.revision ? "Saved" : "";
  }

  function changed() {
    state.dirty = true;
    updateActions();
  }

  function clearSecrets() {
    state.owner = "";
    state.pendingOwner = "";
    rememberOwner("");
    state.pendingClient = "";
    for (const name of ["token", "key"]) {
      byId(name).value = "";
      byId(name + "-wrap").hidden = true;
    }
    byId("recovery").textContent = "Show recovery key";
  }

  function render(result) {
    state.profile = result.profile;
    state.available = result.available;
    renderSelection();
    renderInstall();
  }

  async function perform(button, operation) {
    if (state.busy) return;
    state.busy = true;
    byId("form").inert = true;
    button.disabled = true;
    try { await operation(); }
    catch (error) { announce(error.message); }
    finally {
      state.busy = false;
      byId("form").inert = false;
      button.disabled = false;
      updateActions();
    }
  }

  byId("form").addEventListener("input", changed);
  byId("form").addEventListener("change", changed);
  byId("toggle").addEventListener("click", () => {
    const checks = allChecks(), check = !checks.every(input => input.checked);
    for (const input of checks) input.checked = check;
    changed();
  });
  byId("add").addEventListener("click", () => {
    addRow().focus();
    changed();
  });
  byId("open-form").addEventListener("submit", event => {
    event.preventDefault();
    if (state.dirty && !confirm("Discard your unsaved changes and open another profile?")) return;
    perform(event.submitter, async () => {
      const input = byId("owner");
      const key = input.value.trim();
      const result = await request("/profile", undefined, key);
      if (!result.profile) throw new Error("Enter your recovery key.");
      input.value = "";
      byId("open").open = false;
      clearSecrets();
      state.owner = key;
      rememberOwner(key);
      render(result);
      byId("save-state").scrollIntoView({ block: "nearest" });
      announce("Profile opened.");
    });
  });
  byId("form").addEventListener("submit", event => {
    event.preventDefault();
    perform(byId("save"), async () => {
      const first = !state.profile;
      if (first && !state.pendingOwner) {
        state.pendingOwner = token("nmo_");
        rememberOwner(state.pendingOwner);
      }
      const key = first ? state.pendingOwner : state.owner;
      saved.textContent = "Saving…";
      const builtins = selected();
      const entries = await Promise.all(Array.from(workflows.children, row => row.read()));
      let result;
      try {
        result = await request("/profile", { revision: state.profile?.revision ?? 0, builtins, workflows: entries },
          key);
      } catch (error) {
        if (first) {
          const recovered = await request("/profile", undefined, key).catch(() => null);
          if (recovered?.profile) {
            state.profile = recovered.profile;
            state.owner = key;
            state.pendingOwner = "";
            renderInstall();
            throw new Error("Your profile is saved. Review the current selections before saving again.");
          }
        }
        throw error;
      }
      state.owner = key;
      state.pendingOwner = "";
      render(result);
      announce(first ? "Profile saved. Save your recovery key to reopen it on another device." : "Profile saved.");
    });
  });

  byId("issue").addEventListener("click", event => {
    if (state.profile?.connected && !state.pendingClient && !confirm("Replace the active token? Clients using it will be disconnected.")) return;
    perform(event.currentTarget, async () => {
      if (!state.pendingClient) state.pendingClient = token("nmc_");
      const result = await request("/connection", { revision: state.profile.revision, token: state.pendingClient }, state.owner);
      state.profile = result.profile;
      byId("token").value = state.pendingClient;
      byId("token-wrap").hidden = false;
      state.pendingClient = "";
      renderInstall();
      byId("token").focus();
      announce("Client token ready to copy.");
    });
  });
  byId("revoke").addEventListener("click", event => {
    if (!confirm("Revoke this token and disconnect your client?")) return;
    perform(event.currentTarget, async () => {
      const result = await request("/connection", { revision: state.profile.revision, token: null }, state.owner);
      state.profile = result.profile;
      state.pendingClient = "";
      byId("token").value = "";
      byId("token-wrap").hidden = true;
      renderInstall();
      byId("issue").focus();
      announce("Client token revoked. Your saved tools are still available here.");
    });
  });
  byId("recovery").addEventListener("click", event => {
    const button = event.currentTarget;
    perform(button, async () => {
      const wrap = byId("key-wrap"), input = byId("key");
      input.value = wrap.hidden ? state.owner : "";
      wrap.hidden = !wrap.hidden;
      button.textContent = wrap.hidden ? "Show recovery key" : "Hide recovery key";
      if (!wrap.hidden) input.focus();
    });
  });
  byId("logout").addEventListener("click", () => {
    if (state.dirty && !confirm("Discard unsaved changes and close this profile?")) return;
    if (state.busy) return;
    clearSecrets();
    render({ profile: null, available: state.available });
    byId("open").open = true;
    byId("owner").focus();
    announce("Profile closed in this tab.");
  });
  byId("delete").addEventListener("click", event => {
    if (!confirm("Delete the saved tools and disconnect the client on this host?")) return;
    perform(event.currentTarget, async () => {
      const key = state.owner;
      const result = await request("/delete", { revision: state.profile.revision }, key);
      clearSecrets();
      if (result.profile) {
        state.owner = key;
        rememberOwner(key);
      }
      render(result);
      byId("form").querySelector("input")?.focus();
      announce("Profile deleted on this host.");
    });
  });
  document.addEventListener("click", async event => {
    const target = event.target.closest("[data-copy]");
    if (!target) return;
    const source = document.getElementById(target.dataset.copy);
    try {
      await navigator.clipboard.writeText(source.value ?? source.textContent);
      announce("Copied.");
    } catch {
      if (typeof source.select === "function") { source.focus(); source.select(); }
      announce("Clipboard unavailable. Select and copy the text.");
    }
  });
  window.addEventListener("beforeunload", event => {
    if (state.dirty) event.preventDefault();
  });

  async function initialize() {
    let result, key;
    try { key = sessionStorage.getItem(recoveryDraft); } catch { /* Optional browser storage. */ }
    if (key) {
      try {
        result = await request("/profile", undefined, key);
        state.owner = key;
      } catch (error) {
        if (error.status !== 401) throw error;
        state.pendingOwner = key;
      }
    }
    result ??= await request("/profile");
    render(result);
    byId("load").hidden = true;
    byId("main").hidden = false;
  }
  initialize().catch(() => { byId("load").textContent = "Your tools couldn’t load. Refresh the page to try again."; });
})();
