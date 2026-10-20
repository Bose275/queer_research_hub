(() => {
  "use strict";
  const byId = id => document.getElementById(id);
  const status = byId("status"), queue = byId("submissions");
  let client, people = [], offset = 0, hasMore = false, busy = false, generation = 0;
  function say(text, error = false) { status.textContent = text; status.dataset.error = String(error); }
  function show(panel) {
    byId("login-panel").hidden = panel !== "login";
    byId("queue-panel").hidden = panel !== "queue";
  }
  function clearPrivateData() {
    generation++; queue.replaceChildren(); people = []; offset = 0; hasMore = false;
    byId("queue-count").textContent = ""; byId("load-more").hidden = true;
    byId("empty-state").hidden = true; byId("login-password").value = "";
  }
  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined && text !== null) element.textContent = String(text);
    if (className) element.className = className;
    return element;
  }
  function webUrl(value) {
    try { const u = new URL(value); return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password ? u.href : null; }
    catch { return null; }
  }
  function slugify(value) {
    return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 150).replace(/-$/g, "") || "research";
  }
  function datum(dl, label, value, wide = false, link = false) {
    if (value === null || value === undefined || String(value).trim() === "") return;
    const wrap = node("div", null, wide ? "wide" : ""); wrap.append(node("dt", label));
    const dd = node("dd"), href = link && webUrl(value);
    if (href) { const a = node("a", value); a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; dd.append(a); }
    else dd.textContent = String(value);
    wrap.append(dd); dl.append(wrap);
  }
  function field(label, value = "", textarea = false, wide = false) {
    const wrap = node("label", label, wide ? "wide" : "");
    const input = node(textarea ? "textarea" : "input");
    if (textarea) input.rows = 3; else input.type = "text";
    input.value = value; wrap.append(input); return { wrap, input };
  }
  function setBusy(value) {
    busy = value;
    byId("refresh-button").disabled = value; byId("load-more").disabled = value;
    byId("queue-filter").disabled = value;
    queue.querySelectorAll("button,input,textarea,select").forEach(el => { el.disabled = value; });
  }
  async function request(op, payload = {}) {
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError || !sessionData.session?.access_token) {
      clearPrivateData(); show("login"); throw new Error("Sign in to continue.");
    }
    const { data, error } = await client.functions.invoke("qrn-research-review", {
      headers: { Authorization: `Bearer ${sessionData.session.access_token}` }, body: { op, ...payload }
    });
    if (error) {
      let message = "Could not reach research review. Check that qrn-research-review is deployed and allows this website.";
      const response = error.context;
      if (response?.json) {
        try { const body = await response.json(); if (typeof body.error === "string") message = body.error; } catch { /* Network or gateway failure. */ }
        if (response.status === 401) { clearPrivateData(); show("login"); }
      }
      throw new Error(message);
    }
    if (!data?.ok) throw new Error(data?.error || "The review request did not finish.");
    return data;
  }
  function updateCount() {
    const count = queue.childElementCount;
    const label = byId("queue-filter").value === "pending" ? "awaiting review" : "with changes requested";
    byId("queue-count").textContent = `${count} ${count === 1 ? "submission" : "submissions"} ${label}${hasMore ? " shown; more available" : ""}`;
    byId("empty-state").hidden = count !== 0 || hasMore;
    byId("load-more").hidden = !hasMore;
  }
  function render(item) {
    const card = node("article", null, "submission"), top = node("div", null, "submission-top"), intro = node("div");
    intro.append(node("h3", item.title || "Untitled research"));
    intro.append(node("p", `${item.submitter_name || "Submitter"} · ${item.submitter_email || "No email"}`, "submission-email"));
    top.append(intro);
    const date = new Date(item.submitted_at), time = node("time", Number.isNaN(date.valueOf()) ? "" : date.toLocaleString(undefined, { dateStyle:"medium", timeStyle:"short" }));
    if (!Number.isNaN(date.valueOf())) time.dateTime = date.toISOString();
    top.append(time); card.append(top);
    card.append(node("p", item.consent_to_publish ? "✓ Consent to publish recorded" : "⚠ No publishing consent", `consent${item.consent_to_publish ? "" : " missing"}`));
    if (item.image_url) card.append(node("p", item.image_consent ? "✓ Image publication consent recorded" : "⚠ No image publication consent", `consent${item.image_consent ? "" : " missing"}`));
    const dl = node("dl", null, "profile-data");
    datum(dl, "Research type", item.project_type); datum(dl, "Institution", item.institution);
    datum(dl, "Public researcher / team names", (item.researcher_names || []).join("\n"), true);
    datum(dl, "Card summary", item.short_description, true); datum(dl, "Project details", item.description, true);
    datum(dl, "Website", item.website_url, true, true); datum(dl, "Submitted image link", item.image_url, true, true);
    datum(dl, "Previous private note", item.admin_notes, true);
    card.append(dl);
    const tags = node("div", null, "tags"); tags.setAttribute("aria-label", "Suggested research topics");
    for (const name of item.suggested_tags || []) tags.append(node("span", name, "tag"));
    if (tags.childElementCount) card.append(tags);
    const form = node("form", null, "review-form"); form.noValidate = true;
    const grid = node("div", null, "review-grid");
    const slug = field("Public project slug", slugify(item.title || "research")); slug.input.maxLength = 150;
    const topic = field("Approved topics (comma-separated)", (item.suggested_tags || []).join(", "));
    topic.input.maxLength = 1620;
    topic.wrap.append(node("small", "Up to 20 topics, 80 characters each. New approved topics become active directory tags. Leave empty for no topics."));
    const note = field("Private reviewer note / change request", item.admin_notes || "", true, true); note.input.maxLength = 1000;
    const peopleWrap = node("label", "Link existing researcher profiles (optional)", "wide"), select = node("select");
    select.multiple = true; select.size = 5;
    const names = new Set((item.researcher_names || []).map(s => s.toLocaleLowerCase()));
    for (const person of people) {
      const option = node("option", `${person.display_name}${person.institution ? " · " + person.institution : ""}`);
      option.value = person.id;
      const name = person.display_name.toLocaleLowerCase();
      option.selected = names.has(name) && people.filter(p => p.display_name.toLocaleLowerCase() === name).length === 1;
      select.append(option);
    }
    peopleWrap.append(select, node("small", "Select up to 20 published profiles; use Ctrl/Cmd to select or clear multiple names. Submitted team names appear on research cards even without a profile link. This does not create profiles."));
    grid.append(slug.wrap, topic.wrap, peopleWrap, note.wrap); form.append(grid);
    const actions = node("div", null, "review-actions");
    for (const [action, label, cls] of [["approve","Approve and publish",""],["needs_changes","Request changes","request"],["rejected","Reject","reject"]]) {
      const button = node("button", label, cls); button.type = "submit"; button.dataset.action = action; actions.append(button);
    }
    form.append(actions);
    form.addEventListener("submit", async event => {
      event.preventDefault(); if (busy) return;
      const action = event.submitter?.dataset.action; if (!action) return;
      const approvedTags = [...new Map(topic.input.value.split(",").map(t => t.trim()).filter(Boolean).map(t => [t.toLocaleLowerCase(), t])).values()];
      const approvedPeople = [...select.selectedOptions].map(o => o.value);
      if (note.input.value.length > 1000) { say("Keep notes under 1,000 characters.", true); return; }
      if (action === "needs_changes" && !note.input.value.trim()) { say("Add a private note describing the requested changes.", true); note.input.focus(); return; }
      if (action === "approve") {
        if (!item.consent_to_publish || (item.image_url && !item.image_consent)) { say("Publishing consent is missing. Request changes or reject the submission.", true); return; }
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug.input.value.trim()) || slug.input.value.length > 150) { say("Use a lowercase project slug with letters, numbers, and single hyphens.", true); slug.input.focus(); return; }
        if (approvedTags.length > 20 || approvedTags.some(t => [...t].length > 80)) { say("Choose up to 20 topics, at most 80 characters each.", true); topic.input.focus(); return; }
        if (approvedPeople.length > 20) { say("Link no more than 20 profiles.", true); return; }
      }
      const ticket = generation; setBusy(true);
      say(action === "approve" ? "Publishing approved research…" : "Saving review decision…");
      try {
        const result = await request("review", {
          submission_id: item.id, action, project_slug: action === "approve" ? slug.input.value.trim() : null,
          approved_tags: action === "approve" ? approvedTags : [],
          approved_people: action === "approve" ? approvedPeople : [], admin_notes: note.input.value.trim() || null
        });
        if (ticket !== generation) return;
        card.remove(); offset = Math.max(0, offset - 1); updateCount();
        say(action === "approve" ? `Research approved and published. Project ID: ${result.project_id}` : action === "needs_changes" ? "Changes requested. Contact the submitter separately; no email was sent." : "Submission rejected. Nothing was published.");
        status.focus();
      } catch (error) { say(`${error.message}${card.isConnected ? " Your review entries are preserved." : ""}`, true); status.focus(); }
      finally { setBusy(false); }
    });
    card.append(form); return card;
  }
  async function loadQueue(append = false) {
    if (busy) return;
    const ticket = ++generation; setBusy(true); show("queue"); say("Loading research submissions…");
    if (!append) { queue.replaceChildren(); offset = 0; hasMore = false; byId("empty-state").hidden = true; byId("load-more").hidden = true; }
    try {
      const result = await request("list", { status: byId("queue-filter").value, offset });
      if (ticket !== generation) return;
      people = result.people || []; hasMore = !!result.has_more;
      for (const item of result.submissions || []) queue.append(render(item));
      offset += (result.submissions || []).length; updateCount(); say("");
    } catch (error) { if (ticket === generation || byId("login-panel").hidden === false) say(error.message, true); }
    finally { setBusy(false); }
  }
  byId("login-form").addEventListener("submit", async event => {
    event.preventDefault(); if (!client) return;
    const button = byId("login-button"); button.disabled = true; say("Signing in…");
    try {
      const { data, error } = await client.auth.signInWithPassword({ email: byId("login-email").value.trim(), password: byId("login-password").value });
      if (error) throw error; if (!data.session) throw new Error("Sign-in did not create a session.");
      byId("login-password").value = ""; await loadQueue();
    } catch (error) { say(error.message, true); }
    finally { button.disabled = false; }
  });
  byId("refresh-button").addEventListener("click", () => loadQueue());
  byId("queue-filter").addEventListener("change", () => loadQueue());
  byId("load-more").addEventListener("click", () => loadQueue(true));
  byId("sign-out-button").addEventListener("click", async () => {
    clearPrivateData(); show("login"); say("Signing out…");
    try { const { error } = await client.auth.signOut(); if (error) throw error; say("You’re signed out."); }
    catch { say("The sign-out request failed. Close this tab and sign out again before leaving a shared computer.", true); }
  });
  async function init() {
    const config = window.QRN_CONFIG;
    if (!window.supabase?.createClient || !config?.supabaseUrl || !webUrl(config.supabaseUrl) || config.supabaseUrl.includes("YOUR-") || !config?.publishableKey?.startsWith("sb_publishable_")) {
      show("login"); say("Set the Supabase project URL and publishable key in supabase-config.js. Check that the Supabase script loaded.", true); return;
    }
    client = window.supabase.createClient(config.supabaseUrl, config.publishableKey, { auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:true } });
    byId("login-button").disabled = false;
    client.auth.onAuthStateChange(event => { if (event === "SIGNED_OUT") { clearPrivateData(); show("login"); say("You’re signed out."); } });
    try {
      const { data, error } = await client.auth.getSession(); if (error) throw error;
      if (data.session) await loadQueue(); else { show("login"); say(""); }
    } catch (error) { show("login"); say(error.message, true); }
  }
  init();
})();
