# ADR 0025：下一大版本仅承诺 Node 24.x

- Status: Accepted for next major; applies to the unreleased working branch only
- Date: 2026-09-26
- Authorized by: User
- Scope: `package.json`, CI/release/smoke workflows, and next-major documentation
- Supersedes: ADR 0012 runtime support policy for the next major only

## Context

The next-major branch inherited a broad `>=22` engine declaration and CI coverage across Node 22, 24, plus an optional Node 26 compatibility job. Local implementation and packaging validation have been performed on Node 24. The user selected a narrower support commitment for the unreleased major: formally support Node 24.x only and defer promises for other Node major versions. This is a support-policy choice; there is no evidence that Node 22 is defective.

The published npm `0.6.1` predates this decision and retains its published `>=22` declaration and behavior. Historical specifications, test reports, and ADRs describing Node 22/26 remain factual records for the versions and decisions they covered.

## Decision

1. The unreleased next major declares `engines.node: "24.x"` in `package.json` and the matching root package entry in `package-lock.json`.
2. Every blocking quality, build, install, pack-install, GitHub npx, release, and live-smoke workflow uses Node 24. The existing OS coverage and all blocking jobs remain in `required-ci`.
3. Remove only the optional Node 26 compatibility probe. It performed an extra `npm test`, was already non-blocking, and did not provide a separate npm 12 or Git installation check. Existing package, tarball, and GitHub npx installation checks remain intact on Node 24.
4. Do not add a startup-time hard failure for other Node versions as part of this policy. An engine declaration communicates the supported range without expanding code behavior.
5. Update next-major user and maintainer documentation to say only Node 24.x is supported and other major versions are not promised. Keep Node 22/26 results in historical documents and mark previously planned Node 22 acceptance as superseded by this decision.
6. The remote Node 24 CI run remains a release gate. This local change does not claim that remote CI has passed.

## Consequences

- The next-major package makes no support promise for Node 22 or Node 26, without claiming either runtime has a defect.
- Future CI signals apply to the supported Node 24 line while retaining Linux, Windows, macOS smoke, standalone install, tarball, and GitHub npx coverage.
- npm `0.6.1` is unchanged; this ADR does not alter its already published metadata or public MCP interface.
- Node 24 remote CI must pass before the next major can satisfy its release gate.
