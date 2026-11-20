# omp

omp is a terminal coding agent: the user converses with a model that acts through tool calls, and every exchange is recorded in a transcript.

## Transcript

**Tool card**:
The transcript block showing one agent tool call and its result.
_Avoid_: bash card, tool block

**User command**:
A shell command the user types directly with `!`, run outside any agent tool call. Its transcript block is the _user command block_.
_Avoid_: bang command, `!` block, user bash

**Transcript styling**:
The subset of a command's own colors and text styles that is kept when its output is shown in the transcript.
_Avoid_: SGR, ANSI colors, raw color

## Advisors

**Primary agent**:
The agent doing the user's task, whose turns the transcript records.
_Avoid_: main agent, primary

**Advisor**:
A secondary model that reviews the primary agent's work as it happens and may send it advisories.
_Avoid_: reviewer, critic

**Advisory**:
One note from an advisor to the primary agent, with a severity (`nit`, `concern`, or `blocker`).
_Avoid_: advice note, advisor message

**Final answer**:
A primary agent turn that ends the run with text and no further work queued.
_Avoid_: terminal turn, stop turn
