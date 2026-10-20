(() => {
  "use strict";
  const form = document.getElementById("profile-form");
  if (!form) return;
  const status = document.getElementById("form-status");
  const button = document.getElementById("profile-submit");
  let client;
  let sending = false;
  let sourceImage = null;
  let sourceObjectUrl = null;
  const photoInput = document.getElementById("profile-photo");
  const photoCanvas = document.getElementById("photo-canvas");
  const cropControls = document.getElementById("photo-crop-controls");
  const photoConsentWrap = document.getElementById("photo-consent-wrap");
  const photoConsent = form.elements.photo_consent;

  function message(text, error = false) {
    status.textContent = text;
    status.dataset.error = String(error);
  }

  function setDisabled(disabled) {
    form.querySelectorAll("fieldset").forEach(fieldset => { fieldset.disabled = disabled; });
    button.disabled = disabled;
  }

  function drawSquareCrop() {
    if (!sourceImage || !photoCanvas) return;
    const width = sourceImage.naturalWidth;
    const height = sourceImage.naturalHeight;
    const side = Math.min(width, height);
    const xPct = Number(document.getElementById("photo-x").value) / 100;
    const yPct = Number(document.getElementById("photo-y").value) / 100;
    const sx = (width - side) * xPct;
    const sy = (height - side) * yPct;
    const context = photoCanvas.getContext("2d", { alpha: false });
    context.clearRect(0, 0, 600, 600);
    context.drawImage(sourceImage, sx, sy, side, side, 0, 0, 600, 600);
  }

  photoInput.addEventListener("change", () => {
    if (sourceObjectUrl) URL.revokeObjectURL(sourceObjectUrl);
    sourceImage = null;
    sourceObjectUrl = null;
    cropControls.hidden = true;
    photoConsentWrap.hidden = true;
    photoConsent.required = false;
    photoConsent.checked = false;
    const file = photoInput.files?.[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
      photoInput.value = "";
      message("Choose a JPG, PNG, or WebP photo smaller than 8 MB.", true);
      return;
    }
    sourceObjectUrl = URL.createObjectURL(file);
    sourceImage = new Image();
    sourceImage.onload = () => {
      if (sourceImage.naturalWidth * sourceImage.naturalHeight > 20_000_000) {
        sourceImage = null;
        photoInput.value = "";
        URL.revokeObjectURL(sourceObjectUrl);
        sourceObjectUrl = null;
        message("That image is too large to process. Please choose a smaller image.", true);
        return;
      }
      cropControls.hidden = false;
      photoConsentWrap.hidden = false;
      photoConsent.required = true;
      document.getElementById("photo-x").value = "50";
      document.getElementById("photo-y").value = "50";
      drawSquareCrop();
      message("");
    };
    sourceImage.onerror = () => {
      photoInput.value = "";
      sourceImage = null;
      message("We couldn’t open that image. Please choose a JPG, PNG, or WebP file.", true);
    };
    sourceImage.src = sourceObjectUrl;
  });
  document.getElementById("photo-x").addEventListener("input", drawSquareCrop);
  document.getElementById("photo-y").addEventListener("input", drawSquareCrop);

  function makeSquareJpeg() {
    return new Promise((resolve, reject) => {
      photoCanvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not prepare the profile photo.")), "image/jpeg", 0.86);
    });
  }

  async function uploadSquarePhoto(blob, path) {
    const config = window.QRN_CONFIG;
    const key = config.publishableKey;
    const result = await fetch(`${config.supabaseUrl}/functions/v1/qrn-profile-photo-upload`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "content-type": "image/jpeg",
        "x-photo-path": path,
      },
      body: blob,
    });
    let data = {};
    try { data = await result.json(); } catch { /* handled below */ }
    if (!result.ok || !data.ok) throw new Error(data.error || "The photo upload failed. Try again or submit without a photo.");
    return data.path;
  }

  function collectPayload() {
    const data = new FormData(form);
    const payload = {};
    const limits = {
      display_name: 150, pronouns: 100, role_type: 150, title: 200,
      institution: 200, faculty: 200, department: 200, bio: 3000,
      website_url: 2048, orcid_url: 2048, linkedin_url: 2048,
      submitter_email: 254
    };
    for (const [field, limit] of Object.entries(limits)) {
      const value = String(data.get(field) || "").trim();
      if (Array.from(value).length > limit) throw new Error(`Please shorten the ${field.replaceAll("_", " ")} field.`);
      payload[field] = value || null;
    }
    if (!payload.display_name) throw new Error("Please enter your display name.");
    if (!payload.submitter_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.submitter_email)) {
      throw new Error("Please enter a valid contact email address.");
    }
    for (const field of ["website_url", "orcid_url", "linkedin_url"]) {
      if (!payload[field]) continue;
      let url;
      try { url = new URL(payload[field]); } catch { throw new Error("Please enter complete links beginning with https:// or http://."); }
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("Public links must use https:// or http:// and cannot include passwords.");
      }
    }
    const interests = [...data.getAll("selected_tags"), ...String(data.get("other_tags") || "").split(",")];
    const uniqueTags = new Map();
    for (const interest of interests) {
      const tag = String(interest).trim();
      if (!tag) continue;
      if (Array.from(tag).length > 80) throw new Error("Please keep each research interest under 81 characters.");
      uniqueTags.set(tag.toLocaleLowerCase("en-CA"), tag);
    }
    if (uniqueTags.size > 20) throw new Error("Please select or suggest no more than 20 research interests.");
    payload.suggested_tags = [...uniqueTags.values()];
    payload.consent_to_publish = data.get("consent_to_publish") === "on";
    if (!payload.consent_to_publish) throw new Error("Please give permission to publish your profile before submitting.");
    payload.photo_consent = data.get("photo_consent") === "on";
    if (photoInput.files?.length && !payload.photo_consent) throw new Error("Please consent to publishing the photo, or remove it from the form.");
    // Do not send status, admin_notes, reviewed_at, or other protected columns.
    return payload;
  }

  async function loadTags() {
    const container = document.getElementById("tag-options");
    try {
      const { data, error } = await client.from("tags").select("name, category").eq("is_active", true).order("name");
      if (error) throw error;
      for (const tag of data || []) {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.name = "selected_tags";
        input.value = tag.name;
        label.append(input, document.createTextNode(tag.name));
        container.append(label);
      }
      if (!data?.length) container.textContent = "Add your research interests below.";
    } catch {
      container.textContent = "We couldn’t load the topic list. You can still write your interests below.";
    }
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (sending || !client || !form.reportValidity()) return;
    let payload;
    try { payload = collectPayload(); } catch (error) {
      message(error.message, true);
      status.focus();
      return;
    }
    sending = true;
    setDisabled(true);
    button.textContent = "Submitting…";
    message("Sending your profile for review…");
    try {
      if (photoInput.files?.length) {
        message("Preparing and uploading your square photo…");
        const imageBlob = await makeSquareJpeg();
        const nameSlug = payload.display_name
          .toLowerCase()
          .trim()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "");

        const path = `profile-submissions/${nameSlug}.jpg`;
        payload.photo_path = await uploadSquarePhoto(imageBlob, path);
      } else {
        payload.photo_path = null;
      }
      message("Sending your profile for review…");
      // No .select(): visitors have insert permission, not queue-read permission.
      const { error } = await client.from("profile_submissions").insert(payload);
      if (error) {
        const permissionError = ["42501", "PGRST301", "PGRST302"].includes(error.code);
        const validationError = ["22023", "23514", "23502"].includes(error.code);
        message(permissionError
          ? "The form isn’t accepting submissions right now. Your entries are still here; please contact the network organizer."
          : validationError
            ? "Please check your entries: a name, valid email, publishing consent, and valid links are required."
            : "We couldn’t confirm your submission. Your entries are still here. Please try again later or contact the network organizer.", true);
        status.focus();
        return;
      }
      form.reset();
      sourceImage = null;
      if (sourceObjectUrl) URL.revokeObjectURL(sourceObjectUrl);
      sourceObjectUrl = null;
      cropControls.hidden = true;
      photoConsentWrap.hidden = true;
      form.hidden = true;
      message("");
      const success = document.getElementById("profile-success");
      success.hidden = false;
      success.focus();
      } catch (error) {
        console.error("PROFILE SUBMISSION ERROR:", error);

        message(
          error?.message ||
          "We couldn’t confirm your submission. Please try again.",
          true
        );
      status.focus();
    } finally {
      sending = false;
      if (!form.hidden) setDisabled(false);
      button.textContent = "Submit for review →";
    }
  });

  async function initialize() {
    const config = window.QRN_CONFIG;
    if (!window.supabase?.createClient || !config ||
        config.supabaseUrl.includes("YOUR-") || config.publishableKey.includes("YOUR-")) {
      message("This form is still being set up. Please try again later.", true);
      return;
    }
    // The public form never needs an administrator login session.
    if (!config.publishableKey.startsWith("sb_publishable_")) {
      message("The form needs a Supabase publishable key in supabase-config.js.", true);
      return;
    }
    try {
      client = window.supabase.createClient(config.supabaseUrl, config.publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
      });
      await loadTags();
      setDisabled(false);
      message("");
    } catch {
      client = null;
      message("This form is temporarily unavailable. Please try again later.", true);
    }
  }
  initialize();
})();
