# Agent Note: Pipe-Ready Fixture Diagnostics

Status: implemented

## Problem

A missing coordinator integration fixture marker does not establish whether the
wrapper started, Git failed, or marker publication failed. The fixture removes
its temporary directory after the test, so an absent marker alone cannot explain
which subprocess stage was reached.

## Decision

The fixture records subprocess and marker stages in its temporary directory and
reports a structured summary when the startup marker is missing. The real Git
command and inherited output streams remain part of the gate. The receipt uses
only fixed stage names, process identifiers, bounded error classifications, exit
facts and output byte counts; paths, arguments, environment and output contents
are excluded. Missing events and unavailable observations remain unknown.
Controlled subprocess cases exercise the failure stages and successful marker.

## Alternatives

**Log raw subprocess errors and output.** These can contain credentials, paths
and user data, and truncation alone does not remove secrets.

**Increase the marker deadline or retry.** Neither explains the missing marker,
and both obscure the original failure and alter the gate being tested.

## Consequences

The receipt distinguishes observed stages while retaining the original timeout
and gate assertions. Byte counts cannot explain Git's output content, and an
unrecorded stage is not proof it did not occur. A failure to write the receipt
is reported separately and limits attribution.
