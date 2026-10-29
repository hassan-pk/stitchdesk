# StitchDesk 0.1.0 validation

Verified on Windows, 2026-10-30, using isolated temporary databases and synthetic records. No real business databases are accessed by these tests.

## Automated checks

- Production TypeScript/Vite build.
- 24 unit/integration regressions: core authentication, stock, payments, workflow, references, composite uniqueness, date ordering, integer/max rules, booking capacity, image validation, app-identity isolation, staged backup/restore, fee settlement and document escaping/identity.
- Every configured business module created/read/edited using actual configuration.
- Development and packaged Electron desktop workflows: first-run setup, every module created through real forms, calculated totals and references, photo upload, search/status filter, detail view, document iframe and simulated native print cancellation.
- Invalid overpayment rejected with records unchanged; full bank collection and workflow changes checked.
- Restart/login and native-dialog-stubbed backup export/overwrite/restore verified.

## Reproduce

```powershell
npm ci
npm run build
npm test
node tests/desktop.cjs
```

To test the built executable after `npm run dist`:

```powershell
$env:BUSINESS_TEST_EXECUTABLE = (Resolve-Path 'release/win-unpacked/StitchDesk.exe').Path
node tests/desktop.cjs
```

Set `BUSINESS_SCREENSHOTS=1` to regenerate the public screenshots as part of the desktop test. All demo fields and photos belong to the synthetic test workspace. This is not a seed/import for a real business.

## Not yet verified

Physical printer output, Windows driver/paper settings, second-computer install/uninstall/upgrade behavior, real trading-day operation and multi-year data performance. No cloud/networking or multi-user claims. Read BUSINESS.md and README.md for feature limits.
