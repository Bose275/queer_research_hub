# Queer Research Network profile form and review dashboard

This package adds a public profile submission form and a separate private
review page. Submissions stay unpublished until an authorized reviewer
approves them. The administrator site requires a Supabase Auth account,
email-and-password sign-in, an explicit server-side user-ID allowlist, and a
Supabase Edge Function. The browser never receives the database secret key.

## Package layout

- `submit-profile.html`, `profile-form.css`, `submit-profile.js`: public form.
- `supabase-config.js`: public project URL and publishable key.
- `profile-approval.sql`: additive profile validation and the SQL Editor
  approval function from the previous setup.
- `admin/review-profiles.html`, `admin/admin.css`, `admin/admin.js`: reviewer
  sign-in, scrolling queue, profile details, and review actions.
- `admin-review-authorization.sql`: restricted database function called only
  by the trusted Edge Function.
- `supabase/functions/qrn-profile-review/index.ts`: authenticates reviewers,
  enforces the allowlist, and limits database operations.
- `supabase/config.toml`: lets the function handle browser preflight requests;
  the function independently verifies the user JWT with Supabase Auth on every
  protected request.

## 1. Copy the files into your site

Extract the zip. Copy `submit-profile.html`, `profile-form.css`,
`submit-profile.js`, and `supabase-config.js` into the same folder as
`index.html`, `styles.css`, and `database.js`.

Copy the entire `admin` folder beside those files. Copy the package's `supabase`
folder into your website project root. If you already have a `supabase/config.toml`,
merge the `[functions.qrn-profile-review]` section into it rather than replacing
your existing config.

In `supabase-config.js`, set the same project URL and `sb_publishable_...` key
that already work in `database.js`. Do not put a secret/service-role key there.

## 2. Install the database functions

Run these three files in order under Supabase → SQL Editor → New query, using
the default `postgres` role:

1. `image-support.sql`
2. `profile-approval.sql`
3. `admin-review-authorization.sql`

The first file safely adds the approval link, submission validation, and
SQL Editor approval function. The second adds the narrow review function for
the server. Do not rerun the original table-creation script. Both updates are
additive, and the SQL uses transactions.

Website visitors still cannot read the queue or change its status. Only the
Edge Function's server key can call the new review action. The existing
`qrn_approve_profile` function remains unavailable to website API roles.

The base database already has optional image URL fields for people, projects,
and event covers. `image-support.sql` adds private Storage paths and an ordered
`event_images` table. The profile form crops an optional photo to a 600 × 600
JPEG, compresses it, and uploads it to the private `qrn-images` bucket. Pending
photos remain private; reviewers receive short-lived preview links. The public
read policy exposes a photo only after its related record is published. The
photo upload Edge Function verifies the actual JPEG dimensions and limits each
network to 10 uploads per hour. This package wires the profile-photo workflow;
project and event photo upload controls still need to be added to their site
management screens.

## 3. Create a reviewer account

In Supabase Dashboard → Authentication → Users, invite or add the reviewer
account you will use. Do not enable public sign-ups for this account. Configure
the project's Auth URL allow-list to include the final website origin and
`/admin/review-profiles.html` redirect path. For local testing, also allow the
localhost redirect you use.

Get the reviewer account's user UUID from the Users page. Set a password for
the reviewer account in Supabase before signing in. Use the invited email as
the username on the review page. Choose a long, unique password and keep it
private.

## 4. Deploy the Edge Function

Install the Supabase CLI if needed, then open PowerShell in the website project
folder. Use the project reference from Supabase Dashboard → Project Settings →
General:

```powershell
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
```

Set the reviewer UUID and the exact website origin (scheme + host, no path):

```powershell
npx supabase secrets set QRN_ADMIN_USER_IDS="REVIEWER-USER-UUID" QRN_ALLOWED_ORIGINS="https://your-site.example"
```

If you temporarily include `http://localhost:8000` for local browser testing,
remove it from `QRN_ALLOWED_ORIGINS` after testing and reset the secret to the
production origin alone. The allow-list is an additional browser-origin check;
the reviewer UUID and password-authenticated session remain the authorization
controls.

Deploy:

```powershell
npx supabase functions deploy qrn-profile-review
npx supabase functions deploy qrn-profile-photo-upload
```

Supabase provides the function's project URL, publishable key, and
server-only secret key through its Edge Function environment. Do not copy any
secret key into a `.js`, `.html`, GitHub repository, or static-site setting.

## 5. Link and test

Add this link under the People heading in `index.html`:

```html
<a class="button button-outline" href="submit-profile.html">
  Add your researcher profile <span aria-hidden="true">↗</span>
</a>
```

Serve your site locally with `python -m http.server 8000`, then visit
`http://localhost:8000/submit-profile.html` to test a submission. It should
appear as `pending` in `profile_submissions` and not in the public `people`
directory.

Visit `http://localhost:8000/admin/review-profiles.html` to test reviewer
email-and-password sign-in and the queue. The Edge Function must be deployed
and temporarily allow the local origin for this test. The reviewer must also
be in `QRN_ADMIN_USER_IDS`.

Review the name, publication consent, bio, links, and tags. The reviewer can
edit the public URL slug, choose existing active tags, and approve, request
changes, or reject. A request-changes/reject action records private reviewer
notes without creating a public profile. Approval and linking tags happen in
one transaction. The public page never receives the queue or server key.

## Security notes

- The server checks the Supabase Auth user ID against `QRN_ADMIN_USER_IDS`;
  a hidden URL or client-side check alone does not authorize access.
- The Edge Function validates the signed-in user's JWT with Supabase Auth and
  checks the server-side user-ID allowlist on every protected request. Gateway
  JWT checking is disabled for browser preflight compatibility, so the
  function's own checks are required.
- The function supports only listing the pending queue and submitting one of
  three review decisions. It returns limited profile fields and validates all
  decision parameters server-side.
- CORS allows only origins explicitly listed in `QRN_ALLOWED_ORIGINS`.
- Queue reads and review actions use the elevated key only inside the Edge
  Function. The browser has a publishable key only.
- Each decision records the reviewer's Auth user ID and timestamp in the
  private submission row.
- Reviewers see submitter email addresses because they need a way to follow up.
  Emails and private review notes are never copied into public profiles.

## Checks

The earlier public form checks cover validation, consent, safe tag rendering,
no privileged columns, and error recovery. For this package, also run
`node --check` on `admin/admin.js` and the Edge Function source where your
Supabase CLI/Deno toolchain is available. Test sign-in and a dummy submission
in your own project before inviting additional reviewers. No changes were
made to your live Supabase project from this package.
