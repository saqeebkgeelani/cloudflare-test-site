# Cloudflare Function Live Test

A minimal static site + Cloudflare Pages Function, used to actually verify the
"Cloudflare Functions" integration guide in the Form Hub dashboard end-to-end
on real Cloudflare infrastructure (not just simulated locally).

- `index.html` — the form, matching the dashboard's guide exactly
- `functions/api/submit-form.js` — the proxy Function, copied verbatim from
  the dashboard's Setup & Integration tab for the "Cloudflare Live Test" website

## Deploying

1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**
2. Pick this repo, set **Root directory** to `cloudflare-test-site`
3. No build command needed (static site) — leave build settings blank/default
4. Create a Turnstile widget (**Turnstile → Add widget**, Managed mode), add
   the `*.pages.dev` hostname this project gets assigned
5. In the Pages project's **Settings → Environment Variables**, add (encrypted):
   - `FORMHUB_ORIGIN`
   - `FORMHUB_KEY`
   - `TURNSTILE_SECRET`
6. Edit `index.html`, replace `YOUR_TURNSTILE_SITE_KEY` with the real site key
7. Deploy, open the live `.pages.dev` URL, submit the form, check the Form Hub
   dashboard for the submission
