(() => {
  "use strict";
  const byId = id => document.getElementById(id);
  const status = byId("status");
  const panels = [byId("login-panel"), byId("queue-panel")];
  let supabase;

  function say(text, isError = false) {
    status.textContent = text;
    status.dataset.error = String(isError);
  }
  function show(panel) { for (const item of panels) item.hidden = item !== panel; }
  function node(tag, text, className) {
    const item = document.createElement(tag);
    if (text !== undefined && text !== null) item.textContent = String(text);
    if (className) item.className = className;
    return item;
  }
  function safeWebLink(value) {
    if (!value) return null;
    try {
      const url = new URL(value);
      return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }
  function slugify(name) {
    return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 150).replace(/-$/g, "");
  }
  function addDatum(dl, label, value, wide = false, link = false) {
    if (value === null || value === undefined || String(value).trim() === "") return;
    const wrap = node("div", null, wide ? "wide" : "");
    wrap.append(node("dt", label));
    const dd = node("dd");
    const href = link ? safeWebLink(value) : null;
    if (href) {
      const anchor = node("a", value);
      anchor.href = href;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      dd.append(anchor);
    } else dd.textContent = String(value);
    wrap.append(dd);
    dl.append(wrap);
  }
  async function request(op, payload = {}) {
    const { data, error } = await supabase.functions.invoke("qrn-profile-review", {
      body: { op, ...payload }
    });
    if (error) throw new Error(error.message || "The review server request failed.");
    if (!data?.ok) throw new Error(data?.error || "The review request was not completed.");
    return data;
  }
  async function startLogin() { await loadQueue(); }
  function field(label, value, type = "text", className = "") {
    const wrap = node("label", null, className);
    wrap.append(node("span", label));
    const input = document.createElement(type === "textarea" ? "textarea" : "input");
    if (type !== "textarea") input.type = type;
    if (type === "textarea") input.rows = 2;
    input.value = value || "";
    wrap.append(input);
    return { wrap, input };
  }
  function renderSubmission(item) {
    const card = node("article", null, "submission");
    const top = node("div", null, "submission-top");
    const intro = node("div");
    intro.append(node("h3", item.display_name || "Unnamed submission"));
    intro.append(node("p", item.submitter_email || "No contact email provided", "submission-email"));
    top.append(intro);
    const time = node("time", new Date(item.submitted_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }));
    top.append(time);
    card.append(top);

    if (item.photo_preview_url) {
      const photo = node("img", null, "review-photo");
      photo.src = item.photo_preview_url;
      photo.alt = `Submitted profile photo for ${item.display_name || "this researcher"}`;
      photo.loading = "lazy";
      card.append(photo);
    }
    if (item.photo_path) card.append(node("p", item.photo_consent ? "□ Photo consent recorded" : "⚠ Photo submitted without photo consent", `consent${item.photo_consent ? "" : " missing"}`));

    const consent = node("p", item.consent_to_publish ? "✓ Consent to publish recorded" : "⚠ No publishing consent recorded", `consent${item.consent_to_publish ? "" : " missing"}`);
    card.append(consent);

    const details = node("dl", null, "profile-data");
    addDatum(details, "Pronouns", item.pronouns);
    addDatum(details, "Role", item.role_type);
    addDatum(details, "Title", item.title);
    addDatum(details, "Institution", item.institution);
    addDatum(details, "Faculty", item.faculty);
    addDatum(details, "Department", item.department);
    addDatum(details, "Bio", item.bio, true);
    addDatum(details, "Website", item.website_url, false, true);
    addDatum(details, "ORCID", item.orcid_url, false, true);
    addDatum(details, "LinkedIn", item.linkedin_url, false, true);
    card.append(details);

    const tags = node("div", null, "tags");
    tags.setAttribute("aria-label", "Suggested research tags");
    for (const tag of Array.isArray(item.suggested_tags) ? item.suggested_tags : []) tags.append(node("span", tag, "tag"));
    if (tags.childElementCount) card.append(tags);

    const review = node("form", null, "review-form");
    const grid = node("div", null, "review-grid");
    const slug = field("Public profile URL slug", slugify(item.display_name || "researcher"));
    slug.input.required = true;
    slug.input.maxLength = 150;
    slug.input.pattern = "[a-z0-9]+(-[a-z0-9]+)*";
    const tagsInput = field("Approved tags (comma-separated; optional)", "");
    const note = field("Private reviewer note / change request", "", "textarea", "wide");
    note.input.maxLength = 1000;
    grid.append(slug.wrap, tagsInput.wrap, note.wrap);
    review.append(grid);
    const actions = node("div", null, "review-actions");
    const approve = node("button", "Approve and publish");
    approve.type = "submit";
    approve.dataset.action = "approve";
    const change = node("button", "Request changes");
    change.type = "submit";
    change.className = "request";
    change.dataset.action = "needs_changes";
    const reject = node("button", "Reject");
    reject.type = "submit";
    reject.className = "reject";
    reject.dataset.action = "rejected";
    actions.append(approve, change, reject);
    review.append(actions);
    review.addEventListener("submit", async event => {
      event.preventDefault();
      const action = event.submitter?.dataset.action;
      if (!action) return;
      if (action === "approve" && !item.consent_to_publish) { say("This submission has no recorded consent. Do not publish it; contact the submitter or reject it.", true); return; }
      const buttons = [...actions.querySelectorAll("button")];
      buttons.forEach(button => { button.disabled = true; });
      say(action === "approve" ? `Publishing ${item.display_name}…` : "Saving review decision…");
      try {
        const approvedTags = tagsInput.input.value.split(",").map(tag => tag.trim()).filter(Boolean);
        const result = await request("review", {
          submission_id: item.id,
          action,
          profile_slug: action === "approve" ? slug.input.value.trim() : null,
          approved_tags: action === "approve" && approvedTags.length ? approvedTags : null,
          admin_notes: note.input.value.trim() || null
        });
        card.remove();
        updateCount();
        say(action === "approve" ? `Profile approved and published. Profile ID: ${result.person_id}` : "Review decision saved.");
      } catch (error) {
        say(error.message, true);
        buttons.forEach(button => { button.disabled = false; });
      }
    });
    card.append(review);
    return card;
  }
  function updateCount() {
    const count = byId("submissions").childElementCount;
    byId("queue-count").textContent = `${count} ${count === 1 ? "profile" : "profiles"} awaiting review`;
    byId("empty-state").hidden = count !== 0;
  }
  async function loadQueue() {
    show(byId("queue-panel"));
    say("Loading pending profiles…");
    byId("submissions").replaceChildren();
    try {
      const { submissions } = await request("list");
      for (const item of submissions) byId("submissions").append(renderSubmission(item));
      updateCount();
      say("");
    } catch (error) {
      say(error.message, true);
    }
  }

  byId("login-form").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    say("Signing in…");
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: byId("login-email").value.trim(),
        password: byId("login-password").value
      });
      if (error) throw error;
      if (!data.session) throw new Error("Sign-in did not create a session. Check the email and password.");
      await startLogin();
    } catch (error) { say(error.message, true); }
    finally { button.disabled = false; }
  });
  byId("refresh-button").addEventListener("click", loadQueue);
  byId("sign-out-button").addEventListener("click", async () => {
    await supabase.auth.signOut();
    byId("login-password").value = "";
    show(byId("login-panel"));
    say("You’re signed out.");
  });

  async function init() {
    const config = window.QRN_CONFIG;
    if (!window.supabase?.createClient || !config || config.supabaseUrl.includes("YOUR-") ||
        !config.publishableKey.startsWith("sb_publishable_")) {
      show(byId("login-panel"));
      say("Add your Supabase project URL and publishable key to supabase-config.js.", true);
      return;
    }
    supabase = window.supabase.createClient(config.supabaseUrl, config.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      if (data.session) await startLogin();
      else { show(byId("login-panel")); say(""); }
    } catch (error) { show(byId("login-panel")); say(error.message, true); }
  }
  init();
})();
