# Changelog

## [0.14.1](https://github.com/codapult/codapult-guard/compare/v0.14.0...v0.14.1) (2026-11-10)

### Bug Fixes

* update environment variable name for event path in runContext function ([a76e665](https://github.com/codapult/codapult-guard/commit/a76e6650722396af3da0e8b6a333875ecb6df344))
* update event path variable for pull request context reading ([b45e694](https://github.com/codapult/codapult-guard/commit/b45e694b26b413e7ab0c330604e0e2d598659b78))

## [0.14.0](https://github.com/codapult/codapult-guard/compare/v0.13.3...v0.14.0) (2026-11-09)

### Features

* add Guard verification predicate v1 specification and update predicate type ([8debb93](https://github.com/codapult/codapult-guard/commit/8debb932d970562195346daa5db152196fd10d56))
* bind verification scope to source revisions ([621da2a](https://github.com/codapult/codapult-guard/commit/621da2a445d7c51fef8f9a094ff861e67e8037d6))
* emit file-addressable Guard in-toto subjects ([c7db2be](https://github.com/codapult/codapult-guard/commit/c7db2be3217305ab12ff5229fa740fbe5bd86903))

## [0.13.3](https://github.com/codapult/codapult-guard/compare/v0.13.2...v0.13.3) (2026-11-02)

### Bug Fixes

* add terminalSafeJson function for safe JSON output ([6419c21](https://github.com/codapult/codapult-guard/commit/6419c216e77ec4d24cc4ca7b932362151fb4e907))

## [0.13.2](https://github.com/codapult/codapult-guard/compare/v0.13.1...v0.13.2) (2026-11-01)

### Bug Fixes

* **security:** harden guard inputs and workflows ([58cd786](https://github.com/codapult/codapult-guard/commit/58cd78614f2078ec556fb25fad2270e33e9911f3))

## [0.13.1](https://github.com/codapult/codapult-guard/compare/v0.13.0...v0.13.1) (2026-11-01)

### Bug Fixes

* **ci:** update Guard artifact action pin ([0dc5fd3](https://github.com/codapult/codapult-guard/commit/0dc5fd3a536d3990492c39bb54b803043c322ea6))
* enhance descriptions and input schemas for Guard tools ([df001ce](https://github.com/codapult/codapult-guard/commit/df001ce193488d559a1a3d829fee03186120b538))

## [0.13.0](https://github.com/codapult/codapult-guard/compare/v0.12.0...v0.13.0) (2026-11-01)

### Features

* **ci:** support trusted merge queues ([651d389](https://github.com/codapult/codapult-guard/commit/651d389836e29fb3660d542eaa0b3732cedf7ce1))

### Bug Fixes

* **ci:** trust base-branch PR verifier ([0f728f4](https://github.com/codapult/codapult-guard/commit/0f728f44c920e13ea04f574ebfaa811896d0d93f))
* **ci:** validate merge group base ancestry ([7368aa1](https://github.com/codapult/codapult-guard/commit/7368aa187462cd3e228be0cce9d672e785bee0cd))

## [0.12.0](https://github.com/codapult/codapult-guard/compare/v0.11.0...v0.12.0) (2026-11-01)

### Features

* add host-review policy mode to CI template ([8aab882](https://github.com/codapult/codapult-guard/commit/8aab882ead62a74bab4dfa8230af18079ed46903))
* add script to prepare fixture projects for testing ([0cedf8a](https://github.com/codapult/codapult-guard/commit/0cedf8a09276f615134b6554ef8fbbaabf68cdb7))

### Bug Fixes

* exclude .state.lock from verification scope files ([5e07858](https://github.com/codapult/codapult-guard/commit/5e078588f90a6736572087fdc88543e8c7540088))
* harden consumer Guard workflow template ([ad8fc0a](https://github.com/codapult/codapult-guard/commit/ad8fc0a6d691d29575997be59de52d73dc7def73))
* rename hono-node-server to node-server in fixture scripts ([a75dbe8](https://github.com/codapult/codapult-guard/commit/a75dbe8b0b7a445e10675a1087a7103879d54993))
* simplify fixture project cloning step by using preparation script ([afbd548](https://github.com/codapult/codapult-guard/commit/afbd548aa54aa0a45decd8811c816f0776a34601))

## [0.11.0](https://github.com/codapult/codapult-guard/compare/v0.10.0...v0.11.0) (2026-10-31)

### Features

* **guard:** add trusted PR attestation workflow template ([567c070](https://github.com/codapult/codapult-guard/commit/567c0709928d422b83ce2b6fe92395e98d1af3f2))
* **guard:** audit verification and CI policy integrity ([4694286](https://github.com/codapult/codapult-guard/commit/4694286ebb30e59a1c71346bb250865760a2ee98))
* **guard:** bind receipts to GitHub pull request SHAs ([1b02e19](https://github.com/codapult/codapult-guard/commit/1b02e198db033e213a7ddb1099392df7d436a572))
* **guard:** export verification receipts as in-toto statements ([76935d3](https://github.com/codapult/codapult-guard/commit/76935d309fe5fd88e34e0809698d5ba01bef71ad))
* **guard:** handle fork PR attestation skips ([83fbd94](https://github.com/codapult/codapult-guard/commit/83fbd9498d636b965ef4a3006a91a607f18f27d8))
* **guard:** harden trusted PR attestations ([db20ab2](https://github.com/codapult/codapult-guard/commit/db20ab206c4ad0fdfff9bc54209e4a80000ad77f))

### Bug Fixes

* **guard:** address security scan findings ([74c561a](https://github.com/codapult/codapult-guard/commit/74c561a2bcef298d465d7eeb8d32008903bb4bf9))
* **guard:** harden trusted PR verification ([495173c](https://github.com/codapult/codapult-guard/commit/495173c2f17b8f24bc1a0665bca7965d6bd29d82))

## [0.10.0](https://github.com/codapult/codapult-guard/compare/v0.9.0...v0.10.0) (2026-10-19)

### Features

* harden verification provenance ([1232669](https://github.com/codapult/codapult-guard/commit/1232669c5bbbf88007d66357da5ab9c020249744))

### Bug Fixes

* validate receipt policy provenance ([25598f5](https://github.com/codapult/codapult-guard/commit/25598f593815f36b75963bca859a240d994866df))

## [0.9.0](https://github.com/codapult/codapult-guard/compare/v0.8.1...v0.9.0) (2026-10-15)

### Features

* expose guarded policy and MCP context ([69d840d](https://github.com/codapult/codapult-guard/commit/69d840d920c56a8106e6f21f0bd04254f6af1b54))
* **mcp:** separate context state clearly ([f8a42e8](https://github.com/codapult/codapult-guard/commit/f8a42e8ec0be4955885777bbc45f145abf7c35ba))

### Bug Fixes

* **core:** harden guard state and policy artifacts ([0ea45ca](https://github.com/codapult/codapult-guard/commit/0ea45ca392c6916a3cff13257a184b27fcadd2f6))

## [0.8.1](https://github.com/codapult/codapult-guard/compare/v0.8.0...v0.8.1) (2026-10-12)

### Bug Fixes

* harden governance and run provenance ([f397b01](https://github.com/codapult/codapult-guard/commit/f397b01ba3ba0b453f0c65510b27daafa277e559))

## [0.8.0](https://github.com/codapult/codapult-guard/compare/v0.7.0...v0.8.0) (2026-10-02)

### Features

* add governance provenance audit ([ec88cf7](https://github.com/codapult/codapult-guard/commit/ec88cf7a5058122f8a7f094f91025f7c71eba372))
* expose protected policy verification ([8b512ff](https://github.com/codapult/codapult-guard/commit/8b512ff4240f88e7d4f4933ad4c7894d5f38d019))
* verify against protected policy revisions ([6891f49](https://github.com/codapult/codapult-guard/commit/6891f49f87b7faf752ef0998e174ab733ff7ad2e))

### Bug Fixes

* secure agent instruction installation ([219bcf8](https://github.com/codapult/codapult-guard/commit/219bcf869bd6e14f8fa2eeacd3d62b18d4ecead8))

## [0.7.0](https://github.com/codapult/codapult-guard/compare/v0.6.2...v0.7.0) (2026-09-29)

### Features

* add time-bounded Guard waivers ([4f79593](https://github.com/codapult/codapult-guard/commit/4f79593400939b7ad33a08f71d1e171d09a12701))
* expose waiver management through CLI and MCP ([e44f18c](https://github.com/codapult/codapult-guard/commit/e44f18cdf0a09e32d7c25f797fc5ece918defe49))
* strengthen Guard policy diagnostics and waiver controls ([36896b0](https://github.com/codapult/codapult-guard/commit/36896b006d828f846c8af5e5a965e6614f0264a5))

### Bug Fixes

* increase npm wait timeout and interval for better stability ([7067708](https://github.com/codapult/codapult-guard/commit/7067708a4ee0568007d7ea2238c81110046d37f4))

## [0.6.2](https://github.com/codapult/codapult-guard/compare/v0.6.1...v0.6.2) (2026-09-28)

### Bug Fixes

* use project formatting and bound npm wait ([73224c1](https://github.com/codapult/codapult-guard/commit/73224c15314b1229cae0d6525372a0cf5a85063b))
* wait for npm propagation before registry publish ([9a21bb2](https://github.com/codapult/codapult-guard/commit/9a21bb2bf15f698a07bf74b527fc9ab11fa7a68c))

## [0.6.1](https://github.com/codapult/codapult-guard/compare/v0.6.0...v0.6.1) (2026-09-28)

### Bug Fixes

* shorten MCP Registry description ([5a7569f](https://github.com/codapult/codapult-guard/commit/5a7569f35d250bdefdbb1bd8d28f20cd557f0c84))

## [0.6.0](https://github.com/codapult/codapult-guard/compare/v0.5.0...v0.6.0) (2026-09-28)

### Features

* **ci:** publish Guard metadata to MCP Registry ([7b4ddb8](https://github.com/codapult/codapult-guard/commit/7b4ddb886a39a1b4f928320984ea963defe9ca15))

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
