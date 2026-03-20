# Project Workflow (WSL + GitHub)

This repo follows a standard workflow used across my WSL projects. Prefer the canonical commands below and avoid improvising new scaffolding unless I ask.

## Folder conventions (context)
- Projects root: ~/Projects
- scratch/ = experiments + MVPs
- oss/ = open-source candidates
- clients/ = client work
- scripts/ = helper scripts (not part of most repos)

## Canonical creation flow
New Node projects are created from the template at:
- ~/Projects/scratch/_template-node

Preferred generator:
- new-node <project-name> [target-folder]

Examples:
- new-node my-project (defaults to ~/Projects/scratch)
- new-node my-project ~/Projects/oss

Expected result after generation:
- git repo initialized on branch main
- initial commit exists (init from template)
- .env is ignored
- .env.example exists and is committed

## GitHub (preferred: gh CLI, private by default)
Create the GitHub repo with:
- gh repo create <repo-name> --private --source . --remote origin --push

After that (normal workflow):
- git add .
- git commit -m "..."
- git push

## Sync workflow (when GitHub was edited elsewhere)
Inside the repo:
- git fetch origin
- git pull --rebase

## Security rules (non-negotiable)
Never commit secrets.

### Env handling
- .env must NEVER be tracked.
- .env.example SHOULD exist and can be committed.

.gitignore policy:
- ignore .env
- ignore .env.*
- allow !.env.example

Quick checks:
- git check-ignore -v .env || echo ".env is NOT ignored"
- git ls-files | grep -E '^\.env' && echo "BAD: env tracked" || echo "OK: env not tracked"
