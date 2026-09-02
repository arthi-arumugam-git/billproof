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

## 2. Dodo Payments: done on 2026-09-02, one thing left

Both products and their licence-key entitlements exist in **Live Mode** on the `wrong-numbers` Dodo account, and the checkout pages render:

| product | price | product id | entitlement (activations) | checkout |
|---|---|---|---|---|
| billproof receipt licence | $49 once | `pdt_0NmiiAAeYrdTABT4lpTtJ` | `ent_0NmifwFipPX02W9Dpynqn` (3) | https://checkout.dodopayments.com/buy/pdt_0NmiiAAeYrdTABT4lpTtJ?quantity=1 |
| billproof reconcile licence (Team) | $199 once | `pdt_0NmiitBKHHwsTMzynyfr7` | `ent_0NmihMg0GkYhYy1lhz5mn` (10) | https://checkout.dodopayments.com/buy/pdt_0NmiitBKHHwsTMzynyfr7?quantity=1 |

The landing page's two Buy buttons point at those links. The CLI reads the tier from the product id that Dodo's activate call returns (`src/license.ts`, `DODO_PRODUCTS`), because Dodo's licence keys carry **no prefix**; an earlier draft of this file assumed one, and that assumption is gone from the code.

**The one thing left is verification.** Dodo's dashboard says *"Complete verification to activate live payments and payouts. Most reviews finish within 72 hours."* Until it is approved, a customer can reach the checkout page but the payment will not settle and nothing pays out. Go to **Verification** in the dashboard, choose **Individual**, and finish the identity, PAN and bank steps; the banner "PRODUCT INFORMATION FORM PENDING" is part of the same flow. This needs your documents and your bank account, so it is yours alone.

### Test the whole loop once verification is approved

Buy your own product at $49 (you get it back minus the fee, and it proves the machine works end to end):

```
npx billproof activate <the key from the email>
npx billproof license
npx billproof receipt --last
```

If those three work, a stranger anywhere can buy at 3am and be running the paid tool a minute later with no involvement from you. `npx billproof deactivate` hands a machine's slot back when you move.

### If Dodo fails

The code still accepts **Polar** keys (set `BILLPROOF_POLAR_ORG`) and signed offline keys from `node scripts/issue-key.mjs <email>`; a signed key with `"plan":"team"` in its payload unlocks reconcile.

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
