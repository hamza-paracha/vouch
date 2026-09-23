# Security policy

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/hamza-paracha/browser-verify/security/advisories/new). Include the affected commit, a minimal reproduction using synthetic data, and the impact. Please keep credentials and real application data out of reports.

This project is maintained on a best-effort basis; it does not provide a response-time or security-support SLA. Fixes target the latest `main` and alpha release.

## Scope

Relevant issues include bypassing origin or write-path restrictions; reading local files, environment values or credentials through the tool; escaping configured model budgets; and causing failures or incomplete runs to be reported as passes. Issues in the inherited explorer/runner, including authentication or saved-session exposure, are also in scope.

Browser Verify is intended for controlled disposable local HTTP apps. Its browser proxy is not an operating-system sandbox for hostile sites. Evidence is stored locally and may contain application data. See [documented boundaries](docs/verification.md#bounds-and-current-limits).

A bug that Browser Verify finds in a target application is not itself a vulnerability in Browser Verify.
