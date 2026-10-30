# Project management

A Project is associated with a Git repository.
Project identity determines the scope of task operations; confirm the service, access identity, and project before operating on tasks.

## Discovery and selection

Within a Git repository and its worktrees, task commands may omit `--project`; the CLI matches the `origin` URL to projects on the configured service.
An explicit project overrides automatic discovery for that invocation.

Use `project list` to find accessible projects and `project show` to verify the selected project.
If there is no match or the match is ambiguous, confirm the repository, service, and target project.
Do not guess IDs or create projects merely to make a query succeed.
See the relevant `--help` for details.

## Register a project

With authorization, use `project create` to register the repository as a project.
Reuse an existing project when exactly one matches; resolve identity first when the match is ambiguous.
Retain the returned project ID, then read the project details to confirm the repository and name.

If the creation response is uncertain, establish the actual outcome first under [write safety](write-safety.md).
An identical name does not prove project identity.
Consult `daynight project --help` for available project configuration operations.
