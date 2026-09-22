# Repository Workflow

- Follow `CONTRIBUTING.md` for branch ownership, integration, and release rules.
- Use `dev` for ongoing development once the team creates it. Integrate verified changes into `master` through a pull request.
- Preserve collaborator changes and uncommitted work. Do not mix unrelated changes into a commit.
- Reuse an existing appropriate integration PR rather than opening another long-lived release branch.
- Do not create release tags or trigger Windows/macOS packaging unless the user requests a release. Both platform packages must use the same source commit.

# CONFIG Operations

- For CONFIG model/group enable or disable requests, use `docs/config-channel-control.md` and `scripts/config-channel-control.py`. Reuse the deployed control tool instead of rebuilding or redeploying the service.
- Keep CONFIG preview, CONFIG stable, and the art/cart relay backends distinct. Change only the requested scope; receipts restore only the enabled fields changed by that operation.
- Use each model card's call switch (`catalog.enabled`) for routine canvas call control. Disabling calls must keep the card visible; do not change `presentation.visible` unless hiding is explicitly requested. Publish to the selected CONFIG channel; relay backends remain a separate scope.
