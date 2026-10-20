(() => {
  'use strict';
  // Public browser credentials, matching your existing research page.
  // Never put a secret or service_role key in website files.
  const CONFIG = {
    supabaseUrl: 'https://shgbntwormbquafuezby.supabase.co',
    publishableKey: 'sb_publishable_yAWT43eYKO_23L4CzjHpew_2Hsotj89'
  };
  const form = document.getElementById('research-form');
  if (!form) return;
  const status = document.getElementById('form-status');
  const button = document.getElementById('research-submit');
  const image = document.getElementById('image-url');
  const imageConsent = document.getElementById('image-consent');
  let client;
  let sending = false;
  let lastPayload = null;
  let requestId = null;

  function message(text, error = false) {
    status.textContent = text;
    status.dataset.error = String(error);
  }
  function setDisabled(value) {
    form.querySelectorAll('fieldset').forEach(field => { field.disabled = value; });
    button.disabled = value;
    form.setAttribute('aria-busy', String(value && sending));
  }
  function updateImageConsent() {
    const consentWrap = document.getElementById('image-consent-wrap');

    if (!image || !imageConsent || !consentWrap) return;

    const hasImage = Boolean(image.value.trim());
    consentWrap.hidden = !hasImage;
    imageConsent.required = hasImage;

    if (!hasImage) imageConsent.checked = false;
  }

  image?.addEventListener('input', updateImageConsent);
  const summary = document.getElementById('short-description');
  summary.addEventListener('input', () => {
    document.getElementById('summary-count').textContent = `${summary.value.length} / 600 characters`;
  });

  function collectPayload() {
    const data = new FormData(form);
    if (String(data.get('company_website') || '').trim()) {
      throw new Error('We couldn’t accept this submission. Please contact the network organizer.');
    }
    const payload = {};
    const limits = { title: 250, project_type: 100, institution: 200,
      short_description: 600, description: 6000, website_url: 2048,
      image_url: 2048, submitter_name: 150, submitter_email: 254 };
    for (const [field, limit] of Object.entries(limits)) {
      const value = String(data.get(field) || '').trim();
      if (Array.from(value).length > limit) throw new Error(`Please shorten the ${field.replaceAll('_', ' ')} field.`);
      payload[field] = value || null;
    }
    for (const field of ['title', 'project_type', 'short_description', 'submitter_name']) {
      if (!payload[field]) throw new Error(`Please enter the ${field.replaceAll('_', ' ')}.`);
    }
    if (!payload.submitter_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.submitter_email)) {
      throw new Error('Please enter a valid contact email address.');
    }
    for (const field of ['website_url', 'image_url']) {
      if (!payload[field]) continue;
      let url;
      try { url = new URL(payload[field]); } catch { throw new Error('Please enter complete links beginning with https:// or http://.'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('Public links must use https:// or http:// and cannot include passwords.');
      }
      payload[field] = url.href;
      if (payload[field].length > limits[field]) throw new Error('Please use a shorter public link.');
    }
    const names = String(data.get('researcher_names') || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    payload.researcher_names = [...new Set(names)];
    if (!names.length || payload.researcher_names.length > 20 || names.some(x => Array.from(x).length > 150)) {
      throw new Error('Add 1–20 researcher or team names, one per line, with no more than 150 characters each.');
    }
    const tags = new Map();
    for (const entry of [...data.getAll('selected_tags'), ...String(data.get('other_tags') || '').split(',')]) {
      const tag = String(entry).trim();
      if (!tag) continue;
      if (Array.from(tag).length > 80) throw new Error('Please keep each research topic to 80 characters or fewer.');
      tags.set(tag.toLocaleLowerCase('en-CA'), tag);
    }
    if (tags.size > 20) throw new Error('Please select or suggest no more than 20 research topics.');
    payload.suggested_tags = [...tags.values()];
    payload.image_consent = Boolean(payload.image_url) && data.get('image_consent') === 'on';
    if (payload.image_url && !payload.image_consent) throw new Error('Please give permission to display the image, or remove its URL.');
    payload.consent_to_publish = data.get('consent_to_publish') === 'on';
    if (!payload.consent_to_publish) throw new Error('Please give permission to publish your project before submitting.');
    // Keep the same request ID on a retry of unchanged data.
    const serialized = JSON.stringify(payload);
    if (serialized !== lastPayload) {
      requestId = crypto.randomUUID();
      lastPayload = serialized;
    }
    payload.request_id = requestId;
    return payload;
  }

  async function loadTags() {
    const container = document.getElementById('tag-options');
    try {
      const { data, error } = await client.from('tags').select('name').eq('is_active', true).order('name');
      if (error) throw error;
      for (const tag of data || []) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox'; input.name = 'selected_tags'; input.value = tag.name;
        label.append(input, document.createTextNode(tag.name));
        container.append(label);
      }
      if (!data?.length) container.textContent = 'Add your research topics below.';
    } catch {
      container.textContent = 'We couldn’t load the topic list. You can still write your topics below.';
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    updateImageConsent();
    if (sending || !client || !form.reportValidity()) return;
    let payload;
    try { payload = collectPayload(); } catch (error) {
      message(error.message, true); status.focus(); return;
    }
    sending = true;
    setDisabled(true);
    button.textContent = 'Submitting…';
    message('Sending your research for review…');
    try {
      // Insert only: public visitors cannot read the private review queue.
      const { error } = await client.from('research_submissions').insert(payload);
      // The sole user-supplied unique value is request_id. A duplicate of the
      // same unchanged submission confirms an earlier request reached the queue.
      if (error && error.code !== '23505') {
        const unavailable = ['42501', '42P01', 'PGRST205', 'PGRST301', 'PGRST302'].includes(error.code);
        const invalid = ['22023', '23514', '23502'].includes(error.code);
        message(unavailable
          ? 'This form isn’t accepting submissions right now. Your entries are still here; please contact the network organizer.'
          : invalid
            ? 'Please check your entries, links, and publishing permissions, then try again.'
            : 'We couldn’t confirm your submission. Your entries are still here. You can retry without changing them, or contact the organizer.', true);
        status.focus(); return;
      }
      form.reset();
      form.hidden = true;
      message('');
      const success = document.getElementById('research-success');
      success.hidden = false;
      success.focus();
    } catch {
      message('We couldn’t confirm your submission. Your entries are still here. You can retry without changing them, or contact the organizer.', true);
      status.focus();
    } finally {
      sending = false;
      form.setAttribute('aria-busy', 'false');
      if (!form.hidden) setDisabled(false);
      button.textContent = 'Submit for review →';
    }
  });

  async function initialize() {
    if (!window.supabase?.createClient || !crypto.randomUUID) {
      message('The form couldn’t load. Please use a current browser and open the website over HTTPS, then try again.', true);
      return;
    }
    try {
      client = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
      });
      await loadTags();
      updateImageConsent();
      setDisabled(false);
      message('');
    } catch {
      client = null;
      message('This form is temporarily unavailable. Please try again later.', true);
    }
  }
  initialize();
})();
