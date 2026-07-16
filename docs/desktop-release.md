# Desktop Release

AgentMailbox desktop releases are built from a signed version tag (`v*`) by
`.github/workflows/desktop-release.yml`. The workflow produces notarized macOS
DMG and ZIP artifacts for Intel (`x64`) and Apple Silicon (`arm64`).

Before publishing the first release, configure these repository Action secrets:

- `CSC_LINK`: Developer ID Application certificate as a password-protected
  PKCS#12 data URL accepted by electron-builder.
- `CSC_KEY_PASSWORD`: password for that certificate.
- `APPLE_API_KEY_BASE64`: base64-encoded App Store Connect API `.p8` key.
- `APPLE_API_KEY_ID`: App Store Connect API key ID.
- `APPLE_API_ISSUER`: App Store Connect issuer ID.

The workflow fails closed when any signing or notarization secret is absent.
It launches each packaged application, waits for its loopback health endpoint,
and verifies that the bundled UI is served before publishing the artifacts.

For an unsigned local bundle, run `npm run package:mac:dir`. To create a
release, update the package version, commit it, and push its matching `v*` tag.
