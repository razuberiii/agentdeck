# AgentDeck service restart repair

1. Reproduce reinstall identity loss in deploy-unit-install-contract tests using existing runtime.env.
2. Share service identity resolution between install-units and agentdeckctl rendering. Explicit options override existing runtime.env; new installs retain profile defaults. Never execute environment files as shell code.
3. Let systemd create /run/agentdeck with the runtime service identity at every start.
4. Run deployment regression tests, shell syntax checks and the project suite. Apply only the repaired identity and runtime-directory settings on this host, preserving its newer runtime lifecycle contract.
5. Restart services, verify runtime health, account readiness and public HTTPS, then commit and push GitHub.
