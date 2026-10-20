// ============================================================
// QUEER RESEARCH NETWORK — database.js
// Connects the public website to Supabase/PostgreSQL
// ============================================================


// ============================================================
// 1. SUPABASE CONFIGURATION
//
// Find these in:
// Supabase Dashboard → Project Settings / API
//
// IMPORTANT:
// Use your PUBLISHABLE key here.
// NEVER put a service_role / secret key in this file.
// ============================================================

const SUPABASE_URL =
  "https://shgbntwormbquafuezby.supabase.co";

const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_yAWT43eYKO_23L4CzjHpew_2Hsotj89";

  

const { createClient } = window.supabase;

const db = createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY
);


// ============================================================
// 2. SMALL UTILITY FUNCTIONS
// ============================================================

function escapeHTML(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}


function safeUrl(value) {
  if (!value) return null;

  try {
    const url = new URL(value, window.location.href);

    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.href;
    }
  } catch (error) {
    console.warn("Invalid URL:", value);
  }

  return null;
}


function getInitials(name = "") {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map(part => part[0])
    .join("")
    .toUpperCase();
}


function getFirstName(name = "") {
  return name.trim().split(/\s+/)[0] || "this researcher";
}


function makeTagHTML(tags = []) {
  if (!tags.length) return "";

  return tags
    .map(tag => `<span>${escapeHTML(tag.name)}</span>`)
    .join("");
}


function showLoadError(container, message) {
  if (!container) return;

  container.innerHTML = `
    <p class="database-message">
      ${escapeHTML(message)}
    </p>
  `;
}


// ============================================================
// 3. PEOPLE
// ============================================================

async function loadPeople() {
  const container = document.querySelector(".people-grid");

  if (!container) return;

  const { data: people, error } = await db
    .from("people")
    .select(`
      id,
      slug,
      display_name,
      pronouns,
      role_type,
      title,
      institution,
      faculty,
      department,
      short_bio,
      bio,
      website_url,
      orcid_url,
      linkedin_url,
      photo_url,
      photo_path,
      is_founder,
      is_featured,
      display_order,

      person_tags (
        tags (
          id,
          name,
          slug,
          category
        )
      )
    `)
    .eq("status", "published")
    .order("display_order", { ascending: true })
    .order("display_name", { ascending: true });

  if (error) {
    console.error("Could not load people:", error);

    showLoadError(
      container,
      "We couldn't load the researcher directory right now."
    );

    return;
  }

  if (!people || people.length === 0) {
    container.innerHTML = `
      <p class="database-message">
        Researcher profiles are coming soon.
      </p>
    `;

    return;
  }

  container.innerHTML = people
    .map(person => {

      // --------------------------------------------
      // Tags
      // --------------------------------------------

      const tags = (person.person_tags || [])
        .map(item => item.tags)
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name));


      // --------------------------------------------
      // Name
      // --------------------------------------------

      const name = escapeHTML(person.display_name);

      const pronouns = person.pronouns
        ? ` (${escapeHTML(person.pronouns)})`
        : "";


      // --------------------------------------------
      // Role
      // --------------------------------------------

      const roleParts = [];

      if (person.is_founder) {
        roleParts.push("Co-founder");
      }

      if (person.role_type) {
        roleParts.push(person.role_type);
      } else if (person.title) {
        roleParts.push(person.title);
      }

      const role = roleParts
        .map(escapeHTML)
        .join(" · ");


      // --------------------------------------------
      // Portrait
      // --------------------------------------------

      let photo = safeUrl(person.photo_url);

      if (!photo && person.photo_path) {
        const { data } = db.storage
          .from("qrn-images")
          .getPublicUrl(person.photo_path);

        photo = safeUrl(data?.publicUrl);
      }

      const portraitHTML = photo
        ? `
          <div class="person-portrait">
            <img
              class="person-photo"
              src="${escapeHTML(photo)}"
              alt="Portrait of ${name}"
              loading="lazy"
            />
          </div>
        `
        : `
          <div class="person-portrait" aria-hidden="true">
            <span>${escapeHTML(getInitials(person.display_name))}</span>
          </div>
        `;


      // --------------------------------------------
      // Bio
      // --------------------------------------------

      const bio = person.bio || person.short_bio;

      const bioHTML = bio
        ? `
          <details class="person-bio">
            <summary>
              About ${escapeHTML(getFirstName(person.display_name))}
              <span aria-hidden="true">↓</span>
            </summary>

            <div class="person-bio-content">
              <p>${escapeHTML(bio)}</p>

              ${makePersonLinks(person)}
            </div>
          </details>
        `
        : "";


      // --------------------------------------------
      // Final card
      // --------------------------------------------

      return `
        <article class="person-card">

          ${portraitHTML}

          <div class="person-card-content">

            ${
              role
                ? `<p class="person-role">${role}</p>`
                : ""
            }

            <h3>${name}${pronouns}</h3>

            ${
              tags.length
                ? `
                  <div
                    class="tag-list"
                    aria-label="Research interests"
                  >
                    ${makeTagHTML(tags)}
                  </div>
                `
                : ""
            }

            ${bioHTML}

          </div>

        </article>
      `;
    })
    .join("");
}


// ============================================================
// 4. PERSON EXTERNAL LINKS
// ============================================================

function makePersonLinks(person) {
  const links = [];

  const website = safeUrl(person.website_url);
  const orcid = safeUrl(person.orcid_url);
  const linkedin = safeUrl(person.linkedin_url);

  if (website) {
    links.push(`
      <a href="${escapeHTML(website)}"
         target="_blank"
         rel="noopener noreferrer">
        Website ↗
      </a>
    `);
  }

  if (orcid) {
    links.push(`
      <a href="${escapeHTML(orcid)}"
         target="_blank"
         rel="noopener noreferrer">
        ORCID ↗
      </a>
    `);
  }

  if (linkedin) {
    links.push(`
      <a href="${escapeHTML(linkedin)}"
         target="_blank"
         rel="noopener noreferrer">
        LinkedIn ↗
      </a>
    `);
  }

  if (!links.length) return "";

  return `
    <div class="person-links">
      ${links.join("")}
    </div>
  `;
}


// ============================================================
// 5. FEATURED RESEARCH
// ============================================================

async function loadResearch() {
  const container = document.querySelector(".research-grid");

  if (!container) return;

  const { data: projects, error } = await db
    .from("research_projects")
    .select(`
      id,
      slug,
      title,
      short_description,
      description,
      project_type,
      institution,
      website_url,
      image_url,
      start_date,
      end_date,
      is_featured,
      display_order,

      project_tags (
        tags (
          id,
          name,
          slug,
          category
        )
      ),

      project_people (
        role,
        display_order,

        people (
          id,
          slug,
          display_name,
          pronouns
        )
      )
    `)
    .eq("status", "published")
    .eq("is_featured", true)
    .order("display_order", { ascending: true })
    .limit(3);

  if (error) {
    console.error("Could not load research:", error);

    showLoadError(
      container,
      "We couldn't load featured research right now."
    );

    return;
  }


  container.innerHTML = projects
    .map((project, index) => {

      // --------------------------------------------
      // Researchers
      // --------------------------------------------

      const researchers = (project.project_people || [])
        .sort(
          (a, b) =>
            (a.display_order ?? 0) -
            (b.display_order ?? 0)
        )
        .map(item => item.people?.display_name)
        .filter(Boolean);

      const researcherText = researchers.length
        ? researchers.join(", ")
        : project.project_type || "Research project";


      // --------------------------------------------
      // Tags
      // --------------------------------------------

      const tags = (project.project_tags || [])
        .map(item => item.tags)
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name));


      // --------------------------------------------
      // Description
      // --------------------------------------------

      const description =
        project.short_description ||
        project.description ||
        "";


      // --------------------------------------------
      // Card classes
      // Preserve your current visual variation.
      // --------------------------------------------

      let cardClass = "research-card";

      if (index === 0) {
        cardClass += " research-card-featured";
      }

      if (index === 2) {
        cardClass += " research-card-coral";
      }


      // --------------------------------------------
      // Link
      // --------------------------------------------

      const website = safeUrl(project.website_url);

      const linkHTML = website
        ? `
          <a
            class="card-link"
            href="${escapeHTML(website)}"
            target="_blank"
            rel="noopener noreferrer"
          >
            Find out more
            <span aria-hidden="true">↗</span>
          </a>
        `
        : "";


      // --------------------------------------------
      // Decorative network graphic
      // Keep the visual from your existing first card.
      // --------------------------------------------

      const visualHTML =
        index === 0
          ? `
            <div
              class="research-visual visual-network"
              aria-hidden="true"
            >
              <span></span>
              <span></span>
              <span></span>
              <span></span>
              <span></span>
              <span></span>
              <span></span>
              <span></span>
            </div>
          `
          : "";


      return `
        <article class="${cardClass}">

          ${visualHTML}

          <div class="research-content">

            <p class="content-type">
              ${escapeHTML(researcherText)}
            </p>

            <h3>
              ${escapeHTML(project.title)}
            </h3>

            ${
              description
                ? `<p>${escapeHTML(description)}</p>`
                : ""
            }

            ${
              tags.length
                ? `
                  <div
                    class="tag-list"
                    aria-label="Topics"
                  >
                    ${makeTagHTML(tags)}
                  </div>
                `
                : ""
            }

            ${linkHTML}

          </div>

        </article>
      `;
    })
    .join("");
}


// ============================================================
// 6. EVENTS
// ============================================================

async function loadEvents() {
  const container = document.querySelector(".event-list");

  if (!container) return;

  const now = new Date().toISOString();

  const { data: events, error } = await db
    .from("events")
    .select(`
      id,
      slug,
      title,
      event_type,
      short_description,
      starts_at,
      ends_at,
      timezone,
      venue_name,
      registration_url,
      is_featured
    `)
    .eq("status", "published")
    .gte("starts_at", now)
    .order("starts_at", { ascending: true })
    .limit(4);

  if (error) {
    console.error("Could not load events:", error);

    showLoadError(
      container,
      "We couldn't load upcoming events right now."
    );

    return;
  }

  if (!events || events.length === 0) {
    container.innerHTML = `
      <p class="database-message">
        More events are coming soon.
      </p>
    `;

    return;
  }

  container.innerHTML = events
    .map(event => {

      const date = new Date(event.starts_at);

      const timezone =
        event.timezone || "America/Edmonton";

      const month = new Intl.DateTimeFormat(
        "en-CA",
        {
          month: "short",
          timeZone: timezone
        }
      )
        .format(date)
        .toUpperCase();

      const day = new Intl.DateTimeFormat(
        "en-CA",
        {
          day: "2-digit",
          timeZone: timezone
        }
      ).format(date);

      const registrationURL =
        safeUrl(event.registration_url);

      const linkHTML = registrationURL
        ? `
          <a
            href="${escapeHTML(registrationURL)}"
            aria-label="View ${escapeHTML(event.title)}"
            target="_blank"
            rel="noopener noreferrer"
          >
            ↗
          </a>
        `
        : `
          <span aria-hidden="true"></span>
        `;

      return `
        <article class="event-item">

          <time datetime="${escapeHTML(event.starts_at)}">
            <span>${escapeHTML(month)}</span>
            ${escapeHTML(day)}
          </time>

          <div>

            ${
              event.event_type
                ? `
                  <p class="content-type">
                    ${escapeHTML(event.event_type)}
                  </p>
                `
                : ""
            }

            <h3>
              ${escapeHTML(event.title)}
            </h3>

          </div>

          ${linkHTML}

        </article>
      `;
    })
    .join("");
}


// ============================================================
// 7. INITIALIZE WEBSITE
//
// All database sections load at the same time.
// ============================================================

async function initializeDatabaseContent() {
  try {
    await Promise.all([
      loadResearch(),
      loadEvents(),
      loadPeople()
    ]);

    console.log("QRN database content loaded.");
  } catch (error) {
    console.error(
      "Unexpected database initialization error:",
      error
    );
  }
}


// The script is loaded at the bottom of <body>, but this makes
// initialization safe even if you later move it into <head>.

if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    initializeDatabaseContent
  );
} else {
  initializeDatabaseContent();
}