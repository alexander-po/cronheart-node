COMPOSE ?= docker compose
RUN := $(COMPOSE) run --rm node

.PHONY: help image install build test lint guard contract vectors matrix check smoke shell changeset clean

help:
	@echo "Targets (everything runs inside the container — no host Node or pnpm):"
	@echo "  image      Build the dev image"
	@echo "  install    pnpm install"
	@echo "  build      Bundle dist/ (ESM + CJS + .d.ts)"
	@echo "  test       Build, then run the Vitest suite"
	@echo "  lint       Build, then tsc + fixture tsc + publint + attw + size budget"
	@echo "  guard      Check the source for a network call or a throw outside its layer"
	@echo "  contract   Validate the wire contract against its own anchors and the SDK constants"
	@echo "  vectors    Run the language-neutral conformance vectors"
	@echo "  matrix     Run the fault matrix and its negative control"
	@echo "  smoke      Pack the tarball and consume it from a scratch ESM and CJS project"
	@echo "  check      The full gate: contract + build + lint + test + smoke"
	@echo "  shell      Interactive shell in the container"
	@echo "  changeset  Record a changeset for the next release"
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

vectors:
	$(RUN) pnpm run contract:vectors

matrix: build
	$(RUN) pnpm run fault-matrix

check:
	$(RUN) pnpm run check

shell:
	$(RUN) bash

changeset:
	$(RUN) pnpm run changeset

clean:
	$(COMPOSE) down -v --remove-orphans
