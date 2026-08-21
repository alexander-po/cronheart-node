COMPOSE ?= docker compose

# Behind a TLS-inspecting proxy the container trusts no host CA, so anything the
# gate does over the network fails where the host succeeds. Point CA_FILE at a
# PEM bundle to hand it in; leave it unset and nothing changes.
CA_FILE ?=
CA_MOUNT := $(if $(CA_FILE),-v $(CA_FILE):/etc/ssl/extra-ca.pem:ro -e NODE_EXTRA_CA_CERTS=/etc/ssl/extra-ca.pem,)

RUN := $(COMPOSE) run --rm $(CA_MOUNT) node

.PHONY: help image install build test lint guard contract drift vectors matrix min-peers check smoke docs release-gate shell changeset version clean

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
	@echo "  docs       Compile every documented sample and probe every documented flag"
	@echo "  release-gate  The docs, the leak scan and the release metadata — run before a tag"
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

docs: build
	$(RUN) pnpm run doc-claims

release-gate: build
	$(RUN) pnpm run release-gate

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
