# Release setup — credentials for the macOS CI release (Phase 7c.5)

> One-time, ~10-15 minutes. You add five secrets to the GitHub repo; the
> `Release (macOS)` workflow (`.github/workflows/release.yml`) uses them to
> sign, notarize, and publish a release when you push a `vX.Y.Z` tag.
>
> **SECURITY: do not paste any of these values into chat.** Add them directly
> in GitHub's secret UI. They are never stored in the repo or seen by anyone.
> (This doc is also the reusable template for future RBJ apps.)

## What you need to produce

| GitHub secret name | What it is |
|---|---|
| `APPLE_CERT_P12_BASE64` | Your "Developer ID Application" certificate, exported as a `.p12` and base64-encoded |
| `APPLE_CERT_PASSWORD` | The password you set when exporting that `.p12` |
| `APPLE_ID` | Your Apple ID email (the Apple Developer account login) |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password generated for notarization |
| `APPLE_TEAM_ID` | Your **RBJ Global** Team ID (10 chars). Find it at developer.apple.com -> Account -> Membership details -> Team ID, or in the new cert's name in Keychain Access. NOT the old personal `6KR5F3225N`. |

`GITHUB_TOKEN` is provided automatically by Actions, so there is no sixth secret.

> **Identity note (2026-06-22):** the app ships under the **RBJ Global organization** Apple Developer account, NOT the founder's personal account. Do Step 0 first to retire the old personal cert and create the org one. Everything signs/notarizes under the org Team ID.

---

## Step 0 - Retire the personal cert + create the RBJ Global cert (one-time)

### 0a. Remove the old personal certificate from Keychain Access
1. Open **Keychain Access** -> **login** keychain -> category **My Certificates**.
2. Find **Developer ID Application: Junaid Siddiqi (6KR5F3225N)** (the personal one). Expand it to see its private key.
3. Select the certificate (and the nested private key) -> right-click -> **Delete**. Also delete any other personal-account leftovers (e.g. "Apple Development: Junaid ...") if present.
4. **Do NOT delete** "Apple Worldwide Developer Relations Certification Authority" - that is Apple's shared intermediate, needed for all signing.
5. (Optional) Removing it from Keychain does not revoke it at Apple. If you want it fully dead, revoke it in the personal account's portal under Certificates. Not required for our use.

### 0b. Create the new Developer ID Application cert under RBJ Global
First confirm you're acting in the org account: developer.apple.com -> Account shows **RBJ Global** (you must be Account Holder / Admin to create Developer ID certs).

**Fastest (if you have Xcode):** Xcode -> Settings -> Accounts -> select the **RBJ Global** team -> **Manage Certificates** -> **+** -> **Developer ID Application**. Xcode generates the key + installs the cert. Done.

**Portal path (no Xcode):**
1. Keychain Access -> menu **Certificate Assistant -> Request a Certificate from a Certificate Authority**. Enter your email + a common name (e.g. "RBJ Global Developer ID"), leave CA email blank, choose **Saved to disk**. Save the `.certSigningRequest`.
2. developer.apple.com -> Account -> **Certificates, IDs & Profiles** -> Certificates -> **+** -> **Developer ID Application** -> Continue -> upload the CSR -> download the `.cer`.
3. Double-click the downloaded `.cer` to install it into your login keychain (it pairs with the private key from step 1).
4. Confirm Keychain Access -> My Certificates now shows **Developer ID Application: RBJ Global ... (TEAMID)** with a private key.

### 0c. Note the new Team ID
developer.apple.com -> Account -> **Membership details** -> **Team ID** (or read it from the parentheses in the new cert name). That value is `APPLE_TEAM_ID`.

---

## Step 1 - Export the (new RBJ Global) signing certificate (~3 min)

1. Open **Keychain Access** (Applications -> Utilities).
2. Left sidebar: **login** keychain, category **My Certificates**.
3. Find the new **Developer ID Application: RBJ Global ... (TEAMID)**. Expand it to confirm it has a private key (a disclosure triangle with a key underneath).
4. Right-click it -> **Export "Developer ID Application: ..."** -> save as `tal-cert.p12` to your Desktop.
5. When prompted, set an **export password** (any strong password). Remember it: this is `APPLE_CERT_PASSWORD`.
6. Base64-encode it and copy to the clipboard (Terminal):

   ```sh
   base64 -i ~/Desktop/tal-cert.p12 | pbcopy
   ```

   The clipboard now holds the value for `APPLE_CERT_P12_BASE64`.
7. Delete the `.p12` afterward (`rm ~/Desktop/tal-cert.p12`) - it's sensitive and no longer needed once the secret is set.

## Step 2 - Create an app-specific password for notarization (~2 min)

1. Go to **https://appleid.apple.com** -> sign in.
2. **Sign-In and Security** -> **App-Specific Passwords** -> **+** (generate).
3. Label it e.g. `TAL CI Notarization`. Copy the generated password (format `abcd-efgh-ijkl-mnop`). This is `APPLE_APP_SPECIFIC_PASSWORD`.

## Step 3 - Add the five secrets to GitHub (~5 min)

1. Go to **https://github.com/RBJGlobal/TradingAgentsLab** -> **Settings** -> **Secrets and variables** -> **Actions**.
2. **New repository secret**, once per row in the table above:
   - `APPLE_CERT_P12_BASE64` -> paste (Cmd+V; it's on your clipboard from Step 1.6)
   - `APPLE_CERT_PASSWORD` -> the export password from Step 1.5
   - `APPLE_ID` -> your Apple ID email
   - `APPLE_APP_SPECIFIC_PASSWORD` -> from Step 2
   - `APPLE_TEAM_ID` -> your RBJ Global Team ID from Step 0c

That's the whole setup. Tell me when the five secrets are in and I'll cut a test release.

---

## Cutting a release (I drive this, for reference)

```sh
# bump desktop/package.json "version", commit to main, then:
git tag v0.2.0
git push origin v0.2.0
```

The tag push triggers `Release (macOS)`: it freezes the engine per arch (macos-14
arm64 + macos-13 Intel), builds, signs with your Developer ID, notarizes via your
Apple ID, and publishes a GitHub Release with the DMG(s) + the auto-update feed.
Watch it under the repo's **Actions** tab.

## Notes / known first-run items

- **First run is the real test of the pipeline.** The workflow is correct per
  electron-builder's documented CI pattern but has never executed; expect to
  shake out one or two issues on the first tag (common: the `postinstall`
  Info.plist patch, or the dual-arch update-feed below).
- **Dual-arch auto-update feed:** both arches publish to one release. The
  download DMGs for arm64 + Intel will both be there, but `latest-mac.yml`
  (the auto-update feed) may need an arch-aware fix so both arches update
  cleanly. We validate + fix this on the first release.
- If you would rather ship **arm64 only** first (most current Macs) and add
  Intel later, say so and I'll trim the matrix - it removes the dual-arch
  feed risk for v1.
