# Going live: the four steps only Arthi can do

Everything else is built, tested and pushed. These are the steps that need her account, her card details or her identity. Each one is short, and the order matters only in that step 1 is what makes `npx billproof` work for a stranger.

---

## 1. Publish to npm (about 3 minutes)

Until this is done, `npx billproof` fails for everyone else and the landing page promises something that does not exist.

```
npm login
cd D:\billproof
npm publish
```

`npm publish` runs the build and the 41 tests first and refuses to publish if either fails, so a green run means the package is sound. Check it afterwards:

```
npx billproof@latest --help
```

The name `billproof` was unclaimed on npm and PyPI when checked on 2026-09-02. If npm rejects it as taken in the meantime, tell Claude and the package name gets changed in one commit.

---

## 2. Create the Dodo Payments product (about 15 minutes)

Gumroad did not work. **Dodo Payments** is the replacement, and it is a better fit anyway: it is an Indian company, it is the merchant of record so EU and UK VAT is handled for you, and its own FAQ says *"You can onboard as an individual and start receiving international payments without any hassle"* — no registered business needed.

Its licence-key endpoints are public and need no API key, which is why neither product needs a server. Verified live on 2026-09-02: `POST https://live.dodopayments.com/licenses/validate` with `{license_key}` answers `{"valid":false}` for an unknown key, and it works from a browser too.

1. Sign up at **dodopayments.com**, onboard as an **individual**, and add your Indian bank details.
2. Go to **Entitlements** → **+** → choose **License Key**. Configure:
   - **Activations limit**: `3` (one licence, a laptop, a desktop and a spare).
   - **Duration**: leave blank for a one-time purchase that never expires.
   - **Activation instructions**: `Run: npx billproof activate <key>`
   - **Prefix**: `BILLPROOF-` — this matters. The validate endpoint takes only the key, so the prefix is what stops an unrelated Dodo key from unlocking this tool. The code already expects exactly this prefix.
3. Create the product: `billproof receipt licence`, **$49**, one-time. Attach the entitlement from step 2.
4. Publish, then send Claude the **checkout URL**. One line changes on the landing page and in the CLI.

Nothing else is needed — no product ID in the code, because Dodo validates by key alone and the prefix does the scoping.

### Test the whole loop once

Buy your own product at $49 (you get it back minus the fee, and it proves the machine works end to end):

```
npx billproof activate <the key from the email>
npx billproof license
npx billproof receipt --last
```

If those three work, a stranger anywhere can buy at 3am and be running the paid tool a minute later with no involvement from you.

### If Dodo also fails

The code already accepts **Polar** keys as well; its endpoint is verified live too. Polar takes 5% + 50c against Dodo's 4% + 40c, and it onboards Indian individuals through Stripe Connect Express. Set `BILLPROOF_POLAR_ORG` and it works. Failing both, `node scripts/issue-key.mjs <email>` issues a signed offline key by hand and you invoice however you like.

## 3. Post the launch threads (about 30 minutes, do this AFTER 1 and 2)

Drafts are in `docs/launch/posts.md`, including three specific Reddit threads found on 2026-09-02 with the numbers to reply with. Rules that came out of the research:

- Post as yourself, one venue at a time. Show HN first, then r/ClaudeAI the next day.
- Lead with a measured number from your own machine, never a claim.
- One reply per thread. No cold DMs, no template openers; your own measurement across ~110 sends is that those get zero replies.
- Regenerate the numbers with `billproof` on the day you post, so they are current.

---

## 4. Cancel the Vercel Pro plan (about 2 minutes)

The team `arthi-arumugam` is on Pro, has zero projects, and is currently suspended for a missing payment method. It is a recurring charge for nothing. The site is on GitHub Pages, which is free.

https://vercel.com/teams/arthi-arumugam/settings/billing

---

## Optional, later

- **A domain.** `billproof.dev` or similar, pointed at GitHub Pages. Cosmetic until there is traffic.
- **Hand-issued keys** for anyone you want to give a licence to (a maintainer, a reviewer, a friend):
  ```
  node scripts/issue-key.mjs someone@example.com
  ```
  The signing key lives at `C:\Users\HP\.billproof-keys\private.pem` and is deliberately outside the repository. Back it up somewhere safe; if it is lost, previously issued offline keys keep working but no new ones can be made.
