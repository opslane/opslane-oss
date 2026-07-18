# Opslane Python E2B template

This template provides the Python 3.12 environment for the Opslane Python fix
pipeline. It includes native build dependencies, Git, and a pinned pytest so the
Batch 3 test gate does not depend on each target repository declaring its test
runner as a runtime dependency.

## Ownership

The template is owned by the **Opslane** E2B team
(`824cf00b-6c58-49e6-ae5f-a8419069a091`). Build it only while authenticated
with the same E2B team used by the production worker's `E2B_API_KEY`; template
names are team-local.

## Build

From this directory, with the production team's E2B credential configured:

```bash
pnpm dlx @e2b/cli@2.7.2 template build \
  --name opslane-python \
  --dockerfile e2b.Dockerfile \
  --team 824cf00b-6c58-49e6-ae5f-a8419069a091
```

The E2B CLI creates `e2b.toml`, which records template ID
`84c1j5abpjvqq2g5n5va`. Batch 3 will reference that ID. Do not create or edit
`e2b.toml` by hand.
