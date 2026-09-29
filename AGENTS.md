# Repository Workflow

- Follow `CONTRIBUTING.md` for branch ownership, integration, and release rules.
- Use `dev` for ongoing development once the team creates it. Integrate verified changes into `master` through a pull request.
- Preserve collaborator changes and uncommitted work. Do not mix unrelated changes into a commit.
- Reuse an existing appropriate integration PR rather than opening another long-lived release branch.
- Do not create release tags or trigger Windows/macOS packaging unless the user requests a release. Both platform packages must use the same source commit.

# Relay Accounting

- Both art and cart now use CNY accounting. Art migrated from USD at 6.75 on 2026-09-24, including user wallets, token quotas, prices, and historical ledger amounts. See `docs/art-cny-migration.md`; older deployment notes describe the pre-migration USD state and must not be used as current conversion instructions.

# CONFIG Operations

- For CONFIG model/group enable or disable requests, use `docs/config-channel-control.md` and `scripts/config-channel-control.py`. Reuse the deployed control tool instead of rebuilding or redeploying the service.
- CONFIG stable and the legacy preview endpoint share one published catalog. Keep CONFIG separate from art/cart relay backends; receipts restore only the enabled fields changed by that operation.
- Use each model card's call switch (`catalog.enabled`) for routine canvas call control. Disabling calls must keep the card visible; do not change `presentation.visible` unless hiding is explicitly requested. Publish to the selected CONFIG channel; relay backends remain a separate scope.
- Conditional parameter rules and customer/admin error boundaries are documented in `docs/remote-rules-and-errors.md`. Keep diagnostic credentials and private error mappings out of public CONFIG; never infer billing or retry submissions from missing logs.
- Customer error submissions and retention rules are documented in `docs/customer-error-reports.md`. Public submission responses contain receipts only; client-supplied context and server evidence must remain distinct.
- Model health aggregation is documented in `docs/generation-health.md`. Use real relay task outcomes, keep art/cart separate, and publish aggregates only. Missing completion timestamps must not be replaced with async submission latency.
