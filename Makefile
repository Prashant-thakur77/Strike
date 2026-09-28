.PHONY: build test ci-test fmt fmt-check snapshot coverage stylus-test stylus-check lint

export PATH := $(HOME)/.foundry/bin:$(HOME)/.cargo/bin:$(PATH)

build:
	cd contracts && forge build

test:
	cd contracts && forge test

ci-test:
	cd contracts && FOUNDRY_PROFILE=ci forge test

fmt:
	cd contracts && forge fmt

fmt-check:
	cd contracts && forge fmt --check

snapshot:
	cd contracts && forge snapshot

coverage:
	cd contracts && forge coverage --ir-minimum --report summary --no-match-coverage "(test|script|lib)/"

stylus-test:
	cargo test --manifest-path stylus/pricer/Cargo.toml

stylus-check:
	cd stylus/pricer && cargo stylus check

lint:
	pnpm -r lint
