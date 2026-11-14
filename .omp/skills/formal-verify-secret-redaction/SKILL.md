---
name: formal-verify-secret-redaction
description: "Check every short input against the secret-redaction promises of packages/coding-agent/src/secrets (SecretObfuscator obfuscate and deobfuscate, placeholders, built-in credential patterns). Use when a change or an upstream rebase touches src/secrets or SENSITIVE_TOKEN_RE, when a secret or credential reaches the provider unredacted, when a secret placeholder is not restored in tool arguments, or when redacted history drifts between turns."
---

# Verify secret redaction

`SecretObfuscator` replaces secrets with placeholders before text goes to the model provider and puts them back in tool-call arguments. A break either sends a credential to a third party or hands a tool the wrong bytes. The example tests (`packages/coding-agent/test/secrets-*.test.ts`) check cases someone wrote down. This check runs the real code on **every** sequence of up to four text tokens, about 415,000 texts, in half a minute.

It is generated-input testing of the real TypeScript, exhaustive up to a bound. No verifier proves properties of this code directly, and the question is about one function over all texts, not about the order of events, so it is not a TLA+ model and `/statechart` does not apply.

## Run it

```bash
.omp/skills/formal-verify-secret-redaction/check.sh
```

In an agent shell, prefix it with `source ~/.config/zsh/agent-env.zsh &&` so `bun` is on PATH. It needs only `bun` (>= 1.3.14, the repository's own floor) and installs nothing. A check, self-test or replay writes nothing inside the repository: it copies the covered files to a run directory under `${XDG_STATE_HOME:-~/.local/state}/formal-omp-fork/runs/` and runs there. That directory keeps `report.txt`, `result.json` and the snapshot; delete old ones whenever you like. Only `--write-known` and `--record-sync` write, and only into this skill's directory.

| Command | Use |
| --- | --- |
| `check.sh` | The check, depth 4, 15 to 30 s. Exit 0: no new failure. Exit 1: a failure that is not a known finding. |
| `check.sh --self-test` | Break the code six ways in copies and confirm each property catches its break. About 10 s. |
| `check.sh --replay "env+builtin warm BEARER Ab9 was:P_PW BEARER"` | Print every step of one case. |
| `check.sh --depth 5` | 7.5 million texts, 6 to 9 minutes. For exploring; see "Deeper runs". |
| `check.sh --root DIR` | Check a copy laid out like the repository instead of the checkout. |
| `check.sh --write-known` | Rewrite `known-failures.jsonl` from this run. |
| `check.sh --record-sync` | Rewrite `coverage.json` for the current commit. |

## What it checks

Each line is one property, then the harm when it breaks.

- **NoLeak.** No configured secret (an environment value or a `secrets.yml` literal) is readable in the text the provider receives. Harm: the credential sits in a third party's logs.
- **LongestWins.** When configured secrets nest or overlap, the longest one is hidden whole. Harm: half a password is sent in the clear.
- **PatternsHide.** A credential that a pattern matches (the built-in ones in `patterns.ts`, or a user regex) is not readable at the place it matched. Harm: an API key that nobody listed leaks.
- **Restore.** Redacted text restores to the same bytes the input restores to. Harm: a tool call writes placeholder text or wrong bytes into a file or command, or an exact-match edit can never match.
- **FixedPoint.** Redacting text that is already redacted changes nothing. Harm: the SDK redacts every outbound message twice and resends history every turn, so drift changes what the provider saw before, which breaks prompt caching and can corrupt replacement markers.
- **NoCrash.** `obfuscate()` returns for every text. Harm: a throw on the outbound path stops the request.

NoLeak, PatternsHide, Restore and LongestWins are checked on the output of the first pass and, when a second pass changes it, on that output too.

## Coverage record

The check describes these files. `coverage.json` holds the sync commit (`syncCommit`, `e124a802f5a9` when this skill was written) and a SHA-256 of each file at that commit. Every run prints the sync commit and names the files that have changed since.

| File | What the check exercises |
| --- | --- |
| `packages/coding-agent/src/secrets/obfuscator.ts` | `SecretObfuscator`: constructor, `obfuscate`, `#obfuscateDirtyText`, `#isRedactionIdentity`, `#collectRegexMatches`, `#createPlaceholder`, `#stripUnsafeFriendlyPrefixes`, the `#generate*Replacement` family, `deobfuscate`, `#lookupLiveAlias` |
| `.../secrets/placeholder.ts` | `PLACEHOLDER_RE`, `MIN_OBFUSCATE_SECRET_LEN`, `buildHashBase`, `buildPlaceholder`, `SecretValueSet`, `resumePlaceholderScanAfterRejectedCandidate` |
| `.../secrets/placeholder-scan.ts` | `buildReplaceRegexScan`, `mapReplaceRegexMatch`, the outside-placeholder helpers |
| `.../secrets/replacement.ts` | `generateDeterministicReplacement`, `ensureDistinctReplacement`, `findNonMatchingReplacement` |
| `.../secrets/regex.ts`, `.../secrets/registry-revision.ts` | `compileSecretRegex`; `TrackedMap`, `TrackedSet` |
| `.../secrets/patterns.ts` | `CREDENTIAL_PATTERNS`: all twelve are loaded; the tokens reach `Credential` (GitHub and GitLab shapes), `AWSAccessKey`, `BearerToken` and `PrivateKey` |
| `.../secrets/index.ts` | `builtinCredentialSecretEntries` and `collectEnvSecrets`, **mirrored by hand** in `harness.ts` (`BUILTIN_ENTRIES`, `envEntry`); the file itself is not loaded |
| `packages/ai/src/providers/transform-messages.ts` | Only the `SENSITIVE_TOKEN_RE` literal, which `verify.ts` copies into a stand-in module |

A change touches the verified code when it edits one of these files, changes how the obfuscator is built (`buildSecretObfuscator` in `index.ts`), or changes where `sdk.ts` and `session/` apply it (`obfuscateMessages`, `obfuscateProviderContext`, `deobfuscateToolArguments`).

## Read the result

The run prints one block per scenario and one line per property:

- `PASS` holds on every case.
- `KNOWN` fails only on cases that contain a case listed in `known-failures.jsonl`. These are the findings below. They do not fail the run.
- `FAIL` fails on a case no known case explains. Exit code 1. The shortest such case is printed.
- `UNCOMPARED` appears only at depth 5 and up; see "Deeper runs".
- `NOTE: known ... no longer fails` means a listed case now passes.

A case is a list of tokens, joined with nothing between them, in a session:

- **cold**: a fresh obfuscator, as after a restart. It knows the configured secrets but has minted no placeholder for a pattern-found value yet.
- **warm**: the obfuscator has already redacted every test value once.

In the printed texts, `‹P_PW›` is that secret, readable. `‹hidden:P_PW›` is a placeholder that restores to it. `‹hidden:T_GL as CREDENTIAL›` is a placeholder with a friendly label. `§§` stands for a literal `$$`. Nothing printed is credential-shaped, so omp does not redact the report before you read it.

Tokens of scenario `env+builtin` (four environment secrets plus the built-in patterns; every entry is reversible):

| Token | Text |
| --- | --- |
| `P_GH` | configured secret shaped like a GitHub token, so the `Credential` pattern matches it too |
| `P_PW`, `P_HEAD` | configured secrets `hunter2-Passw0rd` and its first 8 characters `hunter2-` (exactly the minimum length) |
| `Passw0rd`, `-xyz987` | fragments; together they form the configured secret `P_OV`, which overlaps the end of `P_PW` |
| `T_GL`, `T_AWS` | a GitLab-token-shaped and an AWS-key-shaped value that no entry lists; only patterns can catch them |
| `glpat-`, `Ab9`, `SPACE`, `BEARER` | a credential prefix alone, three characters that extend a token, a space, the text `Bearer ` |
| `PEM_BEGIN`, `PEM_END` | the two armor lines of a private key block |
| `DOLLARS`, `FORGED` | a literal `$$`, and a placeholder-shaped text that no obfuscator minted |
| `was:P_GH`, `was:P_PW`, `was:T_GL` | what an earlier call turned that value into: history that comes back |
| `renamed:P_PW` | the `P_PW` placeholder under a friendly name the config no longer uses |

Scenario `secrets.yml` (a user file: two replace-mode literals `R_KEY` and `R_TOK`, the second with a custom replacement; `P_PW` labelled `DbPassword`; a replace-mode regex `api_key=[A-Za-z0-9]{6,}`; an obfuscate-mode regex `tok_[a-z0-9]{8,}`; the built-in patterns) uses tokens `R_KEY R_TOK P_PW api_key= abc123XYZ tok_ a1b2c3d4 x SPACE DOLLARS FORGED REDACTED_MARK was:R_KEY was:P_PW was:API was:TOK`. Replace mode is one-way, so Restore and LongestWins are not checked there.

## A failure: real bug or wrong check?

1. Replay the printed case: `check.sh --replay "<scenario> <session> <tokens>"`. It shows the input, what the provider sees, the second pass, and what each restores to.
2. Read the property's sentence above against those lines. If the provider can read a secret, or the text restores to different bytes, or the second pass differs, the code broke the promise. That is a real bug in your change. Fix the code.
3. It is a wrong check only if your change **intends** the new behaviour: a new minimum length, a new placeholder format, a pattern removed on purpose, a new tie rule for overlapping secrets. Then update the check (next section), not the code.
4. If `covered files changed` names a file you did not mean to touch, or the run stops with `expected one SENSITIVE_TOKEN_RE regex literal` or a missing import, the check no longer describes the code. Use `/maintain-formal-verification-skill`.

Do not add a case to `known-failures.jsonl` to make a run green. That list is for findings the user has been told about.

## When the covered code changed

For a change you intend:

1. Make `harness.ts` describe the new code. Scenario entries mirror `builtinCredentialSecretEntries` and `collectEnvSecrets`; tokens must still reach the edges the code cares about (a secret of exactly `MIN_OBFUSCATE_SECRET_LEN`, overlapping secrets, a pattern-only credential, placeholders from earlier calls).
2. Run `check.sh --self-test`. Every line must say `CAUGHT`. `ERROR ... anchor text` means the line a broken variant edits has changed: rewrite that entry of `MUTANTS` in `verify.ts` so it breaks the same promise in the new code. `MISSED` means the property can no longer fail on that break: the check is too weak, fix it before trusting a pass.
3. Run `check.sh`. Triage every `FAIL` as above.
4. Only when the scenarios, properties and broken variants describe the code at the new commit, commit the product change and run `check.sh --record-sync`. It refuses while covered files have uncommitted changes. Never move the sync commit just to silence the changed-files notice.

After an upstream rebase the commit hashes change even when the files do not. If a run says `covered files match`, only the commit id is stale, and `check.sh --record-sync` is enough.

## Findings in the current code

Each has its shortest cases in `known-failures.jsonl`, labelled `F1` to `F4`. All were found at the sync commit. None makes a secret readable.

**F1, Restore: `deobfuscate()` skips a placeholder that directly follows `$$` and capitals or digits.**
1. A text holds `$$`, then four or more capitals or digits, then a secret with nothing between: `echo $$HOME<secret>` in a Makefile recipe, or `pid=$$1234<secret>`.
2. `obfuscate()` replaces the secret. The text is now `$$HOME` followed by the placeholder, and the placeholder's opening `$$` also reads as the closing `$$` of a placeholder-shaped text that starts at `$$HOME`.
3. `#deobfuscate` scans with `String.replace(PLACEHOLDER_RE)`. It takes that placeholder-shaped text as one candidate, finds it is not a placeholder, and moves past its closing `$$`, so it never sees the real placeholder.
4. The tool call receives the placeholder text instead of the secret.

The obfuscate-side scans avoid this with `resumePlaceholderScanAfterRejectedCandidate` (`placeholder.ts`); `#deobfuscate` does not use it. Shortest case: `env+builtin cold DOLLARS T_AWS P_GH`.

**F2, FixedPoint, cold sessions only: a placeholder in the input turns live in the middle of a pass.**
1. After a restart, a text carries the placeholder of a pattern-found value from before the restart, and the same value raw, glued into one run of token characters: `T_GL was:T_GL P_GH T_GL`.
2. The first pass builds its view of the text while that placeholder is still unknown, then mints it when it redacts the raw value.
3. The second pass sees the placeholder restored, so the `Credential` pattern now matches the whole run, and it hides text the first pass left readable.

**F3, FixedPoint: one pattern's match reaches into text another pattern redacts later in the same pass.**
`glpat- was:P_GH PEM_BEGIN PEM_END`: the `Credential` pattern matches from `glpat-` through the earlier placeholder's secret into the first dashes and `BEGIN` of the armor. On the first pass `glpat-` stays readable and `PrivateKey` then replaces the PEM block. On the second pass the same match ends inside that new placeholder (the `partialPlaceholderCut` case in `#collectRegexMatches`), and this time `glpat-` is hidden.

**F4, FixedPoint: a friendly label is dropped on the second pass.**
`BEARER Ab9 was:P_PW BEARER`: the `BearerToken` match covers `Ab9`, the earlier placeholder and the word `Bearer`. The first pass mints `Ab9` with the label `BEARERTOKEN`, then mints the word `Bearer` as a secret value. From then on `#prefixIsSecretShaped("BEARERTOKEN")` is true, because the label contains that value, so the second pass strips the label in `#stripUnsafeFriendlyPrefixes`. The same happens to `PRIVATEKEY` in `PEM_BEGIN BEARER was:P_PW PEM_END`.

F2 to F4 each need four tokens glued together that mix two patterns around an earlier placeholder. In all of them the second pass hides more text or drops a label; it never reveals anything.

Two behaviours look like leaks and are the code's design, so no property covers them:

- A pattern-found credential is redacted only where its pattern matches. Glued to a letter it stays readable, even in a text where the same value was redacted a few characters earlier (`T_GL SPACE Ab9 T_GL`). Only configured literals are redacted wherever they occur.
- Patterns run on the text with placeholders restored. A credential glued to the end of a configured secret is therefore not matched, and once the secret is replaced it stands readable on its own (`P_GH T_GL`). For the same reason a value glued directly after its own placeholder stays readable (`secrets.yml warm was:TOK tok_ a1b2c3d4`).

## Bounds and what is not covered

A pass covers exactly this: every sequence of 0 to 4 tokens from the lists above, cold and warm, with these fixed secret values and one fixed placeholder key. Nothing longer, no other values.

Not covered:

- `message-transform.ts`: walking messages and tool arguments, sharing pattern values across one batch, native replay, and the streaming helper `stripPendingSecretPlaceholderSuffix`.
- `redactionPrefixEnd` (advisor preview cuts) and `stripUnsafeFriendlyPlaceholderPrefixes`.
- `secrets/index.ts` loading: YAML validation, environment-variable selection, the placeholder key file.
- Secrets that contain `$$`, non-ASCII text, secrets that differ only by case, recursive placeholders.
- Regex entries with a custom `replacement`, and regexes that can match placeholder text itself (such as `\S+`).
- The eight built-in patterns no token matches: Google, Slack, npm, Stripe (two), Hugging Face, SendGrid, JWT; and the `sk-` shapes of `Credential`.
- The tail of the shorter of two overlapping configured secrets, which stays readable by design.
- More than one message, and anything between `obfuscate()` and the provider.

## Deeper runs

`known-failures.jsonl` lists the minimal failing cases at depth 4 and records that depth. At depth 5 the same four findings have about 1,400 further minimal shapes, so a longer failing case of Restore or FixedPoint that contains no listed case is printed as `UNCOMPARED` and does not fail the run. A property with no known finding still fails at any depth. Replay an `UNCOMPARED` case before believing it is one of the four.

At the sync commit a depth-5 run (7,464,282 texts) passed NoCrash, NoLeak, LongestWins and PatternsHide and printed 91 Restore and 1,330 FixedPoint cases as `UNCOMPARED`. Each of those was replayed once when this skill was written: every Restore case was F1 (the two scan views agree, `deobfuscate()` does not), and in every FixedPoint case the second pass only dropped a label or hid more text.

When a finding is fixed, its cases print `NOTE: ... no longer fails`. Run `check.sh --write-known`, which rewrites the list from the run and labels unseen cases `UNTRIAGED`; label or fix those, and remove the finding from this file.
