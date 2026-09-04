# Releasing Vidmark

Vidmark uses Sparkle 2.9.6 for signed macOS updates. The update feed and release disk images are served from the existing DigitalOcean-hosted Vidmark service at:

```text
https://vidmark-159-223-136-163.sslip.io/updates/
```

The update-signing private key is stored in the release operator's macOS Keychain under the Sparkle account `vidmark`. The repository contains only its public key. Never commit an exported private key.

## Create a release

1. Increment both `CFBundleShortVersionString` and `CFBundleVersion` in `packaging/Info.plist`.
2. Add `releases/Vidmark-<version>.md` with concise release notes.
3. Run `pnpm run release:mac`.
4. Review the generated DMG and `releases/appcast.xml`.
5. Upload both files to `/opt/vidmark-relay/updates/` on `vidmark-nyc1`.

The first Sparkle-enabled build must still be installed manually. Builds after that are discovered and installed through the signed feed. Application updates replace only `/Applications/Vidmark.app`; the SQLite database and user files under `~/Library/Application Support/Vidmark` are not touched.
