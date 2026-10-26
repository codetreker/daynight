# Agent Note: Installed dn Short Command

Status: implemented

## Problem

Frequent CLI use requires repeatedly typing the full executable name. Operators
need a short command that is available immediately after package installation and
keeps the same command behavior and shell completion.

## Decision

The npm package declares both `daynight` and `dn` in `bin`, pointing to the same
`dist/main.js`. Package managers create their native launchers for both names.
The shared entry retains canonical `daynight` help and diagnostics, command
parsing, configuration, side effects and exit codes.

The root command definition declares `dn` as an alias. Bash and zsh generators
register the root name and aliases against the same completion function. The
existing startup loader continues generating scripts from the installed package;
new shells and explicit reloads register both names. Saved scripts require
regeneration after updating, as with other command-definition changes.

The command composition and completion ownership choices recorded in the
[client composition](../../archived/architecture/2026-10-20-client-command-composition.md)
and [completion](../../archived/feature/2026-10-20-shell-completion.md) decisions remain in force.
The updater continues validating the canonical npm-owned `daynight` launcher and
physical package directory, including when invoked through `dn`.

## Alternatives

**Shell alias.** A manually configured alias would require per-shell setup and
would not provide a package-managed executable for subprocesses or Windows
command launchers.

**Separate executable wrapper.** Another entry would duplicate dispatch or add a
process hop without changing behavior. Both installed names can use the existing
entry directly.

## Consequences

Every command can use either executable name, including `dn update`. Installed
acceptance checks both launchers, compares help, version and completion output,
and invokes a real npm global replacement through `dn`, then checks both names.
The short name occupies an additional command in the installation's bin directory.
