# Agents

- No cronheart account yet: read step 6 of the recipe below first. Ask the person for the address and whether they accept the Terms of Service and the Privacy Policy, then run `cronheart signup <address> --accept-terms --env-path=$HOME/.config/cronheart/api-key.env` as a background task, give the person the code it prints, and wait for it to write the account's first API key to that file, outside the repository.
- Adding cronheart to a project's scheduled jobs: follow [skills/add-cronheart/SKILL.md](skills/add-cronheart/SKILL.md) step by step. It is a Claude Code skill and reads as a plain recipe for any agent.
- Every command, flag, variable and sample in that recipe is held to the built package by the same gate as the README, so what it says is what the package does.
- Working on this repository itself: [CLAUDE.md](CLAUDE.md) is the handover, and `make check` is the gate before every commit.
