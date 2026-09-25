# Changelog

## [0.5.0](https://github.com/codapult/codapult-guard/compare/v0.4.0...v0.5.0) (2026-09-25)

### Features

* expand tool adapters and run observability ([717c248](https://github.com/codapult/codapult-guard/commit/717c248fe96cdc2ee488539d9ca59ccd360d7ef8))
* expose Guard integration workflows ([0c7ca3e](https://github.com/codapult/codapult-guard/commit/0c7ca3e86b8b5d30b8c78788c7b77dce9623a8c2))

### Bug Fixes

* bound persisted Guard run history ([d0d292e](https://github.com/codapult/codapult-guard/commit/d0d292eb530fe690f9b1c8ad241df7c170b9907a))
* reject unsafe Guard run manifests ([120ad4e](https://github.com/codapult/codapult-guard/commit/120ad4e5ef4cce011fc1d562d407fc9bfeb6b36a))
* validate persisted run manifests ([dec9b0b](https://github.com/codapult/codapult-guard/commit/dec9b0bb5c552fe8e29e1ab13ddeaeec106d27fb))

## [0.4.0](https://github.com/codapult/codapult-guard/compare/v0.3.0...v0.4.0) (2026-09-24)

### Features

* add Guard run provenance and baseline reasons ([849ac8e](https://github.com/codapult/codapult-guard/commit/849ac8efcb1ae28ee9b3c9409ac77102d370db4e))
* add protected policy approval mode ([2e602c5](https://github.com/codapult/codapult-guard/commit/2e602c5dea83ba4d2d766a2d45d9524b2fb01164))
* add scoped architecture budgets ([68a6755](https://github.com/codapult/codapult-guard/commit/68a675524e784562a73ad42912f45fd3c1c71ed4))
* make guard state concurrency safe ([a331dc1](https://github.com/codapult/codapult-guard/commit/a331dc1fa6583ef8c93d4c47a1c2f161b042688f))

### Bug Fixes

* harden guard state and artifact reads ([ea21096](https://github.com/codapult/codapult-guard/commit/ea210969f7e7f64ab253a6133a1d54d945f2b8df))
* harden guard state and MCP boundaries ([3359145](https://github.com/codapult/codapult-guard/commit/3359145fdcb0b24752bbb63b9f7a65afef022f77))
* harden policy scope and approval validation ([b535e56](https://github.com/codapult/codapult-guard/commit/b535e569cca3500196ba24e5eb406ddd7e222658))
* record Guard run commit and gate status ([8f9ed23](https://github.com/codapult/codapult-guard/commit/8f9ed23e4c1e3974942b27156845f265d4bd965a))
* recover interrupted policy transactions ([d480a42](https://github.com/codapult/codapult-guard/commit/d480a4252efa60d8b51e650023cdba1c03ba805b))
* serialize policy activation and audit decisions ([38e3d82](https://github.com/codapult/codapult-guard/commit/38e3d826db2799ed841d9279b6e8f4e283f3602f))
* validate all policy scopes before scanning ([a0c194a](https://github.com/codapult/codapult-guard/commit/a0c194ac20aaf5c87a8a9c8e449b34af587026c2))

## [0.3.0](https://github.com/codapult/codapult-guard/compare/v0.2.0...v0.3.0) (2026-09-23)

### Features

* add impact-aware workspace guardrails ([cbeefb3](https://github.com/codapult/codapult-guard/commit/cbeefb3f251e83ea8d4974c3dd9d79202a036f3d))
* complete guard reliability hardening ([ad00615](https://github.com/codapult/codapult-guard/commit/ad00615ffe914ca32c116cb82eb0496adf605c23))
* deepen guard analysis and policy validation ([38cd181](https://github.com/codapult/codapult-guard/commit/38cd181d41052b28a40634999e098fb18bcf43c8))
* make guard findings explainable ([5428e0d](https://github.com/codapult/codapult-guard/commit/5428e0db31cdab69d556a9e2ea04de78f6ebfbcf))

### Bug Fixes

* add .codapult/guard/ to prettier ignore list ([a9aecbe](https://github.com/codapult/codapult-guard/commit/a9aecbed15e1a9101769d90379cce58295429caa))
* fail closed on unsafe guard execution ([d9b57f7](https://github.com/codapult/codapult-guard/commit/d9b57f7a1a195ca84cb7d77c3ba2b32c8b2c68c0))
* harden guard discovery and proposal flow ([e021497](https://github.com/codapult/codapult-guard/commit/e021497382a564b9083ae620b26e624ef79b423e))
* normalize guard error contract ([1af6e37](https://github.com/codapult/codapult-guard/commit/1af6e37f75f15af9cebbc432434c3048d3009fcd))

## [0.2.0](https://github.com/codapult/codapult-guard/compare/v0.1.0...v0.2.0) (2026-09-18)

### Features

* **guard:** deepen change impact analysis ([30125a8](https://github.com/codapult/codapult-guard/commit/30125a883209691f32d0301d6dfd170c1a093bbb))

## 0.1.0

- Initial public alpha release of the standalone Guard package.
- Deterministic project discovery, architecture policy, baselines, contracts, MCP, and CI output.
