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

## 2. Create the Gumroad product (about 10 minutes)

Gumroad is the checkout because it takes cards and PayPal, it is the merchant of record so EU and UK VAT is handled for you, it pays out to an Indian bank account in INR, and it generates and emails a licence key on every sale with no server of ours involved. Its fee is 10% plus 50 cents per sale.

1. Sign up at **gumroad.com** and complete the payout details (Indian bank account, INR).
2. New product → **Digital product**.
   - Name: `billproof receipt licence`
   - Price: `$29`
   - Description: use the "receipt" column from the landing page.
3. In the product settings, turn **ON** the option called **Generate a unique licence key per sale**. This is the step the whole flow depends on.
4. Publish, then copy two things from the product page:
   - the **short URL**, which looks like `https://gumroad.com/l/xxxxx`
   - the **product ID**. It is in the URL of the product's edit page, or under the licence-key settings.
5. Give both to Claude. Two one-line changes then go in: the buy button's link on the landing page, and `BILLPROOF_GUMROAD_PRODUCT` baked into the published build so keys verify.

Until step 5 is done the buy button points at a placeholder link, so do not share the landing page publicly before then.

### Testing the loop end to end

Gumroad lets you buy your own product. Do it once at $29 (you get the money back minus the fee, and it proves the machine works):

```
billproof activate <the key from the email>
billproof license
billproof receipt --last
```

If those three commands work, a stranger anywhere in the world can now buy at 3am and be running the paid tool a minute later, with no involvement from you.

---

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

- **Polar.sh** as a second checkout. Its fee is lower than Gumroad's at 5% plus 50 cents and it is also a merchant of record. The code already accepts Polar keys; it only needs `BILLPROOF_POLAR_ORG` set. Worth doing once sales exist, not before.
- **A domain.** `billproof.dev` or similar, pointed at GitHub Pages. Cosmetic until there is traffic.
- **Hand-issued keys** for anyone you want to give a licence to (a maintainer, a reviewer, a friend):
  ```
  node scripts/issue-key.mjs someone@example.com
  ```
  The signing key lives at `C:\Users\HP\.billproof-keys\private.pem` and is deliberately outside the repository. Back it up somewhere safe; if it is lost, previously issued offline keys keep working but no new ones can be made.
