# Anthropic Agent SDK terms verdict

- **Status:** SUPERSEDED — reversed 2026-07-22 by founder decision. The SDK may be used
  as a plain npm dependency of the CLI (npm fetches it separately; we do not bundle it).
  Rationale for the reversal: other shipping tools depend on it the same way, and we will
  not build and maintain our own agent harness. The analysis below is kept for the record.
- **Prior status:** Rejected for P3
- **Reviewed:** 2026-07-21
- **Package reviewed:** `@anthropic-ai/claude-agent-sdk@0.3.217`

This is an engineering dependency decision, not legal advice. The published terms do not
provide the permission or provider independence P3 needs, so the conservative implementation
decision is to treat the SDK as restrictive.

## Evidence

- The [published npm metadata](https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk/0.3.217)
  declares `license: "SEE LICENSE IN README.md"`.
- The versioned [`LICENSE.md`](https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.217/LICENSE.md)
  says the code is all rights reserved and that use is subject to Anthropic's Commercial
  Terms. The versioned [README license section](https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.217/README.md#license-and-terms)
  likewise says all SDK use is governed by those terms, including use in products offered to
  a customer's own users. This is a contractual permission to use a service, not an
  open-source software license.
- Section A.1 of the [Commercial Terms](https://www.anthropic.com/legal/commercial-terms)
  permits a Customer to use the Services to power products for its users. Section D.4,
  however, prohibits using the Services to build a competing product or service, reselling
  the Services without approval, and reverse engineering or duplicating the Services. The
  Usage Policy, Supported Regions Policy, and Service Specific Terms are incorporated as
  additional conditions.
- Anthropic's [Agent SDK setup documentation](https://code.claude.com/docs/en/agent-sdk/overview#set-your-api-key)
  requires an Anthropic Console API key or credentials for one of its supported commercial
  cloud-provider paths. Anthropic's
  [authentication rules](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)
  also forbid a third-party product from offering Claude.ai login or routing users through
  Free, Pro, or Max credentials.

## Questions

### 1. May it be redistributed as a dependency of a published package?

**No usable redistribution grant was found; treat it as not redistributable.** A plain npm
`dependencies` entry does not itself copy the SDK into Opslane's package tarball: npm fetches
the dependency separately. That distinction does not clear the dependency for P3, because
the SDK and its bundled native Claude Code binary remain all-rights-reserved, and neither the
README nor the Commercial Terms expressly grants rights to reproduce, redistribute, or
sublicense them. Bundling the SDK or compiling its binary into the CLI would be redistribution
without a published grant.

The README's permission to _use_ the Services in a customer-facing product is not a
replacement for an explicit software redistribution license. Shipping this dependency would
therefore require written Anthropic permission or a legal determination outside this project.

### 2. Is usage tied to being an Anthropic API customer?

**Yes, or to an approved Anthropic commercial channel.** The SDK is governed by the
Commercial Terms' Customer relationship. The documented authentication paths are an
Anthropic Console API key or supported providers such as Amazon Bedrock, Google Cloud, and
Microsoft Foundry. Consumer subscription credentials cannot be routed through a third-party
product.

Pointing `ANTHROPIC_BASE_URL` at an Opslane or self-hosted endpoint may work technically, but
the published terms do not grant standalone use of the SDK with an arbitrary deployment.
Self-hosters who are not Anthropic customers, and who do not use one of the approved provider
paths, therefore have no documented permission path. P3 cannot make that commercial
relationship a prerequisite for running an otherwise self-hosted Opslane CLI.

### 3. Is there a field-of-use restriction incompatible with a commercial product?

**There is a material field-of-use restriction.** Ordinary customer-facing commercial use
is expressly contemplated, so the terms are not a blanket non-commercial license. But
Section D.4 excludes competing products and services and unapproved resale. Opslane's local
agent performs automated code investigation and remediation, which is close enough to
Claude Code's product area that the restriction creates unresolved applicability risk. It is
not compatible with distributing P3 as an unqualified general-purpose commercial and
self-hosted feature.

## Consequence

Do not lock `@anthropic-ai/claude-agent-sdk` for P3. Use the Apache-2.0 Vercel AI SDK fallback.
P3 must include the additional work to build and test its own shell-free local executor
boundary instead of relying on Anthropic's `allowedTools` and `canUseTool` configuration.

Relicensing the Opslane CLI to AGPL removes the repository's MIT-dependency CI gate only. It
does not grant rights that Anthropic's terms withhold and does not change this verdict.
