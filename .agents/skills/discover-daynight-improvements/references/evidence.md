# Evidence Standard

Evidence lets a reader without the session reproduce and judge a finding. Topic
skills add their own evidence types; this reference sets the requirements every
topic shares.

## Identify what was observed

Record for every piece of evidence:

- the source revision as a full SHA, whether the checkout was dirty, and the
  running build or artifact identity;
- the environment: exact origin, local or production service, persona, and the
  Provider and model when relevant;
- the route or command, the conditions such as viewport, locale or data size, and
  the state;
- the actions taken and the observed results, with timestamps or elapsed time
  when timing matters.

A supplied SHA is attribution, not proof that a running process came from that
source. Keep the environment's own build verification.

## Choose the evidence type deliberately

| Type | Use | Limits |
| --- | --- | --- |
| Consistent capture from prepare-daynight-local's capture helper | A stable page state with selected geometry and text, optionally with a screenshot or screen-media PDF | Covers only the selected elements and the capture window |
| Geometry-only capture | Layout facts when an image would expose private content | Makes no visual rendering claim |
| Interaction record in Markdown or JSON | A sequence of actions and results, including a transient state recorded as a time series | Names its method, source, route, conditions and sampling; its reliability rests on that method |
| CLI or API readback | Server-side state that a page, log or record claims | Shows the server's view at read time only |
| Measurement | Durations, counts or resource use | Requires the method, repetitions, spread and environment |
| External source | Behavior of a competitor or a standard | Requires a resolvable citation and access date; separates documented claims from observed behavior |

Keep failed, inconsistent or superseded attempts in the private record, outside
the package. A capture that is not `consistent` cannot support a conclusion about
a stable state.

## Separate observation from explanation

State what was observed before explaining why. Name a cause only after inspecting
the relevant source, and cite it with a permalink at the fixed revision. Label an
unverified but plausible cause as a lead for the implementer. Compare the
relevant specification, tests and document owners before prescribing an
implementation.

## Recheck freshness before dispatch

Long investigations can outlive their source revision. Before registering
findings:

1. Fetch the target branch and record its current SHA.
2. For each finding, compare the files that produce the behavior between the
   evidence revision and the current SHA, for example with
   `git log --oneline <evidence-sha>..origin/main -- <paths>`.
3. When relevant files changed, reproduce the finding on an environment rebuilt
   at the current SHA, or state precisely why the change cannot affect it.
4. Exclude a finding that a delivered change already resolves. Record both
   revisions in the package.

## Screen private data before upload

Native Agents, browsers and accounts used by an investigation run with the user's
own configuration. Session content, command catalogs, settings panels, tool
output and logs can show skill and plugin names, MCP servers, global agent
instructions, home-directory paths, usernames, repository names and private
notes. Synthetic fixtures do not make this content synthetic.

- Prefer geometry-only captures and generic text for surfaces that list personal
  configuration, such as command catalogs.
- Write prompts and fixtures that stay inside the disposable workspace, and deny
  approvals that reach outside it.
- Replace home-directory prefixes in text records with `~`, and remove personal
  values that the finding does not need.
- Run the package validator with `--forbid` for the home directory, the username
  and other known private strings. It scans text files and lists the binary files
  it could not scan.
- Inspect every image and PDF visually; text scanning cannot read them.
- Delete unsafe local captures after replacing them. Never upload credentials,
  tokens, complete configuration files or process environments.
