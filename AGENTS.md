# Repository Guidelines

## Project Overview

- **omp** is a terminal coding agent: a CLI/TUI that drives LLMs through tool calls, plus an SDK, RPC/ACP servers, and a local stats dashboard. It is a Bun + TypeScript monorepo backed by a Rust N-API addon.
- **Primary focus: `packages/coding-agent/`.** Assume work targets it unless told otherwise. When the user says "the agent" or asks "why is agent doing X", they mean this package's code, not you.
- **This checkout is a personal fork.** `origin` = `Randallsm83/oh-my-pi`, `upstream` = `can1357/oh-my-pi`. The fork's commits sit rebased on an upstream release tag. Pre-rebase states are kept in `backup/pre-rebase-*` branches. Fork additions:
  - `bash.userShell` runs tool commands in the user's login shell. Code: `src/exec/settings.ts`, `src/tools/bash.ts`.
  - `bash.color` keeps command colors. Code: `src/exec/non-interactive-env.ts`, `src/exec/bash-executor.ts`, pi-tui `streaming-output.ts` and `terminal-output.ts`.
  - The WezTerm `OMP_TITLE` user var, and `OMP_AGENT_SHELL=1` exported in PTY shells.
  - Keyboard input for user `!` commands.
  - Advisor notes delivered mid-run.
  - Recovery of `xd://` device calls, and stats attribution for them.

## Architecture & Data Flow

Package layering, from bottom to top (every package ships raw `src/*.ts`; none has a build step):

```
omptype, wire, natives → utils → catalog → ai → snapcompact → agent (pi-agent-core) → tui → stats, mnemopi → coding-agent
```

Boot path (`packages/coding-agent/src`):

```
cli.ts ─ profile bootstrap → declareWorkerHostEntry() → worker-selector dispatch (returns early) → --smoke-test
       └ run() over cli-commands.ts → commands/launch.ts → main.ts runRootCommand
           → sdk.ts createAgentSession: Settings, ModelRegistry, discovery (skills/rules/MCP/extensions),
             createTools(ToolSession), each tool wrapped in ExtensionToolWrapper (approval gate + hooks),
             new Agent({ streamFn, … }) from pi-agent-core, new AgentSession(…)
           → mode: interactive (modes/interactive-mode.ts) | print (modes/print-mode.ts) | rpc (modes/rpc/) | acp (modes/acp/)
```

One turn:
1. `AgentSession.prompt()` (`session/agent-session.ts`) calls `agent.prompt()`.
2. pi-agent-core runs its loop (`packages/agent/src/agent-loop.ts`). It calls `streamFn`, which is `session/settings-stream-fn.ts`, which calls pi-ai `streamSimple` (`packages/ai/src/stream.ts`).
3. pi-ai resolves headers and in-flight limits, then dispatches: first the custom API registry, then special-cased providers, then `switch (model.api)`. It returns an `AssistantMessageEventStream`.
4. Tool calls go through `executeToolCalls`, which calls `tool.execute(toolCallId, params, signal, onUpdate, ctx)` and emits `tool_execution_start`, `tool_execution_update` and `tool_execution_end`.
5. `AgentSession.#handleAgentEvent` persists messages to JSONL (`session/session-manager.ts`) and handles compaction, retry/fallback and TTSR. It then re-emits the events to mode subscribers.
6. In interactive mode, `modes/controllers/event-controller.ts` creates a pi-tui `ToolExecutionComponent` (`packages/tui/src/chat/tool-execution.ts`). The renderer comes from `toolRenderers[name]` (`packages/tui/src/tools/index.ts`).

Natives: `crates/natives` (a cdylib facade over the sibling crates) compiles to `packages/natives/native/pi_natives.<platform>-<arch>[-modern|-baseline].node`.
- `native/loader-state.js` loads the addon in this order: embedded addon (compiled binary), then Windows staging copy, then npm leaf package, then local `native/`.
- If the addon is stale, missing exports throw `missingNativeExport` errors that tell you to run `bun run build:native`.

## Key Directories

| Path | Purpose |
| --- | --- |
| `packages/coding-agent` | Main CLI (`@oh-my-pi/pi-coding-agent`, bin `omp` → `src/cli.ts`) |
| `packages/agent` | `@oh-my-pi/pi-agent-core`: agent loop, `Agent` state, compaction |
| `packages/ai` | Multi-provider LLM streaming, auth/OAuth registry, error classes (`src/error/`) |
| `packages/catalog` | Bundled `models.json`, KDL compat engine, model identity/classification, discovery |
| `packages/tui` | TUI engine **and** coding-agent UI: `chat/`, `tools/` (renderers + `*Details` types), `overlays/`, `theme/`, `render/render-utils.ts` |
| `packages/utils` | `logger`, `ptree`, `postmortem`, `prompt`, stream readers, dirs/env, `worker-host`, `TempDir`, `isEnoent`, `$which` |
| `packages/natives` | JS loader for the Rust addon; lazy subpaths `./vcs`, `./path`, `./desktop`, `./clipboard` |
| `packages/omptype` | ArkType-compatible `type()` schemas used for tool parameters |
| `packages/stats`, `mnemopi`, `snapcompact`, `wire` | `omp stats` dashboard; SQLite memory engine; compacted-history PNG frames; collab wire types |
| `packages/collab-web`, `browser-relay`, `metaharness`, `typescript-edit-benchmark` | Private: collab web client, Chrome relay extension, benchmark harnesses |
| `crates/*` | Rust logic crates (shell, vcs, edit, ast, walker, vfs, iso, diff, predict, voice, builtins); `crates/vendor/` holds patched forks |
| `scripts/` | Repo tooling: test runner, Rust tasks, setup, release, changelog fixers, codegen |
| `docs/` | Feature/architecture docs. **Everything in `docs/**/*.md` ships in the `omp://` docs corpus** except `docs/agents/` and `docs/adr/` (dev-only; filtered by `isCorpusDoc` in `internal-urls/docs-index.ts`), so other dev-only notes do not belong there |
| `python/` | `omp-rpc` client and `robomp` (pytest, ruff) |
| `patches/`, `types/` | bun `patchedDependencies`; asset module typings (`types/assets/index.d.ts`, extend for new text-import extensions) |

Inside `packages/coding-agent/src`:
- `tools/`: built-in tools plus the `BUILTIN_TOOLS` registry (`tools/index.ts`) and `xdev.ts` (`xd://` devices).
- `session/`: `AgentSession`, `SessionManager`, compaction, retry.
- `config/`: settings registry, model registry.
- `capability/` and `discovery/`: skills, rules, MCP, context files and hooks, including foreign formats such as Claude, Codex and Cursor.
- `extensibility/`: the extension API, plugins, marketplace.
- `internal-urls/`: one `*-protocol.ts` per scheme.
- `modes/`: interactive, print, rpc and acp modes, plus `controllers/`.
- `prompts/`: static `.md` prompt files.
- `task/`: subagents.
- `exec/`, `eval/`, `lsp/`, `mcp/`: execution and integration backends.

There is no `src/tui/`: UI components live in pi-tui. `packages/coding-agent/DEVELOPMENT.md` maps subsystems to docs, but its directory list is partly stale.

## Development Commands

Run from the repo root. On Windows, run Bun from `D:/omp-fork`: under the `~/projects` junction, bun segfaults.

```bash
bun setup                         # install → build:native → link the `omp` dev launcher
bun dev                           # run the CLI from source (packages/coding-agent/src/cli.ts)
bun run check                     # gate: oxlint + oxfmt --check + per-package tsgo, and cargo fmt/clippy
bun run fix                       # oxlint --fix + oxfmt (+ format-prompts) + cargo fmt/clippy --fix
bun run test                      # all TS buckets + Rust (scripts/ci-test-ts.ts local)
bun run test:rs                   # cargo nextest (vendored forks excluded) + cargo test --doc
bun run ci:test:smoke             # cli.ts --version/--help/stats --help/--smoke-test
bun run build:native              # rebuild the addon after Rust changes (cargo/napi, profile `local`)
bun --cwd=packages/natives run build:bindings   # regenerate native/index.d.ts + index.js exports after Rust API changes
bun --cwd=packages/coding-agent run build       # compiled binary → packages/coding-agent/dist/omp (CROSS_TARGET=… for cross)
bun run gen:compat && bun run gen:models        # after KDL/catalog source edits; commit the generated files
```

- **`check:rs`, `lint:rs` and `test:rs` skip themselves locally** unless `git status` shows Rust-affecting changes. A green local `bun run check` may not have run clippy. Force a run with `CI=1`.
- **Regeneration duties, all CI-checked:**
  - after editing `Cargo.toml` or `Cargo.lock`, run `bun run gen:bazel-lock`
  - after `bun.lock` changes, run `bun run gen:nix`
  - after editing collab-web tool renderers, run `bun run gen:tool-views`
- Root `bun run build` builds every workspace (binary, natives, stats, relay, collab-web) and is heavy. Prefer the targeted builds above.
- **Commit only when asked.** Use `bun run check`, never `tsc`/`npx tsc`. Use `bun run test:rs`, never bare `cargo test`.
- **`bun run release` is upstream-only.** It requires `<version|major|minor|patch|canary>`, bumps versions, then commits and pushes `main` plus the tag to `origin`, which here is the fork. Never run it in this fork. Fork versions follow upstream tags through rebases.

## Code Conventions & Common Patterns

### TypeScript style
- Formatting is oxfmt (`.oxfmtrc.json`): tabs (width 3), `printWidth` 120, double quotes, trailing commas, `arrowParens: avoid`. Lint is oxlint (`.oxlintrc.json`). There is no biome, eslint or prettier gate.
- Avoid `any` unless unavoidable. **Never write `ReturnType<>`**; use the named type. Check `node_modules` for external API types instead of guessing.
- **Imports are top-level only.** No `await import()` and no `import("pkg").Type`. Exception: the boot graph (`cli.ts`, `cli-commands.ts`, `commands/launch.ts`, `main.ts`) lazy-loads at comment-labelled latency/command boundaries. Keep those comments and add no new ones elsewhere.
- **Barrels:** use `export * from "./module"` (including for types) in `index.ts` barrels. When stars collide, remove the redundant path; never duplicate it. pi-utils exports namespaces, so call sites read `logger.warn(…)`, `ptree.…`.
- **Class privacy:** use ES `#private` fields. Write no `private`/`protected`/`public` keywords, except TypeScript-required constructor parameter properties.
- `Promise.withResolvers()` instead of `new Promise((resolve, reject) => …)`.
- Node modules are namespace-imported: `import * as fs from "node:fs/promises"`, `import * as path from "node:path"`, `import * as os from "node:os"`.
- Deep subpath imports are normal (`@oh-my-pi/pi-tui/render/render-utils`, `@oh-my-pi/pi-catalog/compat/providers`). coding-agent's `package.json` `exports` maps `./<dir>/*`, so a **new top-level `src/` directory needs an exports entry**.
- **Catalog values** (models, thinking helpers, identity, descriptors) come from `@oh-my-pi/pi-catalog/<module>`, never through `@oh-my-pi/pi-ai`. Type-only imports of `Model`, `Api`, `Effort` and similar from pi-ai are fine.

### Reuse central utilities
Search before writing any helper. Look in `packages/coding-agent/src/utils/`, `@oh-my-pi/pi-utils`, `@oh-my-pi/pi-tui` and the domain module next to your call site. The central versions carry the timeouts, output caps, non-interactive env, caching and sanitization that a copy loses. Two implementations of one thing is a bug; extend the helper instead.
- git/jj: use `import * as vcs from "@oh-my-pi/pi-natives/vcs"` plus `src/utils/active-repo-context.ts`. Never spawn git yourself. Match native VCS errors by `error.name === "VcsError"`, not `instanceof`.
- Streams: use `readLines`, `readJsonl`, `readSseJson` and `readSseEvents` from `@oh-my-pi/pi-utils`. Write manual reader loops only when the protocol demands it.

### Bun over Node
| Operation | Use | Not |
| --- | --- | --- |
| File I/O | `Bun.file(p).text()/.json()`, `Bun.write(p, data)` (creates parent dirs) | `readFileSync`/`writeFileSync`, `existsSync` in async code |
| Directories | `node:fs/promises` (`mkdir`, `rm`, `readdir`) | shelling out (`mkdir -p`) |
| Processes | `` $`cmd`.cwd(dir).quiet().nothrow() ``; `Bun.spawn` only for long-lived, streaming or signal-controlled processes | `child_process` |
| Sleep, lookup, hash | `Bun.sleep(ms)`, `$which("git")` (pi-utils), `Bun.hash`/WebCrypto | `setTimeout` promise, `which` subprocess, `node:crypto` |
| JSON5/JSONL, width, wrap | `Bun.JSON5`, `Bun.JSONL`, `Bun.stringWidth`, `Bun.wrapAnsi` | third-party packages, custom ANSI math |
| SQLite, HTTP | `bun:sqlite`, `Bun.serve` | `better-sqlite3`, `http.createServer` |

Optional reads use try/catch with `isEnoent(err)` from pi-utils; never check existence first and then read. Keep one `Bun.file(path)` handle per path. When reading from a piped `Bun.spawn` stdout, cast it: `(child.stdout as ReadableStream<Uint8Array>)`.

### Tools
- **Shape:** `class XTool implements AgentTool<typeof schema, XDetails>`, with a `name`, an omptype `parameters` schema (`type({ path: type("string").describe(…) })`), a `description` rendered from `prompts/tools/<tool>.md`, and `async execute(toolCallId, params, signal?, onUpdate?, ctx?)`. See `tools/read.ts` and `tools/bash.ts`.
- **Registration:** add a factory to `BUILTIN_TOOLS` in `tools/index.ts` (`(s: ToolSession) => new XTool(s)`). Gate it with settings inside `createTools`. The renderer and the `XDetails` type go in pi-tui and are registered in `packages/tui/src/tools/index.ts` `toolRenderers`.
- **Results:** build them with `ToolResultBuilder` (`tools/tool-result.ts`). Throw rather than return error text:
  - `ToolError` (from `@oh-my-pi/pi-tui/tools/tool-errors`) for user-facing failures.
  - `ToolAbortError` and `throwIfAborted(signal)` (`tools/tool-errors.ts`) for cancellation.
- **Cancellation:** thread `AbortSignal` through every async boundary. Remove `abort` listeners in `finally`. Use `untilAborted`/`withTimeout` from pi-utils, and `postmortem.register()` for exit cleanup.

### Settings, prompts, registries
- **Settings:**
  - Declare: `export const cfgFoo = register({ id: "domain.key", type, default, env?, ui: {…} })` in the domain's `settings.ts`, then add the domain to `config/all-settings.ts` `DOMAINS`. Order there sets the settings-panel order.
  - Read with `cfgFoo.get(scope)` and react with `cfgFoo.listen(scope, cb)`.
  - Precedence: env > runtime override > `--config` overlay > project > global `config.yml` > default.
- **Prompts are never built in code** (no inline strings, template literals or concatenation). They live in `.md` files imported with `import tpl from "../prompts/x.md" with { type: "text" }` and are rendered with Handlebars through `prompt.render(tpl, ctx)` (pi-utils). `bun run fmt` also runs `format-prompts`.
- **No DI container.** The codebase uses:
  - Process singletons: `InternalUrlRouter.instance()`, `MCPManager`, `AgentLifecycleManager.global()`.
  - Side-effect registration imports: `discovery/index.ts`, `config/all-settings.ts`.
  - A constructor-injected `ToolSession` for tools.
  - Late-bound host setters (`setInternalUrlSchemeHost`, `setXdevRendererLookup`) so pi-tui never imports coding-agent.
- **Internal URLs** (`skill://`, `agent://`, `xd://`, …): one handler per scheme in `internal-urls/*-protocol.ts`, registered in the router constructor. Tools use the router's spec API, never branches on scheme names. `read xd://<tool>` returns a tool's docs; `write xd://<tool>` executes it (`tools/xdev.ts`).
- **Extensions:** an `ExtensionFactory(pi)` uses `pi.on`, `pi.registerTool`, `pi.registerCommand` and `pi.registerProvider`. `ExtensionRunner` exists even with zero extensions, because `ExtensionToolWrapper` is the only approval gate.
- **CLI subcommands:** add to `cli-commands.ts`. Anything not listed there is forwarded as a prompt.

### Workers
Workers re-enter the CLI entrypoint; never add separate worker entry modules. `cli.ts` calls `declareWorkerHostEntry()` from `@oh-my-pi/pi-utils/worker-host` (only when `isProcessEntry`). It dispatches `__omp_worker_*` selectors before the command graph loads. Shared selectors live in `cli/worker-selectors.ts`. Some kinds (stt, tts, mnemopi_embed, js_eval_process, stats_activity) are IPC subprocesses (`subprocess/worker-client.ts`), not threads. Spawn sites:

```ts
const hostEntry = workerHostEntry(); // @oh-my-pi/pi-utils/worker-host
const worker = hostEntry
	? new Worker(hostEntry, { type: "module", argv: ["__omp_worker_<name>"] })
	: new Worker(new URL("./<worker>.ts", import.meta.url).href, { type: "module" });
```

`workerHostEntry()` is `null` under `bun test` and SDK embedding, so keep the fallback branch. For each new worker:
- add its selector to the dispatch in `cli.ts`
- export a `smokeTest*` probe
- wire the probe into `runSmokeTest` so `omp --smoke-test` covers it

The smoke run also executes in `ci:test:smoke` and `scripts/install-tests/run-ci.sh`.

### Model/provider policy lives in KDL
**Never hard-code model- or provider-conditional policy in TS.** That rules out `id.includes("claude")`, id regexes, and per-model tables for effort, pricing, context windows, modalities, routing or quirks.
- **Where policy lives:** `packages/catalog/src/compat/rules/`. The grammar and precedence are in its `README.md`. The five strata:
  - `taxonomy/`: identity
  - `classes/`: model-lineage truths
  - `providers/<id>.kdl`: deployment contracts, default model, env keys, discovery seeds
  - `runtime/behavior.kdl`: pre-lookup heuristics
  - `auth/<id>.kdl`: drives pi-ai's `PROVIDER_REGISTRY`
- **Branching in TS** goes only through `classifyModel()` facts (class/family/revision/effort). An id no selector can isolate gets an exact-id `models` residue rule with a comment.
- **Ties** throw `AmbiguousOverlapError`. Fix them with `priority=` in KDL.
- **Generated files** (never hand-edit):
  - `packages/catalog/src/models.json`: `gen:models`. Fix it via `scripts/generate-models.ts`, the `provider-models/openai-compat.ts` mappers, `PROVIDER_DESCRIPTORS` (`descriptors.ts`, factories only) or the KDL.
  - `src/compat/rules.json`, `auth-ids.ts` and `provider-ids.ts`: `gen:compat`.
  - `native/index.d.ts` and the generated export block in `native/index.js`: `build:bindings`.
  - `nix/bun.nix`, `bazel/clippy.bazelrc` and `MODULE.bazel.lock`.
- Commit generated output alongside its source. Regression tests target the rule, descriptor or mapper, not the bundled JSON.

### Logging and TUI output
- **No `console.*` where the TUI, RPC, SDK, workers or background runtimes may be active.** It corrupts rendering and protocols. Use `logger.error|warn|debug(msg, ctx)` from `@oh-my-pi/pi-utils`, which writes rotating `omp.<DATE>.<PID>.log` files under `getLogsDir()` (default `~/.omp/logs`). Only standalone commands that exit without entering the TUI may write user-facing stdout.
- **Sanitize every render path.** That covers success output, errors (which often embed file content), diffs and streaming previews. The helpers come from `@oh-my-pi/pi-tui/render/render-utils`:
  - `replaceTabs()` for tabs
  - `truncateToWidth()` with `TRUNCATE_LENGTHS` for long lines
  - `shortenPath()` for paths
  - `PREVIEW_LIMITS`; no ad-hoc numbers
- **Streaming tool previews:**
  - Decode streamed args only through `decodeStreamedToolArgs` / `ToolArgsRevealController` (`modes/controllers/tool-args-reveal.ts`), on both the live and the transcript-rebuild paths.
  - Never spread parsed `arguments` beside a raw `__partialJson`.
  - Bash previews must keep preview-only fields through `event-controller.ts`, `modes/utils/ui-helpers.ts` and `packages/tui/src/chat/tool-execution.ts`. `#buildRenderContext()` must work before a result exists.
  - Verify both the live and the rebuilt paths.
- **pi-tui `Component.render(width)`** returns lines that each fit `width`. Return the same array when nothing changed so memoization works.

### Rust
- **Formatting and lints:**
  - `rustfmt.toml`: hard tabs, width 3, `max_width` 100, `StdExternalCrate` import grouping.
  - Clippy runs pedantic + nursery with `-D warnings`. `#[allow]` needs a reason.
- **Layering:** napi-free logic lives in sibling `pi-*` crates; `pi-natives` holds thin `#[napi]` adapters. Blocking work goes through `task.rs` `blocking_task`.
- **Panics:** `catch_unwind` turns panics into rejected Promises. That relies on `panic = "unwind"` in `release`, so keep it.
- **Profiles** (root `Cargo.toml` + `.cargo/config.toml`):
  - `dev`: default
  - `release`: fat LTO
  - `local`: thin LTO, incremental; the default for `build:native`
  - `profiling`: symbols kept
  - `ci`: thin LTO, stripped
- **Shipped addons** are built by Bazel (`bazel/defs.bzl`), not the Cargo `release` profile.
- Never set `split-debuginfo = "off"` on a profile with debuginfo: on Mach-O it silently drops `file:line` from backtraces.
- **Already rejected, with measurements:** sccache, mold, and `panic = "abort"` on `dev`. Don't re-propose them.
- **Nightly toolchain:** `embed-metadata = false` is nightly-coupled, so keep it in sync with `rust-toolchain.toml`.

## Important Files

- **Entry and wiring:**
  - `packages/coding-agent/src/cli.ts`: entry, worker dispatch, `runSmokeTest`
  - `src/cli-commands.ts`
  - `src/main.ts`
  - `src/sdk.ts`: `createAgentSession`
  - `src/session/agent-session.ts`
- **Tools and rendering:**
  - `src/tools/index.ts`: `ToolSession`, `BUILTIN_TOOLS`
  - `packages/tui/src/tools/index.ts`: `toolRenderers`
  - `packages/tui/src/tui.ts`: differential renderer
- **Runtime core:**
  - `packages/agent/src/agent-loop.ts` and `agent.ts`
  - `packages/ai/src/stream.ts`
  - `packages/ai/src/registry/registry.ts`
- **Settings and URLs:**
  - `src/config/registry.ts`
  - `src/config/all-settings.ts`
  - `src/internal-urls/router.ts`
- **Catalog policy:** `packages/catalog/src/compat/rules/README.md`, `packages/catalog/scripts/{compile-compat,generate-models}.ts`
- **Natives:** `crates/natives/src/lib.rs`, `packages/natives/native/{index,loader-state}.js`, `scripts/bazel-natives.ts`, `packages/natives/scripts/build-bindings.ts`
- **Tooling:**
  - `scripts/ci-test-ts.ts`
  - `scripts/run-rs-task.ts`
  - `scripts/setup.ts`
  - `scripts/fix-changelogs.ts`
  - `scripts/merge-pr.ts`
  - `.github/workflows/ci.yml`
- **Config:**
  - `package.json`: scripts, workspace `catalog:` pins
  - `bunfig.toml`: exact, hoisted installs; 3-day minimum release age; `.md`/`.py` text loaders
  - `tsconfig.base.json`
  - `.oxlintrc.json` and `.oxfmtrc.json`
  - `Cargo.toml`, `rust-toolchain.toml`, `rustfmt.toml`
  - `.config/nextest.toml`
  - `deny.toml`
  - `MODULE.bazel`

## Runtime/Tooling Preferences

- **Bun only.** `packageManager: bun@>=1.4`. The engines floor `>=1.3.14` is enforced at startup, and Nix and Docker pin 1.4.2. Install with `bun install`, never npm or pnpm. Internal deps use `catalog:` versions.
- **Type checking uses `tsgo`** (`@typescript/native-preview`, run as `tsgo -p tsconfig.json --noEmit` per package through `check:types`). There is no emit, and packages export `./src/*.ts` directly.
- **Rust:** nightly pinned in `rust-toolchain.toml` (required by `#![feature(alloc_error_hook)]` and `[unstable]` cargo config). Edition 2024. CMake builds need Ninja. `test:rs` needs `cargo-nextest`.
- **Bazel is used only in CI** (Rust validation and release addons). It pins its own nightly in `MODULE.bazel`, which differs from `rust-toolchain.toml`. Windows hosts can only build the `host` addon, through cargo/napi against VS Build Tools. `build-bindings.ts` finds VS cmake/ninja via vswhere.
- **No git hooks:** the `lint-staged` config is inert. `prepare` only runs `gen:tool-views`.
- **Line endings are LF** (`.gitattributes`), except `.cmd`/`.bat`.
- **Linked `omp` launcher:** `packages/coding-agent/scripts/omp` runs bun from `~/.omp/.dev-cwd`, so foreign `bunfig.toml` preloads don't apply.

## Testing & QA

- **Framework:** `bun:test` only; `vi`, `spyOn`, `mock` and `expect` all come from `"bun:test"`.
  - Tests live in `packages/<pkg>/test/**/*.test.ts`, and Rust tests are inline `#[cfg(test)]` modules plus `crates/*/tests/*.rs`.
  - There are no snapshots and no coverage thresholds.
- **Commands:**
  - One file: from the package dir (`D:/omp-fork/packages/<pkg>`), run `bun test test/tools/glob.test.ts -t "<regex>"`.
  - One package: `bun --cwd=packages/<pkg> run test`.
  - coding-agent must go through `scripts/ci-test-ts.ts`, via its `test` script or `ci:test:coding-agent:{singleton,ui,runtime,native}`. A bare whole-package `bun test` OOMs or hits GC aborts.
- **What the runner does:**
  - chunks files
  - strips credential env (`*_API_KEY`, `AWS_*`, `GITHUB_TOKEN`, …)
  - sets `PI_TEST_RUNTIME=1`
  - applies a 30s per-test timeout
  - knobs: `OMP_TEST_CONCURRENCY`, `OMP_TEST_SHARD=i/n`, `OMP_TEST_TIMEOUT`, `--full`, `--dry-run`
- **Buckets follow content markers.** Any direct `process.env.X =`, `Bun.env[…] =`, `Settings.init(` or `vi.useFakeTimers(` moves a file into the serial `singleton` bucket, so prefer scoped helpers.
- **Isolation patterns in use:**
  - `spyOn`/`vi.spyOn` on namespace-imported modules or prototypes, with `afterEach(() => vi.restoreAllMocks())`
  - constructor-injected fakes (`new GlobTool(session, { stat, nativeGlob })`)
  - `Settings.isolated({…})`
  - `beginSettingsTest()`/`restoreSettingsTestState()`
  - `withEnv()` and `withOfficialAnthropicEndpoint()` (ai), `withoutTerminalMultiplexer()` (tui)
  - `TempDir.createSync()` with `using`
  - `Promise.withResolvers()` gates
- **Never use `mock.module()`.** It leaks across files (oven-sh/bun#12823).
- **Tests must be full-suite safe:** no file-wide mutation of `Bun.*`, `process.platform` or env.
- **Live-provider E2E** runs only with `E2E=1` (`packages/ai/test/oauth.ts` `e2eApiKey`). Local-server suites skip themselves when the server is absent.
- **Platform:** about 40 files `skipIf(process.platform === "win32")`. CI runs TS tests on Linux only.
- **CI** (`.github/workflows/ci.yml`):
  - **PRs:** `cargo deny`, `ci:check:full` (TS only), the TS buckets, smoke tests, install-method tests.
  - **Non-PR events:** Rust validated via `bazelisk test //crates/...` plus clippy/rustfmt aspects.
  - **Never run anywhere:** `packages/stats` tests, `metaharness`, most `scripts/*.test.ts`, and the Python tests.
- **What earns a test.** Every test defends one externally observable contract and names the failure a consumer would see. Good targets:
  - computed transformations
  - distinct branches and boundaries
  - exact wire bytes when a consumer parses them
  - precedence and negative contracts that prevent a real leak or 400
  - regressions that reproduce the real failure path
- **Delete on sight:**
  - echo tests (a builder copied a fixture)
  - passthrough `fn(x) === x`
  - default and wording assertions, non-empty or length-grew checks, bare `not.toThrow()`, and `expect(true)`
  - duplicate parameterized rows
  - narrower mocked tests that restate an integration test
- **Never source-grep.** Don't read `.ts`/`.rs` sources and assert on their text. Run the code, use the smoke probe, or enforce structure with a type test or an oxlint rule. Asserting on files your code *wrote* is fine.
- **Error tests:** trigger the real failure and assert the surfaced contract.
- **Cyclic or large inputs:** assert a bounded result.
- **Tiny low-risk changes need no test.** Prefer focused package-local verification.

## Commits, Changelog & GitHub

- **Conventional Commits** with a scope and a past-tense subject: `fix(bash): exported OMP_AGENT_SHELL in interactive pty shells`. The body explains why.
- **Maintainer merges** (upstream) use `Merge PR #<n>: <subject> (@author)` via `scripts/merge-pr.ts`.
- **Changelogs are per package:**
  - Entries go in `packages/*/CHANGELOG.md` under `## [Unreleased]`, in the order `Breaking Changes`, `Added`, `Changed`, `Fixed`, `Removed`.
  - Each entry is one user-facing line. Released sections are immutable.
  - Upstream attribution links point to `can1357/oh-my-pi` issues/PRs. Fork entries carry no links.
  - `bun run fix:changelogs` normalizes them. Don't flag ordering in reviews.
- **GitHub:**
  - Before posting any comment or issue, show the target and text and get confirmation.
  - "Address PR feedback" means drafting replies, not posting them.
  - Resolve a thread only after an approved reply has been posted.
  - For contributor PRs, read `CONTRIBUTING.md` and `.github/PULL_REQUEST_TEMPLATE.md` first and keep the template. Keep the contributor's own why-sentence; never generate one. Read back the published description.

## Agent Skills

- **Issue tracker:** GitHub Issues on `Randallsm83/oh-my-pi`. Pass `-R Randallsm83/oh-my-pi` to every `gh` call: with the `upstream` remote present, bare `gh` targets `can1357/oh-my-pi`. See `docs/agents/issue-tracker.md`.
- **Triage labels:** `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`, as GitHub labels. See `docs/agents/triage-labels.md`.
- **Domain docs:** one root `CONTEXT.md` plus `docs/adr/`. See `docs/agents/domain.md`.
- **Architecture reviews:** `/improve-codebase-architecture` with no direction scopes to the fork additions under Project Overview, not `git log` hot spots, which here are mostly upstream churn. Touch upstream-owned modules only when named: every refactor there conflicts on each rebase.

<!-- caveman-begin -->
Respond terse like smart caveman. All technical substance stay. Only fluff die.

Rules:
- Drop: articles (a/an/the), filler (just/really/basically), pleasantries, hedging
- Fragments OK. Short synonyms. Technical terms exact. Code unchanged.
- Pattern: [thing] [action] [reason]. [next step].
- Not: "Sure! I'd be happy to help you with that."
- Yes: "Bug in auth middleware. Fix:"

Switch level: /caveman lite|full|ultra|wenyan-lite|wenyan-full|wenyan-ultra
Stop: "stop caveman" or "normal mode"

Auto-Clarity: drop caveman for security warnings, irreversible actions, user confused. Resume after.

Boundaries: code/commits/PRs written normal.
<!-- caveman-end -->
