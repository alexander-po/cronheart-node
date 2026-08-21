COMPOSE ?= docker compose
RUN := $(COMPOSE) run --rm node

.PHONY: help image install build test lint guard contract drift vectors matrix min-peers check smoke shell changeset version clean

help:
	@echo "Targets (everything runs inside the container — no host Node or pnpm):"
	@echo "  image      Build the dev image"
	@echo "  install    pnpm install"
	@echo "  build      Bundle dist/ (ESM + CJS + .d.ts)"
	@echo "  test       Build, then run the Vitest suite"
	@echo "  lint       Build, then tsc + fixture tsc + publint + attw + size budget"
	@echo "  guard      Check the source for a network call or a throw outside its layer"
	@echo "  contract   Validate the wire contract against its own anchors and the SDK constants"
	@echo "  drift      Compare the wire contract against the snapshot of the published API"
	@echo "  vectors    Run the language-neutral conformance vectors"
	@echo "  matrix     Run the fault matrix and its negative control"
	@echo "  min-peers  Recheck the adapters against the lowest peer version each range admits"
	@echo "  smoke      Pack the tarball and consume it from a scratch ESM and CJS project"
	@echo "  check      The full gate: contract + build + lint + test + smoke"
	@echo "  shell      Interactive shell in the container"
	@echo "  changeset  Record a changeset for the next release"
	@echo "  version    Fold the pending changesets into CHANGELOG.md and bump package.json"
	@echo "  clean      Remove the containers and the node_modules / store volumes"

image:
	$(COMPOSE) build

install:
	$(RUN) pnpm install

build:
	$(RUN) pnpm run build

test: build
	$(RUN) pnpm run test

lint: build
	$(RUN) pnpm run lint

smoke: build
	$(RUN) pnpm run smoke

guard:
	$(RUN) pnpm run guard

contract: build
	$(RUN) pnpm run contract:check

drift:
	$(RUN) pnpm run contract:drift

vectors:
	$(RUN) pnpm run contract:vectors

matrix: build
	$(RUN) pnpm run fault-matrix

min-peers:
	$(RUN) pnpm run min-peers

check:
	$(RUN) pnpm run check

shell:
	$(RUN) bash

changeset:
	$(RUN) pnpm run changeset

version:
	$(RUN) pnpm run release:version

clean:
	$(COMPOSE) down -v --remove-orphans
